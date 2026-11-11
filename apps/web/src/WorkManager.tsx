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
import { ProjectManager } from "./ProjectManager";
import { TaskBoard } from "./TaskBoard";
import { WorkerPanel } from "./WorkerPanel";

export function WorkManager(): React.JSX.Element {
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

  return (
    <section className="panel work-manager" aria-labelledby="work-manager-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">PROJECTS & DURABLE TASKS</p>
          <h2 id="work-manager-title">项目与任务</h2>
        </div>
        <div className="stream-status" role="status">
          <span className={`dot ${streamState === "live" ? "live" : ""}`} aria-hidden="true" />
          {streamState === "live" ? "实时更新已连接" : "正在重连；恢复后完整同步"}
          {board && <span> · 快照 {new Date(board.snapshotAt).toLocaleTimeString("zh-CN")}</span>}
        </div>
      </div>
      <p className="muted small">
        项目与 VM 是多对多关系。共享 VM
        的桌面、软件和系统状态由所有绑定项目共同影响，所有项目任务进入同一串行队列。
      </p>
      {error && <div className="notice">{error}</div>}
      {loading && !board ? (
        <p className="muted">正在读取项目与任务快照…</p>
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
            <WorkerPanel
              project={selectedDetail}
              revision={revision}
              onChanged={() => load(true)}
            />
          )}
          <TaskBoard
            board={board}
            selectedProject={selectedDetail}
            taskDetail={taskDetail}
            selectedTaskId={selectedTaskId}
            onSelectTask={setSelectedTaskId}
            onSelectProject={selectProject}
            onOpenConversation={openConversation}
            onChanged={() => load(true)}
          />
        </>
      )}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
