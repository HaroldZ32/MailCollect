import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import clsx from "clsx";
import type { SyncProgress } from "@mailcollect/shared";
import type { PageId } from "./components/Sidebar";
import { Sidebar } from "./components/Sidebar";
import { Icon } from "./components/Icon";
import { GlassCard } from "./components/GlassCard";
import { EmptyState } from "./components/EmptyState";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { DeviceCodeDialog } from "./components/DeviceCodeDialog";
import { InboxPage } from "./pages/InboxPage";
import { TasksPage } from "./pages/TasksPage";
import { TimelinePage } from "./pages/TimelinePage";
import { SettingsPage } from "./pages/SettingsPage";
import { RulesPage } from "./pages/RulesPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { useMailData } from "./lib/useMailData";

/**
 * 壳内的全部页面。导航仍是 App 的 state（不引入 router）；
 * 其中 rules / onboarding 是 v1.1 新增入口，Sidebar 的可见条目由 ui-mail (T35) 在其写域内补充。
 */
export type ShellPage = PageId | "rules" | "onboarding";

interface PageMeta {
  readonly eyebrow: string;
  readonly title: string;
  readonly subtitle: string;
}

const SYNC_PHASE_LABEL: Record<SyncProgress["phase"], string> = {
  connect: "连接中",
  fetch: "拉取中",
  store: "写入中",
  extract: "抽取中",
  done: "完成",
  error: "失败",
};

const PAGE_META: Record<ShellPage, PageMeta> = {
  inbox: {
    eyebrow: "Inbox",
    title: "收件箱",
    subtitle: "引文与签名已剥离 · 群发单独标记 · 点开看正文",
  },
  tasks: {
    eyebrow: "Tasks",
    title: "待办",
    subtitle: "点名给我的才自动入库，群发与不确定的等你确认",
  },
  timeline: {
    eyebrow: "Timeline",
    title: "时间线",
    subtitle: "拖拽改期、拖手柄改时长，到期任务是一个可拖动的到期点",
  },
  rules: {
    eyebrow: "Rules",
    title: "规则",
    subtitle: "条件树（与 / 或 / 非、括号）决定每封邮件进入哪个分类，未命中记为「未分类」",
  },
  settings: {
    eyebrow: "Settings",
    title: "设置",
    subtitle: "档案、邮箱账号与 LLM 供应商",
  },
  onboarding: {
    eyebrow: "Setup",
    title: "初始化",
    subtitle: "三步向导：用户档案 · 邮箱账号（IMAP / POP3 / Graph / Exchange）· LLM 供应商",
  },
};

interface PanelSlotProps {
  readonly id: ShellPage;
  readonly active: boolean;
  readonly mounted: boolean;
  readonly children: ReactNode;
}

/**
 * 面板槽：首次访问才挂载，之后一直保留（keep-alive）。
 * `display: contents` 让激活面板的 DOM 布局与原条件渲染完全一致，
 * 非激活面板用 `display: none` 隐藏——切面板不卸载子树，面板内状态与滚动位置得以保留。
 */
function PanelSlot({ id, active, mounted, children }: PanelSlotProps) {
  if (!mounted) return null;
  return (
    <div
      data-panel-slot={id}
      data-active={active ? "true" : "false"}
      style={{ display: active ? "contents" : "none" }}
    >
      {children}
    </div>
  );
}

export function App() {
  const data = useMailData();
  const [page, setPage] = useState<ShellPage>("inbox");
  // 访问过的页面集合：只增不减，保证每个面板首次访问后不再卸载。
  const [visited, setVisited] = useState<ReadonlySet<ShellPage>>(() => new Set<ShellPage>(["inbox"]));
  const meta = PAGE_META[page];

  const navigate = useCallback((next: ShellPage) => {
    setPage(next);
    setVisited((previous) => (previous.has(next) ? previous : new Set(previous).add(next)));
  }, []);

  const goInbox = useCallback(() => {
    navigate("inbox");
  }, [navigate]);

  // Sidebar 的 PageId 由 ui-mail (T35) 的契约扩展出 rules/onboarding 入口；
  // 扩展前该值不会命中任何 nav 条目（无高亮），扩展后自然生效。
  const sidebarPage = page as PageId;
  const syncLabel =
    data.syncProgress === null
      ? null
      : data.syncProgress.fetched > 0
        ? `同步 · ${SYNC_PHASE_LABEL[data.syncProgress.phase]} ${data.syncProgress.stored}/${data.syncProgress.fetched}`
        : `同步 · ${SYNC_PHASE_LABEL[data.syncProgress.phase]}`;
  const extractLabel =
    data.extractProgress === null
      ? null
      : `抽取 ${data.extractProgress.done}/${data.extractProgress.total}`;
  const deviceLogin = data.deviceLogin;
  const deviceLoginAccount =
    deviceLogin === null ? null : data.accounts.find((account) => account.id === deviceLogin.accountId) ?? null;
  const deviceLoginLabel = deviceLoginAccount?.label ?? deviceLogin?.accountId ?? "";

  // 未完成初始化时在壳层给一个可见入口（C3：侧栏未配置提示的 App 侧接线；
  // 可见的侧栏条目由 ui-mail (T35) 在 Sidebar.tsx 内落地）。
  // 该入口读 useMailData 的 onboarding 资源；向导完成后由 ONBOARDING_CHANGED_EVENT
  // 触发缓存失效 + 重拉（见 useMailData.ts），这里无需轮询或整页刷新（T61）。
  const onboarding = data.onboarding;
  const needsOnboarding =
    data.mode === "live" && onboarding !== null && !onboarding.completed && !onboarding.skipped;

  if (data.mode === "loading") {
    return (
      <div className="boot">
        <div className="boot-mark">
          <Icon name="mail" size={26} />
        </div>
        <div className="boot-text">正在连接本地服务…</div>
      </div>
    );
  }

  if (data.mode === "offline") {
    return (
      <div className="boot">
        <GlassCard className="boot-card">
          <EmptyState
            icon="server"
            tone="iris"
            title="本地服务未连接"
            text={data.error ?? "无法连接 apps/server。启动服务后重试，或先用演示数据浏览界面。"}
            action={
              <div className="form-actions" style={{ justifyContent: "center" }}>
                <button type="button" className="btn" onClick={data.retry}>
                  <Icon name="refresh" size={14} />
                  重新连接
                </button>
                <button type="button" className="btn btn--primary" onClick={data.enterDemo}>
                  <Icon name="spark" size={14} />
                  使用演示数据
                </button>
              </div>
            }
          />
        </GlassCard>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        page={sidebarPage}
        candidateCount={data.counts.candidate}
        profileName={data.profile?.displayName ?? "未设置档案"}
        profileMeta={
          data.profile === null
            ? "去设置页填写档案"
            : `${data.profile.timezone} · ${data.profile.emails[0] ?? "未填邮箱"}`
        }
        onNavigate={navigate}
      />

      <main className="app-main">
        <header className="topbar">
          <div className="topbar-titles">
            <div className="eyebrow">{meta.eyebrow}</div>
            <h1 className="page-title">{meta.title}</h1>
            <p className="page-subtitle">{meta.subtitle}</p>
          </div>
          <div className="topbar-actions">
            {data.mode === "live" && syncLabel !== null ? (
              <span className="chip chip--accent live-chip">
                <Icon name="refresh" size={11} />
                {syncLabel}
              </span>
            ) : null}
            {data.mode === "live" && extractLabel !== null ? (
              <span className="chip chip--iris live-chip">
                <Icon name="spark" size={11} />
                {extractLabel}
              </span>
            ) : null}
            <span className={clsx("mode-pill", data.mode === "demo" && "is-demo", data.mode === "live" && "is-live")}>
              <span className={clsx("conn-dot", data.mode === "demo" && "is-demo")} />
              {data.mode === "demo" ? "演示数据" : "已连接服务"}
            </span>
            {needsOnboarding && page !== "onboarding" ? (
              <button
                type="button"
                className="btn btn--primary btn--sm"
                title="打开初始化向导"
                onClick={() => navigate("onboarding")}
              >
                <Icon name="spark" size={14} />
                初始化未完成 · 去完成
              </button>
            ) : null}
            {page === "rules" ? null : (
              <button
                type="button"
                className="btn btn--quiet btn--sm"
                title="规则与分类"
                onClick={() => navigate("rules")}
              >
                <Icon name="bolt" size={14} />
                规则
              </button>
            )}
            {page === "settings" ? null : (
              <button type="button" className="btn btn--icon" aria-label="刷新数据" title="刷新数据" onClick={data.refresh}>
                <Icon name="refresh" size={16} />
              </button>
            )}
          </div>
        </header>

        {data.streamError === null ? null : (
          <div className="stream-banner" role="alert">
            <Icon name="alert" size={14} />
            <span className="stream-banner-text">{data.streamError}</span>
            <button
              type="button"
              className="stream-banner-close"
              aria-label="关闭实时错误提示"
              onClick={data.dismissStreamError}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        )}

        <div className="page-scroll">
          <div className="page">
            <PanelSlot id="inbox" active={page === "inbox"} mounted={visited.has("inbox")}>
              <ErrorBoundary scope="panel" title="收件箱" onHome={goInbox}>
                <InboxPage
                  mode={data.mode}
                  accounts={data.accounts}
                  resyncToken={data.resyncToken}
                  onSync={(accountId) => {
                    void data.syncAccount(accountId);
                  }}
                  onExtract={() => {
                    void data.runExtract();
                  }}
                />
              </ErrorBoundary>
            </PanelSlot>

            <PanelSlot id="tasks" active={page === "tasks"} mounted={visited.has("tasks")}>
              <ErrorBoundary scope="panel" title="待办" onHome={goInbox}>
                <TasksPage
                  mode={data.mode}
                  tasks={data.tasks}
                  counts={data.counts}
                  onBulkDecision={data.bulkDecision}
                  onComplete={(taskId) => {
                    void data.updateTask(taskId, { status: "done" });
                  }}
                  onOpenTimeline={() => navigate("timeline")}
                />
              </ErrorBoundary>
            </PanelSlot>

            <PanelSlot id="timeline" active={page === "timeline"} mounted={visited.has("timeline")}>
              <ErrorBoundary scope="panel" title="时间线" onHome={goInbox}>
                <TimelinePage
                  tasks={data.tasks}
                  onTaskTimeChange={(taskId, patch) => data.updateTask(taskId, patch)}
                />
              </ErrorBoundary>
            </PanelSlot>

            <PanelSlot id="rules" active={page === "rules"} mounted={visited.has("rules")}>
              <ErrorBoundary scope="panel" title="规则" onHome={goInbox}>
                <RulesPage />
              </ErrorBoundary>
            </PanelSlot>

            <PanelSlot id="settings" active={page === "settings"} mounted={visited.has("settings")}>
              <ErrorBoundary scope="panel" title="设置" onHome={goInbox}>
                <SettingsPage
                  mode={data.mode}
                  profile={data.profile}
                  accounts={data.accounts}
                  llmConfigs={data.llmConfigs}
                  onSaveProfile={data.saveProfile}
                  onAddAccount={data.addAccount}
                  onRemoveAccount={data.removeAccount}
                  onVerifyAccount={data.verifyAccount}
                  onSaveLlm={data.saveLlmConfig}
                  onSetDefaultLlm={data.setDefaultLlmConfig}
                  onRemoveLlm={data.removeLlmConfig}
                  onTestLlm={data.testLlm}
                  onRetry={data.retry}
                  canLoginDevice={data.canLoginDevice}
                  graphLoggedIn={data.graphLoggedIn}
                  onLoginAccount={data.loginAccount}
                />
              </ErrorBoundary>
            </PanelSlot>

            <PanelSlot id="onboarding" active={page === "onboarding"} mounted={visited.has("onboarding")}>
              <ErrorBoundary scope="panel" title="初始化" onHome={goInbox}>
                <OnboardingPage />
              </ErrorBoundary>
            </PanelSlot>
          </div>
        </div>
      </main>

      {deviceLogin === null ? null : (
        <DeviceCodeDialog
          state={deviceLogin}
          accountLabel={deviceLoginLabel}
          onClose={data.dismissDeviceLogin}
          onRetry={() => {
            void data.retryDeviceLogin();
          }}
        />
      )}

      {data.notice === null ? null : (
        <div
          className={clsx("toast", data.notice.kind === "error" && "toast--error")}
          role="status"
          onClick={data.dismissNotice}
        >
          <span className="toast-dot" />
          {data.notice.text}
        </div>
      )}
    </div>
  );
}
