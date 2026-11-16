/* eslint-disable react-hooks/set-state-in-effect -- runtime status loads from the desktop bridge */
import { useCallback, useEffect, useState } from "react";
import type { DesktopBridge, HostInspectionReport, VmRuntimeStatus } from "@agent-in-box/protocol";
import { chooseDirectory } from "./desktop";
import { VmSetupGuidance } from "./VmSetupGuidance";

interface VmRuntimeSettingsProps {
  bridge: DesktopBridge | null;
  host: HostInspectionReport | null;
  onRefreshHost?: (() => Promise<void>) | undefined;
}

const STATE_LABELS: Record<VmRuntimeStatus["state"], string> = {
  unavailable: "不可用",
  stopped: "已停止",
  starting: "启动中",
  running: "运行中",
  error: "异常",
};

const QEMU_LABELS: Record<VmRuntimeStatus["qemu"]["state"], string> = {
  missing: "未安装",
  managed: "应用托管",
  custom: "自定义路径",
  system: "系统安装",
  invalid: "路径无效",
};

export function VmRuntimeSettings({
  bridge,
  host,
  onRefreshHost,
}: VmRuntimeSettingsProps): React.JSX.Element {
  const [status, setStatus] = useState<VmRuntimeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!bridge) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await bridge.vm.status());
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [bridge]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(operation: () => Promise<VmRuntimeStatus>, success: string): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setStatus(await operation());
      setMessage(success);
    } catch (cause) {
      setError(errorMessage(cause));
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function chooseQemu(): Promise<void> {
    if (!bridge) return;
    const directory = await chooseDirectory(bridge, { title: "选择包含 QEMU 的 bin 目录" });
    if (!directory) return;
    await run(() => bridge.vm.setQemuPath(directory), "已切换 QEMU 路径并重启 VM 运行组件");
  }

  return (
    <section className="panel" aria-labelledby="vm-runtime-title">
      <div className="panel-heading">
        <div>
          <h2 id="vm-runtime-title">VM 运行环境</h2>
          <p className="muted small">自动准备遇到问题时可在这里检查；大多数用户无需修改。</p>
        </div>
        <button
          type="button"
          className="secondary"
          onClick={() => void Promise.all([load(), onRefreshHost?.()])}
          disabled={busy}
        >
          重新检查
        </button>
      </div>
      {!bridge ? (
        <p className="muted small">
          浏览器模式不能管理桌面端 VM 运行组件；请使用 Windows 桌面应用。
        </p>
      ) : (
        <>
          <p className="muted small">
            应用会自动下载并校验所需组件，再启动后台服务。组件不随安装包捆绑，首次准备需要联网。
          </p>
          {host?.ready ? (
            <div className="validation-box ok">
              <strong>电脑运行条件检查通过</strong>
              <span className="muted small">虚拟化、内存和磁盘检查均满足当前要求。</span>
            </div>
          ) : (
            <VmSetupGuidance host={host} />
          )}
          {error && <div className="notice">{error}</div>}
          {message && <div className="validation-box ok">{message}</div>}
          {status ? (
            <details className="runtime-advanced">
              <summary>查看组件路径与进程详情</summary>
              <dl className="runtime-facts">
                <div>
                  <dt>Supervisor</dt>
                  <dd>
                    {STATE_LABELS[status.state]}
                    {status.pid ? ` · pid ${status.pid}` : ""}
                  </dd>
                </div>
                <div>
                  <dt>QEMU</dt>
                  <dd>
                    {QEMU_LABELS[status.qemu.state]}
                    {status.qemu.version ? ` · ${status.qemu.version}` : ""}
                  </dd>
                </div>
                <div>
                  <dt>QEMU 路径</dt>
                  <dd>
                    <code>{status.qemu.path ?? "—"}</code>
                  </dd>
                </div>
                <div>
                  <dt>托管目录</dt>
                  <dd>
                    <code>{status.qemu.managedRoot ?? "—"}</code>
                  </dd>
                </div>
              </dl>
            </details>
          ) : (
            <p className="muted small">正在读取 VM 运行组件状态…</p>
          )}
          {status?.message && <p className="muted small">{status.message}</p>}
          {status?.lastError && <p className="error-line">{status.lastError}</p>}
          {status?.qemu.message && <p className="muted small">{status.qemu.message}</p>}
          <div className="action-row">
            <button
              type="button"
              className="primary"
              disabled={busy || status?.qemu.state === "managed"}
              onClick={() =>
                run(() => bridge.vm.installQemu(), "QEMU 已安装并校验，VM 运行组件已重启")
              }
            >
              {busy
                ? "处理中…"
                : status?.qemu.state === "managed"
                  ? "已安装托管 QEMU"
                  : "自动下载并安装 VM 组件"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void chooseQemu()}
            >
              已有安装？手动选择目录
            </button>
            {status?.qemu.state === "custom" && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  run(() => bridge.vm.setQemuPath(null), "已恢复为托管/系统 QEMU 检测")
                }
              >
                清除自定义路径
              </button>
            )}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => run(() => bridge.vm.restartSupervisor(), "VM Supervisor 已重启")}
            >
              重启后台服务
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
