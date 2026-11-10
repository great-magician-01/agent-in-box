import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Server as HttpServer } from "node:http";
import net from "node:net";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { VmConsoleSession } from "@agent-in-box/protocol";
import { LeaseService } from "../persistence/services/lease-service";
import { PersistenceError } from "../persistence/errors";
import { VmService } from "./vm.service";
import { VncClientFramer, VncClientNegotiation, VncServerHandshake } from "./vnc-protocol";

const CONSOLE_TICKET_TTL_MS = 60_000;
const CONSOLE_LEASE_TTL_MS = 15_000;
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

interface ConsoleTicket {
  vmId: string;
  leaseId: string;
  consoleUrl: string;
  expiresAt: number;
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

  async openSession(vmId: string): Promise<VmConsoleSession> {
    // Check the actual Supervisor state before preemption, so a failed console
    // connection cannot unnecessarily revoke a running AI Lease.
    const console = await this.vms.console(vmId);
    assertConsoleProtocol(console.consoleUrl);
    const lease = await this.leases.acquire({
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
      leaseId: lease.id,
      consoleUrl: console.consoleUrl,
      expiresAt: ticketExpiresAt,
    });
    return {
      vmId,
      webSocketUrl: `/api/v1/vms/${encodeURIComponent(vmId)}/console/ws?ticket=${encodeURIComponent(ticket)}`,
      lease,
      ticketExpiresAt: new Date(ticketExpiresAt).toISOString(),
    };
  }

  /** Attach to the loopback HTTP server created by Nest. */
  attach(server: HttpServer): () => void {
    const listener = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
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
    const control = await this.leases.control(vmId);
    if (
      control.state !== "human" ||
      control.lease?.id !== ticket.leaseId ||
      control.lease.owner !== "human"
    ) {
      rejectUpgrade(socket, 403, "Human execution lease is not active");
      return;
    }

    this.websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      this.connect(websocket, ticket);
    });
  }

  private connect(websocket: WebSocket, ticket: ConsoleTicket): void {
    this.sockets.add(websocket);
    const target = new URL(ticket.consoleUrl);
    const upstream = net.connect({
      host: "127.0.0.1",
      port: Number(target.port),
      noDelay: true,
    });
    const handshake = new VncServerHandshake();
    const negotiation = new VncClientNegotiation();
    const framer = new VncClientFramer();
    let pendingClient: Buffer = Buffer.alloc(0);
    let queue = Promise.resolve();
    let queuedMessages = 0;
    let closed = false;

    const close = (code = 1011, reason = "Console disconnected"): void => {
      if (closed) return;
      closed = true;
      upstream.destroy();
      websocket.close(code, reason.slice(0, 100));
      const forceClose = setTimeout(() => websocket.terminate(), 250);
      forceClose.unref();
    };
    const forwardFrames = async (chunk: Buffer): Promise<void> => {
      for (const frame of framer.feed(chunk)) {
        if (frame.requiresLease) {
          await this.leases.executeWithLease(ticket.vmId, ticket.leaseId, "human", async () => {
            upstream.write(frame.data);
          });
        } else {
          upstream.write(frame.data);
        }
      }
    };
    const flushPending = async (): Promise<void> => {
      if (!handshake.done || pendingClient.length === 0) return;
      const pending = pendingClient;
      pendingClient = Buffer.alloc(0);
      await forwardFrames(pending);
    };
    const processClient = async (chunk: Buffer): Promise<void> => {
      if (!handshake.done) {
        const result = negotiation.feed(Buffer.concat([pendingClient, chunk]));
        for (const message of result.negotiation) upstream.write(message);
        pendingClient = result.pending;
        if (!handshake.done) return;
        await flushPending();
        return;
      }
      await forwardFrames(chunk);
    };

    upstream.setTimeout(15_000, () => close(1011, "VNC connection timed out"));
    upstream.on("connect", () => upstream.setTimeout(0));
    upstream.on("data", (data) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      try {
        const wasDone = handshake.done;
        handshake.feed(chunk);
        websocket.send(chunk, { binary: true });
        if (!wasDone && handshake.done) {
          queue = queue.then(async () => {
            try {
              await flushPending();
            } catch {
              close(1008, "Execution Lease lost or invalid RFB input");
            }
          });
        }
      } catch (error) {
        close(1002, error instanceof Error ? error.message : "Invalid RFB response");
      }
    });
    upstream.on("error", () => close(1011, "VNC server unavailable"));
    upstream.on("close", () => close(1000, "VNC server closed"));

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
          await processClient(chunk);
        } catch {
          close(1008, "Execution Lease lost or invalid RFB input");
        }
      });
    });
    websocket.on("close", () => {
      closed = true;
      upstream.destroy();
      this.sockets.delete(websocket);
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

function validConsoleUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "vnc:" && url.hostname === "127.0.0.1" && validPort(url.port);
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
