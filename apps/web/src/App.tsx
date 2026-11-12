/* eslint-disable react-hooks/set-state-in-effect -- initial data fetch effects intentionally set loading/result state */
import { useCallback, useEffect, useState } from "react";
import type {
  DesktopAppStatus,
  DesktopBridge,
  HealthResponse,
  LocalAuthSessionView,
  OnboardingCompleteResult,
  OnboardingState,
  RuntimeInfo,
} from "@agent-in-box/protocol";
import { api, UNAUTHORIZED_EVENT } from "./api";
import { Dashboard, type RestartRequest } from "./Dashboard";
import { useDesktop } from "./desktop";
import { CONTROL_PLANE_STATE_LABELS, formatDate } from "./format";
import { LoginScreen } from "./LoginScreen";
import { NotificationCenter, useNotificationCenter } from "./NotificationCenter";
import { ObserverSidebar, type ObserverTab } from "./ObserverSidebar";
import { OnboardingWizard } from "./OnboardingWizard";
import { WorkerConversation } from "./WorkerConversation";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

export type AppView =
  "overview" | "session" | "projects" | "tasks" | "vms" | "archive" | "notifications" | "settings";

const NAV_ITEMS: Array<{ id: AppView; label: string; hint: string }> = [
  { id: "overview", label: "总览", hint: "本机状态与快速摘要" },
  { id: "session", label: "主会话", hint: "Router 主会话与结构化工具" },
  { id: "projects", label: "项目", hint: "项目、绑定、Worker 与文件投递" },
  { id: "tasks", label: "任务", hint: "持久任务看板与 Trace" },
  { id: "vms", label: "虚拟机", hint: "VM 生命周期、控制台与快照" },
  { id: "archive", label: "归档", hint: "Worker 归档注册表与搜索" },
  { id: "notifications", label: "通知", hint: "统一通知中心" },
  { id: "settings", label: "设置", hint: "存储、资源、桌面与更新" },
];

function viewFromHash(): AppView {
  const value = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  return NAV_ITEMS.some((item) => item.id === value) ? (value as AppView) : "overview";
}

type AuthState =
  | { state: "checking" }
  | { state: "anonymous"; info: LocalAuthSessionView }
  | { state: "authenticated"; info: LocalAuthSessionView }
  | { state: "unreachable"; message: string };

interface PendingRestart {
  targetRoot: string;
  reason: string;
  previousStartedAt: string;
}

export function App(): React.JSX.Element {
  const { bridge, status: desktopStatus, error: desktopError } = useDesktop();
  const [auth, setAuth] = useState<AuthState>({ state: "checking" });

  const checkAuth = useCallback(async (): Promise<void> => {
    try {
      const info = await api.authSession();
      setAuth(
        info.state === "authenticated"
          ? { state: "authenticated", info }
          : { state: "anonymous", info },
      );
    } catch (error) {
      setAuth({
        state: "unreachable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    function onUnauthorized(): void {
      if (bridge) {
        // A rotated/revoked session in Electron is recovered by reloading:
        // Main re-reads the current access key and injects a new cookie.
        try {
          const last = Number(window.sessionStorage.getItem("agent-in-box:auth-reload") ?? 0);
          if (Date.now() - last > 10_000) {
            window.sessionStorage.setItem("agent-in-box:auth-reload", String(Date.now()));
            window.location.reload();
            return;
          }
        } catch {
          // Fall through to the normal unlock screen.
        }
      }
      void api
        .authSession()
        .then((info) => setAuth({ state: "anonymous", info }))
        .catch(() => setAuth({ state: "checking" }));
    }
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [bridge]);

  useEffect(() => {
    if (auth.state !== "unreachable") return;
    const timer = window.setInterval(() => void checkAuth(), 3000);
    return () => window.clearInterval(timer);
  }, [auth.state, checkAuth]);

  useEffect(() => {
    if (auth.state !== "anonymous" || !bridge) return;
    let cancelled = false;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (attempts > 60) {
        window.clearInterval(timer);
        return;
      }
      void api
        .authSession()
        .then((info) => {
          if (!cancelled && info.state === "authenticated") {
            setAuth({ state: "authenticated", info });
            window.clearInterval(timer);
          }
        })
        .catch(() => undefined);
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [auth.state, bridge]);

  if (auth.state === "checking") {
    return (
      <main className="shell" id="main-content">
        <section className="panel loading-panel" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <div>
            <h1>正在验证本机会话</h1>
            <p className="muted">正在检查本地控制平面和本机访问密钥。</p>
          </div>
        </section>
      </main>
    );
  }

  if (auth.state === "unreachable") {
    return (
      <main className="shell" id="main-content">
        <header className="header">
          <div>
            <p className="eyebrow">LOCAL-FIRST AI COMPUTER</p>
            <h1>Agent-in-Box</h1>
          </div>
        </header>
        <section className="notice offline-panel" role="alert">
          <strong>无法连接本地控制平面。</strong>
          <span>{auth.message}</span>
          <button type="button" className="primary" onClick={() => void checkAuth()}>
            重试连接
          </button>
        </section>
      </main>
    );
  }

  if (auth.state === "anonymous") {
    return (
      <main className="shell login-shell" id="main-content">
        <header className="header">
          <div>
            <p className="eyebrow">LOCAL-FIRST AI COMPUTER</p>
            <h1>Agent-in-Box</h1>
            <p className="subtitle">
              本地控制平面已在线。解锁后才能读取项目、任务、VM、机器人和设置。
            </p>
          </div>
        </header>
        <LoginScreen
          info={auth.info}
          bridge={bridge}
          onAuthenticated={(info) => setAuth({ state: "authenticated", info })}
        />
      </main>
    );
  }

  return (
    <AuthenticatedApp
      bridge={bridge}
      desktopStatus={desktopStatus}
      desktopError={desktopError}
      authInfo={auth.info}
      onLogout={() => setAuth({ state: "anonymous", info: auth.info })}
    />
  );
}

interface AuthenticatedAppProps {
  bridge: DesktopBridge | null;
  desktopStatus: DesktopAppStatus | null;
  desktopError: string | null;
  authInfo: LocalAuthSessionView;
  onLogout(): void;
}

function AuthenticatedApp({
  bridge,
  desktopStatus,
  desktopError,
  authInfo,
  onLogout,
}: AuthenticatedAppProps): React.JSX.Element {
  const [connection, setConnection] = useState<
    | { state: "loading" }
    | { state: "online"; health: HealthResponse }
    | { state: "offline"; message: string }
  >({ state: "loading" });
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [pendingRestart, setPendingRestart] = useState<PendingRestart | null>(null);
  const [restartBusy, setRestartBusy] = useState(false);
  const [restartMessage, setRestartMessage] = useState<string | null>(null);
  const [view, setView] = useState<AppView>(() => viewFromHash());
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [selectedWorker, setSelectedWorker] = useState<{
    workerId: string;
    projectId: string;
    vmId: string;
  } | null>(null);
  const [observerOpen, setObserverOpen] = useState(false);
  const [observerTab, setObserverTab] = useState<ObserverTab>("vm");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 900,
  );
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  const navigate = useCallback((next: string) => {
    const target = NAV_ITEMS.some((item) => item.id === next) ? (next as AppView) : "overview";
    setView(target);
    if (target !== "session") setSelectedWorker(null);
    if (target !== "projects") setSelectedProjectId(null);
    if (window.location.hash !== `#/${target}`) {
      window.history.replaceState(null, "", `#/${target}`);
    }
  }, []);

  const selectWorker = useCallback((workerId: string, projectId: string, vmId: string) => {
    setSelectedWorker({ workerId, projectId, vmId });
    setView("session");
    if (window.location.hash !== "#/session") {
      window.history.replaceState(null, "", "#/session");
    }
  }, []);

  const selectRouter = useCallback(() => {
    setSelectedWorker(null);
    setView("session");
    if (window.location.hash !== "#/session") {
      window.history.replaceState(null, "", "#/session");
    }
  }, []);

  const selectProject = useCallback((projectId: string) => {
    setSelectedWorker(null);
    setSelectedProjectId(projectId);
    setView("projects");
    if (window.location.hash !== "#/projects") {
      window.history.replaceState(null, "", "#/projects");
    }
  }, []);

  useEffect(() => {
    function onHashChange(): void {
      const next = viewFromHash();
      setView(next);
      if (next !== "session") setSelectedWorker(null);
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (!bridge) return;
    return bridge.app.onNavigate((next) => navigate(next));
  }, [bridge, navigate]);

  const notifications = useNotificationCenter(bridge, () => navigate("notifications"));

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

  async function lockUi(): Promise<void> {
    if (logoutBusy) return;
    setLogoutBusy(true);
    try {
      await api.logout();
      onLogout();
    } finally {
      setLogoutBusy(false);
    }
  }

  const online = connection.state === "online" ? connection.health : null;
  const statusLabel =
    connection.state === "online"
      ? `本地服务在线 · ${connection.health.protocolVersion}`
      : connection.state === "offline"
        ? "本地服务离线"
        : "正在连接本地服务";

  const workspaceVisible = Boolean(onboarding && runtime && online && !onboarding.required);
  const openWorkerFromBoard = (projectId: string, workerId: string): void => {
    void api
      .worker(workerId)
      .then((view) => selectWorker(workerId, projectId, view.worker.vmId))
      .catch(() => {
        setView("projects");
      });
  };
  const onWorkspaceChanged = (): void => {
    setWorkspaceRevision((value) => value + 1);
    void refresh(true);
  };

  return (
    <div
      className={`shell app-shell${workspaceVisible ? "" : " workspace-hidden"}${
        sidebarCollapsed ? " sidebar-collapsed" : ""
      }${observerOpen ? " observer-open" : ""}`}
    >
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        跳到主要内容
      </a>
      {workspaceVisible && (
        <WorkspaceSidebar
          view={view}
          selectedWorkerId={selectedWorker?.workerId ?? null}
          observerOpen={observerOpen}
          unreadCount={notifications.view?.unreadCount ?? 0}
          revision={workspaceRevision}
          onSelectView={navigate}
          onSelectProject={selectProject}
          onSelectWorker={(workerId, projectId, vmId) => {
            selectWorker(workerId, projectId, vmId);
            setObserverTab("worker");
          }}
          onSelectRouter={selectRouter}
          onToggleObserver={() => setObserverOpen((current) => !current)}
          onCollapse={() => setSidebarCollapsed(true)}
        />
      )}
      <div className="app-workspace">
        <header className="header app-header">
          <div className="brand">
            <p className="eyebrow">LOCAL-FIRST AI COMPUTER</p>
            <h1>Agent-in-Box</h1>
            <div className="top-badges">
              <span className="badge">{bridge ? "桌面应用" : "本地 Web"}</span>
              {desktopStatus && (
                <span className="badge">
                  Electron {desktopStatus.version} · {desktopStatus.platform}/{desktopStatus.arch}
                </span>
              )}
              <span className="badge">{authInfo.user?.displayName ?? "本机管理员"}</span>
            </div>
          </div>
          <div className="header-actions">
            {workspaceVisible && sidebarCollapsed && (
              <button
                type="button"
                className="secondary icon-button"
                title="展开左栏"
                onClick={() => setSidebarCollapsed(false)}
              >
                ☰
              </button>
            )}
            {workspaceVisible && (
              <button
                type="button"
                className={observerOpen ? "secondary active" : "secondary"}
                aria-pressed={observerOpen}
                onClick={() => setObserverOpen((current) => !current)}
              >
                观察栏
              </button>
            )}
            <button
              type="button"
              className="bell-button"
              aria-label={`通知中心，${notifications.view?.unreadCount ?? 0} 条未读`}
              onClick={() => navigate("notifications")}
            >
              <span aria-hidden="true">🔔</span>
              {(notifications.view?.unreadCount ?? 0) > 0 && (
                <span className="bell-count">{notifications.view?.unreadCount}</span>
              )}
            </button>
            <div
              className={`status ${connection.state === "online" ? "online" : connection.state === "offline" ? "offline" : "checking"}`}
              role="status"
            >
              <span className="dot" aria-hidden="true" />
              {statusLabel}
            </div>
            {!bridge && (
              <button
                type="button"
                className="secondary"
                onClick={() => void lockUi()}
                disabled={logoutBusy}
              >
                {logoutBusy ? "正在锁定…" : "锁定界面"}
              </button>
            )}
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

        <main id="main-content" tabIndex={-1} className="app-main">
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
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void retryControlPlane()}
                    >
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
            <section className="notice offline-panel" role="alert">
              <strong>无法连接本地控制平面。</strong>
              <span>{connection.message}</span>
              {desktopStatus?.controlPlane.message && (
                <span>{desktopStatus.controlPlane.message}</span>
              )}
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
            <section className="panel loading-panel" aria-live="polite">
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
            ) : view === "notifications" ? (
              <NotificationCenter state={notifications} onNavigate={navigate} />
            ) : selectedWorker ? (
              <section className="panel worker-main" aria-labelledby="worker-main-title">
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">WORKER SESSION</p>
                    <h2 id="worker-main-title">Worker {selectedWorker.workerId.slice(0, 8)}</h2>
                  </div>
                  <div className="action-row">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setObserverTab("vm");
                        setObserverOpen(true);
                      }}
                    >
                      观察 VM
                    </button>
                    <button type="button" className="secondary" onClick={selectRouter}>
                      返回主会话
                    </button>
                  </div>
                </div>
                <WorkerConversation
                  workerId={selectedWorker.workerId}
                  revision={workspaceRevision}
                  onChanged={onWorkspaceChanged}
                />
              </section>
            ) : (
              <Dashboard
                view={view}
                onboarding={onboarding}
                runtime={runtime}
                health={online}
                bridge={bridge}
                authInfo={authInfo}
                controlPlaneState={desktopStatus?.controlPlane.state ?? "running"}
                onNavigate={navigate}
                onChanged={async () => {
                  await refresh(true);
                  setWorkspaceRevision((value) => value + 1);
                }}
                onRestartRequired={restartRequired}
                onOpenWorker={openWorkerFromBoard}
                initialProjectId={selectedProjectId}
              />
            )
          ) : (
            <section className="panel loading-panel" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              <div>
                <h2>正在读取本地配置</h2>
                <p className="muted">控制平面已连接，正在加载首次启动状态。</p>
              </div>
            </section>
          )}
        </main>

        <footer className="footer">
          <span>所有密钥只保存在系统安全存储中，不写入普通配置、日志或 VM。</span>
          <span>
            {online && view !== "notifications"
              ? `控制平面启动于 ${formatDate(online.startedAt)}`
              : "本页面不连接模型。"}
          </span>
        </footer>
      </div>
      {workspaceVisible && (
        <ObserverSidebar
          open={observerOpen}
          tab={observerTab}
          workerId={selectedWorker?.workerId ?? null}
          preferredVmId={selectedWorker?.vmId ?? null}
          revision={workspaceRevision}
          onTabChange={setObserverTab}
          onClose={() => setObserverOpen(false)}
          onChanged={onWorkspaceChanged}
        />
      )}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
