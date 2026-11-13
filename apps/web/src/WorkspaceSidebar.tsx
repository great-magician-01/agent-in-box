/* eslint-disable react-hooks/set-state-in-effect -- workspace snapshots refresh from server events */
import { useCallback, useEffect, useState } from "react";
import type { ProjectView, WorkerView } from "@agent-in-box/protocol";
import type { AppView } from "./App";
import { api, subscribeTaskEvents } from "./api";

interface WorkspaceSidebarProps {
  view: AppView;
  selectedWorkerId: string | null;
  observerOpen: boolean;
  unreadCount: number;
  revision: number;
  onSelectView(view: AppView): void;
  onSelectProject(projectId: string): void;
  onSelectWorker(workerId: string, projectId: string, vmId: string): void;
  onSelectRouter(): void;
  onToggleObserver(): void;
  onCollapse(): void;
}

const FOOTER_VIEWS: Array<{ id: AppView; label: string }> = [
  { id: "tasks", label: "任务" },
  { id: "vms", label: "虚拟机" },
  { id: "archive", label: "归档" },
  { id: "settings", label: "设置" },
];

export function WorkspaceSidebar({
  view,
  selectedWorkerId,
  observerOpen,
  unreadCount,
  revision,
  onSelectView,
  onSelectProject,
  onSelectWorker,
  onSelectRouter,
  onToggleObserver,
  onCollapse,
}: WorkspaceSidebarProps): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [workers, setWorkers] = useState<WorkerView[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [allProjects, nextWorkers] = await Promise.all([api.projects(true), api.workers()]);
      const nextProjects = allProjects.filter((item) => item.project.archivedAt === null);
      setProjects(nextProjects);
      setWorkers(nextWorkers);
      setExpanded((current) => {
        if (current.size > 0) return current;
        return new Set(nextProjects.slice(0, 3).map((item) => item.project.id));
      });
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revision]);

  useEffect(
    () =>
      subscribeTaskEvents(
        () => void load(),
        () => undefined,
      ),
    [load],
  );

  function toggleProject(projectId: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  return (
    <aside className="workspace-sidebar" aria-label="项目与会话导航">
      <div className="workspace-brand">
        <div>
          <h1>工作区</h1>
        </div>
        <button
          type="button"
          className="secondary icon-button"
          onClick={onCollapse}
          title="收起左栏"
        >
          ‹
        </button>
      </div>

      <button
        type="button"
        className={`workspace-primary ${view === "session" ? "active" : ""}`}
        onClick={onSelectRouter}
      >
        <span className="workspace-dot router" aria-hidden="true" />
        Router 主会话
      </button>

      <div className="workspace-nav-row">
        <button
          type="button"
          className={view === "overview" ? "active" : ""}
          onClick={() => onSelectView("overview")}
        >
          总览
        </button>
        <button
          type="button"
          className={view === "notifications" ? "active" : ""}
          onClick={() => onSelectView("notifications")}
        >
          通知{unreadCount > 0 ? ` ${unreadCount}` : ""}
        </button>
        <button
          type="button"
          className={observerOpen ? "active" : ""}
          onClick={onToggleObserver}
          title="打开或收起右侧观察栏"
        >
          观察
        </button>
      </div>

      {error && <div className="notice small">{error}</div>}

      <div className="workspace-projects">
        <div className="workspace-section-title">
          <span>项目</span>
          <button type="button" className="link-button" onClick={() => onSelectView("projects")}>
            管理
          </button>
        </div>
        {projects.length === 0 ? (
          <p className="muted small">尚无项目。打开“项目”创建并绑定 VM。</p>
        ) : (
          <ul className="workspace-project-list">
            {projects.map((item) => {
              const projectWorkers = workers.filter(
                (worker) => worker.worker.projectId === item.project.id,
              );
              const isExpanded = expanded.has(item.project.id);
              return (
                <li key={item.project.id}>
                  <button
                    type="button"
                    className={`workspace-project ${view === "projects" ? "active" : ""}`}
                    onClick={() => {
                      toggleProject(item.project.id);
                      onSelectProject(item.project.id);
                    }}
                  >
                    <span className="workspace-chevron" aria-hidden="true">
                      {isExpanded ? "▾" : "▸"}
                    </span>
                    <span className="workspace-project-name">{item.project.name}</span>
                    <span className="workspace-count">{projectWorkers.length}</span>
                  </button>
                  {isExpanded && (
                    <ul className="workspace-session-list">
                      {projectWorkers.length === 0 ? (
                        <li className="muted small">暂无 Worker 会话</li>
                      ) : (
                        projectWorkers.map((worker) => (
                          <li key={worker.worker.id}>
                            <button
                              type="button"
                              className={`workspace-session ${
                                selectedWorkerId === worker.worker.id ? "active" : ""
                              }`}
                              onClick={() =>
                                onSelectWorker(
                                  worker.worker.id,
                                  worker.worker.projectId,
                                  worker.worker.vmId,
                                )
                              }
                              title={`${worker.worker.status} · ${worker.worker.providerId ?? "默认模型"}`}
                            >
                              <span
                                className={`workspace-dot ${worker.worker.status}`}
                                aria-hidden="true"
                              />
                              <span>Worker {worker.worker.id.slice(0, 8)}</span>
                              <span className="workspace-status">{worker.worker.status}</span>
                            </button>
                          </li>
                        ))
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <nav className="workspace-footer" aria-label="其他视图">
        {FOOTER_VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={view === item.id ? "active" : ""}
            onClick={() => onSelectView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
    </aside>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
