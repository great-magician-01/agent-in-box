import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Server as HttpServer } from "node:http";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { WebSocket, WebSocketServer } from "ws";
import type { VmConsoleSession } from "@agent-in-box/protocol";
import { LeaseService } from "../persistence/services/lease-service";
import { PersistenceError } from "../persistence/errors";
import { VmService } from "./vm.service";
import {
  negotiateVncUpstream,
  VncClientFramer,
  VncDownstreamHandshake,
  type VncTlsOptions,
} from "./vnc-protocol";

const CONSOLE_TICKET_TTL_MS = 60_000;
const CONSOLE_LEASE_TTL_MS = 15_000;
const CONSOLE_UPSTREAM_TIMEOUT_MS = 15_000;
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const RFB_VERSION = "RFB 003.008\n";

interface ConsoleTicket {
  vmId: string;
  leaseId: string | null;
  consoleUrl: string;
  viewOnly: boolean;
  expiresAt: number;
}

interface ConsoleTarget {
  host: string;
  port: number;
  requireTls: boolean;
  tls?: VncTlsOptions;
}

@Injectable()
export class ConsoleService implements OnModuleDestroy {
  private readonly tickets = new Map<string, ConsoleTicket>();
  private readonly sockets = new Set<WebSocket>();
  private readonly websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
  });

  constructor(
    private readonly vms: VmService,
    private readonly leases: LeaseService,
  ) {}

  async openSession(vmId: string, options: { viewOnly?: boolean } = {}): Promise<VmConsoleSession> {
    // Check the actual Supervisor state before preemption, so a failed console
    // connection cannot unnecessarily revoke a running AI Lease.
    const console = await this.vms.console(vmId);
    assertConsoleProtocol(console.consoleUrl);
    const viewOnly = options.viewOnly === true;
    // Passive observation must never acquire a human lease: opening the
    // observer sidebar must not preempt an AI Worker or break its CUA lease.
    const lease = viewOnly
      ? null
      : await this.leases.acquire({
          vmId,
          owner: "human",
          taskId: null,
          ttlMs: CONSOLE_LEASE_TTL_MS,
        });
    const ticket = randomBytes(32).toString("base64url");
    const ticketExpiresAt = Date.now() + CONSOLE_TICKET_TTL_MS;
    this.pruneTickets();
    this.tickets.set(ticket, {
      vmId,
      leaseId: lease?.id ?? null,
      consoleUrl: console.consoleUrl,
      viewOnly,
      expiresAt: ticketExpiresAt,
    });
    return {
      vmId,
      webSocketUrl: `/api/v1/vms/${encodeURIComponent(vmId)}/console/ws?ticket=${encodeURIComponent(ticket)}`,
      lease,
      viewOnly,
      ticketExpiresAt: new Date(ticketExpiresAt).toISOString(),
    };
  }

  /** Attach to the loopback HTTP server created by Nest. */
  attach(server: HttpServer): () => void {
    const listener = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
      let isConsoleRoute = false;
      try {
        const pathname = new URL(request.url ?? "", "http://127.0.0.1").pathname;
        isConsoleRoute = /^\/api\/v1\/vms\/[^/]+\/console\/ws$/.test(pathname);
      } catch {
        isConsoleRoute = false;
      }
      // The phase-5 event stream owns a separate upgrade route.
      if (!isConsoleRoute) return;
      void this.upgrade(request, socket, head).catch(() => {
        rejectUpgrade(socket, 403, "Console access denied");
      });
    };
    server.on("upgrade", listener);
    return () => server.off("upgrade", listener);
  }

  onModuleDestroy(): void {
    for (const socket of this.sockets) socket.terminate();
    this.websocketServer.close();
    this.tickets.clear();
  }

  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const remote = request.socket.remoteAddress ?? "";
    if (!LOOPBACK_ADDRESSES.has(remote) || !validHost(request.headers.host)) {
      rejectUpgrade(socket, 403, "Loopback clients only");
      return;
    }
    if (!validOrigin(request.headers.origin, request.headers.host)) {
      rejectUpgrade(socket, 403, "Console origin denied");
      return;
    }
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    const match = /^\/api\/v1\/vms\/([^/]+)\/console\/ws$/.exec(url.pathname);
    if (!match) {
      // This service owns only its versioned route. Leave unrelated upgrades to
      // other listeners instead of turning them into unauthenticated proxies.
      rejectUpgrade(socket, 404, "Console route not found");
      return;
    }
    const vmId = decodeURIComponent(match[1] ?? "");
    const ticketId = url.searchParams.get("ticket") ?? "";
    const ticket = this.tickets.get(ticketId);
    this.tickets.delete(ticketId);
    if (
      !ticket ||
      ticket.vmId !== vmId ||
      ticket.expiresAt <= Date.now() ||
      !validConsoleUrl(ticket.consoleUrl)
    ) {
      rejectUpgrade(socket, 403, "Invalid or expired console ticket");
      return;
    }
    if (!ticket.viewOnly) {
      const control = await this.leases.control(vmId);
      if (
        control.state !== "human" ||
        !ticket.leaseId ||
        control.lease?.id !== ticket.leaseId ||
        control.lease.owner !== "human"
      ) {
        rejectUpgrade(socket, 403, "Human execution lease is not active");
        return;
      }
    }

    this.websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      this.connect(websocket, ticket);
    });
  }

  private connect(websocket: WebSocket, ticket: ConsoleTicket): void {
    this.sockets.add(websocket);
    let target: ConsoleTarget;
    try {
      target = parseConsoleTarget(ticket.consoleUrl);
    } catch {
      websocket.close(1011, "Unsupported console endpoint");
      this.sockets.delete(websocket);
      return;
    }

    const upstream = net.connect({
      host: target.host,
      port: target.port,
      noDelay: true,
    });
    let active: net.Socket | TLSSocket = upstream;
    const handshake = new VncDownstreamHandshake();
    const framer = new VncClientFramer();
    let queue = Promise.resolve();
    let queuedMessages = 0;
    let closed = false;
    let clientReady = false;
    let upstreamReady = false;
    let pendingUpstream = Buffer.alloc(0);

    const destroyAll = (): void => {
      try {
        active.destroy();
      } catch {
        // already closed
      }
      if (active !== upstream) {
        try {
          upstream.destroy();
        } catch {
          // already closed
        }
      }
    };
    const close = (code = 1011, reason = "Console disconnected"): void => {
      if (closed) return;
      closed = true;
      destroyAll();
      websocket.close(code, reason.slice(0, 100));
      const forceClose = setTimeout(() => websocket.terminate(), 250);
      forceClose.unref();
    };

    const forwardFrames = async (chunk: Buffer): Promise<void> => {
      for (const frame of framer.feed(chunk)) {
        if (frame.requiresLease) {
          // View-only sessions never forward keyboard/pointer/clipboard input.
          // Non-input framing (pixel format, encodings, update requests) still
          // reaches the VNC server so the observer receives a live picture.
          if (ticket.viewOnly) continue;
          if (!ticket.leaseId) {
            close(1008, "Execution Lease lost or invalid RFB input");
            return;
          }
          await this.leases.executeWithLease(ticket.vmId, ticket.leaseId, "human", async () => {
            active.write(frame.data);
          });
        } else {
          active.write(frame.data);
        }
      }
    };

    const flushUpstream = (): void => {
      if (pendingUpstream.length > 0) {
        const chunk = pendingUpstream;
        pendingUpstream = Buffer.alloc(0);
        websocket.send(chunk, { binary: true });
      }
    };

    // The browser always sees a plain RFB 3.8 no-auth server. The real
    // (TLS/VeNCrypt) negotiation happens between this process and QEMU, so
    // security bytes never reach the renderer.
    websocket.send(RFB_VERSION, { binary: true });

    const connectTimer = setTimeout(() => {
      close(1011, "VNC connection timed out");
    }, CONSOLE_UPSTREAM_TIMEOUT_MS);
    connectTimer.unref();

    upstream.once("error", () => {
      clearTimeout(connectTimer);
      close(1011, "VNC server unavailable");
    });
    upstream.once("connect", () => {
      clearTimeout(connectTimer);
      void (async () => {
        try {
          const negotiated = await negotiateVncUpstream(
            upstream,
            { requireTls: target.requireTls, ...(target.tls ? { tls: target.tls } : {}) },
            CONSOLE_UPSTREAM_TIMEOUT_MS,
          );
          active = negotiated.socket;
        } catch {
          close(1011, "VNC authentication failed");
          return;
        }
        if (closed) {
          destroyAll();
          return;
        }
        upstreamReady = true;
        active.setTimeout(CONSOLE_UPSTREAM_TIMEOUT_MS, () =>
          close(1011, "VNC connection timed out"),
        );
        active.on("data", (data) => {
          const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
          if (!clientReady) {
            pendingUpstream = Buffer.concat([pendingUpstream, chunk]);
            return;
          }
          try {
            websocket.send(chunk, { binary: true });
          } catch {
            close();
          }
        });
        active.on("error", () => close(1011, "VNC server unavailable"));
        active.on("close", () => close(1000, "VNC server closed"));
        flushUpstream();
      })();
    });

    websocket.on("message", (raw, isBinary) => {
      if (!isBinary || closed) {
        close(1003, "RFB requires binary WebSocket messages");
        return;
      }
      queuedMessages += 1;
      if (queuedMessages > 64) {
        close(1009, "VNC input queue is too large");
        return;
      }
      queue = queue.then(async () => {
        queuedMessages -= 1;
        if (closed) return;
        const chunk = raw instanceof Buffer ? raw : Buffer.from(raw as ArrayBuffer);
        try {
          if (!clientReady) {
            const result = handshake.feed(chunk);
            if (result.reply) websocket.send(result.reply, { binary: true });
            if (!result.done) return;
            clientReady = true;
            // ServerInit may already be waiting; send it before client frames.
            flushUpstream();
            if (result.pending.length > 0) await forwardFrames(result.pending);
            return;
          }
          if (!upstreamReady) {
            close(1011, "VNC server is not ready");
            return;
          }
          await forwardFrames(chunk);
        } catch {
          close(1008, "Execution Lease lost or invalid RFB input");
        }
      });
    });
    websocket.on("close", () => {
      if (closed) return;
      closed = true;
      destroyAll();
      this.sockets.delete(websocket);
      if (ticket.leaseId) {
        // Do not make the AI wait for the 15s TTL after the human closes the
        // console; releasing is idempotent and a takeover already removed it.
        void this.leases.release(ticket.vmId, ticket.leaseId).catch(() => undefined);
      }
    });
    websocket.on("error", () => close());
  }

  private pruneTickets(): void {
    const now = Date.now();
    for (const [id, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.tickets.delete(id);
    }
  }
}

function parseConsoleTarget(value: string): ConsoleTarget {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "127.0.0.2";
  if (!loopback || !validPort(url.port)) {
    throw new Error("console endpoint must be loopback");
  }
  const port = Number(url.port);
  if (url.protocol === "vnc:") {
    // Legacy metadata created before secure transports existed. It is still
    // restricted to loopback but carries no TLS negotiation.
    return { host: url.hostname, port, requireTls: false };
  }
  if (url.protocol !== "vnc+tls:") {
    throw new Error(`unsupported console protocol ${url.protocol}`);
  }
  const fingerprint = (url.searchParams.get("fingerprint") ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error("console fingerprint is malformed");
  }
  const ca = url.searchParams.get("ca") ?? "";
  const cert = url.searchParams.get("cert") ?? "";
  const key = url.searchParams.get("key") ?? "";
  for (const candidate of [ca, cert, key]) {
    if (!candidate || candidate.includes("\0") || !path.isAbsolute(candidate)) {
      throw new Error("console credentials must be absolute paths");
    }
  }
  if (path.dirname(ca) !== path.dirname(cert) || path.dirname(ca) !== path.dirname(key)) {
    throw new Error("console credentials must share one directory");
  }
  return {
    host: url.hostname,
    port,
    requireTls: true,
    tls: { ca, cert, key, fingerprint },
  };
}

function validConsoleUrl(value: string): boolean {
  try {
    parseConsoleTarget(value);
    return true;
  } catch {
    return false;
  }
}

function validPort(value: string): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function validHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
    return ["127.0.0.1", "localhost", "::1"].includes(hostname);
  } catch {
    return false;
  }
}

function validOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && parsed.host === host && validHost(parsed.host);
  } catch {
    return false;
  }
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\nX-Content-Type-Options: nosniff\r\n\r\n`,
  );
  socket.destroy();
}

// Kept as a typed guard for future non-VNC providers; unsupported protocols must
// fail closed rather than being treated as a generic TCP tunnel.
export function assertConsoleProtocol(value: string): void {
  if (!validConsoleUrl(value)) {
    throw new PersistenceError("unavailable", `Supervisor 未提供受支持的回环 VNC 控制台：${value}`);
  }
}
