/* eslint-disable react-hooks/set-state-in-effect -- worker snapshots refresh from server events */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationMessageRecord, WorkerView } from "@agent-in-box/protocol";
import { api } from "./api";

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
  const [notice, setNotice] = useState<string | null>(null);
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
    setNotice(null);
  }, [workerId]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  async function submit(mode: "prompt" | "steer" | "follow_up"): Promise<void> {
    if (!workerId || !text.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "prompt") await api.workerPrompt(workerId, { text: text.trim() });
      if (mode === "steer") await api.workerSteer(workerId, { text: text.trim() });
      if (mode === "follow_up") await api.workerFollowUp(workerId, { text: text.trim() });
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
      setNotice("已请求中止 Worker 当前回合");
      await load();
      onChanged?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!workerId) {
    return <p className="muted small">选择一个 Worker 会话查看消息。</p>;
  }

  const running = worker?.worker.status === "running";
  const connected = worker?.runtime.connected === true;
  const canPrompt = connected && worker?.worker.status === "idle";

  return (
    <div className={`worker-conversation${compact ? " compact" : ""}`}>
      <div className="worker-meta">
        <span>
          {worker?.worker.status ?? "读取中"} · {connected ? "RPC 已连接" : "RPC 未连接"}
        </span>
        <span className="muted small">
          模型：{worker?.worker.providerId ?? "默认"} / {worker?.worker.modelId ?? "默认"}
        </span>
        {worker?.runtime.restoreMode && (
          <span className="muted small">
            恢复：{worker.runtime.restoreMode === "native" ? "原生会话" : "摘要会话"}
          </span>
        )}
      </div>
      {error && <div className="notice">{error}</div>}
      {notice && <div className="validation-box ok">{notice}</div>}
      <div className="worker-messages" aria-live="polite">
        {messages.length === 0 ? (
          <p className="muted small">尚无会话消息。</p>
        ) : (
          messages.map((message) => (
            <article key={message.id} className={`chat-message ${message.role}`}>
              <span className="chat-role">
                {message.role === "user" ? "用户" : "Worker"} · {message.mode} ·{" "}
                {new Date(message.createdAt).toLocaleTimeString("zh-CN")}
              </span>
              <p>{message.content}</p>
            </article>
          ))
        )}
      </div>
      <label className="field">
        <span>{compact ? "发送到 Worker" : "消息 / 任务目标"}</span>
        <textarea
          rows={compact ? 2 : 3}
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
          disabled={busy || !connected}
          onClick={() => void abort()}
        >
          中止
        </button>
      </div>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
