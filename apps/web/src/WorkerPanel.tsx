/* eslint-disable react-hooks/set-state-in-effect -- worker snapshots refresh from server events */
import { useCallback, useEffect, useState } from "react";
import type {
  ConversationMessageRecord,
  ModelConfigurationView,
  ModelProviderView,
  ProjectDetail,
  WorkerView,
} from "@agent-in-box/protocol";
import { api } from "./api";

interface WorkerPanelProps {
  project: ProjectDetail;
  revision: number;
  focusWorkerId?: string | null;
  onChanged(): void;
}

export function WorkerPanel({
  project,
  revision,
  focusWorkerId,
  onChanged,
}: WorkerPanelProps): React.JSX.Element {
  const [workers, setWorkers] = useState<WorkerView[]>([]);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessageRecord[]>([]);
  const [selectedVmId, setSelectedVmId] = useState<string>(
    project.bindings.find((item) => item.binding.isPrimary)?.vm.id ??
      project.bindings[0]?.vm.id ??
      "",
  );
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  const [providers, setProviders] = useState<ModelProviderView[]>([]);
  const [modelConfiguration, setModelConfiguration] = useState<ModelConfigurationView | null>(null);
  const [workerProvider, setWorkerProvider] = useState("");
  const [workerModel, setWorkerModel] = useState("");
  const [switchProvider, setSwitchProvider] = useState("");
  const [switchModel, setSwitchModel] = useState("");
  const [switchNotice, setSwitchNotice] = useState<string | null>(null);

  const projectId = project.project.id;

  useEffect(() => {
    let active = true;
    void api
      .modelConfiguration()
      .then((configuration) => {
        if (!active) return;
        setModelConfiguration(configuration);
        setProviders(configuration.providers);
        const fallback = configuration.providers.find((provider) => provider.enabled);
        const selection = configuration.selection.worker;
        setWorkerProvider((current) => current || selection?.providerId || fallback?.id || "");
        setWorkerModel((current) => current || selection?.model || fallback?.models[0]?.id || "");
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [revision]);

  useEffect(() => {
    setSelectedVmId((current) => {
      if (project.bindings.some((item) => item.vm.id === current)) return current;
      return (
        project.bindings.find((item) => item.binding.isPrimary)?.vm.id ??
        project.bindings[0]?.vm.id ??
        ""
      );
    });
  }, [project.bindings]);

  useEffect(() => {
    let active = true;
    void api
      .workers(projectId)
      .then((items) => {
        if (!active) return;
        setWorkers(items);
        setSelectedWorkerId((current) => {
          if (current && items.some((item) => item.worker.id === current)) return current;
          return items[0]?.worker.id ?? null;
        });
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [projectId, revision]);

  useEffect(() => {
    if (!focusWorkerId) return;
    setSelectedWorkerId((current) =>
      workers.some((item) => item.worker.id === focusWorkerId) ? focusWorkerId : current,
    );
  }, [focusWorkerId, workers]);

  useEffect(() => {
    if (!selectedWorkerId) {
      setMessages([]);
      return;
    }
    let active = true;
    void api
      .workerMessages(selectedWorkerId)
      .then((items) => {
        if (active) setMessages(items);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [selectedWorkerId, revision]);

  const selected = workers.find((item) => item.worker.id === selectedWorkerId) ?? null;
  const running = selected?.worker.status === "running";
  const connected = selected?.runtime.connected === true;
  const enabledProviders = providers.filter((provider) => provider.enabled);
  const modelsFor = (providerId: string) =>
    enabledProviders.find((provider) => provider.id === providerId)?.models ?? [];

  useEffect(() => {
    if (!selected) return;
    const provider =
      selected.worker.providerId ??
      modelConfiguration?.selection.worker?.providerId ??
      enabledProviders[0]?.id ??
      "";
    setSwitchProvider(provider);
    setSwitchModel(
      selected.worker.modelId ??
        modelConfiguration?.selection.worker?.model ??
        modelsFor(provider)[0]?.id ??
        "",
    );
    // Only reset the switch draft when the selected Worker or its persisted
    // model changes, not on every provider-list revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selected?.worker.id,
    selected?.worker.providerId,
    selected?.worker.modelId,
    modelConfiguration?.selection.worker?.providerId,
    modelConfiguration?.selection.worker?.model,
  ]);
  const canPrompt = connected && selected?.worker.status === "idle";
  const canResume =
    selected !== null && !connected && ["archived", "failed"].includes(selected.worker.status);

  const run = useCallback(
    async (operation: () => Promise<unknown>): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await operation();
        onChanged();
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  async function createWorker(): Promise<void> {
    await run(async () => {
      const created = await api.createWorker({
        projectId,
        vmId: selectedVmId,
        ...(workerProvider ? { providerId: workerProvider } : {}),
        ...(workerModel ? { model: workerModel } : {}),
      });
      setSelectedWorkerId(created.worker.id);
    });
  }

  async function switchSelectedModel(): Promise<void> {
    if (!selected || !switchProvider || !switchModel) return;
    setBusy(true);
    setError(null);
    setSwitchNotice(null);
    try {
      const created = await api.workerSwitchModel(selected.worker.id, {
        providerId: switchProvider,
        model: switchModel,
      });
      setSelectedWorkerId(created.worker.id);
      setSwitchNotice(`已切换到 ${switchProvider} / ${switchModel}，并创建新的 Worker 会话`);
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function resumeWorker(
    workerId: string,
    mode: "auto" | "native" | "summary",
  ): Promise<void> {
    setBusy(true);
    setError(null);
    setResumeNotice(null);
    try {
      const result = await api.workerResume(workerId, { mode });
      setResumeNotice(
        `恢复方式：${result.restoreMode === "native" ? "原生会话" : "归档摘要语义恢复"}${
          result.notice ? ` — ${result.notice}` : ""
        }`,
      );
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function submit(mode: "prompt" | "steer" | "follow_up"): Promise<void> {
    if (!selected || !text.trim()) return;
    await run(async () => {
      if (mode === "prompt") await api.workerPrompt(selected.worker.id, { text: text.trim() });
      if (mode === "steer") await api.workerSteer(selected.worker.id, { text: text.trim() });
      if (mode === "follow_up") await api.workerFollowUp(selected.worker.id, { text: text.trim() });
      setText("");
    });
  }

  return (
    <section id="worker-panel" className="worker-panel" aria-labelledby="worker-panel-title">
      <div className="panel-heading">
        <div>
          <h3 id="worker-panel-title">项目 Worker 会话</h3>
        </div>
        <span className="muted small">
          Guest 只持有短期 Broker 令牌；长期凭据留在宿主机安全存储
        </span>
      </div>
      <p className="muted small">
        Prompt 会创建并排入任务队列；Worker 回合结束后任务进入 Blocked，等待阶段 7
        的独立完成校验，不以模型自称完成作为成功标准。
      </p>
      {error && <div className="notice">{error}</div>}
      {resumeNotice && <div className="validation-box ok">{resumeNotice}</div>}
      <p className="muted small">
        {providers.length === 0
          ? "尚未配置模型 Provider。"
          : `已配置 ${providers.length} 套模型 Provider。`}{" "}
        <a href="#settings">前往“模型与 API 配置”管理或切换</a>
      </p>
      {switchNotice && <div className="validation-box ok">{switchNotice}</div>}

      <div className="action-row worker-create-row">
        <label className="field">
          <span>绑定 VM</span>
          <select
            value={selectedVmId}
            onChange={(event) => setSelectedVmId(event.target.value)}
            disabled={busy}
          >
            {project.bindings.map((binding) => (
              <option key={binding.vm.id} value={binding.vm.id}>
                {binding.vm.name} · {binding.vm.powerState}
                {binding.vm.powerState !== "running" ? "（需先启动）" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Worker Provider</span>
          <select
            value={workerProvider}
            onChange={(event) => {
              setWorkerProvider(event.target.value);
              setWorkerModel(modelsFor(event.target.value)[0]?.id ?? "");
            }}
            disabled={busy}
          >
            <option value="">默认</option>
            {enabledProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.id}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Worker 模型</span>
          <select
            value={workerModel}
            onChange={(event) => setWorkerModel(event.target.value)}
            disabled={busy}
          >
            <option value="">默认</option>
            {modelsFor(workerProvider).map((model) => (
              <option key={model.id} value={model.id}>
                {model.id}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="primary"
          disabled={busy || !selectedVmId}
          onClick={() => void createWorker()}
        >
          启动 Worker
        </button>
        {workers.length === 0 && <span className="muted small">该项目暂无 Worker 会话</span>}
      </div>
      {workers.length > 0 && (
        <div className="worker-layout">
          <div className="worker-list" role="list">
            {workers.map((item) => (
              <button
                key={item.worker.id}
                type="button"
                className={`worker-card ${item.worker.id === selectedWorkerId ? "selected" : ""}`}
                onClick={() => setSelectedWorkerId(item.worker.id)}
              >
                <strong>{item.worker.status}</strong>
                <span className="muted small">
                  {item.runtime.connected ? "RPC 已连接" : "RPC 未连接"} ·{" "}
                  {item.worker.engineVersion ?? "版本未知"}
                </span>
                {item.worker.lastErrorMessage && (
                  <span className="error-line">{item.worker.lastErrorMessage}</span>
                )}
              </button>
            ))}
          </div>

          <div className="worker-conversation">
            {selected && (
              <div className="worker-meta">
                <span>
                  {selected.worker.status} · {selected.runtime.connected ? "已连接" : "未连接"} ·
                  Session {selected.worker.sessionVersion ?? "?"}
                </span>
                <span className="muted small">
                  模型：{selected.worker.providerId ?? "默认"} / {selected.worker.modelId ?? "默认"}
                </span>
                <span className="muted small">
                  归档：{selected.worker.agentSessionRef ? "已保存引用" : "无"}
                  {selected.runtime.restoreMode
                    ? ` · 恢复方式：${selected.runtime.restoreMode === "native" ? "原生" : "摘要"}`
                    : ""}
                </span>
                <div className="worker-switch-model">
                  <label className="field">
                    <span>切换 Provider</span>
                    <select
                      value={switchProvider}
                      onChange={(event) => {
                        setSwitchProvider(event.target.value);
                        setSwitchModel(modelsFor(event.target.value)[0]?.id ?? "");
                      }}
                      disabled={busy || selected.worker.status !== "idle"}
                    >
                      {enabledProviders.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>切换模型</span>
                    <select
                      value={switchModel}
                      onChange={(event) => setSwitchModel(event.target.value)}
                      disabled={busy || selected.worker.status !== "idle"}
                    >
                      {modelsFor(switchProvider).map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="secondary"
                    disabled={
                      busy || selected.worker.status !== "idle" || !switchProvider || !switchModel
                    }
                    onClick={() => void switchSelectedModel()}
                  >
                    切换模型（归档并新建会话）
                  </button>
                </div>
              </div>
            )}
            <div className="worker-messages" aria-live="polite">
              {messages.length === 0 ? (
                <p className="muted small">尚无会话消息。输入任务后 Worker 会开始执行。</p>
              ) : (
                messages.map((message) => (
                  <article key={message.id} className={`chat-message ${message.role}`}>
                    <span className="chat-role">
                      {message.role === "user" ? "用户" : "Worker"} · {message.mode}
                    </span>
                    <p>{message.content}</p>
                  </article>
                ))
              )}
            </div>
            <label className="field">
              <span>消息 / 任务目标</span>
              <textarea
                rows={3}
                value={text}
                maxLength={4000}
                onChange={(event) => setText(event.target.value)}
                placeholder="描述要在 VM 桌面上完成的任务"
                disabled={busy || !connected}
              />
            </label>
            <div className="action-row">
              <button
                type="button"
                className="primary"
                disabled={busy || !canPrompt || !text.trim()}
                onClick={() => void submit("prompt")}
              >
                {running ? "执行中" : "发送任务"}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy || !running || !text.trim()}
                onClick={() => void submit("steer")}
              >
                Steer
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy || !connected || !text.trim()}
                onClick={() => void submit("follow_up")}
              >
                Follow-up
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy || !connected || !running}
                onClick={() => {
                  if (window.confirm("中止当前 Worker 回合？正在进行的桌面操作会被停止。")) {
                    void run(() =>
                      api.workerAbort(selected?.worker.id ?? "", "用户中止 Worker 回合"),
                    );
                  }
                }}
              >
                中止回合
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy || !connected || running}
                onClick={() => void run(() => api.workerArchive(selected?.worker.id ?? ""))}
              >
                归档
              </button>
              {canResume && (
                <>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void resumeWorker(selected?.worker.id ?? "", "auto")}
                  >
                    恢复会话（自动）
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void resumeWorker(selected?.worker.id ?? "", "summary")}
                  >
                    按摘要恢复
                  </button>
                </>
              )}
            </div>
            <p className="muted small">
              Steer 插入当前正在运行的回合；Follow-up 在下一回合加入。取消任务由任务看板触发，
              Worker 会收到 Abort 并释放 Execution Lease。
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
