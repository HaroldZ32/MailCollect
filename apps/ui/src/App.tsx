import { useState } from "react";
import clsx from "clsx";
import type { SyncProgress } from "@mailcollect/shared";
import type { PageId } from "./components/Sidebar";
import { Sidebar } from "./components/Sidebar";
import { Icon } from "./components/Icon";
import { GlassCard } from "./components/GlassCard";
import { EmptyState } from "./components/EmptyState";
import { DeviceCodeDialog } from "./components/DeviceCodeDialog";
import { InboxPage } from "./pages/InboxPage";
import { TasksPage } from "./pages/TasksPage";
import { TimelinePage } from "./pages/TimelinePage";
import { SettingsPage } from "./pages/SettingsPage";
import { useMailData } from "./lib/useMailData";

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

const PAGE_META: Record<PageId, PageMeta> = {
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
  settings: {
    eyebrow: "Settings",
    title: "设置",
    subtitle: "档案、邮箱账号与 LLM 供应商",
  },
};

export function App() {
  const data = useMailData();
  const [page, setPage] = useState<PageId>("inbox");
  const meta = PAGE_META[page];
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
        page={page}
        candidateCount={data.counts.candidate}
        profileName={data.profile?.displayName ?? "未设置档案"}
        profileMeta={
          data.profile === null
            ? "去设置页填写档案"
            : `${data.profile.timezone} · ${data.profile.emails[0] ?? "未填邮箱"}`
        }
        onNavigate={setPage}
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
            {page === "inbox" ? (
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
            ) : null}

            {page === "tasks" ? (
              <TasksPage
                mode={data.mode}
                tasks={data.tasks}
                counts={data.counts}
                onBulkDecision={data.bulkDecision}
                onComplete={(taskId) => {
                  void data.updateTask(taskId, { status: "done" });
                }}
                onOpenTimeline={() => setPage("timeline")}
              />
            ) : null}

            {page === "timeline" ? (
              <TimelinePage
                tasks={data.tasks}
                onTaskTimeChange={(taskId, patch) => data.updateTask(taskId, patch)}
              />
            ) : null}

            {page === "settings" ? (
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
            ) : null}
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
