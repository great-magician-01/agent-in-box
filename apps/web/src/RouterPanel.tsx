/* eslint-disable react-hooks/set-state-in-effect -- server snapshots refresh from event revisions */
import { useCallback, useEffect, useState } from "react";
import type {
  ModelConfigurationView,
  RouterMessageRecord,
  RouterToolCallRecord,
  RouterView,
} from "@agent-in-box/protocol";
import { api } from "./api";

interface RouterPanelProps {
  revision: number;
  onChanged(): void;
  onOpenSettings?(): void;
}

export function RouterPanel({
  revision,
  onChanged,
  onOpenSettings,
}: RouterPanelProps): React.JSX.Element {
  const [view, setView] = useState<RouterView | null>(null);
  const [messages, setMessages] = useState<RouterMessageRecord[]>([]);
  const [toolCalls, setToolCalls] = useState<RouterToolCallRecord[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelConfig, setModelConfig] = useState<ModelConfigurationView | null>(null);
  const [switchProvider, setSwitchProvider] = useState("");
  const [switchModel, setSwitchModel] = useState("");

  const load = useCallback(async (): Promise<void> => {
    try {
      const [nextView, nextMessages, nextCalls, nextModels] = await Promise.all([
        api.router(),
        api.routerMessages(100),
        api.routerToolCalls(50),
        api.modelConfiguration().catch(() => null),
      ]);
      setView(nextView);
      setMessages(nextMessages);
      setToolCalls(nextCalls);
      setModelConfig(nextModels);
      setSwitchProvider(
        (current) =>
          current || nextView.selectedProviderId || nextModels?.selection.router?.providerId || "",
      );
      setSwitchModel(
        (current) =>
          current || nextView.selectedModelId || nextModels?.selection.router?.model || "",
      );
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revision]);

  async function send(): Promise<void> {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.routerSend(text.trim());
      setText("");
      await load();
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function abort(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.routerAbort();
      await load();
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function applyModel(providerId: string, model: string): Promise<void> {
    setSwitchProvider(providerId);
    setSwitchModel(model);
    setBusy(true);
    setError(null);
    try {
      await api.routerConfigure({ providerId, model });
      await load();
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const running = view?.status === "running";
  const enabledProviders = (modelConfig?.providers ?? []).filter((provider) => provider.enabled);
  const selectedModel = JSON.stringify([switchProvider, switchModel]);

  const composer = (
    <div className="chat-composer">
      <textarea
        aria-label="消息"
        rows={3}
        value={text}
        maxLength={20000}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!busy && !running && text.trim()) void send();
          }
        }}
        placeholder="描述你想完成的任务"
        disabled={busy}
      />
      <div className="composer-toolbar">
        {enabledProviders.length > 0 && !view?.selectionLockedByEnv ? (
          <select
            aria-label="当前模型"
            className="composer-model"
            value={selectedModel}
            disabled={busy || running}
            onChange={(event) => {
              const [providerId, model] = JSON.parse(event.target.value) as [string, string];
              void applyModel(providerId, model);
            }}
          >
            {enabledProviders.flatMap((provider) =>
              provider.models.map((model) => (
                <option
                  key={`${provider.id}-${model.id}`}
                  value={JSON.stringify([provider.id, model.id])}
                >
                  {provider.id} / {model.id}
                </option>
              )),
            )}
          </select>
        ) : (
          <span />
        )}
        {running ? (
          <button
            type="button"
            className="secondary composer-send"
            disabled={busy}
            onClick={() => void abort()}
          >
            停止
          </button>
        ) : (
          <button
            type="button"
            className="primary composer-send"
            disabled={busy || !text.trim() || enabledProviders.length === 0}
            onClick={() => void send()}
          >
            发送
          </button>
        )}
      </div>
    </div>
  );

  return (
    <section className="conversation-page router-panel" aria-label="主会话">
      {messages.length === 0 ? (
        <div className="chat-empty">
          <h2>有什么需要完成的？</h2>
          {enabledProviders.length === 0 ? (
            <div className="configuration-hint">
              <p>先配置一个模型服务，就可以开始对话。</p>
              {onOpenSettings && (
                <button type="button" className="primary" onClick={onOpenSettings}>
                  配置模型
                </button>
              )}
            </div>
          ) : (
            composer
          )}
        </div>
      ) : (
        <>
          <div className="conversation-scroll">
            <div className="conversation-column">
              <div className="worker-messages" aria-live="polite">
                {messages.map((message) => (
                  <article key={message.id} className={`chat-message ${message.role}`}>
                    {message.role !== "user" && <span className="chat-role">Agent</span>}
                    <p>{message.content}</p>
                  </article>
                ))}
              </div>
              {toolCalls.length > 0 && (
                <details className="conversation-tools">
                  <summary>最近使用了 {toolCalls.length} 次工具</summary>
                  <ul>
                    {toolCalls
                      .slice()
                      .reverse()
                      .slice(0, 10)
                      .map((call) => (
                        <li key={call.id}>
                          <span>{call.toolName}</span>
                          <span className={call.status === "error" ? "error-line" : "muted"}>
                            {call.status === "error" ? "失败" : "完成"}
                          </span>
                          {call.errorMessage && <p className="error-line">{call.errorMessage}</p>}
                        </li>
                      ))}
                  </ul>
                </details>
              )}
            </div>
          </div>
          <div className="conversation-composer">{composer}</div>
        </>
      )}
      {view?.lastError && <div className="notice conversation-notice">{view.lastError}</div>}
      {error && <div className="notice conversation-notice">{error}</div>}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
