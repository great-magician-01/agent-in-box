/* eslint-disable react-hooks/set-state-in-effect -- worker snapshots refresh from server events */
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, Send, Square } from "lucide-react";
import type { ConversationMessageRecord, WorkerView } from "@agent-in-box/protocol";
import { api, subscribeTaskEvents } from "./api";
import { MarkdownContent } from "./MarkdownContent";
import { useConversationScroll } from "./useConversationScroll";

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
  const contextEpoch = useRef(0);
  const loadRequest = useRef(0);
  const operationEpoch = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const request = ++loadRequest.current;
    const epoch = contextEpoch.current;
    const targetWorkerId = workerId;
    if (!targetWorkerId) {
      if (contextEpoch.current === epoch && loadRequest.current === request) {
        setWorker(null);
        setMessages([]);
      }
      return;
    }
    try {
      const [nextWorker, nextMessages] = await Promise.all([
        api.worker(targetWorkerId),
        api.workerMessages(targetWorkerId),
      ]);
      if (contextEpoch.current !== epoch || loadRequest.current !== request) return;
      setWorker(nextWorker);
      setMessages(nextMessages);
      setError(null);
    } catch (cause) {
      if (contextEpoch.current !== epoch || loadRequest.current !== request) return;
      setError(errorMessage(cause));
    }
  }, [workerId]);

  useEffect(() => {
    const epoch = ++contextEpoch.current;
    // Invalidate both loads and commands from the previously selected Worker.
    operationEpoch.current += 1;
    loadRequest.current += 1;
    setWorker(null);
    setMessages([]);
    setText("");
    setBusy(false);
    setError(null);
    return () => {
      if (contextEpoch.current !== epoch) return;
      contextEpoch.current += 1;
      operationEpoch.current += 1;
      loadRequest.current += 1;
    };
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
    if (!workerId || !text.trim() || !worker || busy) return;
    const targetWorkerId = workerId;
    const epoch = contextEpoch.current;
    const operation = ++operationEpoch.current;
    const submittedText = text.trim();
    const status = worker.worker.status;
    const isCurrent = (): boolean =>
      contextEpoch.current === epoch && operationEpoch.current === operation;
    setBusy(true);
    setError(null);
    try {
      if (status === "running") {
        await api.workerSteer(targetWorkerId, { text: submittedText });
      } else if (status === "idle") {
        await api.workerPrompt(targetWorkerId, { text: submittedText });
      } else {
        await api.workerFollowUp(targetWorkerId, { text: submittedText });
      }
      if (!isCurrent()) return;
      setText("");
      await load();
      if (!isCurrent()) return;
      jumpToLatest();
      onChanged?.();
    } catch (cause) {
      if (isCurrent()) setError(errorMessage(cause));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  async function abort(): Promise<void> {
    if (!workerId || busy) return;
    const targetWorkerId = workerId;
    const epoch = contextEpoch.current;
    const operation = ++operationEpoch.current;
    const isCurrent = (): boolean =>
      contextEpoch.current === epoch && operationEpoch.current === operation;
    setBusy(true);
    setError(null);
    try {
      await api.workerAbort(targetWorkerId);
      if (!isCurrent()) return;
      await load();
      if (!isCurrent()) return;
      onChanged?.();
    } catch (cause) {
      if (isCurrent()) setError(errorMessage(cause));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  const running = worker?.worker.status === "running";
  const connected = worker?.runtime.connected === true;
  const lastMessage = messages.at(-1);
  const {
    scrollRef: conversationRef,
    showJump,
    onScroll,
    jumpToLatest,
  } = useConversationScroll(
    `${messages.length}:${lastMessage?.id ?? ""}:${lastMessage?.content.length ?? 0}`,
    workerId,
  );

  if (!workerId) {
    return <p className="muted small">选择一个会话查看执行详情。</p>;
  }

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
              <Square aria-hidden="true" />
              停止
            </button>
          )}
          <button
            type="button"
            className="primary composer-send"
            disabled={busy || !connected || !text.trim()}
            onClick={() => void submit()}
          >
            <Send aria-hidden="true" />
            发送
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className={`conversation-page worker-conversation${compact ? " compact" : ""}`}>
      <div className="conversation-body">
        <div className="conversation-scroll" ref={conversationRef} onScroll={onScroll}>
          <div className="conversation-column">
            {running && (
              <p className="conversation-running" role="status">
                <span className="workspace-dot running" aria-hidden="true" />
                正在执行任务
              </p>
            )}
            {!connected && worker && <p className="muted">执行环境尚未连接，暂时无法发送消息。</p>}
            {error && (
              <div className="notice" role="alert">
                {error}
              </div>
            )}
            <div className="worker-messages">
              {messages.length === 0 ? (
                <div className="worker-empty">
                  <h2>准备开始</h2>
                  <p className="muted">在下方描述任务，Agent 会在项目绑定的虚拟机中执行。</p>
                </div>
              ) : (
                messages.map((message) => (
                  <article
                    key={message.id}
                    className={`chat-message ${message.role}`}
                    aria-label={message.role === "user" ? "你的消息" : "Agent 的回答"}
                  >
                    {message.role !== "user" && <span className="chat-role">Agent</span>}
                    <MarkdownContent content={message.content} />
                  </article>
                ))
              )}
            </div>
          </div>
        </div>
        {showJump && (
          <button type="button" className="jump-latest" onClick={jumpToLatest}>
            <ArrowDown aria-hidden="true" />
            回到最新
          </button>
        )}
      </div>
      <div className="conversation-composer">{composer}</div>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
