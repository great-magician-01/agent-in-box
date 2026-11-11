/* eslint-disable react-hooks/set-state-in-effect -- task trace loads as a server snapshot */
import { useEffect, useMemo, useState } from "react";
import {
  ACTIVE_TASK_STATUSES,
  TASK_STATUSES,
  type ProjectDetail,
  type TaskBoardItem,
  type TaskBoardSnapshot,
  type TaskDetail,
  type TaskStatus,
  type TaskTraceView,
} from "@agent-in-box/protocol";
import { api } from "./api";
import { formatBytes, formatDate, TASK_STATUS_LABELS, VM_POWER_STATE_LABELS } from "./format";

interface TaskBoardProps {
  board: TaskBoardSnapshot | null;
  selectedProject: ProjectDetail | null;
  taskDetail: TaskDetail | null;
  selectedTaskId: string | null;
  revision: number;
  onSelectTask(taskId: string | null): void;
  onSelectProject(projectId: string): void;
  onOpenConversation(projectId: string, conversationId: string): void;
  onOpenWorker?(projectId: string, workerId: string): void;
  onOpenVmConsole?(vmId: string): void;
  onChanged(): Promise<void>;
}

export function TaskBoard({
  board,
  selectedProject,
  taskDetail,
  selectedTaskId,
  revision,
  onSelectTask,
  onSelectProject,
  onOpenConversation,
  onOpenWorker,
  onOpenVmConsole,
  onChanged,
}: TaskBoardProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [objective, setObjective] = useState("");
  const [vmId, setVmId] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [priority, setPriority] = useState(0);
  const [dependencyId, setDependencyId] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [vmFilter, setVmFilter] = useState("");
  const [workerFilter, setWorkerFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [trace, setTrace] = useState<TaskTraceView | null>(null);

  useEffect(() => {
    if (!selectedTaskId) {
      setTrace(null);
      return;
    }
    let active = true;
    void api
      .taskTrace(selectedTaskId)
      .then((next) => {
        if (active) setTrace(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [selectedTaskId, revision]);

  const primaryBinding =
    selectedProject?.bindings.find((item) => item.binding.isPrimary) ??
    selectedProject?.bindings[0];
  const selectedVmId = selectedProject?.bindings.some((item) => item.vm.id === vmId)
    ? vmId
    : (primaryBinding?.vm.id ?? "");
  const selectedConversationId = selectedProject?.conversations.some(
    (item) => item.id === conversationId,
  )
    ? conversationId
    : (selectedProject?.conversations[0]?.id ?? "");

  const tasks = useMemo(() => {
    return (board?.tasks ?? []).filter(
      (task) =>
        (!projectFilter || task.projectId === projectFilter) &&
        (!vmFilter || task.vmId === vmFilter) &&
        (!workerFilter || task.assignedWorkerId === workerFilter) &&
        (!statusFilter || task.status === statusFilter),
    );
  }, [board, projectFilter, vmFilter, workerFilter, statusFilter]);

  const projects = useMemo(
    () => new Map(board?.projects.map((project) => [project.id, project]) ?? []),
    [board],
  );
  const vms = useMemo(() => new Map(board?.vms.map((vm) => [vm.id, vm]) ?? []), [board]);
  const workers = useMemo(
    () => new Map(board?.workers.map((worker) => [worker.id, worker]) ?? []),
    [board],
  );

  async function run<T>(action: () => Promise<T>): Promise<T | null> {
    if (busy) return null;
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      await onChanged();
      return result;
    } catch (cause) {
      setError(errorMessage(cause));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function createTask(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!selectedProject || !selectedVmId || !objective.trim()) return;
    const result = await run(() =>
      api.createTask(
        {
          projectId: selectedProject.project.id,
          vmId: selectedVmId,
          ...(selectedConversationId ? { originConversationId: selectedConversationId } : {}),
          objective,
          priority,
          ...(dependencyId ? { dependsOn: [dependencyId] } : {}),
        },
        crypto.randomUUID(),
      ),
    );
    if (result) {
      setObjective("");
      setDependencyId("");
      onSelectTask(result.task.id);
    }
  }

  function jumpToProject(projectId: string): void {
    onSelectProject(projectId);
    document
      .getElementById("project-detail")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const detail = taskDetail?.task.id === selectedTaskId ? taskDetail : null;

  return (
    <section className="task-workspace" aria-labelledby="task-board-title">
      <div className="section-heading">
        <div>
          <h3 id="task-board-title">任务看板</h3>
          <span className="muted small">数据库快照 · 每 VM 串行，不同 VM 可独立认领</span>
        </div>
        <span className="muted small">
          {tasks.length} / {board?.tasks.length ?? 0} 个任务
        </span>
      </div>
      {error && <div className="notice">{error}</div>}

      {board?.resources && (
        <div className={`resource-banner pressure-${board.resources.pressure}`} role="status">
          <span>
            资源预算 {formatBytes(board.resources.allocatedMemoryBytes)} /{" "}
            {formatBytes(board.resources.effectiveBudgetBytes)} · 等待资源{" "}
            {board.resources.waitingResourceTaskCount} · 等待 VM{" "}
            {board.resources.waitingVmTaskCount} · 排队 {board.resources.queuedTaskCount}
          </span>
          {board.resources.blockedAutoStarts.map((blocked) => (
            <span key={blocked.vmId} className="warning-line small">
              「{blocked.vmName}」自动启动受阻：{blocked.reason}
            </span>
          ))}
        </div>
      )}

      {selectedProject && !selectedProject.project.archivedAt && (
        <details className="create-box task-create-box">
          <summary>在「{selectedProject.project.name}」中新建任务</summary>
          <form className="stack compact-form" onSubmit={(event) => void createTask(event)}>
            <label className="field">
              <span>任务目标</span>
              <textarea
                value={objective}
                required
                maxLength={4000}
                placeholder="描述希望 Worker 在受控 Linux 桌面中完成的任务"
                onChange={(event) => setObjective(event.target.value)}
              />
            </label>
            <div className="form-grid four-columns">
              <label className="field">
                <span>目标 VM</span>
                <select
                  value={selectedVmId}
                  onChange={(event) => setVmId(event.target.value)}
                  required
                >
                  {selectedProject.bindings.map((item) => (
                    <option key={item.vm.id} value={item.vm.id}>
                      {item.vm.name} · {VM_POWER_STATE_LABELS[item.vm.powerState]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>来源会话</span>
                <select
                  value={selectedConversationId}
                  onChange={(event) => setConversationId(event.target.value)}
                >
                  <option value="">自动使用项目会话</option>
                  {selectedProject.conversations.map((conversation) => (
                    <option key={conversation.id} value={conversation.id}>
                      {conversation.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>优先级（-100～100）</span>
                <input
                  type="number"
                  min={-100}
                  max={100}
                  value={priority}
                  onChange={(event) => setPriority(Number(event.target.value))}
                />
              </label>
              <label className="field">
                <span>依赖任务（可选）</span>
                <select
                  value={dependencyId}
                  onChange={(event) => setDependencyId(event.target.value)}
                >
                  <option value="">无依赖</option>
                  {(board?.tasks ?? [])
                    .filter((task) => task.projectId === selectedProject.project.id)
                    .map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.objective.slice(0, 48)} · {TASK_STATUS_LABELS[task.status]}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <p className="muted small">
              停止 VM 上的任务会进入“等待 VM”；资源预算不足且启用自动启动时进入“等待资源”；
              依赖未完成时保持“已创建”。任务仍由服务端队列和 Worker 认领执行。
            </p>
            <button
              type="submit"
              className="primary"
              disabled={busy || !selectedVmId || !objective.trim()}
            >
              创建并入队
            </button>
          </form>
        </details>
      )}

      <div className="task-filters" aria-label="任务筛选">
        <label className="field">
          <span>项目</span>
          <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
            <option value="">全部项目</option>
            {board?.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>VM</span>
          <select value={vmFilter} onChange={(event) => setVmFilter(event.target.value)}>
            <option value="">全部 VM</option>
            {board?.vms.map((vm) => (
              <option key={vm.id} value={vm.id}>
                {vm.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Worker</span>
          <select value={workerFilter} onChange={(event) => setWorkerFilter(event.target.value)}>
            <option value="">全部 Worker</option>
            {board?.workers.map((worker) => (
              <option key={worker.id} value={worker.id}>
                {worker.id.slice(0, 8)} · {worker.engineType}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>状态</span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="">全部状态</option>
            {TASK_STATUSES.map((status) => (
              <option key={status} value={status}>
                {TASK_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="secondary filter-reset"
          onClick={() => {
            setProjectFilter("");
            setVmFilter("");
            setWorkerFilter("");
            setStatusFilter("");
          }}
        >
          清除筛选
        </button>
      </div>

      <div className="task-table-wrap">
        <table className="task-table">
          <caption className="sr-only">任务数据库快照，可按项目、VM、Worker 和状态筛选</caption>
          <thead>
            <tr>
              <th scope="col">任务</th>
              <th scope="col">状态</th>
              <th scope="col">项目 / VM</th>
              <th scope="col">Worker</th>
              <th scope="col">队列 / 优先级</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                projectName={projects.get(task.projectId)?.name ?? task.projectId}
                vmName={vms.get(task.vmId)?.name ?? task.vmId}
                workerName={
                  task.assignedWorkerId
                    ? (workers.get(task.assignedWorkerId)?.engineType ??
                      task.assignedWorkerId.slice(0, 8))
                    : "未分配"
                }
                busy={busy}
                onDetails={() => onSelectTask(task.id)}
                onProject={() => jumpToProject(task.projectId)}
                onAction={run}
              />
            ))}
          </tbody>
        </table>
        {tasks.length === 0 && <p className="muted empty-state">当前筛选条件下没有任务。</p>}
      </div>

      {selectedTaskId && (
        <aside className="task-detail" aria-label="任务详情">
          {!detail ? (
            <p className="muted">正在读取任务详情…</p>
          ) : (
            <>
              <div className="section-heading">
                <div>
                  <p className="eyebrow">TASK TIMELINE</p>
                  <h3>{detail.task.objective}</h3>
                </div>
                <button type="button" className="secondary" onClick={() => onSelectTask(null)}>
                  关闭
                </button>
              </div>
              <div className="task-detail-badges">
                <TaskStatusBadge status={detail.task.status} />
                <span className="pill">尝试 {detail.task.attemptCount} 次</span>
                {detail.task.queuePosition && (
                  <span className="pill">队列第 {detail.task.queuePosition} 位</span>
                )}
              </div>
              <dl className="detail-facts">
                <div>
                  <dt>项目</dt>
                  <dd>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => jumpToProject(detail.task.projectId)}
                    >
                      {projects.get(detail.task.projectId)?.name ?? detail.task.projectId}
                    </button>
                  </dd>
                </div>
                <div>
                  <dt>目标 VM</dt>
                  <dd>
                    <a href={`#vm-${detail.task.vmId}`}>
                      {vms.get(detail.task.vmId)?.name ?? detail.task.vmId}
                    </a>
                    {" · "}
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => onOpenVmConsole?.(detail.task.vmId)}
                    >
                      打开实时控制台
                    </button>
                  </dd>
                </div>
                <div>
                  <dt>来源会话</dt>
                  <dd>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() =>
                        onOpenConversation(detail.task.projectId, detail.task.originConversationId)
                      }
                    >
                      打开项目会话
                    </button>
                    {detail.task.assignedWorkerId && (
                      <>
                        {" · "}
                        <button
                          type="button"
                          className="link-button"
                          onClick={() =>
                            onOpenWorker?.(detail.task.projectId, detail.task.assignedWorkerId!)
                          }
                        >
                          打开 Worker 会话
                        </button>
                      </>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>创建 / 更新</dt>
                  <dd>
                    {formatDate(detail.task.createdAt)} / {formatDate(detail.task.updatedAt)}
                  </dd>
                </div>
                <div>
                  <dt>开始 / 结束</dt>
                  <dd>
                    {detail.task.startedAt ? formatDate(detail.task.startedAt) : "—"} /{" "}
                    {detail.task.completedAt ? formatDate(detail.task.completedAt) : "—"}
                  </dd>
                </div>
              </dl>
              {detail.task.latestSummary && (
                <p className="result-box">{detail.task.latestSummary}</p>
              )}
              {detail.task.errorMessage && (
                <p className="notice">
                  {detail.task.errorCode}: {detail.task.errorMessage}
                </p>
              )}
              {detail.task.result !== null && (
                <pre className="json-view">{JSON.stringify(detail.task.result, null, 2)}</pre>
              )}
              {detail.dependencies.length > 0 && (
                <section className="subsection">
                  <h4>依赖任务</h4>
                  <ul className="plain-list">
                    {detail.dependencies.map((dependency) => (
                      <li key={dependency.id}>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => onSelectTask(dependency.id)}
                        >
                          {dependency.objective}
                        </button>
                        <TaskStatusBadge status={dependency.status} />
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {detail.artifacts.length > 0 && (
                <section className="subsection">
                  <h4>完成产物</h4>
                  <ul className="plain-list artifact-list">
                    {detail.artifacts.map((artifact) => (
                      <li key={artifact.id}>
                        <div>
                          <code>{artifact.relativePath}</code>
                          <span className="muted small">
                            {artifact.mediaType} · {artifact.sizeBytes} B · SHA-256{" "}
                            {artifact.sha256.slice(0, 12)}…
                          </span>
                        </div>
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            void run(() => api.verifyTaskArtifact(detail.task.id, artifact.id))
                          }
                        >
                          {artifact.verifiedAt ? "重新校验" : "校验产物"}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {trace && (
                <section className="subsection">
                  <h4>Computer Use Trace</h4>
                  {trace.execution && (
                    <dl className="detail-facts">
                      <div>
                        <dt>步数 / 动作</dt>
                        <dd>
                          {trace.execution.stepCount} / {trace.execution.actionCount}
                          （上限见项目策略）
                        </dd>
                      </div>
                      <div>
                        <dt>执行窗口</dt>
                        <dd>
                          {formatDate(trace.execution.startedAt)} →{" "}
                          {formatDate(trace.execution.deadlineAt)}
                        </dd>
                      </div>
                      <div>
                        <dt>无进展 / 重复</dt>
                        <dd>
                          {trace.execution.noProgressStreak} / {trace.execution.duplicateStreak}
                        </dd>
                      </div>
                      <div>
                        <dt>完成验证</dt>
                        <dd>
                          {trace.execution.completionAttempts} 次尝试 ·{" "}
                          {trace.execution.outcome ?? "进行中"}
                        </dd>
                      </div>
                    </dl>
                  )}
                  {trace.approvals.length > 0 && (
                    <ul className="plain-list">
                      {trace.approvals.map((approval) => (
                        <li key={approval.id}>
                          <div>
                            <strong>{approval.actionType}</strong>{" "}
                            <span className="muted small">{approval.status}</span>
                            <p>{approval.contextSummary}</p>
                          </div>
                          {approval.status === "pending" && (
                            <div className="button-row">
                              <button
                                type="button"
                                className="primary"
                                disabled={busy}
                                onClick={() =>
                                  void run(() => api.approveApproval(approval.id, "界面批准"))
                                }
                              >
                                批准
                              </button>
                              <button
                                type="button"
                                className="secondary"
                                disabled={busy}
                                onClick={() =>
                                  void run(() => api.rejectApproval(approval.id, "界面拒绝"))
                                }
                              >
                                拒绝
                              </button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {trace.screenshots.length > 0 && (
                    <div className="trace-screenshots">
                      {trace.screenshots.slice(-4).map((shot) => (
                        <a
                          key={shot.id}
                          href={`/api/v1/tasks/${encodeURIComponent(detail.task.id)}/screenshots/${encodeURIComponent(shot.id)}`}
                          target="_blank"
                          rel="noreferrer"
                          title={`${shot.kind} ${shot.width}x${shot.height} ${formatDate(shot.capturedAt)}`}
                        >
                          <img
                            src={`/api/v1/tasks/${encodeURIComponent(detail.task.id)}/screenshots/${encodeURIComponent(shot.id)}`}
                            alt={`${shot.kind} screenshot`}
                            loading="lazy"
                          />
                        </a>
                      ))}
                    </div>
                  )}
                  {trace.actions.length > 0 && (
                    <ol className="timeline">
                      {trace.actions.map((action) => (
                        <li key={action.id}>
                          <span className="timeline-id">{action.type}</span>
                          <div>
                            <strong>{action.status}</strong>
                            {action.errorCode && (
                              <span className="muted small">
                                {" "}
                                {action.errorCode}: {action.errorMessage}
                              </span>
                            )}
                            <span className="muted small">
                              {" "}
                              · {formatDate(action.createdAt)}
                              {action.durationMs !== null ? ` · ${action.durationMs}ms` : ""}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              )}
              <section className="subsection">
                <h4>任务时间线</h4>
                <ol className="timeline">
                  {detail.events.map((event) => (
                    <li key={event.id}>
                      <span className="timeline-id">#{event.id}</span>
                      <div>
                        <strong>{event.type}</strong>
                        <span className="muted small">{formatDate(event.createdAt)}</span>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          )}
        </aside>
      )}
    </section>
  );
}

function TaskRow({
  task,
  projectName,
  vmName,
  workerName,
  busy,
  onDetails,
  onProject,
  onAction,
}: {
  task: TaskBoardItem;
  projectName: string;
  vmName: string;
  workerName: string;
  busy: boolean;
  onDetails(): void;
  onProject(): void;
  onAction<T>(action: () => Promise<T>): Promise<T | null>;
}): React.JSX.Element {
  const active = (ACTIVE_TASK_STATUSES as readonly TaskStatus[]).includes(task.status);
  return (
    <tr>
      <td>
        <button type="button" className="task-objective" onClick={onDetails}>
          {task.objective}
        </button>
        <span className="muted small">创建于 {formatDate(task.createdAt)}</span>
      </td>
      <td>
        <TaskStatusBadge status={task.status} />
        {task.dependencyIds.length > 0 && (
          <span className="muted small">{task.dependencyIds.length} 个依赖</span>
        )}
      </td>
      <td>
        <button type="button" className="link-button" onClick={onProject}>
          {projectName}
        </button>
        <span className="muted small">
          {vmName} · {task.vmOsFamily === "windows" ? "Windows" : "Linux"} ·{" "}
          {VM_POWER_STATE_LABELS[task.vmPowerState]}
        </span>
        {task.status === "waiting_resources" && (
          <span className="pill warn small">等待宿主资源</span>
        )}
        {task.status === "waiting_vm" && <span className="pill small">等待 VM 启动</span>}
      </td>
      <td>{workerName}</td>
      <td>
        {task.queuePosition ? (
          <span className="queue-position">#{task.queuePosition}</span>
        ) : (
          <span className="muted">—</span>
        )}
        <PriorityEditor
          key={`${task.id}:${task.priority}`}
          task={task}
          busy={busy}
          onAction={onAction}
        />
      </td>
      <td>
        <div className="row-actions">
          <button type="button" className="secondary" onClick={onDetails}>
            详情
          </button>
          {active && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void onAction(() => api.cancelTask(task.id, "用户从看板取消"))}
            >
              取消
            </button>
          )}
          {task.status === "blocked" && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void onAction(() => api.requeueTask(task.id))}
            >
              重新排队
            </button>
          )}
          {task.status === "failed" && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void onAction(() => api.retryTask(task.id))}
            >
              重试
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function PriorityEditor({
  task,
  busy,
  onAction,
}: {
  task: TaskBoardItem;
  busy: boolean;
  onAction<T>(action: () => Promise<T>): Promise<T | null>;
}): React.JSX.Element {
  const [value, setValue] = useState(task.priority);
  const editable = ["created", "waiting_resources", "waiting_vm", "queued", "blocked"].includes(
    task.status,
  );
  if (!editable) return <span className="muted small">优先级 {task.priority}</span>;
  return (
    <span className="priority-editor">
      <label>
        <span className="sr-only">任务 {task.objective} 的优先级</span>
        <input
          type="number"
          min={-100}
          max={100}
          value={value}
          onChange={(event) => setValue(Number(event.target.value))}
        />
      </label>
      <button
        type="button"
        className="link-button"
        disabled={busy || value === task.priority}
        onClick={() => void onAction(() => api.setTaskPriority(task.id, value))}
      >
        保存
      </button>
    </span>
  );
}

function TaskStatusBadge({ status }: { status: TaskStatus }): React.JSX.Element {
  const icons: Record<TaskStatus, string> = {
    created: "○",
    waiting_resources: "◷",
    waiting_vm: "◷",
    queued: "→",
    running: "▶",
    waiting_approval: "!",
    blocked: "!",
    completed: "✓",
    failed: "×",
    cancelled: "—",
  };
  return (
    <span className={`task-status ${status}`}>
      <span aria-hidden="true">{icons[status]}</span>
      {TASK_STATUS_LABELS[status]}
    </span>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
