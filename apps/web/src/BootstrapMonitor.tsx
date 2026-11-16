/* eslint-disable react-hooks/set-state-in-effect -- bootstrap snapshots load from the persistent backend */
import { useCallback, useEffect, useRef, useState } from "react";
import type { BootstrapState, DesktopBridge, HostInspectionReport } from "@agent-in-box/protocol";
import { Check } from "lucide-react";
import { api } from "./api";
import { formatBytes } from "./format";
import { VmSetupGuidance } from "./VmSetupGuidance";

const STAGE_LABELS: Record<BootstrapState["stage"], string> = {
  not_started: "尚未开始",
  preferences_saved: "设置已保存",
  validating_model: "验证模型",
  checking_host: "检查电脑",
  preparing_runtime: "准备 VM 组件",
  preparing_image: "下载 Linux 镜像",
  creating_default_vm: "创建默认 VM",
  provisioning_guest: "初始化 VM 与 Agent",
  creating_default_workspace: "准备工作区",
  verifying_execution: "验证执行环境",
  execution_ready: "已就绪",
};

const SETUP_STEPS = [
  { id: "host", label: "检查电脑", stages: ["checking_host"] },
  { id: "runtime", label: "准备 VM 组件", stages: ["preparing_runtime"] },
  { id: "image", label: "下载 Linux 镜像", stages: ["preparing_image"] },
  {
    id: "vm",
    label: "创建并初始化",
    stages: [
      "creating_default_vm",
      "provisioning_guest",
      "creating_default_workspace",
      "verifying_execution",
    ],
  },
] as const;

export function BootstrapMonitor({
  bridge,
  showNotStarted = true,
}: {
  bridge: DesktopBridge | null;
  showNotStarted?: boolean;
}) {
  const [state, setState] = useState<BootstrapState | null>(null);
  const [host, setHost] = useState<HostInspectionReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const runtimeAttempted = useRef(false);
  const refreshInFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      setState(await api.bootstrap());
    } catch {
      // The global connection/error surface already handles a disconnected API.
    } finally {
      refreshInFlight.current = false;
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
    const active = state?.status === "running" || state?.status === "waiting_user_action";
    if (!active) return;
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [refresh, state?.status]);

  useEffect(() => {
    if (state?.requiredAction !== "enable_virtualization") return;
    let active = true;
    void api
      .hostInspection()
      .then((report) => {
        if (active) setHost(report);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [state?.requiredAction, state?.updatedAt]);

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

  if (
    !state ||
    state.status === "execution_ready" ||
    (state.status === "not_started" && !showNotStarted)
  ) {
    return null;
  }

  const needsModel = state.requiredAction === "configure_model";
  const needsVirtualization = state.requiredAction === "enable_virtualization";
  const needsRuntime = state.requiredAction === "install_runtime";
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
  const downloadPercent =
    downloaded !== null && total !== null
      ? Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)))
      : null;
  const progressText =
    downloaded !== null && total !== null
      ? `已下载 ${formatBytes(downloaded)} / ${formatBytes(total)} · ${downloadPercent}%`
      : typeof state.progress.message === "string"
        ? state.progress.message
        : null;
  const message = localError ?? state.error?.message;
  const currentStep = needsVirtualization
    ? 0
    : needsRuntime
      ? 1
      : Math.max(
          0,
          SETUP_STEPS.findIndex((step) => (step.stages as readonly string[]).includes(state.stage)),
        );
  const title = needsModel
    ? "先完成模型设置"
    : needsVirtualization
      ? "电脑还需要完成一项设置"
      : needsRuntime
        ? busy
          ? "正在自动安装 VM 组件"
          : "VM 组件尚未准备好"
        : state.status === "not_started"
          ? "一键准备 VM 执行环境"
          : state.status === "cancelled"
            ? "VM 准备已取消"
            : state.status === "retryable_failed" || state.status === "blocked"
              ? "VM 准备暂时停下来了"
              : "正在准备 VM，你可以先聊天";
  const description = needsModel
    ? "模型可用后才能初始化 Agent。保存模型不会丢失当前进度。"
    : needsVirtualization
      ? "这不是应用下载失败。按下面的系统步骤处理后，即可从这里继续。"
      : needsRuntime
        ? busy
          ? "应用正在下载并校验组件，无需另行安装 QEMU。请保持网络连接。"
          : "可以点击重试自动安装；已有 QEMU 的用户也可以到运行环境中手动选择。"
        : state.status === "not_started"
          ? "自动完成组件安装、Linux 镜像下载、VM 创建和 Agent 初始化，无需逐项配置。"
          : state.conversationReady
            ? "对话不受影响；执行任务时会自动等待环境就绪。已完成的步骤不会重复执行。"
            : "完成模型配置后即可开始对话。";

  return (
    <section className={`bootstrap-banner setup-guide ${state.status}`} aria-live="polite">
      <div className="bootstrap-heading">
        <span className="bootstrap-vm-icon" aria-hidden="true">
          VM
        </span>
        <div className="bootstrap-title">
          <span className="setup-kicker">虚拟机执行环境</span>
          <strong>{title}</strong>
          <p>{description}</p>
        </div>
        <span className={`setup-status ${state.status}`}>
          {busy
            ? "自动处理中"
            : state.status === "running"
              ? "后台准备中"
              : STAGE_LABELS[state.stage]}
        </span>
      </div>

      {!needsModel && (
        <ol className="bootstrap-steps" aria-label="VM 自动准备进度">
          {SETUP_STEPS.map((step, index) => {
            const done = index < currentStep || state.executionReady;
            const active = index === currentStep && !done;
            return (
              <li
                key={step.id}
                className={`${done ? "done" : ""}${active ? " active" : ""}${
                  active && (state.status === "blocked" || state.status === "retryable_failed")
                    ? " needs-action"
                    : ""
                }`}
                aria-current={active ? "step" : undefined}
              >
                <span className="bootstrap-step-index" aria-hidden="true">
                  {done ? <Check /> : index + 1}
                </span>
                <span>{step.label}</span>
              </li>
            );
          })}
        </ol>
      )}

      {state.status === "running" && (
        <div className="bootstrap-progress">
          <div
            className="progress-track"
            role="progressbar"
            aria-label="当前 VM 准备进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={downloadPercent ?? undefined}
          >
            <span
              className={downloadPercent === null ? "indeterminate" : undefined}
              style={downloadPercent !== null ? { width: `${downloadPercent}%` } : undefined}
            />
          </div>
          <span className="muted small">
            {progressText ?? `${STAGE_LABELS[state.stage]}… 你可以继续使用对话。`}
          </span>
        </div>
      )}

      {needsVirtualization && <VmSetupGuidance host={host} />}
      {message && !needsVirtualization && (
        <div className="bootstrap-error" role="alert">
          <strong>{localError ? "自动处理没有完成" : "停在了这一步"}</strong>
          <span>{message}</span>
        </div>
      )}

      <div className="bootstrap-footer">
        <div className="bootstrap-actions">
          {state.status === "not_started" && (
            <button type="button" className="primary" onClick={() => void start()} disabled={busy}>
              {busy ? "正在启动…" : "一键准备默认 VM"}
            </button>
          )}
          {canRetry && !needsModel && (
            <button type="button" className="primary" onClick={() => void start()} disabled={busy}>
              {busy ? "正在处理…" : needsVirtualization ? "我已处理，重新检查" : "从此步骤重试"}
            </button>
          )}
          {needsModel && (
            <button
              type="button"
              className="primary"
              onClick={() => {
                window.location.hash = "#/settings/models";
              }}
            >
              去设置模型
            </button>
          )}
          {needsVirtualization && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                window.location.hash = "#/settings/runtime";
              }}
            >
              查看完整环境检查
            </button>
          )}
          {(needsRuntime || state.status === "retryable_failed") && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                window.location.hash = "#/settings/runtime";
              }}
            >
              手动管理运行组件
            </button>
          )}
          {state.status === "running" && (
            <button
              type="button"
              className="link-button"
              disabled={busy}
              onClick={() => void api.cancelBootstrap().then(setState)}
            >
              暂停后台准备
            </button>
          )}
        </div>
        {(state.error || state.progress.message) && (
          <details className="bootstrap-diagnostics">
            <summary>技术详情</summary>
            <dl>
              <div>
                <dt>当前阶段</dt>
                <dd>{state.stage}</dd>
              </div>
              {state.error?.code && (
                <div>
                  <dt>错误代码</dt>
                  <dd>
                    <code>{state.error.code}</code>
                  </dd>
                </div>
              )}
              {state.progress.message && (
                <div>
                  <dt>进度信息</dt>
                  <dd>{state.progress.message}</dd>
                </div>
              )}
            </dl>
          </details>
        )}
      </div>
    </section>
  );
}
