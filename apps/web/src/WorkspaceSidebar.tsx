import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  ListChecks,
  Monitor,
  PanelLeftClose,
  Plus,
  Settings,
  type LucideIcon,
} from "lucide-react";
import type { ProjectView, WorkerView } from "@agent-in-box/protocol";
import type { AppView } from "./routes";
import { api, subscribeTaskEvents } from "./api";
import { useModalFocus } from "./useModalFocus";

interface WorkspaceSidebarProps {
  view: AppView;
  selectedWorkerId: string | null;
  revision: number;
  modal: boolean;
  onSelectView(view: AppView): void;
  onSelectProject(projectId: string): void;
  onSelectWorker(workerId: string, projectId: string, vmId: string): void;
  onSelectRouter(): void;
  onCollapse(): void;
}

const FOOTER_VIEWS: Array<{ id: AppView; label: string; icon: LucideIcon }> = [
  { id: "projects", label: "项目", icon: Folder },
  { id: "tasks", label: "任务", icon: ListChecks },
  { id: "vms", label: "虚拟机", icon: Monitor },
  { id: "settings", label: "设置", icon: Settings },
];

export function WorkspaceSidebar({
  view,
  selectedWorkerId,
  revision,
  modal,
  onSelectView,
  onSelectProject,
  onSelectWorker,
  onSelectRouter,
  onCollapse,
}: WorkspaceSidebarProps): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [workers, setWorkers] = useState<WorkerView[]>([]);
  const [conversationTitles, setConversationTitles] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const loadInFlight = useRef(false);
  const loadQueued = useRef(false);
  const sidebarRef = useModalFocus<HTMLElement>(modal, onCollapse);
  const newSessionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const newSessionMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!newSessionOpen) return;
    const frame = requestAnimationFrame(() =>
      newSessionMenuRef.current?.querySelector("button")?.focus(),
    );
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setNewSessionOpen(false);
      newSessionTriggerRef.current?.focus();
    }
    function onPointerDown(event: PointerEvent): void {
      const target = event.target instanceof Node ? event.target : null;
      if (
        newSessionMenuRef.current?.contains(target) ||
        newSessionTriggerRef.current?.contains(target)
      ) {
        return;
      }
      setNewSessionOpen(false);
    }
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [newSessionOpen]);

  const load = useCallback(async (): Promise<void> => {
    if (loadInFlight.current) {
      loadQueued.current = true;
      return;
    }
    loadInFlight.current = true;
    try {
      do {
        loadQueued.current = false;
        try {
          const [allProjects, nextWorkers] = await Promise.all([api.projects(true), api.workers()]);
          const nextProjects = allProjects.filter((item) => item.project.archivedAt === null);
          setProjects(nextProjects);
          setWorkers(nextWorkers.filter((item) => item.worker.archivedAt === null));
          setExpanded((current) => {
            if (current.size > 0) return current;
            return new Set(nextProjects.slice(0, 1).map((item) => item.project.id));
          });
          // Conversation names live on the project detail, not on WorkerRecord.
          const details = await Promise.all(
            nextProjects.map((item) => api.project(item.project.id).catch(() => null)),
          );
          const titles = new Map<string, string>();
          for (const detail of details) {
            for (const conversation of detail?.conversations ?? []) {
              titles.set(conversation.id, conversation.title || "新会话");
            }
          }
          setConversationTitles(titles);
          setError(null);
        } catch (cause) {
          setError(errorMessage(cause));
        }
      } while (loadQueued.current);
    } finally {
      loadInFlight.current = false;
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

  async function createWorkerFor(project: ProjectView): Promise<void> {
    const vmId = project.bindings[0]?.binding.vmId ?? null;
    if (!vmId) {
      setNewSessionOpen(false);
      onSelectProject(project.project.id);
      setError("先为项目绑定虚拟机，再创建会话。");
      return;
    }
    setCreatingFor(project.project.id);
    setError(null);
    try {
      const created = await api.createWorker({ projectId: project.project.id, vmId });
      setExpanded((current) => new Set(current).add(project.project.id));
      setNewSessionOpen(false);
      onSelectWorker(created.worker.id, project.project.id, vmId);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCreatingFor(null);
    }
  }

  return (
    <aside
      className="workspace-sidebar"
      aria-label="会话导航"
      id="workspace-sidebar"
      ref={sidebarRef}
      role={modal ? "dialog" : undefined}
      aria-modal={modal || undefined}
      tabIndex={modal ? -1 : undefined}
    >
      <div className="workspace-brand">
        <div className="brand">
          <img className="brand-logo" src="/logo.svg" alt="" width={24} height={24} />
          <div className="brand-name">Agent-in-Box</div>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onCollapse}
          title="收起侧栏"
          aria-label="收起侧栏"
          data-dialog-close
        >
          <PanelLeftClose aria-hidden="true" />
        </button>
      </div>

      <button
        type="button"
        className={`workspace-primary${newSessionOpen ? " active" : ""}`}
        aria-expanded={newSessionOpen}
        aria-controls="new-session-menu"
        ref={newSessionTriggerRef}
        onClick={() => setNewSessionOpen((current) => !current)}
      >
        <Plus aria-hidden="true" />
        新会话
      </button>
      {newSessionOpen && (
        <div className="new-session-menu" id="new-session-menu" ref={newSessionMenuRef}>
          <button
            type="button"
            onClick={() => {
              setNewSessionOpen(false);
              setError(null);
              onSelectRouter();
            }}
          >
            主会话
          </button>
          {projects.map((item) => (
            <button
              key={item.project.id}
              type="button"
              disabled={creatingFor === item.project.id}
              onClick={() => void createWorkerFor(item)}
            >
              {creatingFor === item.project.id ? "正在创建…" : item.project.name}
            </button>
          ))}
          {projects.length === 0 && (
            <button type="button" onClick={() => onSelectView("projects")}>
              先创建项目
            </button>
          )}
        </div>
      )}

      {error && <div className="notice small">{error}</div>}

      <div className="workspace-projects">
        <div className="workspace-section-title">
          <span>会话</span>
          <button type="button" className="link-button" onClick={() => onSelectView("projects")}>
            管理项目
          </button>
        </div>
        <button
          type="button"
          className={`workspace-session workspace-router-link${
            view === "session" && selectedWorkerId === null ? " active" : ""
          }`}
          aria-current={view === "session" && selectedWorkerId === null ? "page" : undefined}
          onClick={onSelectRouter}
        >
          <span>主会话</span>
        </button>
        {projects.length === 0 ? (
          <p className="muted small workspace-empty-hint">还没有项目会话</p>
        ) : (
          <ul className="workspace-project-list">
            {projects.map((item) => {
              const projectWorkers = workers.filter(
                (worker) => worker.worker.projectId === item.project.id,
              );
              const isExpanded = expanded.has(item.project.id);
              return (
                <li key={item.project.id}>
                  <div className="workspace-project-row">
                    <button
                      type="button"
                      className="workspace-project"
                      aria-expanded={isExpanded}
                      onClick={() => toggleProject(item.project.id)}
                    >
                      <span className="workspace-chevron" aria-hidden="true">
                        {isExpanded ? <ChevronDown /> : <ChevronRight />}
                      </span>
                      <span className="workspace-project-name">{item.project.name}</span>
                    </button>
                    <button
                      type="button"
                      className="workspace-add-session"
                      title="在此项目中新建会话"
                      aria-label={`在 ${item.project.name} 中新建会话`}
                      disabled={creatingFor === item.project.id}
                      onClick={() => void createWorkerFor(item)}
                    >
                      <Plus aria-hidden="true" />
                    </button>
                  </div>
                  {isExpanded && (
                    <ul className="workspace-session-list">
                      {projectWorkers.length === 0 ? (
                        <li className="muted small">暂无会话</li>
                      ) : (
                        projectWorkers.map((worker) => (
                          <li key={worker.worker.id}>
                            <button
                              type="button"
                              className={`workspace-session ${
                                selectedWorkerId === worker.worker.id ? "active" : ""
                              }`}
                              aria-current={
                                selectedWorkerId === worker.worker.id ? "page" : undefined
                              }
                              onClick={() =>
                                onSelectWorker(
                                  worker.worker.id,
                                  worker.worker.projectId,
                                  worker.worker.vmId,
                                )
                              }
                            >
                              {(worker.worker.status === "running" ||
                                worker.worker.status === "failed") && (
                                <span
                                  className={`workspace-dot ${worker.worker.status}`}
                                  aria-hidden="true"
                                />
                              )}
                              <span>
                                {conversationTitles.get(worker.worker.conversationId) ?? "新会话"}
                              </span>
                              {worker.worker.status === "running" && (
                                <span className="workspace-status">执行中</span>
                              )}
                              {worker.worker.status === "failed" && (
                                <span className="workspace-status error-line">异常</span>
                              )}
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

      <nav className="workspace-footer" aria-label="工作区管理">
        {FOOTER_VIEWS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={view === item.id ? "active" : ""}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => onSelectView(item.id)}
            >
              <Icon aria-hidden="true" />
              {item.label}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
