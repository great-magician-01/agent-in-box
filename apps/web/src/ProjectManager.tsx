/* eslint-disable react-hooks/set-state-in-effect -- selected server records initialize edit forms */
import { useEffect, useMemo, useState } from "react";
import type {
  ComputerActionType,
  CuaPolicyView,
  ProjectBindingView,
  ProjectDetail,
  ProjectView,
  VmInstanceRecord,
} from "@agent-in-box/protocol";
import { api } from "./api";
import { formatDate, VM_POWER_STATE_LABELS } from "./format";

const DEFAULT_LINUX_WORKSPACE = "/home/aib-worker/workspace";
const DEFAULT_WINDOWS_WORKSPACE = "C:\\Users\\aib\\AgentInBox\\workspace";

function defaultGuestWorkspace(osFamily: VmInstanceRecord["osFamily"]): string {
  return osFamily === "windows" ? DEFAULT_WINDOWS_WORKSPACE : DEFAULT_LINUX_WORKSPACE;
}

interface ProjectManagerProps {
  projects: ProjectView[];
  vms: VmInstanceRecord[];
  detail: ProjectDetail | null;
  selectedProjectId: string | null;
  onSelect(projectId: string): void;
  onChanged(): Promise<void>;
}

export function ProjectManager({
  projects,
  vms,
  detail,
  selectedProjectId,
  onSelect,
  onChanged,
}: ProjectManagerProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [workspace, setWorkspace] = useState(DEFAULT_LINUX_WORKSPACE);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editWorkspace, setEditWorkspace] = useState("");
  const [editMcpEnabled, setEditMcpEnabled] = useState(false);
  const [bindVmId, setBindVmId] = useState("");
  const [bindPath, setBindPath] = useState(DEFAULT_LINUX_WORKSPACE);
  const [bindPrimary, setBindPrimary] = useState(false);
  const [conversationTitle, setConversationTitle] = useState("");
  const [policyView, setPolicyView] = useState<CuaPolicyView | null>(null);
  const [policyMaxSteps, setPolicyMaxSteps] = useState("80");
  const [policyMinutes, setPolicyMinutes] = useState("15");
  const [policyApproval, setPolicyApproval] = useState<ComputerActionType[]>([]);
  const [policyHosts, setPolicyHosts] = useState("");
  const [policyRoots, setPolicyRoots] = useState("/home, /tmp, C:\\Users");

  useEffect(() => {
    if (!detail) return;
    setEditName(detail.project.name);
    setEditDescription(detail.project.description);
    setEditWorkspace(detail.project.workspaceConfig.defaultGuestWorkspacePath);
    setEditMcpEnabled(detail.project.agentConfig.mcpEnabled);
  }, [detail]);

  useEffect(() => {
    if (!detail) {
      setPolicyView(null);
      return;
    }
    let active = true;
    void api
      .projectPolicy(detail.project.id)
      .then((view) => {
        if (!active) return;
        setPolicyView(view);
        setPolicyMaxSteps(String(view.policy.maxSteps));
        setPolicyMinutes(String(Math.round(view.policy.maxDurationMs / 60_000)));
        setPolicyApproval(view.policy.approvalActionTypes);
        setPolicyHosts(view.policy.network.allowedHosts.join(", "));
        setPolicyRoots(view.policy.fileExchange.allowedRoots.join(", "));
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [detail]);

  async function savePolicy(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!detail) return;
    const updated = await run(() =>
      api.updateProjectPolicy(detail.project.id, {
        maxSteps: Number(policyMaxSteps),
        maxDurationMs: Number(policyMinutes) * 60_000,
        approvalActionTypes: policyApproval,
        network: {
          allowedHosts: policyHosts
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        },
        fileExchange: {
          allowedRoots: policyRoots
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        },
      }),
    );
    if (updated) setPolicyView(updated);
  }

  function toggleApproval(action: ComputerActionType): void {
    setPolicyApproval((current) =>
      current.includes(action) ? current.filter((value) => value !== action) : [...current, action],
    );
  }

  const availableVms = useMemo(() => {
    const bound = new Set(detail?.bindings.map((item) => item.vm.id) ?? []);
    return vms.filter((vm) => !bound.has(vm.id));
  }, [detail, vms]);
  const selectedBindVm = availableVms.some((vm) => vm.id === bindVmId)
    ? bindVmId
    : (availableVms[0]?.id ?? "");
  const archived = detail?.project.archivedAt != null;

  function selectBindingVm(nextId: string): void {
    setBindVmId(nextId);
    const vm = vms.find((item) => item.id === nextId);
    setBindPath(defaultGuestWorkspace(vm?.osFamily ?? "linux"));
  }

  // When the first unbound VM is selected automatically, keep the suggested
  // directory in sync with its Guest OS without overwriting a custom path.
  useEffect(() => {
    const vm = vms.find((item) => item.id === selectedBindVm);
    if (!vm) return;
    if (bindPath !== DEFAULT_LINUX_WORKSPACE && bindPath !== DEFAULT_WINDOWS_WORKSPACE) return;
    setBindPath(defaultGuestWorkspace(vm.osFamily));
  }, [selectedBindVm, vms, bindPath]);

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

  async function createProject(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const created = await run(() =>
      api.createProject({
        name,
        description,
        workspaceConfig: { defaultGuestWorkspacePath: workspace },
      }),
    );
    if (created) {
      setName("");
      setDescription("");
      setWorkspace(DEFAULT_LINUX_WORKSPACE);
      onSelect(created.project.id);
    }
  }

  async function addBinding(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!detail || !selectedBindVm) return;
    const created = await run(() =>
      api.bindProjectVm(detail.project.id, {
        vmId: selectedBindVm,
        guestWorkspacePath: bindPath,
        isPrimary: bindPrimary,
      }),
    );
    if (created) {
      setBindVmId("");
      setBindPrimary(false);
    }
  }

  async function addConversation(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!detail) return;
    const created = await run(() =>
      api.createProjectConversation(detail.project.id, conversationTitle),
    );
    if (created) setConversationTitle("");
  }

  return (
    <div className="project-workspace">
      <div className="project-list" aria-label="项目列表">
        <div className="section-heading">
          <h3>项目</h3>
          <span className="muted small">{projects.length} 个</span>
        </div>
        {projects.length === 0 && <p className="muted small">创建项目后，再绑定一台或多台 VM。</p>}
        <div className="project-tabs" role="list">
          {projects.map((view) => (
            <button
              type="button"
              role="listitem"
              key={view.project.id}
              className={view.project.id === selectedProjectId ? "selected" : ""}
              onClick={() => onSelect(view.project.id)}
            >
              <strong>{view.project.name}</strong>
              <span>
                {view.project.archivedAt ? "已归档 · " : ""}
                {view.bindings.length} VM · {view.activeTaskCount} 活跃任务 ·{" "}
                {view.activeWorkerCount} 活跃 Worker
              </span>
            </button>
          ))}
        </div>
        <details className="create-box">
          <summary>新建项目</summary>
          <form className="stack compact-form" onSubmit={(event) => void createProject(event)}>
            <label className="field">
              <span>名称</span>
              <input
                value={name}
                maxLength={80}
                required
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="field">
              <span>描述</span>
              <textarea
                value={description}
                maxLength={2000}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <label className="field">
              <span>默认 Guest 工作目录</span>
              <input
                value={workspace}
                required
                spellCheck={false}
                onChange={(event) => setWorkspace(event.target.value)}
              />
            </label>
            <button type="submit" className="primary" disabled={busy}>
              创建项目
            </button>
          </form>
        </details>
      </div>

      <div className="project-detail" id="project-detail">
        {error && <div className="notice">{error}</div>}
        {!detail ? (
          <p className="muted">
            {selectedProjectId ? "正在读取项目详情…" : "请选择或创建一个项目。"}
          </p>
        ) : (
          <>
            <div className="section-heading">
              <div>
                <h3>{detail.project.name}</h3>
                <span className="muted small">创建于 {formatDate(detail.project.createdAt)}</span>
              </div>
              <span className={`pill ${archived ? "warn" : "ok"}`}>
                {archived ? "已归档" : "活跃"}
              </span>
            </div>
            <form
              className="project-edit-form"
              onSubmit={(event) => {
                event.preventDefault();
                void run(() =>
                  api.updateProject(detail.project.id, {
                    name: editName,
                    description: editDescription,
                    workspaceConfig: { defaultGuestWorkspacePath: editWorkspace },
                    agentConfig: { mcpEnabled: editMcpEnabled },
                  }),
                );
              }}
            >
              <div className="form-grid two-columns">
                <label className="field">
                  <span>项目名称</span>
                  <input
                    value={editName}
                    disabled={archived || busy}
                    required
                    onChange={(event) => setEditName(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>默认工作目录</span>
                  <input
                    value={editWorkspace}
                    disabled={archived || busy}
                    required
                    spellCheck={false}
                    onChange={(event) => setEditWorkspace(event.target.value)}
                  />
                </label>
              </div>
              <label className="field">
                <span>描述</span>
                <textarea
                  value={editDescription}
                  disabled={archived || busy}
                  onChange={(event) => setEditDescription(event.target.value)}
                />
              </label>
              <div className="field">
                <span>Agent 扩展</span>
                <label className="toggle compact-toggle">
                  <input
                    type="checkbox"
                    checked={editMcpEnabled}
                    disabled={archived || busy}
                    onChange={(event) => setEditMcpEnabled(event.target.checked)}
                  />
                  <span>为此项目启用 MCP</span>
                </label>
                <span className="form-hint">
                  Subagent 默认启用，无需配置。MCP 默认关闭；开启后由该项目 Worker 的 Pi 会话加载
                  Guest 中的 MCP 配置。更改在新建或恢复 Worker 会话后生效，点击“保存项目”应用。
                </span>
              </div>
              <div className="action-row">
                {!archived && (
                  <button type="submit" className="secondary" disabled={busy}>
                    保存项目
                  </button>
                )}
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      archived
                        ? api.restoreProject(detail.project.id)
                        : api.archiveProject(detail.project.id),
                    )
                  }
                >
                  {archived ? "恢复项目" : "归档项目"}
                </button>
                <button
                  type="button"
                  className="link-button danger-link"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        "删除项目元数据不会删除任何 VM 或虚拟磁盘。已有任务历史的项目只能归档。确定继续？",
                      )
                    ) {
                      void run(() => api.deleteProject(detail.project.id));
                    }
                  }}
                >
                  删除项目
                </button>
              </div>
            </form>

            <section className="subsection" aria-labelledby="bindings-title">
              <div className="section-heading">
                <h4 id="bindings-title">VM 绑定与共享影响</h4>
                <span className="muted small">停止的 VM 也可绑定</span>
              </div>
              {detail.bindings.length === 0 && <p className="muted small">尚未绑定 VM。</p>}
              <div className="binding-list">
                {detail.bindings.map((item) => (
                  <BindingRow
                    key={`${item.binding.id}:${item.binding.guestWorkspacePath}`}
                    item={item}
                    currentProjectId={detail.project.id}
                    archived={archived}
                    busy={busy}
                    onChanged={onChanged}
                    onError={setError}
                  />
                ))}
              </div>
              {!archived && (
                <form
                  className="inline-form binding-form"
                  onSubmit={(event) => void addBinding(event)}
                >
                  <label className="field">
                    <span>添加 VM</span>
                    <select
                      value={selectedBindVm}
                      onChange={(event) => selectBindingVm(event.target.value)}
                      disabled={!selectedBindVm || busy}
                    >
                      {!selectedBindVm && <option value="">所有 VM 均已绑定</option>}
                      {availableVms.map((vm) => (
                        <option key={vm.id} value={vm.id}>
                          {vm.osFamily === "windows" ? "Windows" : "Linux"} · {vm.name} ·{" "}
                          {VM_POWER_STATE_LABELS[vm.powerState]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Guest 工作目录</span>
                    <input
                      value={bindPath}
                      required
                      spellCheck={false}
                      onChange={(event) => setBindPath(event.target.value)}
                    />
                  </label>
                  <label className="toggle compact-toggle">
                    <input
                      type="checkbox"
                      checked={bindPrimary}
                      onChange={(event) => setBindPrimary(event.target.checked)}
                    />
                    <span>设为主 VM</span>
                  </label>
                  <button type="submit" className="secondary" disabled={busy || !selectedBindVm}>
                    绑定
                  </button>
                </form>
              )}
            </section>

            <section className="subsection" aria-labelledby="cua-policy-title">
              <div className="section-heading">
                <h4 id="cua-policy-title">Computer Use 策略</h4>
                <span className="muted small">
                  {policyView?.source === "project" ? "项目覆盖默认策略" : "使用全局默认策略"}
                </span>
              </div>
              <p className="muted small">
                Worker 动作必须持有 Execution Lease。敏感动作可要求人工审批；完成必须由 Guest
                文件/进程证据或新截图独立验证，模型自述不算完成。
              </p>
              {policyView && (
                <form className="stack compact-form" onSubmit={(event) => void savePolicy(event)}>
                  <div className="project-columns">
                    <label className="field">
                      <span>最大步数</span>
                      <input
                        type="number"
                        min={1}
                        max={1000}
                        value={policyMaxSteps}
                        disabled={archived || busy}
                        onChange={(event) => setPolicyMaxSteps(event.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>最长执行（分钟）</span>
                      <input
                        type="number"
                        min={1}
                        max={1440}
                        value={policyMinutes}
                        disabled={archived || busy}
                        onChange={(event) => setPolicyMinutes(event.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>允许的 Provider/网络主机（逗号分隔）</span>
                      <input
                        value={policyHosts}
                        disabled={archived || busy}
                        placeholder="models.example.test"
                        onChange={(event) => setPolicyHosts(event.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>文件证据允许根目录（逗号分隔）</span>
                      <input
                        value={policyRoots}
                        disabled={archived || busy}
                        onChange={(event) => setPolicyRoots(event.target.value)}
                      />
                      <span className="form-hint">
                        支持 POSIX（如 /home/worker）和 Windows（如 C:\Users\aib-worker）绝对路径；
                        不能使用文件系统根目录。
                      </span>
                    </label>
                  </div>
                  <div className="field">
                    <span>必须人工审批的动作</span>
                    <div className="button-row">
                      {(
                        [
                          "type_text",
                          "keypress",
                          "drag",
                          "click",
                          "move",
                          "scroll",
                        ] as ComputerActionType[]
                      ).map((action) => (
                        <label key={action} className="toggle compact-toggle">
                          <input
                            type="checkbox"
                            checked={policyApproval.includes(action)}
                            disabled={archived || busy}
                            onChange={() => toggleApproval(action)}
                          />
                          <span>{action}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="button-row">
                    <button type="submit" className="secondary" disabled={archived || busy}>
                      保存策略
                    </button>
                    <span className="muted small">
                      网络策略默认 broker_only；文件交换与凭据策略按项目配置审计。
                    </span>
                  </div>
                </form>
              )}
            </section>

            <div className="project-columns">
              <section className="subsection">
                <h4>项目会话</h4>
                <ul className="plain-list">
                  {detail.conversations.map((conversation) => (
                    <li key={conversation.id} id={`conversation-${conversation.id}`}>
                      <strong>{conversation.title}</strong>
                      <span className="muted small">{formatDate(conversation.lastMessageAt)}</span>
                    </li>
                  ))}
                </ul>
                {!archived && (
                  <form className="inline-form" onSubmit={(event) => void addConversation(event)}>
                    <label className="field">
                      <span className="sr-only">新会话标题</span>
                      <input
                        value={conversationTitle}
                        required
                        maxLength={120}
                        placeholder="新会话标题"
                        onChange={(event) => setConversationTitle(event.target.value)}
                      />
                    </label>
                    <button type="submit" className="secondary" disabled={busy}>
                      新建会话
                    </button>
                  </form>
                )}
              </section>
              <section className="subsection">
                <h4>最近活动</h4>
                <ul className="plain-list activity-list">
                  {detail.activities.slice(0, 8).map((activity) => (
                    <li key={activity.id}>
                      <code>{activity.type}</code>
                      <span className="muted small">{formatDate(activity.createdAt)}</span>
                    </li>
                  ))}
                  {detail.activities.length === 0 && <li className="muted small">暂无活动</li>}
                </ul>
              </section>
            </div>
            {detail.artifacts.length > 0 && (
              <section className="subsection">
                <h4>产物引用</h4>
                <ul className="plain-list">
                  {detail.artifacts.slice(0, 8).map((artifact) => (
                    <li key={artifact.id}>
                      <code>{artifact.relativePath}</code>
                      <span className="muted small">
                        {artifact.sizeBytes} B · {artifact.verifiedAt ? "哈希已校验" : "需重新校验"}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function BindingRow({
  item,
  currentProjectId,
  archived,
  busy,
  onChanged,
  onError,
}: {
  item: ProjectBindingView;
  currentProjectId: string;
  archived: boolean;
  busy: boolean;
  onChanged(): Promise<void>;
  onError(message: string | null): void;
}): React.JSX.Element {
  const [workspace, setWorkspace] = useState(item.binding.guestWorkspacePath);
  const [rowBusy, setRowBusy] = useState(false);
  const others = item.sharedProjects.filter((project) => project.id !== currentProjectId);

  async function update(action: () => Promise<unknown>): Promise<void> {
    if (rowBusy) return;
    setRowBusy(true);
    onError(null);
    try {
      await action();
      await onChanged();
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setRowBusy(false);
    }
  }

  return (
    <article className="binding-card">
      <div className="section-heading">
        <div>
          <strong>{item.vm.name}</strong>
          <span className="muted small">
            {" "}
            · {VM_POWER_STATE_LABELS[item.vm.powerState]} · {item.vm.osFamily}
          </span>
        </div>
        {item.binding.isPrimary && <span className="pill ok">主 VM</span>}
      </div>
      <label className="field">
        <span>项目工作目录</span>
        <input
          value={workspace}
          disabled={archived || busy || rowBusy}
          spellCheck={false}
          onChange={(event) => setWorkspace(event.target.value)}
        />
      </label>
      <p className={others.length ? "shared-warning" : "muted small"}>
        {others.length ? (
          <>
            共享给：
            {item.sharedProjects
              .map((project) => `${project.name}${project.archivedAt ? "（已归档）" : ""}`)
              .join("、")}
            。桌面、软件和系统状态共同影响；当前 VM 有 {item.sharedActiveTaskCount}{" "}
            个未结束任务，跨项目串行。本项目在此 VM 的活跃任务：{item.queueDepth}。
          </>
        ) : (
          <>
            当前仅由此项目绑定；之后新增共享项目时，任务也会进入同一 VM 串行队列。本项目在此 VM
            的活跃任务：{item.queueDepth}。
          </>
        )}
      </p>
      <div className="project-workers">
        <span className="muted small">活跃 Worker：</span>
        {item.activeWorkers.length > 0 ? (
          item.activeWorkers.map((worker) => (
            <span key={worker.workerId} className="pill small">
              {worker.workerId.slice(0, 8)} · {worker.status}
            </span>
          ))
        ) : (
          <span className="muted small">无</span>
        )}
      </div>
      {!archived && (
        <div className="action-row">
          <button
            type="button"
            className="secondary"
            disabled={busy || rowBusy}
            onClick={() =>
              void update(() =>
                api.updateProjectVmBinding(currentProjectId, item.binding.id, {
                  guestWorkspacePath: workspace,
                }),
              )
            }
          >
            保存目录
          </button>
          {!item.binding.isPrimary && (
            <button
              type="button"
              className="secondary"
              disabled={busy || rowBusy}
              onClick={() =>
                void update(() =>
                  api.updateProjectVmBinding(currentProjectId, item.binding.id, {
                    isPrimary: true,
                  }),
                )
              }
            >
              设为主 VM
            </button>
          )}
          <button
            type="button"
            className="link-button danger-link"
            disabled={busy || rowBusy}
            onClick={() =>
              void update(() => api.unbindProjectVm(currentProjectId, item.binding.id))
            }
          >
            解绑（不删除 VM）
          </button>
        </div>
      )}
    </article>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
