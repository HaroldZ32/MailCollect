import { useEffect, useState } from "react";
import clsx from "clsx";
import { Icon } from "./Icon";
import type { DeviceLoginState } from "../lib/useMailData";

export interface DeviceCodeDialogProps {
  readonly state: DeviceLoginState;
  readonly accountLabel: string;
  readonly onClose: () => void;
  readonly onRetry: () => void;
}

function formatRemaining(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function DeviceCodeDialog({ state, accountLabel, onClose, onRetry }: DeviceCodeDialogProps) {
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState<string | null>(null);

  const expiresAt = state.startedAt + state.expiresInSeconds * 1000;
  const remaining = state.expiresInSeconds <= 0 ? 0 : Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const expired = state.phase === "waiting" && remaining === 0;
  const userCode = state.userCode;
  const verificationUri = state.verificationUri;
  const hasCode = userCode !== null && verificationUri !== null;

  useEffect(() => {
    if (state.phase !== "waiting") return;
    const deadline = state.startedAt + state.expiresInSeconds * 1000;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= deadline) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [state.phase, state.startedAt, state.expiresInSeconds]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (copied === null) return;
    const timer = window.setTimeout(() => setCopied(null), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = (value: string, key: string): void => {
    if (navigator.clipboard === undefined) return;
    void navigator.clipboard.writeText(value).then(
      () => setCopied(key),
      (error: unknown) => {
        if (error instanceof DOMException) return;
        throw error;
      },
    );
  };

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div
        className="dialog-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="device-login-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <div className="dialog-icon">
            <Icon name="key" size={17} />
          </div>
          <div className="dialog-titles">
            <h2 className="dialog-title" id="device-login-title">
              登录 Microsoft
            </h2>
            <p className="dialog-sub">{accountLabel} · 设备码登录</p>
          </div>
          <button
            type="button"
            className="dialog-close"
            aria-label="关闭登录对话框"
            onClick={onClose}
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        {state.phase === "requesting" ? (
          <div className="dialog-loading">
            <span className="pulse-dot" />
            正在向 Microsoft 申请设备码…
          </div>
        ) : null}

        {hasCode ? (
          <>
            <div className="device-code-box">
              <span className="device-code-value">{userCode}</span>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => {
                  if (userCode !== null) copy(userCode, "code");
                }}
              >
                <Icon name={copied === "code" ? "check" : "key"} size={13} />
                {copied === "code" ? "已复制" : "复制"}
              </button>
            </div>

            <div className="device-link">
              <Icon name="link" size={13} />
              <a href={verificationUri ?? undefined} target="_blank" rel="noreferrer">
                {verificationUri}
              </a>
              <button
                type="button"
                className="btn btn--quiet btn--sm"
                onClick={() => {
                  if (verificationUri !== null) copy(verificationUri, "uri");
                }}
              >
                {copied === "uri" ? "已复制" : "复制链接"}
              </button>
            </div>

            {state.message === null ? null : <p className="device-message">{state.message}</p>}

            <div className="device-row">
              <span className={clsx("device-countdown", expired && "is-expired")}>
                <Icon name="clock" size={11} />
                {expired ? "验证码已过期" : `剩余 ${formatRemaining(remaining)}`}
              </span>
              {state.phase === "waiting" && !expired ? (
                <span className="device-waiting">
                  <span className="pulse-dot" />
                  已自动等待，完成后会自己刷新
                </span>
              ) : null}
            </div>
          </>
        ) : null}

        {state.phase === "failed" && state.error !== null ? (
          <div className="test-result is-error">
            <Icon name="alert" size={14} />
            <span>{state.error}</span>
          </div>
        ) : null}

        <div className="dialog-actions">
          {state.phase === "failed" || expired ? (
            <button type="button" className="btn btn--primary btn--sm" onClick={onRetry}>
              <Icon name="refresh" size={13} />
              重新发起
            </button>
          ) : null}
          <button type="button" className="btn btn--sm" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
