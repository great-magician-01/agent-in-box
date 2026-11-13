/* eslint-disable react-hooks/set-state-in-effect -- server snapshots refresh from event revisions */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActiveRosterView,
  WorkerArchiveRecord,
  WorkerArchiveSearchResult,
  WorkerSummaryView,
} from "@agent-in-box/protocol";
import { api } from "./api";

interface WorkerRegistryPanelProps {
  revision: number;
  onChanged(): void;
}

interface RestoreNotice {
  workerId: string;
  restoreMode: "native" | "summary";
  notice: string | null;
}

export function WorkerRegistryPanel({
  revision,
  onChanged,
}: WorkerRegistryPanelProps): React.JSX.Element {
  const [roster, setRoster] = useState<ActiveRosterView | null>(null);
  const [archives, setArchives] = useState<WorkerArchiveSearchResult | null>(null);
  const [query, setQuery] = useState("");
  const queryRef = useRef("");
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [summary, setSummary] = useState<WorkerSummaryView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restore, setRestore] = useState<RestoreNotice | null>(null);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  const load = useCallback(async (archiveQuery?: string): Promise<void> => {
    try {
      const trimmed = (archiveQuery ?? queryRef.current).trim();
      const [nextRoster, nextArchives] = await Promise.all([
        api.activeRoster(),
        api.searchWorkerArchives(trimmed ? { query: trimmed } : {}),
      ]);
      setRoster(nextRoster);
      setArchives(nextArchives);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revision]);

  useEffect(() => {
    if (!selectedWorkerId) {
      setSummary(null);
      return;
    }
    let active = true;
    void api
      .workerSummary(selectedWorkerId)
      .then((next) => {
        if (active) setSummary(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [selectedWorkerId, revision]);

  async function resumeWorker(workerId: string): Promise<void> {
    setBusy(true);
    setError(null);
    setRestore(null);
    try {
      const result = await api.workerResume(workerId, { mode: "auto" });
      setRestore({
        workerId,
        restoreMode: result.restoreMode,
        notice: result.notice,
      });
      await load();
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function restoreArchive(archive: WorkerArchiveRecord): Promise<void> {
    setBusy(true);
    setError(null);
    setRestore(null);
    try {
      const created = await api.createWorker({
        projectId: archive.projectId,
        vmId: archive.vmId,
        conversationId: archive.conversationId,
        restoreArchiveId: archive.id,
      });
      setRestore({
        workerId: created.worker.id,
        restoreMode: "summary",
        notice: "已按归档摘要启动新的 Agent Session；截图和环境变化已注入首回合。",
      });
      await load();
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel registry-panel" aria-labelledby="registry-panel-title">
      <div className="panel-heading">
        <div>
          <h3 id="registry-panel-title">Worker 注册表与归档</h3>
        </div>
        <span className="muted small">
          {roster?.workers.length ?? 0} 个活跃 Worker · {archives?.items.length ?? 0} 条归档结果
        </span>
      </div>
      <p className="muted small">
        Active Roster 完全由数据库重建；归档 Worker 不再进入 Router
        默认上下文，但摘要、会话引用和产物仍可搜索。
      </p>
      {error && <div className="notice">{error}</div>}
      {restore && (
        <div className="validation-box ok">
          <strong>
            Worker {restore.workerId} 已恢复 ·{" "}
            {restore.restoreMode === "native" ? "原生会话" : "摘要语义恢复"}
          </strong>
          {restore.notice && <span className="muted small">{restore.notice}</span>}
        </div>
      )}

      <div className="registry-layout">
        <div>
          <h4 className="registry-heading">活跃 Worker</h4>
          {!roster || roster.workers.length === 0 ? (
            <p className="muted small">
              当前没有活跃 Worker。任务进入 VM 队列后由空闲 Worker 认领。
            </p>
          ) : (
            <div className="registry-cards">
              {roster.workers.map((card) => (
                <button
                  key={card.workerId}
                  type="button"
                  className={`registry-card ${selectedWorkerId === card.workerId ? "selected" : ""}`}
                  onClick={() => setSelectedWorkerId(card.workerId)}
                >
                  <span className={`pill ${card.status === "running" ? "live" : "ok"}`}>
                    {card.status}
                  </span>
                  <strong>
                    {card.projectName} · {card.vmName} ({card.vmPowerState})
                  </strong>
                  <span className="muted small">
                    队列 {card.queueDepth} · 审批 {card.pendingApprovals} · 待处理消息{" "}
                    {card.pendingInputs}
                  </span>
                  <span className="muted small">
                    当前：{card.currentTask?.objective ?? card.recentTask?.objective ?? "空闲"}
                  </span>
                  <span className="muted small">
                    最后活跃 {new Date(card.lastActiveAt).toLocaleString("zh-CN")}
                  </span>
                </button>
              ))}
            </div>
          )}

          {summary && (
            <div className="registry-summary">
              <div className="panel-heading">
                <h4>Worker 摘要</h4>
                <span className="muted small">
                  归档阻塞：{summary.archiveBlockers.blocked ? "是" : "否"}
                </span>
              </div>
              {summary.archiveBlockers.reasons.length > 0 && (
                <ul className="usage-list">
                  {summary.archiveBlockers.reasons.map((reason) => (
                    <li key={reason}>
                      <span className="error-line">{reason}</span>
                    </li>
                  ))}
                </ul>
              )}
              <ul className="usage-list">
                {summary.recentTasks.length === 0 ? (
                  <li>
                    <span className="muted small">没有已分配任务</span>
                  </li>
                ) : (
                  summary.recentTasks.map((task) => (
                    <li key={task.id}>
                      <span>[{task.status}]</span>
                      <span className="muted">{task.objective}</span>
                    </li>
                  ))
                )}
              </ul>
              {summary.latestArchive && (
                <div className="validation-box">
                  <strong>最近归档</strong>
                  <span className="muted small">{summary.latestArchive.summary}</span>
                  <span className="muted small">
                    {summary.latestArchive.source} · {summary.latestArchive.status} ·{" "}
                    {new Date(summary.latestArchive.createdAt).toLocaleString("zh-CN")}
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void resumeWorker(summary.worker.id)}
                  >
                    {busy ? "恢复中…" : "恢复会话（自动选择原生/摘要）"}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <div>
          <h4 className="registry-heading">归档检索</h4>
          <div className="action-row">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索任务目标、摘要、产物或归档引用"
              aria-label="归档检索关键词"
            />
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void load(query)}
            >
              搜索
            </button>
          </div>
          {!archives || archives.items.length === 0 ? (
            <p className="muted small">没有匹配的归档。</p>
          ) : (
            <ul className="archive-list">
              {archives.items.map((archive) => (
                <li key={archive.id} className="archive-card">
                  <strong>
                    {archive.source} · {archive.status}
                  </strong>
                  <span className="muted small">
                    Worker {archive.workerId} ·{" "}
                    {new Date(archive.createdAt).toLocaleString("zh-CN")}
                  </span>
                  <p className="muted small">{archive.summary}</p>
                  {archive.artifacts.length > 0 && (
                    <span className="muted small">
                      产物：{archive.artifacts.map((item) => item.name).join(", ")}
                    </span>
                  )}
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void restoreArchive(archive)}
                  >
                    从摘要恢复为新 Worker
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
