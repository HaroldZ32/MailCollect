import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type { AccountView, BroadcastVerdict, RawEmail } from "@mailcollect/shared";
import { api, isApiError } from "../lib/api";
import type { EmailDetail } from "../lib/api";
import { createMockEmails, createMockVerdicts } from "../lib/mock";
import {
  formatFullDate,
  formatMailTime,
  hueFor,
  initials,
  listIdOf,
  senderLabel,
  snippet,
} from "../lib/format";
import { GlassCard } from "../components/GlassCard";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import type { ConnectionMode } from "../lib/useMailData";

export interface InboxPageProps {
  readonly mode: ConnectionMode;
  readonly accounts: readonly AccountView[];
  readonly resyncToken: number;
  readonly onSync: (accountId: string) => void;
  readonly onExtract: () => void;
}

const ALL_ACCOUNTS = "all";

function verdictText(verdict: BroadcastVerdict | null): string | null {
  if (verdict === null) return null;
  const signals = verdict.signals.length === 0 ? "无额外信号" : verdict.signals.join("、");
  if (verdict.kind === "broadcast") {
    return `这封邮件被判定为群发（${signals}）。群发任务不会自动进入待办，需要你逐条确认。`;
  }
  if (verdict.kind === "uncertain") {
    return `这封邮件的性质不确定（${signals}），抽取结果放在「待确认」区。`;
  }
  return null;
}

function avatarBackground(seed: string): string {
  const hue = hueFor(seed);
  return `linear-gradient(140deg, hsl(${hue + 6} 92% 70%), hsl(${hue} 80% 54%))`;
}

export function InboxPage({ mode, accounts, resyncToken, onSync, onExtract }: InboxPageProps) {
  const demoEmails = useMemo(() => createMockEmails(), []);
  const demoVerdicts = useMemo(() => createMockVerdicts(), []);

  const [search, setSearch] = useState("");
  const [accountFilter, setAccountFilter] = useState<string>(ALL_ACCOUNTS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [liveEmails, setLiveEmails] = useState<readonly RawEmail[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detail, setDetail] = useState<EmailDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  const accountLabel = (accountId: string): string => {
    const account = accounts.find((item) => item.id === accountId);
    return account?.label ?? "未知账号";
  };

  useEffect(() => {
    if (mode !== "live") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void api.emails
        .list({
          search: search.trim() === "" ? undefined : search.trim(),
          accountId: accountFilter === ALL_ACCOUNTS ? undefined : accountFilter,
          limit: 60,
        })
        .then((response) => {
          if (cancelled) return;
          setLiveEmails(response.items);
          setLoadError(null);
          setLoading(false);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setLoading(false);
          if (isApiError(error)) {
            setLoadError(error.message);
            return;
          }
          throw error;
        });
    }, 260);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mode, search, accountFilter, refreshToken, resyncToken]);

  const visibleEmails = useMemo(() => {
    if (mode !== "demo") return liveEmails;
    const query = search.trim().toLowerCase();
    return demoEmails.filter((email) => {
      if (accountFilter !== ALL_ACCOUNTS && email.accountId !== accountFilter) return false;
      if (query === "") return true;
      const haystack = `${email.subject} ${email.fromName ?? ""} ${email.fromEmail} ${email.bodyText}`;
      return haystack.toLowerCase().includes(query);
    });
  }, [mode, demoEmails, liveEmails, search, accountFilter]);

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }
    const fallback = visibleEmails.find((email) => email.id === selectedId);

    if (mode === "demo") {
      const email = fallback ?? demoEmails.find((item) => item.id === selectedId);
      if (email === undefined) {
        setDetail(null);
        return;
      }
      setDetail({ email, verdict: demoVerdicts[email.id] ?? null, listId: listIdOf(email) });
      return;
    }

    if (mode !== "live") return;
    let cancelled = false;
    setDetailLoading(true);
    void api.emails
      .get(selectedId)
      .then((result) => {
        if (cancelled) return;
        setDetail(result);
        setDetailLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDetailLoading(false);
        if (isApiError(error)) {
          if (fallback !== undefined) {
            setDetail({ email: fallback, verdict: null, listId: listIdOf(fallback) });
          }
          return;
        }
        throw error;
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, mode, visibleEmails, demoEmails, demoVerdicts]);

  const detailMatches = detail !== null && detail.email.id === selectedId;
  const selected = detailMatches ? detail.email : null;
  const verdict = detailMatches ? detail.verdict : null;
  const verdictMessage = verdictText(verdict);
  const hasFilter = search.trim() !== "" || accountFilter !== ALL_ACCOUNTS;

  const syncAccountId = accounts[0]?.id ?? null;

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
              className="btn btn--icon"
              title={syncAccountId === null ? "还没有邮箱账号" : "同步第一个已配置账号"}
              aria-label="同步邮箱"
              disabled={syncAccountId === null}
              onClick={() => {
                if (syncAccountId !== null) onSync(syncAccountId);
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
              {loading ? "加载中…" : `共 ${visibleEmails.length} 封`}
            </span>
          </div>
        </div>

        {loadError === null ? null : (
          <div className="test-result is-error" role="status">
            <Icon name="alert" size={14} />
            {loadError}
          </div>
        )}

        <div className="mail-list">
          {loading && visibleEmails.length === 0 ? (
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

          {!loading && visibleEmails.length === 0 ? (
            <EmptyState
              icon="inbox"
              title={hasFilter ? "没有匹配的邮件" : "收件箱还是空的"}
              text={
                hasFilter
                  ? "换个关键词，或切回「全部账号」再找找。"
                  : "在设置页添加邮箱账号后点同步，邮件会先做引文剥离，再抽取待办。"
              }
              action={
                hasFilter ? (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => {
                      setSearch("");
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
            {visibleEmails.map((email, index) => {
              const from = senderLabel(email.fromName, email.fromEmail);
              const broadcast = listIdOf(email) !== null;
              return (
                <button
                  key={email.id}
                  type="button"
                  className={clsx("mail-item", email.id === selectedId && "is-active")}
                  style={{ animationDelay: `${index * 40}ms` }}
                  onClick={() => {
                    setSelectedId(email.id);
                    setDetailLoading(true);
                  }}
                >
                  <div className="avatar" style={{ background: avatarBackground(from) }}>
                    {initials(from)}
                  </div>
                  <div className="mail-item-main">
                    <div className="mail-item-top">
                      <span className="mail-from">{from}</span>
                      <span className="mail-time">{formatMailTime(email.sentAt)}</span>
                    </div>
                    <span className="mail-subject">{email.subject}</span>
                    <span className="mail-snippet">{snippet(email.bodyText, 110)}</span>
                    <span className="mail-tags">
                      {broadcast ? (
                        <span className="chip chip--iris">
                          <Icon name="megaphone" size={10} />
                          群发
                        </span>
                      ) : null}
                      {email.hasAttachments ? (
                        <span className="chip">
                          <Icon name="paperclip" size={10} />
                          附件
                        </span>
                      ) : null}
                      <span className="chip">{accountLabel(email.accountId)}</span>
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </GlassCard>

      <GlassCard className="mail-detail" flush={false}>
        {selected === null ? (
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
                title="选一封邮件看正文"
                text="引文与签名已在同步时剥离，这里只显示这封邮件本身的内容；群发邮件会额外标出判定依据。"
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
                <span className="chip">{accountLabel(selected.accountId)}</span>
                {listIdOf(selected) === null ? null : <span className="chip chip--iris">群发</span>}
                {selected.hasAttachments ? (
                  <span className="chip">
                    <Icon name="paperclip" size={10} />
                    含附件
                  </span>
                ) : null}
                <span className="inbox-count">{formatFullDate(selected.sentAt)}</span>
              </div>
              <h2 className="mail-detail-subject">{selected.subject}</h2>
              <div className="mail-detail-meta">
                <span>
                  发件人 <strong>{senderLabel(selected.fromName, selected.fromEmail)}</strong> ·{" "}
                  {selected.fromEmail}
                </span>
                <span>
                  收件人 <strong>{selected.to.join("、")}</strong>
                </span>
                {selected.cc.length === 0 ? null : <span>抄送 {selected.cc.join("、")}</span>}
              </div>
            </div>

            <div className="mail-detail-scroll">
              {verdictMessage === null ? null : (
                <div className={clsx("verdict", verdict?.kind === "uncertain" && "is-warning")}>
                  <span className="verdict-icon">
                    <Icon name="megaphone" size={14} />
                  </span>
                  <span>{verdictMessage}</span>
                </div>
              )}
              <div className="mail-body">{selected.bodyText}</div>
            </div>
          </>
        )}
      </GlassCard>
    </div>
  );
}
