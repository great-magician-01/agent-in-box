/* eslint-disable react-hooks/set-state-in-effect -- bootstrap snapshots load from the persistent backend */
import { useCallback, useEffect, useRef, useState } from "react";
import type { BootstrapState, DesktopBridge } from "@agent-in-box/protocol";
import { api } from "./api";
import { formatBytes } from "./format";

const STAGE_LABELS: Record<BootstrapState["stage"], string> = {
  not_started: "尚未准备执行环境",
  preferences_saved: "设置已保存",
  validating_model: "正在验证模型",
  checking_host: "正在检查电脑运行条件",
  preparing_runtime: "正在准备虚拟机运行组件",
  preparing_image: "正在下载并校验工作镜像",
  creating_default_vm: "正在创建默认工作环境",
  provisioning_guest: "正在初始化工作环境",
  creating_default_workspace: "正在准备默认工作区",
  verifying_execution: "正在验证执行环境",
  execution_ready: "执行环境已就绪",
};

export function BootstrapMonitor({ bridge }: { bridge: DesktopBridge | null }) {
  const [state, setState] = useState<BootstrapState | null>(null);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const runtimeAttempted = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setState(await api.bootstrap());
    } catch {
      // The global connection/error surface already handles a disconnected API.
    }
  }, []);

  const start = useCallback(async () => {
    setBusy(true);
    setLocalError(null);
    runtimeAttempted.current = false;
    try {
      setState(await api.startBootstrap());
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const autostart = window.localStorage.getItem("agent-in-box:bootstrap-autostart") === "1";
    if (autostart) {
      window.localStorage.removeItem("agent-in-box:bootstrap-autostart");
      void start();
    } else {
      void refresh();
    }
  }, [refresh, start]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (state?.status !== "execution_ready") void refresh();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [refresh, state?.status]);

  useEffect(() => {
    if (
      !bridge ||
      state?.requiredAction !== "install_runtime" ||
      state.status !== "waiting_user_action" ||
      runtimeAttempted.current
    ) {
      return;
    }
    runtimeAttempted.current = true;
    setBusy(true);
    setLocalError(null);
    void bridge.vm
      .installQemu()
      .then(() => api.retryBootstrap())
      .then(setState)
      .catch((error: unknown) => {
        setLocalError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setBusy(false));
  }, [bridge, state]);

  if (!state || state.status === "execution_ready") return null;

  const needsModel = state.requiredAction === "configure_model";
  const needsVirtualization = state.requiredAction === "enable_virtualization";
  const canRetry =
    state.status === "retryable_failed" ||
    state.status === "blocked" ||
    state.status === "cancelled" ||
    state.status === "waiting_user_action";
  const downloaded =
    typeof state.progress.downloadedBytes === "number" ? state.progress.downloadedBytes : null;
  const total =
    typeof state.progress.totalBytes === "number" && state.progress.totalBytes > 0
      ? state.progress.totalBytes
      : null;
  const progressText =
    downloaded !== null && total !== null
      ? `已下载 ${formatBytes(downloaded)} / ${formatBytes(total)}`
      : typeof state.progress.message === "string"
        ? state.progress.message
        : null;
  const message = localError ?? state.error?.message ?? progressText;

  return (
    <section className={`bootstrap-banner ${state.status}`} aria-live="polite">
      <div className="bootstrap-summary">
        <span className="bootstrap-indicator" aria-hidden="true" />
        <div>
          <strong>{STAGE_LABELS[state.stage]}</strong>
          <p className="muted small">
            {state.status === "not_started"
              ? "自动准备默认工作环境；聊天不受影响。"
              : state.conversationReady
                ? "现在可以正常对话，任务会等待执行环境就绪。"
                : "完成模型配置后即可开始对话。"}
          </p>
        </div>
      </div>
      {message && <p className="bootstrap-message">{message}</p>}
      <div className="bootstrap-actions">
        {state.status === "not_started" && (
          <button type="button" className="primary" onClick={() => void start()} disabled={busy}>
            自动准备执行环境
          </button>
        )}
        {canRetry && (
          <button type="button" className="secondary" onClick={() => void start()} disabled={busy}>
            {busy ? "正在处理…" : "重试"}
          </button>
        )}
        {needsModel && (
          <button
            type="button"
            className="primary"
            onClick={() => {
              window.location.hash = "#/settings";
            }}
          >
            打开模型设置
          </button>
        )}
        {needsVirtualization && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              window.location.hash = "#/settings";
            }}
          >
            查看环境要求
          </button>
        )}
        {state.status === "running" && (
          <button
            type="button"
            className="link-button"
            disabled={busy}
            onClick={() => void api.cancelBootstrap().then(setState)}
          >
            取消后台准备
          </button>
        )}
      </div>
    </section>
  );
}
