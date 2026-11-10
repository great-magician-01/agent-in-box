/* eslint-disable react-hooks/set-state-in-effect -- initial data fetch effects intentionally set loading/result state */
import { useCallback, useEffect, useState } from "react";
import type {
  HealthResponse,
  OnboardingCompleteResult,
  OnboardingState,
  RuntimeInfo,
} from "@agent-in-box/protocol";
import { api } from "./api";
import { Dashboard, type RestartRequest } from "./Dashboard";
import { useDesktop } from "./desktop";
import { CONTROL_PLANE_STATE_LABELS, formatDate } from "./format";
import { OnboardingWizard } from "./OnboardingWizard";

type Connection =
  | { state: "loading" }
  | { state: "online"; health: HealthResponse }
  | { state: "offline"; message: string };

interface PendingRestart {
  targetRoot: string;
  reason: string;
  previousStartedAt: string;
}

export function App(): React.JSX.Element {
  const { bridge, status: desktopStatus, error: desktopError } = useDesktop();
  const [connection, setConnection] = useState<Connection>({ state: "loading" });
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [pendingRestart, setPendingRestart] = useState<PendingRestart | null>(null);
  const [restartBusy, setRestartBusy] = useState(false);
  const [restartMessage, setRestartMessage] = useState<string | null>(null);

  const refresh = useCallback(async (silent = false): Promise<HealthResponse | null> => {
    if (!silent) {
      setConnection((current) => (current.state === "online" ? current : { state: "loading" }));
    }
    try {
      const health = await api.health();
      const [nextOnboarding, nextRuntime] = await Promise.all([api.onboarding(), api.runtime()]);
      setConnection({ state: "online", health });
      setOnboarding(nextOnboarding);
      setRuntime(nextRuntime);
      setPendingRestart((current) =>
        current && health.startedAt !== current.previousStartedAt ? null : current,
      );
      return health;
    } catch (error) {
      setConnection({ state: "offline", message: errorMessage(error) });
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (desktopStatus?.controlPlane.state === "running") {
      void refresh(true);
    }
  }, [desktopStatus?.controlPlane.state, refresh]);

  useEffect(() => {
    if (!onboarding?.restartRequired || pendingRestart) {
      return;
    }
    setPendingRestart({
      targetRoot: onboarding.configuredDataRoot ?? onboarding.dataRoot,
      reason: `配置已指向 ${
        onboarding.configuredDataRoot ?? onboarding.dataRoot
      }，但当前本地服务仍在使用 ${onboarding.dataRoot}。需要重启后才能完成切换。`,
      previousStartedAt: connection.state === "online" ? connection.health.startedAt : "",
    });
  }, [onboarding, pendingRestart, connection]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (connection.state === "offline") {
        void refresh(true);
        return;
      }
      if (pendingRestart) {
        void api
          .health()
          .then((health) => {
            if (health.startedAt !== pendingRestart.previousStartedAt) {
              setPendingRestart(null);
              setRestartMessage(null);
              void refresh(true);
            }
          })
          .catch(() => undefined);
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [connection.state, pendingRestart, refresh]);

  const completed = useCallback(
    async (result: OnboardingCompleteResult) => {
      setOnboarding(result.state);
      if (!result.restartRequired) {
        await refresh(true);
        return;
      }
      const previousStartedAt = connection.state === "online" ? connection.health.startedAt : "";
      setPendingRestart({
        targetRoot: result.storageMigration?.to ?? result.state.dataRoot,
        reason:
          result.storageMigration !== null
            ? `数据已迁移到 ${result.storageMigration.to}。本地服务必须重启后才能使用新目录。`
            : "本地服务需要重启才能应用新的存储位置。",
        previousStartedAt,
      });
      setRestartMessage(null);
      if (bridge) {
        setRestartBusy(true);
        try {
          await bridge.app.restartControlPlane();
        } catch (error) {
          setRestartMessage(errorMessage(error));
        } finally {
          setRestartBusy(false);
        }
      }
    },
    [bridge, connection, refresh],
  );

  const restartRequired = useCallback(
    (request: RestartRequest) => {
      const previousStartedAt = connection.state === "online" ? connection.health.startedAt : "";
      setPendingRestart({
        targetRoot: request.targetRoot,
        reason: request.reason,
        previousStartedAt,
      });
      setRestartMessage(null);
      if (bridge) {
        setRestartBusy(true);
        void bridge.app
          .restartControlPlane()
          .catch((error: unknown) => setRestartMessage(errorMessage(error)))
          .finally(() => setRestartBusy(false));
      }
    },
    [bridge, connection],
  );

  async function retryControlPlane(): Promise<void> {
    setRestartMessage(null);
    if (bridge) {
      setRestartBusy(true);
      try {
        await bridge.app.restartControlPlane();
      } catch (error) {
        setRestartMessage(errorMessage(error));
      } finally {
        setRestartBusy(false);
      }
    }
    await refresh(true);
  }

  const online = connection.state === "online" ? connection.health : null;
  const statusLabel =
    connection.state === "online"
      ? `本地服务在线 · ${connection.health.protocolVersion}`
      : connection.state === "offline"
        ? "本地服务离线"
        : "正在连接本地服务";

  return (
    <main className="shell">
      <header className="header">
        <div>
          <p className="eyebrow">LOCAL-FIRST AI COMPUTER</p>
          <h1>Agent-in-Box</h1>
          <p className="subtitle">
            在 Windows 宿主机上运行 Linux VM，由本机 Worker 接管受控桌面任务。
            首次启动先完成环境、存储和安全设置。
          </p>
          <div className="top-badges">
            <span className="badge">{bridge ? "桌面应用" : "本地 Web"}</span>
            {desktopStatus && (
              <span className="badge">
                Electron {desktopStatus.version} · {desktopStatus.platform}/{desktopStatus.arch}
              </span>
            )}
            {!bridge && <span className="badge">模型凭据需在桌面应用中配置</span>}
          </div>
        </div>
        <div
          className={`status ${connection.state === "online" ? "online" : connection.state === "offline" ? "offline" : "checking"}`}
        >
          <span className="dot" />
          {statusLabel}
        </div>
      </header>

      {desktopStatus && (
        <div className="desktop-strip">
          <span>
            本地服务：{CONTROL_PLANE_STATE_LABELS[desktopStatus.controlPlane.state]}
            {desktopStatus.controlPlane.pid ? ` · pid ${desktopStatus.controlPlane.pid}` : ""}
          </span>
          <span className="muted">配置目录：{desktopStatus.configDirectory}</span>
          {desktopStatus.controlPlane.message && (
            <span className="muted">{desktopStatus.controlPlane.message}</span>
          )}
        </div>
      )}
      {desktopError && <div className="notice">桌面桥接异常：{desktopError}</div>}

      {pendingRestart ? (
        <section className="panel restart-panel">
          <p className="eyebrow">RESTART REQUIRED</p>
          <h2>需要重启本地服务</h2>
          <p className="muted">{pendingRestart.reason}</p>
          <p className="muted small">新数据目录：{pendingRestart.targetRoot}</p>
          {restartMessage && <div className="notice">{restartMessage}</div>}
          <div className="action-row">
            {bridge ? (
              <button
                type="button"
                className="primary"
                disabled={restartBusy}
                onClick={() => void retryControlPlane()}
              >
                {restartBusy ? "正在重启…" : "重新启动本地服务"}
              </button>
            ) : (
              <>
                <code className="command">pnpm --filter @agent-in-box/control-plane start</code>
                <button type="button" className="primary" onClick={() => void retryControlPlane()}>
                  我已重启，重新连接
                </button>
              </>
            )}
            {bridge && (
              <button
                type="button"
                className="secondary"
                onClick={() => void bridge.app.openLogs()}
              >
                打开日志目录
              </button>
            )}
          </div>
          <p className="muted small">
            重启后如果仍停留在本页，请检查控制平面日志；旧数据目录会保留，不会自动删除。
          </p>
        </section>
      ) : connection.state === "offline" ? (
        <section className="notice offline-panel">
          <strong>无法连接本地控制平面。</strong>
          <span>{connection.message}</span>
          {desktopStatus?.controlPlane.message && <span>{desktopStatus.controlPlane.message}</span>}
          <div className="action-row">
            <button type="button" className="primary" onClick={() => void retryControlPlane()}>
              {bridge ? "重新启动本地服务" : "重试连接"}
            </button>
            {bridge && (
              <button
                type="button"
                className="secondary"
                onClick={() => void bridge.app.openLogs()}
              >
                打开日志目录
              </button>
            )}
          </div>
          {!bridge && <code>pnpm --filter @agent-in-box/control-plane dev</code>}
        </section>
      ) : connection.state === "loading" ? (
        <section className="panel loading-panel">
          <span className="spinner" aria-hidden="true" />
          <div>
            <h2>正在连接本地服务</h2>
            <p className="muted">
              {desktopStatus?.controlPlane.message ??
                "正在检查控制平面健康状态、首次启动配置和存储目录。"}
            </p>
          </div>
        </section>
      ) : onboarding && runtime && online ? (
        onboarding.required ? (
          <OnboardingWizard
            initialState={onboarding}
            bridge={bridge}
            onCompleted={(result) => void completed(result)}
          />
        ) : (
          <Dashboard
            onboarding={onboarding}
            runtime={runtime}
            health={online}
            bridge={bridge}
            controlPlaneState={desktopStatus?.controlPlane.state ?? "running"}
            onChanged={async () => {
              await refresh(true);
            }}
            onRestartRequired={restartRequired}
          />
        )
      ) : (
        <section className="panel loading-panel">
          <span className="spinner" aria-hidden="true" />
          <div>
            <h2>正在读取本地配置</h2>
            <p className="muted">控制平面已连接，正在加载首次启动状态。</p>
          </div>
        </section>
      )}

      <footer className="footer">
        <span>所有密钥只保存在系统安全存储中，不写入普通配置、日志或 VM。</span>
        <span>
          {online ? `控制平面启动于 ${formatDate(online.startedAt)}` : "本页面不连接模型。"}
        </span>
      </footer>
    </main>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
