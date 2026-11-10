import { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc/lib/rfb.js";
import type { VmConsoleSession } from "@agent-in-box/protocol";
import { api, ApiRequestError } from "./api";

interface VmConsoleProps {
  session: VmConsoleSession;
  vmName: string;
  onClose: () => void;
  onReconnect: () => void;
}

export function VmConsole({ session, vmName, onClose, onReconnect }: VmConsoleProps) {
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const releasedRef = useRef(false);
  const [state, setState] = useState<"connecting" | "connected" | "disconnected" | "error">(
    "connecting",
  );
  const [message, setMessage] = useState("正在建立受保护的本机控制台连接…");
  const [desktopName, setDesktopName] = useState("");

  useEffect(() => {
    let disposed = false;
    let heartbeat: number | undefined;
    // StrictMode performs a setup/cleanup/setup pass. Deferring construction lets
    // the first pass cancel before consuming the one-time WebSocket ticket.
    const connectTimer = window.setTimeout(() => {
      if (disposed || !screenRef.current) return;
      const url = new URL(session.webSocketUrl, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const rfb = new RFB(screenRef.current, url.toString(), { shared: true });
      rfbRef.current = rfb;
      rfb.scaleViewport = true;
      rfb.viewOnly = false;
      rfb.resizeSession = false;
      rfb.showDotCursor = true;
      rfb.focusOnClick = true;
      rfb.addEventListener("connect", () => {
        if (disposed) return;
        setState("connected");
        setMessage("已连接。鼠标、键盘和剪贴板输入均受当前人工 Lease 保护。");
        heartbeat = window.setInterval(() => {
          void api.heartbeatVmLease(session.vmId, session.lease.id).catch((error: unknown) => {
            if (releasedRef.current || disposed) return;
            setState("error");
            setMessage(`人工 Lease 已失效，输入已停止：${consoleError(error)}`);
            rfb.disconnect();
          });
        }, 5_000);
      });
      rfb.addEventListener("desktopname", (event) => setDesktopName(event.detail.name));
      rfb.addEventListener("disconnect", (event) => {
        if (heartbeat !== undefined) window.clearInterval(heartbeat);
        if (!releasedRef.current) {
          releasedRef.current = true;
          void api.releaseVmLease(session.vmId, session.lease.id).catch(() => undefined);
        }
        if (disposed) return;
        setState(event.detail.clean ? "disconnected" : "error");
        setMessage(
          event.detail.clean
            ? "控制台已断开。请重新连接以获取新的 Lease 和一次性票据。"
            : "控制台异常断开或 Lease 已失效。旧连接不能继续输入，请重新连接。",
        );
      });
    }, 0);

    return () => {
      disposed = true;
      window.clearTimeout(connectTimer);
      if (heartbeat !== undefined) window.clearInterval(heartbeat);
      if (rfbRef.current) {
        rfbRef.current.disconnect();
        rfbRef.current = null;
        if (!releasedRef.current) {
          releasedRef.current = true;
          void api.releaseVmLease(session.vmId, session.lease.id).catch(() => undefined);
        }
      }
    };
  }, [session]);

  async function close(): Promise<void> {
    if (!releasedRef.current) {
      releasedRef.current = true;
      rfbRef.current?.disconnect();
      rfbRef.current = null;
      try {
        await api.releaseVmLease(session.vmId, session.lease.id);
      } catch {
        // A lost Lease is already safe; its short TTL is the final cleanup.
      }
    }
    onClose();
  }

  return (
    <div className="novnc-console" aria-label={`${vmName} 实时控制台`}>
      <div className="console-toolbar">
        <div>
          <strong>{desktopName || `${vmName} · noVNC`}</strong>
          <span className={`console-state ${state}`} role="status">
            {state === "connected"
              ? "人工控制中"
              : state === "connecting"
                ? "连接中"
                : state === "error"
                  ? "连接已保护性断开"
                  : "已断开"}
          </span>
        </div>
        <div className="action-row">
          <button
            type="button"
            className="secondary"
            onClick={() => rfbRef.current?.sendCtrlAltDel()}
            disabled={state !== "connected"}
          >
            Ctrl+Alt+Del
          </button>
          {state !== "connected" && state !== "connecting" && (
            <button type="button" className="secondary" onClick={onReconnect}>
              重新连接
            </button>
          )}
          <button type="button" className="secondary" onClick={() => void close()}>
            关闭并释放 Lease
          </button>
        </div>
      </div>
      <p className="muted small console-message">{message}</p>
      <div className="novnc-screen" ref={screenRef} tabIndex={-1} />
    </div>
  );
}

function consoleError(error: unknown): string {
  return error instanceof ApiRequestError
    ? error.message
    : error instanceof Error
      ? error.message
      : String(error);
}
