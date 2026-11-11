import { useEffect, useRef, useState } from "react";
import type { DesktopBridge, LocalAuthSessionView } from "@agent-in-box/protocol";
import { api, ApiRequestError } from "./api";

interface LoginScreenProps {
  info: LocalAuthSessionView;
  bridge: DesktopBridge | null;
  onAuthenticated(session: LocalAuthSessionView): void;
}

export function LoginScreen({
  info,
  bridge,
  onAuthenticated,
}: LoginScreenProps): React.JSX.Element {
  const [accessKey, setAccessKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!bridge) {
      inputRef.current?.focus();
    }
  }, [bridge]);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!accessKey.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await api.login({
        accessKey: accessKey.trim(),
        label: bridge ? "desktop-renderer" : "local-browser",
      });
      setAccessKey("");
      onAuthenticated(session);
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel login-panel" aria-labelledby="login-title">
      <p className="eyebrow">LOCAL AUTHENTICATION</p>
      <h2 id="login-title">解锁本地 Web</h2>
      <p className="muted">
        控制平面只监听本机回环地址，但仍然要求本机访问密钥。仅绑定 127.0.0.1
        不等于无需认证，其他本机网页不能直接调用管理 API。
      </p>
      {bridge ? (
        <div className="notice">
          桌面应用会自动使用本机访问密钥建立会话。如果长时间停留在此页，请重启本地服务或打开日志目录检查。
        </div>
      ) : (
        <p className="muted small">
          访问密钥文件：<code>{info.accessKeyPath}</code>。用文本编辑器打开该文件并粘贴其中的
          <code>aib_…</code> 字符串。文件权限为仅当前用户可读。
        </p>
      )}
      <form onSubmit={(event) => void submit(event)} className="login-form">
        <label className="field">
          <span>本机访问密钥</span>
          <input
            ref={inputRef}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={accessKey}
            onChange={(event) => setAccessKey(event.target.value)}
            placeholder="aib_..."
            disabled={busy}
            aria-describedby="login-error"
          />
        </label>
        {error && (
          <div className="notice" id="login-error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className="primary" disabled={busy || !accessKey.trim()}>
          {busy ? "正在验证…" : "解锁"}
        </button>
      </form>
    </section>
  );
}
