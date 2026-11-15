/* eslint-disable react-hooks/set-state-in-effect -- worker snapshots refresh from server events */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationMessageRecord, WorkerView } from "@agent-in-box/protocol";
import { api, subscribeTaskEvents } from "./api";

interface WorkerConversationProps {
  workerId: string | null;
  revision: number;
  compact?: boolean;
  onChanged?(): void;
}

export function WorkerConversation({
  workerId,
  revision,
  compact = false,
  onChanged,
}: WorkerConversationProps): React.JSX.Element {
  const [worker, setWorker] = useState<WorkerView | null>(null);
  const [messages, setMessages] = useState<ConversationMessageRecord[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadRequest = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const request = ++loadRequest.current;
    if (!workerId) {
      setWorker(null);
      setMessages([]);
      return;
    }
    try {
      const [nextWorker, nextMessages] = await Promise.all([
        api.worker(workerId),
        api.workerMessages(workerId),
      ]);
      if (loadRequest.current !== request) return;
      setWorker(nextWorker);
      setMessages(nextMessages);
      setError(null);
    } catch (cause) {
      if (loadRequest.current !== request) return;
      setError(errorMessage(cause));
    }
  }, [workerId]);

  useEffect(() => {
    // A stale response must never be shown under the newly selected Worker.
    setWorker(null);
    setMessages([]);
    setError(null);
  }, [workerId]);

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

  async function submit(): Promise<void> {
    if (!workerId || !text.trim() || !worker) return;
    setBusy(true);
    setError(null);
    try {
      if (worker.worker.status === "running") {
        await api.workerSteer(workerId, { text: text.trim() });
      } else if (worker.worker.status === "idle") {
        await api.workerPrompt(workerId, { text: text.trim() });
      } else {
        await api.workerFollowUp(workerId, { text: text.trim() });
      }
      setText("");
      await load();
      onChanged?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function abort(): Promise<void> {
    if (!workerId) return;
    setBusy(true);
    setError(null);
    try {
      await api.workerAbort(workerId);
      await load();
      onChanged?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!workerId) {
    return <p className="muted small">选择一个会话查看执行详情。</p>;
  }

  const running = worker?.worker.status === "running";
  const connected = worker?.runtime.connected === true;

  const composer = (
    <div className="chat-composer">
      <textarea
        aria-label="消息"
        rows={compact ? 2 : 3}
        value={text}
        maxLength={4000}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!busy && connected && text.trim()) void submit();
          }
        }}
        placeholder={running ? "补充要求，发送后立即指导当前任务" : "描述要在 VM 桌面完成的任务"}
        disabled={busy || !connected}
      />
      <div className="composer-toolbar">
        <span className="composer-hint">Enter 发送 · Shift + Enter 换行</span>
        <div className="composer-actions">
          {running && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void abort()}
            >
              停止
            </button>
          )}
          <button
            type="button"
            className="primary composer-send"
            disabled={busy || !connected || !text.trim()}
            onClick={() => void submit()}
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className={`conversation-page worker-conversation${compact ? " compact" : ""}`}>
      <div className="conversation-scroll">
        <div className="conversation-column">
          {running && (
            <p className="conversation-running" role="status">
              <span className="workspace-dot running" aria-hidden="true" />
              正在执行任务
            </p>
          )}
          {!connected && worker && <p className="muted">执行环境尚未连接，暂时无法发送消息。</p>}
          {error && <div className="notice">{error}</div>}
          <div className="worker-messages" aria-live="polite">
            {messages.length === 0 ? (
              <div className="worker-empty">
                <h2>准备开始</h2>
                <p className="muted">在下方描述任务，Agent 会在项目绑定的虚拟机中执行。</p>
              </div>
            ) : (
              messages.map((message) => (
                <article key={message.id} className={`chat-message ${message.role}`}>
                  {message.role !== "user" && <span className="chat-role">Agent</span>}
                  <p>{message.content}</p>
                </article>
              ))
            )}
          </div>
        </div>
      </div>
      <div className="conversation-composer">{composer}</div>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
