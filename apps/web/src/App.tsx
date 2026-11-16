/* eslint-disable react-hooks/set-state-in-effect -- initial data fetch effects intentionally set loading/result state */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Bell, Lock, PanelLeft, PanelRight } from "lucide-react";
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
import type { RestartRequest } from "./Dashboard";
import { useDesktop } from "./desktop";
import { CONTROL_PLANE_STATE_LABELS } from "./format";
import { LoginScreen } from "./LoginScreen";
import { NotificationCenter, useNotificationCenter } from "./NotificationCenter";
import { OnboardingWizard } from "./OnboardingWizard";
import { BootstrapMonitor } from "./BootstrapMonitor";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import type { ObserverTab } from "./ObserverSidebar";
import { useMediaQuery } from "./useMediaQuery";
import {
  DEFAULT_ROUTE,
  parseRoute,
  routeFor,
  routeHash,
  type AppRoute,
  type AppView,
  type SettingsSection,
} from "./routes";

export type { AppView } from "./routes";

const Dashboard = lazy(() =>
  import("./Dashboard").then((module) => ({ default: module.Dashboard })),
);
const ObserverSidebar = lazy(() =>
  import("./ObserverSidebar").then((module) => ({ default: module.ObserverSidebar })),
);
const WorkerConversation = lazy(() =>
  import("./WorkerConversation").then((module) => ({ default: module.WorkerConversation })),
);

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
          <div className="brand">
            <img className="brand-logo" src="/logo.svg" alt="" width={30} height={30} />
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
          <div className="brand">
            <img className="brand-logo" src="/logo.svg" alt="" width={30} height={30} />
            <h1>Agent-in-Box</h1>
            <p className="subtitle">本地控制平面已在线，解锁后继续使用。</p>
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
  const [route, setRoute] = useState<AppRoute>(() => parseRoute(window.location.hash));
  const view = route.view;
  const compactShell = useMediaQuery("(max-width: 900px)");
  const observerOverlay = useMediaQuery("(max-width: 1280px)");
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [selectedWorkerContext, setSelectedWorkerContext] = useState<{
    workerId: string;
    projectId: string;
    vmId: string | null;
    projectName: string | null;
    conversationTitle: string | null;
  } | null>(null);
  const [observerOpen, setObserverOpen] = useState(false);
  const [observerTab, setObserverTab] = useState<ObserverTab>("activity");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => typeof window !== "undefined" && window.innerWidth <= 900,
  );
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const observerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sidebarTriggerRef = useRef<HTMLButtonElement | null>(null);

  const closeObserver = useCallback(() => {
    setObserverOpen(false);
    requestAnimationFrame(() => observerTriggerRef.current?.focus());
  }, []);

  const collapseSidebar = useCallback(() => {
    setSidebarCollapsed(true);
    requestAnimationFrame(() => sidebarTriggerRef.current?.focus());
  }, []);

  const commitRoute = useCallback(
    (next: AppRoute, replace = false) => {
      setRoute(next);
      if (compactShell) setSidebarCollapsed(true);
      const hash = routeHash(next);
      if (window.location.hash !== hash) {
        window.history[replace ? "replaceState" : "pushState"](null, "", hash);
      }
    },
    [compactShell],
  );

  const navigate = useCallback(
    (next: string, entityId?: string) => {
      const target = NAV_ITEMS.some((item) => item.id === next) ? (next as AppView) : "session";
      commitRoute(routeFor(target, entityId));
    },
    [commitRoute],
  );

  const selectWorker = useCallback(
    (workerId: string, projectId: string, vmId: string) => {
      setSelectedWorkerContext({
        workerId,
        projectId,
        vmId,
        projectName: null,
        conversationTitle: null,
      });
      commitRoute(routeFor("session", workerId));
    },
    [commitRoute],
  );

  const selectRouter = useCallback(() => {
    commitRoute(routeFor("session"));
  }, [commitRoute]);

  const selectProject = useCallback(
    (projectId: string) => {
      commitRoute(routeFor("projects", projectId));
    },
    [commitRoute],
  );

  const selectSettingsSection = useCallback(
    (settingsSection: SettingsSection) => {
      commitRoute({ ...routeFor("settings"), settingsSection });
    },
    [commitRoute],
  );

  useEffect(() => {
    function onLocationChange(): void {
      setRoute(parseRoute(window.location.hash));
      if (window.innerWidth <= 900) setSidebarCollapsed(true);
    }
    window.addEventListener("hashchange", onLocationChange);
    window.addEventListener("popstate", onLocationChange);
    return () => {
      window.removeEventListener("hashchange", onLocationChange);
      window.removeEventListener("popstate", onLocationChange);
    };
  }, []);

  useEffect(() => {
    if (compactShell) setSidebarCollapsed(true);
  }, [compactShell]);

  useEffect(() => {
    if (!bridge) return;
    // The desktop app always opens on the session view; a hash left over from
    // a previous run must not resurrect an old page.
    if (window.location.hash !== "#/session") {
      window.history.replaceState(null, "", "#/session");
      setRoute(DEFAULT_ROUTE);
      setSelectedWorkerContext(null);
    }
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.app.onNavigate((next) => navigate(next));
  }, [bridge, navigate]);

  useEffect(() => {
    const workerId = route.workerId;
    if (!workerId) {
      setSelectedWorkerContext(null);
      return;
    }
    let active = true;
    setSelectedWorkerContext((current) => (current?.workerId === workerId ? current : null));
    void api
      .worker(workerId)
      .then(async (workerView) => {
        if (!active) return;
        const { projectId, vmId, conversationId } = workerView.worker;
        setSelectedWorkerContext({
          workerId,
          projectId,
          vmId,
          projectName: null,
          conversationTitle: null,
        });
        const project = await api.project(projectId);
        if (!active) return;
        setSelectedWorkerContext({
          workerId,
          projectId,
          vmId,
          projectName: project.project.name,
          conversationTitle:
            project.conversations.find((item) => item.id === conversationId)?.title || "新会话",
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [route.workerId, workspaceRevision]);

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
  const workspaceVisible = Boolean(onboarding && runtime && online && !onboarding.required);
  const currentTitle =
    view === "session"
      ? (selectedWorkerContext?.conversationTitle ?? (route.workerId ? "项目会话" : "主会话"))
      : (NAV_ITEMS.find((item) => item.id === view)?.label ?? "");
  const mobileSidebarOpen = compactShell && workspaceVisible && !sidebarCollapsed;
  const modalObserverOpen = observerOverlay && workspaceVisible && observerOpen;
  const openWorkerFromBoard = (projectId: string, workerId: string): void => {
    setSelectedWorkerContext({
      workerId,
      projectId,
      vmId: null,
      projectName: null,
      conversationTitle: null,
    });
    commitRoute(routeFor("session", workerId));
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
      {workspaceVisible && (!compactShell || !sidebarCollapsed) && (
        <WorkspaceSidebar
          view={view}
          selectedWorkerId={route.workerId}
          revision={workspaceRevision}
          modal={compactShell}
          onSelectView={navigate}
          onSelectProject={selectProject}
          onSelectWorker={(workerId, projectId, vmId) => {
            selectWorker(workerId, projectId, vmId);
            setObserverTab("activity");
          }}
          onSelectRouter={selectRouter}
          onCollapse={collapseSidebar}
        />
      )}
      {mobileSidebarOpen && (
        <button
          type="button"
          className="shell-backdrop workspace-backdrop"
          aria-label="关闭会话导航"
          onClick={collapseSidebar}
        />
      )}
      <div className="app-workspace" inert={mobileSidebarOpen || modalObserverOpen}>
        <header className="header app-header">
          <div className="app-header-leading">
            {workspaceVisible && sidebarCollapsed && (
              <button
                type="button"
                className="icon-button"
                ref={sidebarTriggerRef}
                title="展开侧栏"
                aria-label="展开侧栏"
                onClick={() => setSidebarCollapsed(false)}
              >
                <PanelLeft aria-hidden="true" />
              </button>
            )}
            <div className="app-title-group">
              <h1>{currentTitle}</h1>
              {view === "session" && selectedWorkerContext?.projectName && (
                <span>{selectedWorkerContext.projectName}</span>
              )}
            </div>
          </div>
          <div className="header-actions">
            {workspaceVisible && (
              <button
                type="button"
                className="header-tool"
                aria-label={`通知中心，${notifications.view?.unreadCount ?? 0} 条未读`}
                onClick={() => navigate("notifications")}
              >
                <Bell aria-hidden="true" />
                <span className="header-tool-label">通知</span>
                {(notifications.view?.unreadCount ?? 0) > 0 && (
                  <span className="bell-count">{notifications.view?.unreadCount}</span>
                )}
              </button>
            )}
            {workspaceVisible && (
              <button
                type="button"
                className={observerOpen ? "header-tool active" : "header-tool"}
                ref={observerTriggerRef}
                aria-pressed={observerOpen}
                aria-label="观察执行详情"
                aria-expanded={observerOpen}
                aria-controls="observer-sidebar"
                onClick={() => {
                  if (observerOpen) closeObserver();
                  else setObserverOpen(true);
                }}
              >
                <PanelRight aria-hidden="true" />
                <span className="header-tool-label">观察</span>
              </button>
            )}
            {!bridge && (
              <button
                type="button"
                className="header-tool"
                aria-label={logoutBusy ? "正在锁定" : "锁定当前会话"}
                onClick={() => void lockUi()}
                disabled={logoutBusy}
              >
                <Lock aria-hidden="true" />
                <span className="header-tool-label">{logoutBusy ? "锁定中…" : "锁定"}</span>
              </button>
            )}
          </div>
        </header>

        {desktopStatus && desktopStatus.controlPlane.state !== "running" && (
          <div className="desktop-strip">
            <span>本地服务：{CONTROL_PLANE_STATE_LABELS[desktopStatus.controlPlane.state]}</span>
            {desktopStatus.controlPlane.message && (
              <span className="muted">{desktopStatus.controlPlane.message}</span>
            )}
          </div>
        )}
        {desktopError && <div className="notice">桌面桥接异常：{desktopError}</div>}

        <main
          id="main-content"
          tabIndex={-1}
          className={`app-main${view === "session" && workspaceVisible ? " session-active" : ""}`}
        >
          {pendingRestart ? (
            <section className="panel restart-panel">
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
            <Suspense
              fallback={
                <section className="panel loading-panel" aria-live="polite">
                  <span className="spinner" aria-hidden="true" />
                  <div>
                    <h2>正在加载工作区</h2>
                    <p className="muted">正在准备当前页面所需的组件。</p>
                  </div>
                </section>
              }
            >
              <>
                {!onboarding.required && ["session", "projects", "vms"].includes(view) && (
                  <BootstrapMonitor bridge={bridge} showNotStarted={view === "session"} />
                )}
                {onboarding.required ? (
                  <OnboardingWizard
                    initialState={onboarding}
                    bridge={bridge}
                    onCompleted={(result) => void completed(result)}
                  />
                ) : view === "notifications" ? (
                  <NotificationCenter state={notifications} onNavigate={navigate} />
                ) : route.workerId ? (
                  <section className="conversation-page worker-main" aria-label="项目会话">
                    <WorkerConversation
                      workerId={route.workerId}
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
                    initialProjectId={route.projectId}
                    focusTaskId={route.taskId}
                    settingsSection={route.settingsSection}
                    onSettingsSectionChange={selectSettingsSection}
                    onProjectSelected={selectProject}
                  />
                )}
              </>
            </Suspense>
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
      </div>
      {modalObserverOpen && (
        <button
          type="button"
          className="shell-backdrop observer-backdrop"
          aria-label="关闭观察栏"
          onClick={closeObserver}
        />
      )}
      {workspaceVisible && observerOpen && (
        <Suspense
          fallback={
            <aside className="observer-sidebar" aria-label="正在加载观察栏">
              <span className="spinner" aria-hidden="true" />
            </aside>
          }
        >
          <ObserverSidebar
            open={observerOpen}
            tab={observerTab}
            workerId={route.workerId}
            preferredVmId={selectedWorkerContext?.vmId ?? null}
            revision={workspaceRevision}
            modal={observerOverlay}
            onTabChange={setObserverTab}
            onClose={closeObserver}
            onChanged={onWorkspaceChanged}
          />
        </Suspense>
      )}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
