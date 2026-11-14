/* eslint-disable react-hooks/set-state-in-effect -- initial snapshot and project changes load server state */
import { useCallback, useEffect, useRef, useState } from "react";
import type { InboxFileRecord } from "@agent-in-box/protocol";
import { api } from "./api";
import { formatBytes, formatDate } from "./format";

interface FileInboxPanelProps {
  projectId: string | null;
  revision?: number;
}

export function InboxDownloadLink({ file }: { file: InboxFileRecord }): React.JSX.Element {
  return (
    <a
      className="link-button"
      href={`/api/v1/inbox/${encodeURIComponent(file.id)}/content`}
      download={file.originalName}
    >
      下载
    </a>
  );
}

export function FileInboxPanel({
  projectId,
  revision = 0,
}: FileInboxPanelProps): React.JSX.Element {
  const [files, setFiles] = useState<InboxFileRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await api.inbox(projectId);
      setFiles(result.items);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  async function upload(list: FileList | File[]): Promise<void> {
    const selected = [...list];
    if (selected.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    let uploaded = 0;
    try {
      for (const file of selected) {
        await api.uploadInboxFile(file, projectId);
        uploaded += 1;
      }
      setMessage(`已投递 ${uploaded} 个文件到本地数据目录。`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(file: InboxFileRecord): Promise<void> {
    if (!window.confirm(`删除 inbox 文件「${file.originalName}」？`)) return;
    setBusy(true);
    try {
      await api.deleteInboxFile(file.id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel inbox-panel" aria-labelledby="inbox-title">
      <div className="panel-heading">
        <div>
          <h2 id="inbox-title">文件投递</h2>
        </div>
        <span className="muted small">{files.length} 个文件</span>
      </div>
      <p className="muted small">
        将文件拖入下方区域或选择文件。文件保存在本机数据目录的 inbox 中，不会自动复制到 VM；需要
        Guest 使用时请由 Worker 或人工传输。
      </p>
      <div
        className={`drop-zone ${dragging ? "dragging" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          void upload(event.dataTransfer.files);
        }}
        role="region"
        aria-label="拖放文件到本机投递目录"
      >
        <span className="drop-icon" aria-hidden="true">
          ⇣
        </span>
        <strong>{busy ? "正在投递…" : "拖放文件到这里"}</strong>
        <span className="muted small">或</span>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          选择文件
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="visually-hidden"
          aria-label="选择要投递的文件"
          onChange={(event) => {
            if (event.target.files) void upload(event.target.files);
            event.target.value = "";
          }}
        />
      </div>
      {message && (
        <p className="muted small" role="status">
          {message}
        </p>
      )}
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
      {files.length > 0 && (
        <ul className="file-list">
          {files.map((file) => (
            <li key={file.id}>
              <div>
                <strong>{file.originalName}</strong>
                <span className="muted small">
                  {formatBytes(file.sizeBytes)} · {formatDate(file.createdAt)} · SHA-256{" "}
                  <code>{file.sha256.slice(0, 12)}…</code>
                </span>
              </div>
              <div className="action-row">
                <InboxDownloadLink file={file} />
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  onClick={() => void remove(file)}
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
