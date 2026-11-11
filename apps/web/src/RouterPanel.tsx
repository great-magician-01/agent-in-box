/* eslint-disable react-hooks/set-state-in-effect -- server snapshots refresh from event revisions */
import { useCallback, useEffect, useState } from "react";
import type {
  RouterMessageRecord,
  RouterToolCallRecord,
  RouterToolDefinition,
  RouterView,
} from "@agent-in-box/protocol";
import { api } from "./api";

interface RouterPanelProps {
  revision: number;
  onChanged(): void;
}

export function RouterPanel({ revision, onChanged }: RouterPanelProps): React.JSX.Element {
  const [view, setView] = useState<RouterView | null>(null);
  const [messages, setMessages] = useState<RouterMessageRecord[]>([]);
  const [tools, setTools] = useState<RouterToolDefinition[]>([]);
  const [toolCalls, setToolCalls] = useState<RouterToolCallRecord[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [nextView, nextMessages, nextTools, nextCalls] = await Promise.all([
        api.router(),
        api.routerMessages(100),
        api.routerTools(),
        api.routerToolCalls(50),
      ]);
      setView(nextView);
      setMessages(nextMessages);
      setTools(nextTools);
      setToolCalls(nextCalls);
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
    setNotice(null);
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

  const running = view?.status === "running";

  return (
    <section className="panel router-panel" aria-labelledby="router-panel-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">LOCAL ROUTER / STRUCTURED TOOLS</p>
          <h2 id="router-panel-title">Router 主会话</h2>
        </div>
        <span className={`pill ${view?.status === "failed" ? "warn" : running ? "live" : "ok"}`}>
          {view?.status === "failed" ? "失败" : running ? "处理中" : "空闲"}
        </span>
      </div>
      <p className="muted small">
        Router 只拥有项目、任务、Worker、看板和归档工具；没有 VM 输入、Shell 或 Supervisor
        接口。任务完成后由看板和工作证据判定，Router 不能自行宣告完成。
      </p>
      {view && (
        <div className="router-meta">
          <span>
            Provider {view.providerId ?? "未配置"} · Model {view.modelId ?? "未配置"} ·{" "}
            {view.messageCount} 条消息
          </span>
          <span className="muted small">{tools.length} 个结构化工具</span>
        </div>
      )}
      {view?.lastError && <div className="notice">{view.lastError}</div>}
      {error && <div className="notice">{error}</div>}
      {notice && <div className="validation-box ok">{notice}</div>}

      <div className="router-layout">
        <div className="router-conversation">
          <div className="worker-messages" aria-live="polite">
            {messages.length === 0 ? (
              <p className="muted small">
                尚无 Router 消息。描述目标，Router 会先查询项目与已有 Worker，再创建或复用任务。
              </p>
            ) : (
              messages.map((message) => (
                <article key={message.id} className={`chat-message ${message.role}`}>
                  <span className="chat-role">
                    {message.role === "user" ? "用户" : "Router"} ·{" "}
                    {new Date(message.createdAt).toLocaleTimeString("zh-CN")}
                  </span>
                  <p>{message.content}</p>
                </article>
              ))
            )}
          </div>
          <label className="field">
            <span>Router 消息</span>
            <textarea
              rows={3}
              value={text}
              maxLength={20000}
              onChange={(event) => setText(event.target.value)}
              placeholder="例如：在项目 X 中整理本周发票并输出报表"
              disabled={busy}
            />
          </label>
          <div className="action-row">
            <button
              type="button"
              className="primary"
              disabled={busy || running || !text.trim()}
              onClick={() => void send()}
            >
              {running ? "Router 处理中" : "发送给 Router"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || !running}
              onClick={() => void abort()}
            >
              中止 Router 回合
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => void load()}>
              刷新
            </button>
          </div>
        </div>

        <aside className="router-side">
          <details className="provider-config" open>
            <summary>Router 工具面（{tools.length}）</summary>
            <ul className="provider-list">
              {tools.map((tool) => (
                <li key={tool.name}>
                  <strong>{tool.name}</strong>
                  <span className="muted small">{tool.description}</span>
                </li>
              ))}
            </ul>
          </details>
          <details className="provider-config">
            <summary>最近工具调用（{toolCalls.length}）</summary>
            {toolCalls.length === 0 ? (
              <p className="muted small">尚无工具调用。</p>
            ) : (
              <ul className="provider-list">
                {toolCalls
                  .slice()
                  .reverse()
                  .map((call) => (
                    <li key={call.id}>
                      <strong>
                        {call.toolName} · {call.status} · {call.durationMs}ms
                      </strong>
                      <span className="muted small">
                        {new Date(call.createdAt).toLocaleTimeString("zh-CN")}
                      </span>
                      {call.errorMessage && <span className="error-line">{call.errorMessage}</span>}
                    </li>
                  ))}
              </ul>
            )}
          </details>
        </aside>
      </div>
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
