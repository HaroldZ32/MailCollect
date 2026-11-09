import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type {
  AccountView,
  AttachmentMeta,
  Category,
  Draft,
  Folder,
  FolderRole,
  MessageListResponse,
  MessageDetailResponse,
  MessageListItem,
  OutboxItem,
  OutboxStatus,
  RawEmail,
  SendMessageResponse,
} from "@mailcollect/shared";
import { api, isApiError } from "../lib/api";
import { createMockEmails } from "../lib/mock";
import { formatFullDate, formatMailTime, hueFor, initials, senderLabel, snippet } from "../lib/format";
import { GlassCard } from "../components/GlassCard";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import { MessageView } from "../components/MessageView";
import { ComposerDialog } from "../components/ComposerDialog";
import type { ComposerInitialMode, ComposerSource } from "../components/ComposerDialog";
import { FOLDER_EVENT, type FolderTarget } from "../components/Sidebar";
import { ROUTE_EVENT, type ShellRoute } from "../components/OnboardingWizard";
import type { ConnectionMode } from "../lib/useMailData";

export interface InboxPageProps {
  readonly mode: ConnectionMode;
  readonly accounts: readonly AccountView[];
  readonly resyncToken: number;
  readonly onSync: (accountId: string) => void;
  readonly onExtract: () => void;
}

const ALL_ACCOUNTS = "all";
/** 服务端接受角色名作为 folder（`inbox/archive/trash/…`），省略 = INBOX。 */
const DEFAULT_FOLDER = "inbox";
/** `GET /api/messages` 的默认物理路径（带 accountId 时角色名会被解析成它）。 */
const DEFAULT_FOLDER_PATH = "INBOX";
const PAGE_SIZE = 40;
const SEARCH_DEBOUNCE_MS = 260;

const FOLDER_ROLES: readonly FolderRole[] = ["inbox", "sent", "drafts", "trash", "archive", "junk", "other"];

const ROLE_LABEL: Record<FolderRole, string> = {
  inbox: "收件箱",
  sent: "已发送",
  drafts: "草稿",
  trash: "垃圾箱",
  archive: "归档",
  junk: "垃圾邮件",
  other: "其他",
};

const OUTBOX_STATUS_LABEL: Record<OutboxStatus, string> = {
  queued: "排队中",
  sending: "发送中",
  failed: "失败",
  sent: "已发送",
};

/** 服务端把「可重试的失败」也记成 failed，但会给一个近期的 nextAttemptAt（退避 ≥30 秒）；
 *  不可重试的失败被停到 365 天后（`PARKED_RETRY_MS`）。UI 必须把两者说清楚。 */
const PARKED_THRESHOLD_MS = 24 * 60 * 60 * 1000;

function outboxIsParked(entry: OutboxItem): boolean {
  if (entry.status !== "failed") return false;
  const due = entry.nextAttemptAt === null ? null : Date.parse(entry.nextAttemptAt);
  return due === null || !Number.isFinite(due) || due - Date.now() > PARKED_THRESHOLD_MS;
}

function outboxLabel(entry: OutboxItem): string {
  if (entry.status !== "failed") return OUTBOX_STATUS_LABEL[entry.status];
  return outboxIsParked(entry) ? "失败 · 需手动重试" : "失败 · 将自动重试";
}

interface ComposerState {
  readonly mode: ComposerInitialMode;
  readonly replyTo: ComposerSource | null;
  readonly draft: Draft | null;
  readonly accountId: string | null;
}

interface Notice {
  readonly kind: "ok" | "error";
  readonly text: string;
}

/** 文件夹展示名：优先用服务端快照里的 role，其次按角色名，最后原样显示路径。 */
function folderLabelOf(folder: string, folders: readonly Folder[]): string {
  const found = folders.find((item) => item.path === folder);
  if (found !== undefined) return ROLE_LABEL[found.role] ?? found.path;
  const role = FOLDER_ROLES.find((candidate) => candidate === folder.toLowerCase());
  return role === undefined ? folder : ROLE_LABEL[role];
}

/** 服务端没有文件夹快照（未同步 / 适配器不可达）时的兜底：角色名本身就能被 GET /messages 解析。 */
function fallbackFolders(accountId: string | null): readonly Folder[] {
  if (accountId === null) return [];
  return FOLDER_ROLES.filter((role) => role !== "junk" && role !== "other").map((role) => ({
    accountId,
    path: role,
    role,
    unread: 0,
  }));
}

function avatarBackground(seed: string): string {
  const hue = hueFor(seed);
  return `linear-gradient(140deg, hsl(${hue + 6} 92% 70%), hsl(${hue} 80% 54%))`;
}

/** 演示数据 → 列表项；没有分类/文件夹事实，用空标签与 INBOX 占位。 */
function demoSummary(email: RawEmail): MessageListItem {
  return {
    id: email.id,
    accountId: email.accountId,
    folder: "INBOX",
    fromName: email.fromName,
    fromEmail: email.fromEmail,
    subject: email.subject,
    snippet: snippet(email.bodyText, 120),
    sentAt: email.sentAt,
    isRead: true,
    hasAttachments: email.hasAttachments,
    categoryIds: [],
  };
}

function demoDetail(email: RawEmail): MessageDetailResponse {
  return {
    message: email,
    body: { text: email.bodyText, html: null },
    attachments: [],
    folder: "INBOX",
    isRead: true,
    categoryIds: [],
  };
}

function composerSourceOf(detail: MessageDetailResponse): ComposerSource {
  return {
    id: detail.message.id,
    subject: detail.message.subject,
    fromName: detail.message.fromName,
    fromEmail: detail.message.fromEmail,
    to: detail.message.to,
    cc: detail.message.cc,
    sentAt: detail.message.sentAt,
    bodyText: detail.body.text,
  };
}

/**
 * 收件箱 / 发件箱 / 草稿（C5 + C8 + AC-28 的 UI 侧）。
 *
 * 数据全部走冻结的 HTTP 契约：`GET /folders`、`GET /messages`（folder/categoryIds=ANY/
 * search/unreadOnly/cursor）、`GET /messages/:id`（服务端已 sanitize 的 html）、
 * `PATCH /messages/:id`（已读，乐观更新 + 失败回滚）、`POST /messages/:id/move`、
 * `GET /messages/:id/attachments[/:id]`、`/outbox` 与 `/drafts`。
 * 侧栏发来的文件夹点击经 `FOLDER_EVENT` 收口，避免把路由塞进 App.tsx（不在本任务写域）。
 */
export function InboxPage({ mode, accounts, resyncToken, onSync, onExtract }: InboxPageProps) {
  const demoEmails = useMemo(() => createMockEmails(), []);
  const live = mode === "live";

  const [accountFilter, setAccountFilter] = useState<string>(ALL_ACCOUNTS);
  const [folder, setFolder] = useState<string>(DEFAULT_FOLDER);
  const [search, setSearch] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<readonly string[]>([]);
  const [tab, setTab] = useState<"mail" | "outbox" | "drafts">("mail");

  const [items, setItems] = useState<readonly MessageListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [folders, setFolders] = useState<readonly Folder[]>([]);
  const [foldersError, setFoldersError] = useState<string | null>(null);
  const [categories, setCategories] = useState<readonly Category[]>([]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MessageDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [outbox, setOutbox] = useState<readonly OutboxItem[]>([]);
  const [drafts, setDrafts] = useState<readonly Draft[]>([]);
  const [outboxBusy, setOutboxBusy] = useState<string | null>(null);
  const [sideError, setSideError] = useState<string | null>(null);

  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const readAttemptedRef = useRef<Set<string>>(new Set());

  const scopedAccountId = accountFilter === ALL_ACCOUNTS ? (accounts[0]?.id ?? null) : accountFilter;

  // 侧栏的文件夹点击（Sidebar 在自己的写域里发一个窗口事件）：切账号 + 切文件夹 + 回邮件页。
  useEffect(() => {
    const onFolder = (event: Event): void => {
      const target = (event as CustomEvent<FolderTarget>).detail;
      if (target === undefined || target === null) return;
      setAccountFilter(target.accountId);
      setFolder(target.path);
      setTab("mail");
      setSelectedId(null);
    };
    window.addEventListener(FOLDER_EVENT, onFolder);
    return () => window.removeEventListener(FOLDER_EVENT, onFolder);
  }, []);
  const categoryLabel = useCallback(
    (categoryId: string): string => {
      const found = categories.find((item) => item.id === categoryId);
      return found?.name ?? "未知分类";
    },
    [categories],
  );

  /* --------------------------------- folders -------------------------------- */

  useEffect(() => {
    if (!live || scopedAccountId === null) {
      setFolders([]);
      setFoldersError(null);
      return;
    }
    const controller = new AbortController();
    void api.folders
      .list({ accountId: scopedAccountId }, { signal: controller.signal })
      .then((list) => {
        if (controller.signal.aborted) return;
        setFolders(list);
        setFoldersError(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // 适配器不可达（离线 / 演示账号）时退化成角色兜底，不阻塞收信列表。
        setFolders(fallbackFolders(scopedAccountId));
        setFoldersError(isApiError(error) ? error.message : "文件夹读取失败");
      });
    return () => controller.abort();
  }, [live, scopedAccountId, resyncToken]);

  const visibleFolders = folders.length === 0 ? fallbackFolders(scopedAccountId) : folders;

  /**
   * 「全部账号」时服务端没有 accountId 可用来解析角色名，只能按物理路径查；
   * 因此这一档把角色名解析成已知路径（缺快照时退回服务端的默认值 INBOX）。
   */
  const requestFolder = useMemo(() => {
    if (accountFilter !== ALL_ACCOUNTS) return folder;
    if (folder.toLowerCase() === DEFAULT_FOLDER) return DEFAULT_FOLDER_PATH;
    const match = visibleFolders.find((item) => item.path === folder || item.role === folder);
    return match?.path ?? folder;
  }, [accountFilter, folder, visibleFolders]);

  /* -------------------------------- categories ------------------------------- */

  useEffect(() => {
    if (!live) {
      setCategories([]);
      return;
    }
    const controller = new AbortController();
    void api.categories
      .list({ signal: controller.signal })
      .then((list) => {
        if (!controller.signal.aborted) setCategories(list);
      })
      .catch(() => {
        // 分类读不到时筛选条留空，收信列表照常工作。
      });
    return () => controller.abort();
  }, [live, resyncToken, refreshToken]);

  /* --------------------------------- messages -------------------------------- */

  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      void api.messages
        .list(
          {
            ...(accountFilter === ALL_ACCOUNTS ? {} : { accountId: accountFilter }),
            folder: requestFolder,
            ...(search.trim() === "" ? {} : { search: search.trim() }),
            ...(unreadOnly ? { unreadOnly: true } : {}),
            ...(categoryFilter.length === 0 ? {} : { categoryIds: [...categoryFilter] }),
            limit: PAGE_SIZE,
          },
          { signal: controller.signal },
        )
        .then((page) => {
          if (controller.signal.aborted) return;
          setItems(page.items);
          setNextCursor(page.nextCursor);
          setLoadError(null);
          setLoading(false);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setLoading(false);
          setItems([]);
          setNextCursor(null);
          setLoadError(isApiError(error) ? error.message : "邮件列表读取失败");
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [live, accountFilter, requestFolder, search, unreadOnly, categoryFilter, refreshToken, resyncToken]);

  const visibleItems = useMemo(() => {
    if (live) return items;
    const query = search.trim().toLowerCase();
    return demoEmails
      .map(demoSummary)
      .filter((item) => {
        if (query === "") return true;
        const haystack = `${item.subject} ${item.fromName ?? ""} ${item.fromEmail} ${item.snippet}`;
        return haystack.toLowerCase().includes(query);
      });
  }, [live, items, demoEmails, search]);

  /* ------------------------------ outbox / drafts ----------------------------- */

  const refreshSideData = useCallback(async (): Promise<void> => {
    if (!live) return;
    const query = accountFilter === ALL_ACCOUNTS ? {} : { accountId: accountFilter };
    const [outboxResult, draftResult] = await Promise.allSettled([
      api.outbox.list(query),
      api.drafts.list(query),
    ]);
    if (outboxResult.status === "fulfilled") setOutbox(outboxResult.value);
    if (draftResult.status === "fulfilled") setDrafts(draftResult.value);
    const failure =
      outboxResult.status === "rejected"
        ? outboxResult.reason
        : draftResult.status === "rejected"
          ? draftResult.reason
          : null;
    setSideError(failure !== null && isApiError(failure) ? failure.message : null);
  }, [live, accountFilter]);

  useEffect(() => {
    void refreshSideData();
  }, [refreshSideData, resyncToken, refreshToken]);

  /* --------------------------------- detail ---------------------------------- */

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    if (!live) {
      const email = demoEmails.find((item) => item.id === selectedId);
      setDetail(email === undefined ? null : demoDetail(email));
      setDetailError(email === undefined ? "演示数据里没有这封邮件" : null);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    void api.messages
      .get(selectedId, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setDetail(result);
        setDetailLoading(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setDetail(null);
        setDetailLoading(false);
        setDetailError(isApiError(error) ? error.message : "邮件正文读取失败");
      });
    return () => controller.abort();
  }, [selectedId, live, demoEmails, refreshToken]);

  /**
   * 打开未读邮件 = 标记已读：先乐观改视觉，再 PATCH；服务端拒绝远端变更时（类型化 502）
   * 必须回滚，不能显示一个假的「已读」。回滚后同一封不再自动重试（否则会打转）。
   */
  useEffect(() => {
    if (detail === null || detail.isRead) return;
    const id = detail.message.id;
    if (readAttemptedRef.current.has(id)) return;
    readAttemptedRef.current.add(id);
    setItems((previous) => previous.map((item) => (item.id === id ? { ...item, isRead: true } : item)));
    setDetail((previous) => (previous !== null && previous.message.id === id ? { ...previous, isRead: true } : previous));
    if (!live) return;
    void api.messages.update(id, { isRead: true }).catch((error: unknown) => {
      setItems((previous) => previous.map((item) => (item.id === id ? { ...item, isRead: false } : item)));
      setDetail((previous) =>
        previous !== null && previous.message.id === id ? { ...previous, isRead: false } : previous,
      );
      setNotice({
        kind: "error",
        text: isApiError(error) ? `标记已读失败，已回退：${error.message}` : "标记已读失败，已回退",
      });
    });
  }, [detail, live]);

  /* ---------------------------------- actions -------------------------------- */

  const navigateSettings = (): void => {
    window.dispatchEvent(new CustomEvent<ShellRoute>(ROUTE_EVENT, { detail: "settings" }));
  };

  const toggleCategory = (categoryId: string): void => {
    setCategoryFilter((previous) =>
      previous.includes(categoryId)
        ? previous.filter((item) => item !== categoryId)
        : [...previous, categoryId],
    );
  };

  const loadMore = async (): Promise<void> => {
    if (!live || nextCursor === null) return;
    try {
      const page: MessageListResponse = await api.messages.list({
        ...(accountFilter === ALL_ACCOUNTS ? {} : { accountId: accountFilter }),
        folder: requestFolder,
        ...(search.trim() === "" ? {} : { search: search.trim() }),
        ...(unreadOnly ? { unreadOnly: true } : {}),
        ...(categoryFilter.length === 0 ? {} : { categoryIds: [...categoryFilter] }),
        limit: PAGE_SIZE,
        cursor: nextCursor,
      });
      setItems((previous) => [...previous, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      setLoadError(isApiError(error) ? error.message : "加载更多失败");
    }
  };

  const openComposer = (next: ComposerState): void => setComposer(next);

  const defaultAccountId = accountFilter === ALL_ACCOUNTS ? (accounts[0]?.id ?? null) : accountFilter;

  const moveSelected = async (target: "archive" | "trash"): Promise<void> => {
    if (detail === null || !live) return;
    const id = detail.message.id;
    try {
      await api.messages.move(id, { folder: target });
      setSelectedId(null);
      setDetail(null);
      setRefreshToken((token) => token + 1);
      setNotice({ kind: "ok", text: target === "archive" ? "已归档" : "已移入垃圾箱" });
    } catch (error) {
      setNotice({ kind: "error", text: isApiError(error) ? error.message : "移动失败" });
    }
  };

  const toggleRead = async (): Promise<void> => {
    if (detail === null || !live) return;
    const id = detail.message.id;
    const nextRead = !detail.isRead;
    setDetail({ ...detail, isRead: nextRead });
    setItems((previous) => previous.map((item) => (item.id === id ? { ...item, isRead: nextRead } : item)));
    try {
      await api.messages.update(id, { isRead: nextRead });
    } catch (error) {
      setDetail((previous) => (previous === null ? previous : { ...previous, isRead: !nextRead }));
      setItems((previous) => previous.map((item) => (item.id === id ? { ...item, isRead: !nextRead } : item)));
      setNotice({
        kind: "error",
        text: isApiError(error) ? `改已读状态失败，已回退：${error.message}` : "改已读状态失败，已回退",
      });
    }
  };

  const downloadAttachment = async (attachment: AttachmentMeta): Promise<void> => {
    if (detail === null || !live) return;
    setDownloadingId(attachment.id);
    setAttachmentError(null);
    try {
      const file = await api.attachments.download(detail.message.id, attachment.id);
      const url = URL.createObjectURL(file.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.filename ?? attachment.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (error) {
      setAttachmentError(isApiError(error) ? error.message : "附件下载失败");
    } finally {
      setDownloadingId(null);
    }
  };

  const retryOutboxItem = async (outboxId: string): Promise<void> => {
    setOutboxBusy(outboxId);
    try {
      const item = await api.outbox.retry(outboxId);
      setOutbox((previous) => previous.map((entry) => (entry.id === outboxId ? item : entry)));
      setNotice({ kind: "ok", text: "已重新入队：后台按 ≥30 秒退避重试" });
    } catch (error) {
      setNotice({ kind: "error", text: isApiError(error) ? error.message : "重试失败" });
    } finally {
      setOutboxBusy(null);
    }
  };

  const deleteOutboxItem = async (outboxId: string): Promise<void> => {
    setOutboxBusy(outboxId);
    try {
      await api.outbox.remove(outboxId);
      setOutbox((previous) => previous.filter((entry) => entry.id !== outboxId));
      setNotice({ kind: "ok", text: "已从发件箱删除" });
    } catch (error) {
      setNotice({ kind: "error", text: isApiError(error) ? error.message : "删除失败" });
    } finally {
      setOutboxBusy(null);
    }
  };

  const deleteDraft = async (draftId: string): Promise<void> => {
    try {
      await api.drafts.remove(draftId);
      setDrafts((previous) => previous.filter((entry) => entry.id !== draftId));
      setNotice({ kind: "ok", text: "草稿已删除" });
    } catch (error) {
      setNotice({ kind: "error", text: isApiError(error) ? error.message : "草稿删除失败" });
    }
  };

  const handleSent = useCallback((result: SendMessageResponse): void => {
    setRefreshToken((token) => token + 1);
    if (result.status !== "sent") setTab("outbox");
  }, []);

  /* ---------------------------------- derived -------------------------------- */

  const detailMessage = detail?.message ?? null;
  const replyTarget = detail === null ? null : composerSourceOf(detail);
  const unreadCount = items.filter((item) => !item.isRead).length;
  const activeFolderLabel = folderLabelOf(folder, visibleFolders);
  const outboxAttention = outbox.filter((item) => item.status === "failed" || item.status === "queued").length;
  const hasFilter = search.trim() !== "" || unreadOnly || categoryFilter.length > 0 || accountFilter !== ALL_ACCOUNTS;
  const accountLabel = (accountId: string): string =>
    accounts.find((item) => item.id === accountId)?.label ?? "未知账号";

  /* ------------------------------------ view -------------------------------- */

  return (
    <div className={clsx("inbox", selectedId !== null && "is-detail-open")}>
      <GlassCard className="inbox-pane" flush={false}>
        <div className="inbox-toolbar">
          <div className="inbox-toolbar-row">
            <div className="search">
              <span className="search-icon">
                <Icon name="search" size={16} />
              </span>
              <input
                className="input"
                type="search"
                value={search}
                placeholder="搜主题、发件人或正文"
                aria-label="搜索邮件"
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn btn--primary"
              title="撰写新邮件"
              disabled={!live || accounts.length === 0}
              onClick={() => openComposer({ mode: "new", replyTo: null, draft: null, accountId: defaultAccountId })}
            >
              <Icon name="mail" size={14} />
              写邮件
            </button>
            <button
              type="button"
              className="btn btn--icon"
              title={scopedAccountId === null ? "还没有邮箱账号" : "同步当前账号"}
              aria-label="同步邮箱"
              disabled={!live || scopedAccountId === null}
              onClick={() => {
                if (scopedAccountId !== null) onSync(scopedAccountId);
              }}
            >
              <Icon name="refresh" size={16} />
            </button>
            <button
              type="button"
              className="btn btn--icon"
              title="对已存储的邮件重新抽取待办"
              aria-label="重新抽取待办"
              onClick={onExtract}
            >
              <Icon name="spark" size={16} />
            </button>
          </div>

          <div className="inbox-filters">
            <button
              type="button"
              className={accountFilter === ALL_ACCOUNTS ? "filter-chip is-active" : "filter-chip"}
              onClick={() => setAccountFilter(ALL_ACCOUNTS)}
            >
              全部账号
            </button>
            {accounts.map((account) => (
              <button
                key={account.id}
                type="button"
                className={accountFilter === account.id ? "filter-chip is-active" : "filter-chip"}
                onClick={() => setAccountFilter(account.id)}
              >
                {account.label}
              </button>
            ))}
            <span className="inbox-count">
              {loading ? "加载中…" : `${live ? visibleItems.length : demoEmails.length} 封 · 未读 ${unreadCount}`}
            </span>
          </div>

          <div className="inbox-filters">
            {visibleFolders.map((entry) => {
              const role = entry.role;
              const target = folders.length === 0 ? role : entry.path;
              const selected = folder === target;
              return (
                <button
                  key={`${entry.accountId}-${entry.path}`}
                  type="button"
                  className={selected ? "filter-chip is-active" : "filter-chip"}
                  onClick={() => {
                    setFolder(target);
                    // 非默认文件夹的路径是账号私有的：切过去就钉住该账号，避免「全部账号 + 别人的路径」。
                    if (entry.role !== "inbox" && scopedAccountId !== null) setAccountFilter(scopedAccountId);
                    setTab("mail");
                    setSelectedId(null);
                  }}
                >
                  {ROLE_LABEL[role] ?? entry.path}
                  {entry.unread > 0 ? <span className="nav-badge">{entry.unread}</span> : null}
                </button>
              );
            })}
            <button
              type="button"
              className={unreadOnly ? "filter-chip is-active" : "filter-chip"}
              onClick={() => setUnreadOnly((previous) => !previous)}
            >
              只看未读
            </button>
          </div>

          <div className="inbox-filters">
            <span className="field-label" style={{ marginRight: 2 }}>
              分类筛选（任一命中，多选取并集）
            </span>
            {categories.length === 0 ? (
              <span className="field-hint">
                还没有分类：在「规则」面板里建分类与规则后，邮件会带上多个标签。
              </span>
            ) : (
              categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className={categoryFilter.includes(category.id) ? "filter-chip is-active" : "filter-chip"}
                  title={`${category.enterTodo ? "进入待办抽取" : "不抽取"}${category.broadcast ? " · 群发提醒" : ""}`}
                  onClick={() => toggleCategory(category.id)}
                >
                  {category.name}
                </button>
              ))
            )}
            {categoryFilter.length === 0 ? null : (
              <button type="button" className="btn btn--sm btn--quiet" onClick={() => setCategoryFilter([])}>
                清空分类
              </button>
            )}
          </div>

          <div className="inbox-filters">
            <button
              type="button"
              className={tab === "mail" ? "filter-chip is-active" : "filter-chip"}
              onClick={() => setTab("mail")}
            >
              邮件 · {activeFolderLabel}
            </button>
            <button
              type="button"
              className={tab === "outbox" ? "filter-chip is-active" : "filter-chip"}
              onClick={() => setTab("outbox")}
            >
              发件箱{outboxAttention > 0 ? ` · ${outboxAttention}` : ""}
            </button>
            <button
              type="button"
              className={tab === "drafts" ? "filter-chip is-active" : "filter-chip"}
              onClick={() => setTab("drafts")}
            >
              草稿{drafts.length > 0 ? ` · ${drafts.length}` : ""}
            </button>
            {foldersError === null ? null : (
              <span className="field-hint" title={foldersError}>
                文件夹：{foldersError}（已按角色兜底）
              </span>
            )}
          </div>
        </div>

        {notice === null ? null : (
          <div
            className={notice.kind === "error" ? "test-result is-error" : "test-result"}
            role="status"
            onClick={() => setNotice(null)}
            style={{ cursor: "pointer" }}
          >
            <Icon name={notice.kind === "error" ? "alert" : "check"} size={14} />
            {notice.text}
          </div>
        )}

        {loadError === null ? null : (
          <div className="test-result is-error" role="status">
            <Icon name="alert" size={14} />
            {loadError}
          </div>
        )}

        {accounts.length === 0 ? (
          <div className="test-result is-error" role="status">
            <Icon name="alert" size={14} />
            还没有邮箱账号，收发都用不了：先在
            <button type="button" className="btn btn--sm btn--quiet" onClick={navigateSettings}>
              设置页添加账号
            </button>
            并填写收信与发信设置。
          </div>
        ) : null}

        {tab === "mail" ? (
          <div className="mail-list">
            {loading && visibleItems.length === 0 ? (
              <>
                {[0, 1, 2, 3].map((key) => (
                  <div className="skeleton-row" key={key}>
                    <div className="skeleton" style={{ width: 34, height: 34, borderRadius: 11 }} />
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
                      <div className="skeleton skeleton-line" style={{ width: "46%" }} />
                      <div className="skeleton skeleton-line" style={{ width: "84%" }} />
                      <div className="skeleton skeleton-line" style={{ width: "64%" }} />
                    </div>
                  </div>
                ))}
              </>
            ) : null}

            {!loading && visibleItems.length === 0 ? (
              <EmptyState
                icon="inbox"
                title={hasFilter ? "没有匹配的邮件" : `${activeFolderLabel}还是空的`}
                text={
                  hasFilter
                    ? "换个关键词、取消分类筛选，或切回「全部账号」再找找。"
                    : live
                      ? "同步一次会把邮件落到本地库；分类标签由规则面板里的规则在同步/重算时打进。"
                      : "当前是演示数据：接上本地服务后可看到真实邮件、文件夹未读数与分类标签。"
                }
                action={
                  hasFilter ? (
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => {
                        setSearch("");
                        setUnreadOnly(false);
                        setCategoryFilter([]);
                        setAccountFilter(ALL_ACCOUNTS);
                      }}
                    >
                      清空筛选
                    </button>
                  ) : undefined
                }
              />
            ) : null}

            <div className="stagger">
              {visibleItems.map((item) => {
                const from = senderLabel(item.fromName, item.fromEmail);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={clsx("mail-item", item.id === selectedId && "is-active")}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <span className="avatar avatar--sm" style={{ background: avatarBackground(item.fromEmail) }}>
                      {initials(from)}
                    </span>
                    <div className="mail-item-main">
                      <div className="mail-item-top">
                        <span className="mail-from">
                          {item.isRead ? null : (
                            <span
                              aria-label="未读"
                              style={{
                                display: "inline-block",
                                width: 6,
                                height: 6,
                                borderRadius: 50,
                                background: "var(--accent, #2F7CF6)",
                                marginRight: 6,
                                verticalAlign: "middle",
                              }}
                            />
                          )}
                          {from}
                        </span>
                        <span className="mail-time">{formatMailTime(item.sentAt)}</span>
                      </div>
                      <span className="mail-subject">{item.subject}</span>
                      <span className="mail-snippet">{item.snippet}</span>
                      <span className="mail-tags">
                        {item.categoryIds.length === 0 ? (
                          <span className="chip chip--muted">未分类</span>
                        ) : (
                          item.categoryIds.map((categoryId) => (
                            <span key={categoryId} className="chip chip--iris">
                              {categoryLabel(categoryId)}
                            </span>
                          ))
                        )}
                        {item.hasAttachments ? (
                          <span className="chip">
                            <Icon name="paperclip" size={10} />
                            附件
                          </span>
                        ) : null}
                        {accountFilter === ALL_ACCOUNTS && accounts.length > 1 ? (
                          <span className="chip">{accountLabel(item.accountId)}</span>
                        ) : null}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            {live && nextCursor !== null ? (
              <div className="form-actions" style={{ justifyContent: "center" }}>
                <button type="button" className="btn btn--sm" disabled={loading} onClick={() => void loadMore()}>
                  {loading ? "加载中…" : "加载更多"}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {tab === "outbox" ? (
          <div className="mail-list">
            {sideError === null ? null : (
              <div className="test-result is-error" role="status">
                <Icon name="alert" size={14} />
                {sideError}
              </div>
            )}
            {outbox.length === 0 ? (
              <EmptyState
                icon="mail"
                title="发件箱是空的"
                text="离线或发送失败时，邮件会停在发件箱：排队中会自动重试，失败的可查看原因、重试或删除。"
              />
            ) : (
              outbox.map((entry) => (
                <div
                  key={entry.id}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 14,
                    border: "1px solid rgba(47,124,246,.14)",
                    background: "rgba(255,255,255,.66)",
                    marginBottom: 8,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span
                      className={clsx(
                        "chip",
                        entry.status === "failed" && "chip--danger",
                        entry.status === "sent" && "chip--success",
                        (entry.status === "queued" || entry.status === "sending") && "chip--warning",
                      )}
                    >
                      {outboxLabel(entry)}
                    </span>
                    <strong style={{ fontSize: 13 }}>{entry.message.subject || "(无主题)"}</strong>
                    <span className="field-hint">
                      {accountLabel(entry.accountId)} · 尝试 {entry.attempts} 次 ·{" "}
                      {formatMailTime(entry.updatedAt)}
                    </span>
                    <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        className="btn btn--sm btn--quiet"
                        disabled={outboxBusy === entry.id || entry.status === "sent"}
                        onClick={() => void retryOutboxItem(entry.id)}
                      >
                        重试
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--quiet"
                        disabled={outboxBusy === entry.id || entry.status === "sending"}
                        onClick={() => void deleteOutboxItem(entry.id)}
                      >
                        删除
                      </button>
                    </span>
                  </div>
                  <div className="field-hint" style={{ marginTop: 4 }}>
                    收件人 {entry.message.to.join("、") || "（空）"}
                    {entry.message.attachments.length === 0
                      ? ""
                      : ` · 附件 ${entry.message.attachments.length} 个`}
                    {outboxIsParked(entry)
                      ? " · 已暂停自动重试"
                      : entry.nextAttemptAt === null
                        ? ""
                        : ` · 下次尝试 ${formatMailTime(entry.nextAttemptAt)}`}
                  </div>
                  {entry.lastError === null ? null : (
                    <div className="test-result is-error" role="status" style={{ marginTop: 6 }}>
                      <Icon name="alert" size={13} />
                      {entry.lastError}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        ) : null}

        {tab === "drafts" ? (
          <div className="mail-list">
            {drafts.length === 0 ? (
              <EmptyState
                icon="mail"
                title="没有草稿"
                text="撰写时停输 3 秒或关闭弹层会自动保存草稿；发送成功或删除后清理。重启后仍可从这里恢复。"
              />
            ) : (
              drafts.map((draft) => (
                <div
                  key={draft.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "10px 12px",
                    borderRadius: 14,
                    border: "1px solid rgba(47,124,246,.14)",
                    background: "rgba(255,255,255,.66)",
                    marginBottom: 8,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 650 }}>{draft.subject || "(无主题)"}</div>
                    <div className="field-hint">
                      收件人 {draft.to.join("、") || "（空）"} · 保存于 {formatMailTime(draft.savedAt)}
                      {draft.attachments.length === 0 ? "" : ` · 附件 ${draft.attachments.length} 个`}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() =>
                      openComposer({ mode: draft.mode, replyTo: null, draft, accountId: draft.accountId })
                    }
                  >
                    继续编辑
                  </button>
                  <button type="button" className="btn btn--sm btn--quiet" onClick={() => void deleteDraft(draft.id)}>
                    删除
                  </button>
                </div>
              ))
            )}
          </div>
        ) : null}
      </GlassCard>

      <GlassCard className="mail-detail" flush={false}>
        {detailMessage === null ? (
          <div className="inbox-empty-detail">
            {detailLoading ? (
              <div className="empty-state">
                <div className="skeleton" style={{ width: 62, height: 62, borderRadius: 21 }} />
                <div className="skeleton skeleton-line" style={{ width: 180, height: 12 }} />
                <div className="skeleton skeleton-line" style={{ width: 260, height: 10 }} />
              </div>
            ) : (
              <EmptyState
                icon="mail"
                title={detailError ?? "选一封邮件看正文"}
                text={
                  detailError ??
                  "富文本由服务端 sanitize 后再经前端二次清洗；多标签会全部显示在标题下方。"
                }
              />
            )}
          </div>
        ) : (
          <>
            <div className="mail-detail-head">
              <div className="mail-detail-top">
                <button
                  type="button"
                  className="btn btn--quiet btn--sm mail-detail-back"
                  onClick={() => setSelectedId(null)}
                >
                  <Icon name="chevron-left" size={14} />
                  返回列表
                </button>
                <span className="chip">{accountLabel(detailMessage.accountId)}</span>
                <span className="chip">{folderLabelOf(detail?.folder ?? "", visibleFolders)}</span>
                {detail?.categoryIds.map((categoryId) => (
                  <span key={categoryId} className="chip chip--iris">
                    {categoryLabel(categoryId)}
                  </span>
                ))}
                <span className="inbox-count">{formatFullDate(detailMessage.sentAt)}</span>
              </div>
              <h2 className="mail-detail-subject">{detailMessage.subject}</h2>
              <div className="mail-detail-meta">
                <span>
                  发件人 <strong>{senderLabel(detailMessage.fromName, detailMessage.fromEmail)}</strong> ·{" "}
                  {detailMessage.fromEmail}
                </span>
                <span>
                  收件人 <strong>{detailMessage.to.join("、")}</strong>
                </span>
                {detailMessage.cc.length === 0 ? null : <span>抄送 {detailMessage.cc.join("、")}</span>}
              </div>
              <div className="form-actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={!live}
                  onClick={() =>
                    openComposer({
                      mode: "reply",
                      replyTo: replyTarget,
                      draft: null,
                      accountId: detailMessage.accountId,
                    })
                  }
                >
                  回复
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={!live}
                  onClick={() =>
                    openComposer({
                      mode: "forward",
                      replyTo: replyTarget,
                      draft: null,
                      accountId: detailMessage.accountId,
                    })
                  }
                >
                  转发
                </button>
                <button type="button" className="btn btn--sm btn--quiet" disabled={!live} onClick={() => void toggleRead()}>
                  {detail?.isRead ? "标为未读" : "标为已读"}
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--quiet"
                  disabled={!live}
                  onClick={() => void moveSelected("archive")}
                >
                  归档
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--quiet"
                  disabled={!live}
                  onClick={() => void moveSelected("trash")}
                >
                  移入垃圾箱
                </button>
                {detail?.isRead ? null : <span className="chip chip--warning">未读</span>}
              </div>
            </div>

            <div className="mail-detail-scroll">
              <MessageView
                message={detailMessage}
                body={detail?.body ?? { text: "", html: null }}
                attachments={detail?.attachments ?? []}
                downloadingId={downloadingId}
                downloadError={attachmentError}
                onDownload={live ? (attachment: AttachmentMeta) => void downloadAttachment(attachment) : undefined}
              />
            </div>
          </>
        )}
      </GlassCard>

      {composer === null ? null : (
        <ComposerDialog
          open
          mode={composer.mode}
          accounts={accounts}
          accountId={composer.accountId}
          replyTo={composer.replyTo}
          draft={composer.draft}
          onClose={() => {
            setComposer(null);
            // 草稿是在弹层里保存的：关闭后刷新草稿页与发件箱，避免列表还停在旧快照。
            void refreshSideData();
          }}
          onSent={handleSent}
          onNotice={(kind, text) => setNotice({ kind, text })}
        />
      )}
    </div>
  );
}
