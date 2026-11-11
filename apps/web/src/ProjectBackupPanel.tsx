/* eslint-disable react-hooks/set-state-in-effect -- backup snapshots reload from the server */
import { useCallback, useEffect, useState } from "react";
import type {
  ProjectBackupImpact,
  ProjectBackupRecord,
  ProjectDetail,
} from "@agent-in-box/protocol";
import { api } from "./api";
import { formatBytes, formatDate } from "./format";

interface ProjectBackupPanelProps {
  project: ProjectDetail;
  revision: number;
  onChanged(): void;
}

export function ProjectBackupPanel({
  project,
  revision,
  onChanged,
}: ProjectBackupPanelProps): React.JSX.Element {
  const [backups, setBackups] = useState<ProjectBackupRecord[]>([]);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [impact, setImpact] = useState<ProjectBackupImpact | null>(null);

  const projectId = project.project.id;

  const load = useCallback(async (): Promise<void> => {
    try {
      setBackups(await api.projectBackups(projectId));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  async function run<T>(operation: () => Promise<T>): Promise<T | null> {
    if (busy) return null;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await operation();
      await load();
      onChanged();
      return result;
    } catch (cause) {
      setError(errorMessage(cause));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function createBackup(): Promise<void> {
    const trimmedLabel = label.trim();
    const created = await run(() =>
      api.createProjectBackup(projectId, trimmedLabel ? { label: trimmedLabel } : {}),
    );
    if (created) {
      setLabel("");
      setMessage(
        `已备份 ${created.bindings.length} 个项目工作目录（${created.artifactSnapshot.length} 个产物引用）。`,
      );
    }
  }

  async function inspect(backup: ProjectBackupRecord): Promise<void> {
    setError(null);
    setMessage(null);
    try {
      setImpact(await api.projectBackupImpact(projectId, backup.id));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function restore(backup: ProjectBackupRecord): Promise<void> {
    if (!impact || impact.backup.id !== backup.id) return;
    const restored = await run(() =>
      api.restoreProjectBackup(projectId, backup.id, { confirm: true }),
    );
    if (restored) {
      setImpact(null);
      setMessage("项目工作目录已恢复；共享 VM 的其他项目目录和系统状态未回滚。");
    }
  }

  async function verify(backup: ProjectBackupRecord): Promise<void> {
    const result = await run(() => api.verifyProjectBackup(projectId, backup.id));
    if (result) {
      setMessage(
        result.ok
          ? `备份校验通过：${result.bindings.length} 个工作目录和 ${result.artifacts.length} 个产物引用哈希一致。`
          : "备份校验失败：存在缺失或哈希不一致的文件。",
      );
    }
  }

  async function remove(backup: ProjectBackupRecord): Promise<void> {
    if (!window.confirm(`删除项目备份「${backup.label}」会移除备份文件。确定继续吗？`)) return;
    const removed = await run(() => api.deleteProjectBackup(projectId, backup.id));
    if (removed) setMessage("项目备份已删除。");
  }

  return (
    <section className="task-workspace" aria-labelledby="project-backup-title">
      <div className="section-heading">
        <div>
          <h3 id="project-backup-title">项目目录备份</h3>
          <span className="muted small">
            备份项目绑定的 Guest 工作目录和产物引用；恢复只覆盖本项目目录，不使用整机快照回滚。
          </span>
        </div>
      </div>
      {error && <div className="notice">{error}</div>}
      {message && <div className="notice ok">{message}</div>}

      <div className="action-row">
        <input
          value={label}
          maxLength={80}
          placeholder="备份标签（可选）"
          onChange={(event) => setLabel(event.target.value)}
        />
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void createBackup()}
        >
          {busy ? "处理中…" : "创建项目备份"}
        </button>
        <span className="muted small">
          需要 VM 运行且该项目没有活动任务或活动 Worker；共享目录冲突会阻止恢复。
        </span>
      </div>

      {backups.length === 0 ? (
        <p className="muted small">还没有项目备份。</p>
      ) : (
        <ul className="plain-list backup-list">
          {backups.map((backup) => (
            <li key={backup.id}>
              <div>
                <strong>{backup.label}</strong>
                <span className="muted small">
                  {" "}
                  · {formatDate(backup.createdAt)} · {BACKUP_STATUS_LABELS[backup.status]} ·{" "}
                  {backup.bindings.length} 个目录 · {backup.artifactSnapshot.length} 个产物引用
                </span>
                <div className="muted small">
                  {backup.bindings.map((binding) => (
                    <div key={binding.id}>
                      {binding.vmName} · <code>{binding.guestWorkspacePath}</code> ·{" "}
                      {binding.sizeBytes !== null ? formatBytes(binding.sizeBytes) : "—"} ·{" "}
                      {binding.fileCount ?? "—"} 个文件
                      {binding.status === "failed" && binding.errorMessage
                        ? ` · 失败：${binding.errorMessage}`
                        : ""}
                    </div>
                  ))}
                </div>
                {backup.errorMessage && <p className="error-line small">{backup.errorMessage}</p>}
              </div>
              <div className="button-row">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void inspect(backup)}
                >
                  检查恢复影响
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void verify(backup)}
                >
                  校验
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => void remove(backup)}
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {impact && (
        <div className="notice" role="alertdialog">
          <strong>恢复影响：{impact.backup.label}</strong>
          <p>{impact.warning}</p>
          {impact.otherProjects.length > 0 && (
            <p className="muted small">
              共享 VM 上的其他项目不会被恢复：
              {impact.otherProjects.map((other) => other.name).join("、")}
            </p>
          )}
          {impact.conflicts.length > 0 && (
            <ul className="plain-list">
              {impact.conflicts.map((conflict) => (
                <li key={`${conflict.bindingId}-${conflict.reason}`}>
                  <span className="error-line small">{conflict.message}</span>
                  {conflict.affectedProjects.length > 0 && (
                    <span className="muted small">
                      {" "}
                      涉及项目：{conflict.affectedProjects.map((other) => other.name).join("、")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="button-row">
            <button
              type="button"
              className="danger"
              disabled={busy || impact.blocked}
              onClick={() => void restore(impact.backup)}
            >
              {busy ? "恢复中…" : "确认恢复本项目目录"}
            </button>
            <button type="button" className="secondary" onClick={() => setImpact(null)}>
              取消
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

const BACKUP_STATUS_LABELS: Record<ProjectBackupRecord["status"], string> = {
  creating: "创建中",
  available: "可用",
  failed: "失败",
  restoring: "恢复中",
  restored: "已恢复",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
