/* eslint-disable react-hooks/set-state-in-effect -- server snapshots and reconnects intentionally update state */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ProjectDetail,
  ProjectView,
  TaskBoardSnapshot,
  TaskDetail,
  TaskStreamState,
} from "@agent-in-box/protocol";
import { api, subscribeTaskEvents } from "./api";
import { FileInboxPanel } from "./FileInboxPanel";
import { ProjectBackupPanel } from "./ProjectBackupPanel";
import { ProjectManager } from "./ProjectManager";
import { RouterPanel } from "./RouterPanel";
import { TaskBoard } from "./TaskBoard";
import { WorkerPanel } from "./WorkerPanel";
import { WorkerRegistryPanel } from "./WorkerRegistryPanel";

export type WorkView = "session" | "projects" | "tasks" | "archive";

interface WorkManagerProps {
  view: WorkView;
  onOpenVmConsole?(vmId: string): void;
  onOpenWorker?(projectId: string, workerId: string): void;
  focusProjectId?: string;
  onNavigate?(view: "tasks" | "archive" | "settings"): void;
}

const VIEW_TITLES: Record<WorkView, string> = {
  session: "主会话",
  projects: "项目",
  tasks: "任务看板",
  archive: "归档",
};

export function WorkManager({
  view,
  onOpenVmConsole,
  onOpenWorker,
  focusProjectId,
  onNavigate,
}: WorkManagerProps): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [board, setBoard] = useState<TaskBoardSnapshot | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectDetail, setProjectDetail] = useState<ProjectDetail | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [streamState, setStreamState] = useState<TaskStreamState>("reconnecting");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [focusedConversationId, setFocusedConversationId] = useState<string | null>(null);
  const [focusedWorkerId, setFocusedWorkerId] = useState<string | null>(null);
  const selectedProjectRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const queuedRefreshRef = useRef(false);

  const load = useCallback(async (silent: boolean): Promise<void> => {
    if (inFlightRef.current) {
      queuedRefreshRef.current = true;
      return;
    }
    inFlightRef.current = true;
    if (!silent) setLoading(true);
    try {
      do {
        queuedRefreshRef.current = false;
        try {
          const [nextProjects, nextBoard] = await Promise.all([
            api.projects(true),
            api.taskBoard(),
          ]);
          setProjects(nextProjects);
          setBoard(nextBoard);
          if (
            selectedProjectRef.current === null ||
            !nextProjects.some((view) => view.project.id === selectedProjectRef.current)
          ) {
            const firstId = nextProjects[0]?.project.id ?? null;
            selectedProjectRef.current = firstId;
            setSelectedProjectId(firstId);
          }
          setError(null);
          setRevision((value) => value + 1);
        } catch (cause) {
          setError(errorMessage(cause));
        }
      } while (queuedRefreshRef.current);
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    if (!focusProjectId || !projects.some((item) => item.project.id === focusProjectId)) return;
    if (selectedProjectRef.current === focusProjectId) return;
    selectedProjectRef.current = focusProjectId;
    setSelectedProjectId(focusProjectId);
    setProjectDetail(null);
  }, [focusProjectId, projects]);

  useEffect(() => subscribeTaskEvents(() => void load(true), setStreamState), [load]);

  useEffect(() => {
    if (!selectedProjectId) {
      setProjectDetail(null);
      return;
    }
    let active = true;
    void api
      .project(selectedProjectId)
      .then((detail) => {
        if (active) setProjectDetail(detail);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [selectedProjectId, revision]);

  useEffect(() => {
    if (!selectedTaskId) {
      setTaskDetail(null);
      return;
    }
    let active = true;
    void api
      .taskDetail(selectedTaskId)
      .then((detail) => {
        if (active) setTaskDetail(detail);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [selectedTaskId, revision]);

  const selectProject = useCallback((projectId: string) => {
    const changed = selectedProjectRef.current !== projectId;
    selectedProjectRef.current = projectId;
    setSelectedProjectId(projectId);
    if (changed) setProjectDetail(null);
  }, []);

  const selectedDetail = projectDetail?.project.id === selectedProjectId ? projectDetail : null;

  useEffect(() => {
    if (!selectedDetail || !focusedConversationId) return;
    document
      .getElementById(`conversation-${focusedConversationId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [selectedDetail, focusedConversationId]);

  const openConversation = useCallback((projectId: string, conversationId: string) => {
    const changed = selectedProjectRef.current !== projectId;
    selectedProjectRef.current = projectId;
    setSelectedProjectId(projectId);
    if (changed) setProjectDetail(null);
    setFocusedConversationId(conversationId);
  }, []);

  const openWorker = useCallback(
    (projectId: string, workerId: string) => {
      if (onOpenWorker) {
        onOpenWorker(projectId, workerId);
        return;
      }
      const changed = selectedProjectRef.current !== projectId;
      selectedProjectRef.current = projectId;
      setSelectedProjectId(projectId);
      if (changed) setProjectDetail(null);
      setFocusedWorkerId(workerId);
    },
    [onOpenWorker],
  );

  useEffect(() => {
    if (!focusedWorkerId || !selectedDetail) return;
    document.getElementById("worker-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusedWorkerId, selectedDetail]);

  if (view === "session") {
    return (
      <RouterPanel
        revision={revision}
        onChanged={() => load(true)}
        {...(onNavigate ? { onOpenSettings: () => onNavigate("settings") } : {})}
      />
    );
  }

  const title = VIEW_TITLES[view];
  return (
    <section className="panel work-manager" aria-labelledby="work-manager-title">
      <div className="panel-heading">
        <div>
          <h2 id="work-manager-title">{title}</h2>
        </div>
        <div className="panel-heading-actions">
          {onNavigate && (view === "tasks" || view === "archive") && (
            <button
              type="button"
              className="secondary"
              onClick={() => onNavigate(view === "tasks" ? "archive" : "tasks")}
            >
              {view === "tasks" ? "已归档" : "返回任务"}
            </button>
          )}
          {streamState !== "live" && <span className="muted small">正在更新连接</span>}
        </div>
      </div>
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
      {loading && !board ? (
        <p className="muted">正在读取项目与任务快照…</p>
      ) : view === "archive" ? (
        <WorkerRegistryPanel revision={revision} onChanged={() => load(true)} />
      ) : view === "tasks" ? (
        <TaskBoard
          board={board}
          selectedProject={selectedDetail}
          taskDetail={taskDetail}
          selectedTaskId={selectedTaskId}
          revision={revision}
          onSelectTask={setSelectedTaskId}
          onSelectProject={selectProject}
          onOpenConversation={openConversation}
          onOpenWorker={openWorker}
          {...(onOpenVmConsole ? { onOpenVmConsole } : {})}
          onChanged={() => load(true)}
        />
      ) : (
        <>
          <ProjectManager
            projects={projects}
            vms={board?.vms ?? []}
            detail={selectedDetail}
            selectedProjectId={selectedProjectId}
            onSelect={selectProject}
            onChanged={() => load(true)}
          />
          {selectedDetail && selectedDetail.project.archivedAt === null && (
            <>
              <FileInboxPanel projectId={selectedDetail.project.id} revision={revision} />
              <ProjectBackupPanel
                project={selectedDetail}
                revision={revision}
                onChanged={() => load(true)}
              />
              <WorkerPanel
                project={selectedDetail}
                revision={revision}
                focusWorkerId={focusedWorkerId}
                onChanged={() => load(true)}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
