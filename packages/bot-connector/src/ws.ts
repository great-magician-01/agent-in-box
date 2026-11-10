/**
 * Thin WebSocket transport abstraction.
 *
 * The abstraction keeps the connection state machine testable with a local
 * mock server and makes it possible to swap `ws` for another client later.
 */

import { Buffer } from "node:buffer";
import WebSocket, { type RawData } from "ws";

export type WsData = string | Uint8Array;

export interface WsCloseInfo {
  code: number;
  reason: string;
}

export interface WsSocket {
  send(data: WsData): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (data: WsData) => void): () => void;
  onClose(listener: (info: WsCloseInfo) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
}

export interface WsConnectOptions {
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface WsConnector {
  connect(url: string, options?: WsConnectOptions): Promise<WsSocket>;
}

function toWsData(data: RawData, isBinary: boolean): WsData {
  if (!isBinary) {
    if (typeof data === "string") {
      return data;
    }
    if (Buffer.isBuffer(data)) {
      return data.toString("utf8");
    }
    if (Array.isArray(data)) {
      return Buffer.concat(data).toString("utf8");
    }
    return Buffer.from(data).toString("utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

function toWsSendPayload(data: WsData): string | Buffer {
  return typeof data === "string" ? data : Buffer.from(data);
}

/** `ws`-backed connector used by the Feishu and QQ adapters in production. */
export class DefaultWsConnector implements WsConnector {
  connect(url: string, options: WsConnectOptions = {}): Promise<WsSocket> {
    return new Promise<WsSocket>((resolve, reject) => {
      const headers = options.headers ? { ...options.headers } : undefined;
      const socket = new WebSocket(url, headers ? { headers } : undefined);
      let settled = false;

      const cleanupOpening = () => {
        socket.off("open", onOpen);
        socket.off("error", onOpeningError);
        options.signal?.removeEventListener("abort", onAbort);
      };

      const onOpen = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupOpening();
        resolve(wrapSocket(socket));
      };

      const onOpeningError = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupOpening();
        reject(error);
      };

      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupOpening();
        // `terminate()` can throw while CONNECTING and may emit a later error;
        // keep a sink so an aborted handshake cannot crash the host process.
        socket.on("error", () => {});
        try {
          socket.terminate();
        } catch {
          // Best-effort cleanup of an aborted handshake.
        }
        reject(new Error("websocket connection aborted"));
      };

      socket.once("open", onOpen);
      socket.once("error", onOpeningError);
      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}

function wrapSocket(socket: WebSocket): WsSocket {
  const messageListeners = new Set<(data: WsData) => void>();
  const closeListeners = new Set<(info: WsCloseInfo) => void>();
  const errorListeners = new Set<(error: Error) => void>();
  // The peer can send the first frame (QQ Hello) immediately after the WS
  // upgrade, before the protocol session attaches a listener. Buffer it.
  const pendingMessages: WsData[] = [];
  let pendingClose: WsCloseInfo | null = null;
  let pendingError: Error | null = null;

  socket.on("message", (data: RawData, isBinary: boolean) => {
    const normalized = toWsData(data, isBinary);
    if (messageListeners.size === 0) {
      pendingMessages.push(normalized);
      return;
    }
    for (const listener of messageListeners) {
      listener(normalized);
    }
  });
  socket.on("close", (code: number, reason: Buffer) => {
    const info: WsCloseInfo = { code, reason: reason.toString("utf8") };
    if (closeListeners.size === 0) {
      pendingClose = info;
      return;
    }
    for (const listener of closeListeners) {
      listener(info);
    }
  });
  socket.on("error", (error: Error) => {
    if (errorListeners.size === 0) {
      pendingError = error;
      return;
    }
    for (const listener of errorListeners) {
      listener(error);
    }
  });

  return {
    send(data: WsData): void {
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("websocket is not open");
      }
      socket.send(toWsSendPayload(data));
    },
    close(code?: number, reason?: string): void {
      if (socket.readyState === WebSocket.CLOSED) {
        return;
      }
      socket.close(code, reason);
    },
    onMessage(listener: (data: WsData) => void): () => void {
      messageListeners.add(listener);
      while (pendingMessages.length > 0) {
        const queued = pendingMessages.shift();
        if (queued !== undefined) {
          listener(queued);
        }
      }
      return () => messageListeners.delete(listener);
    },
    onClose(listener: (info: WsCloseInfo) => void): () => void {
      closeListeners.add(listener);
      if (pendingClose) {
        const queued = pendingClose;
        pendingClose = null;
        listener(queued);
      }
      return () => closeListeners.delete(listener);
    },
    onError(listener: (error: Error) => void): () => void {
      errorListeners.add(listener);
      if (pendingError) {
        const queued = pendingError;
        pendingError = null;
        listener(queued);
      }
      return () => errorListeners.delete(listener);
    },
  };
}
