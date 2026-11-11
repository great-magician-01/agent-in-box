import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { WebSocket, WebSocketServer } from "ws";
import { PROTOCOL_VERSION } from "@agent-in-box/protocol";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import { KYSELY } from "../persistence/tokens";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";

const EVENTS_PATH = "/api/v1/events/ws";
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);
  private readonly sockets = new Set<WebSocket>();
  private readonly websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private publishing = false;

  constructor(
    private readonly outbox: OutboxRepository,
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
  ) {}

  onModuleInit(): void {
    this.pollTimer = setInterval(() => void this.publishPending(), 150);
    this.pollTimer.unref();
    this.heartbeatTimer = setInterval(() => {
      for (const socket of this.sockets) {
        if (socket.readyState === WebSocket.OPEN) socket.ping();
      }
    }, 30_000);
    this.heartbeatTimer.unref();
  }

  attach(server: HttpServer): () => void {
    const listener = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
      let pathname = "";
      try {
        pathname = new URL(request.url ?? "", "http://127.0.0.1").pathname;
      } catch {
        rejectUpgrade(socket, 400, "Bad event stream URL");
        return;
      }
      if (pathname !== EVENTS_PATH) return;
      this.upgrade(request, socket, head);
    };
    server.on("upgrade", listener);
    return () => server.off("upgrade", listener);
  }

  onModuleDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
    this.websocketServer.close();
  }

  async publishPending(): Promise<void> {
    if (this.publishing) return;
    this.publishing = true;
    try {
      const pending = await this.outbox.listPending(200);
      if (pending.length === 0) return;
      for (const message of pending) {
        const context = await this.eventContext(message.payload);
        const event = {
          type: "invalidate",
          eventId: message.id,
          topic: message.topic,
          eventVersion: 1,
          protocolVersion: PROTOCOL_VERSION,
          occurredAt: message.createdAt,
          ...context,
          payload: message.payload,
        };
        const encoded = JSON.stringify(event);
        for (const socket of this.sockets) {
          if (socket.readyState !== WebSocket.OPEN) continue;
          try {
            socket.send(encoded);
          } catch {
            this.sockets.delete(socket);
            socket.terminate();
          }
        }
      }
      await this.outbox.markPublished(
        pending.map((message) => message.id),
        nowIso(),
      );
    } catch (error) {
      this.logger.error(
        "Outbox publish failed; pending rows will be retried",
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.publishing = false;
    }
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const remote = request.socket.remoteAddress ?? "";
    if (
      !LOOPBACK_ADDRESSES.has(remote) ||
      !validHost(request.headers.host) ||
      !validOrigin(request.headers.origin, request.headers.host)
    ) {
      rejectUpgrade(socket, 403, "Event stream access denied");
      return;
    }
    this.websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      this.sockets.add(websocket);
      websocket.on("close", () => this.sockets.delete(websocket));
      websocket.on("error", () => this.sockets.delete(websocket));
      websocket.on("message", () => websocket.close(1003, "Event stream is server-to-client only"));
      void this.sendReady(websocket).catch(() => websocket.terminate());
    });
  }

  private async sendReady(socket: WebSocket): Promise<void> {
    const latest = await this.db
      .selectFrom("outbox")
      .select("id")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "ready",
          eventCursor: latest?.id ?? 0,
          eventVersion: 1,
          protocolVersion: PROTOCOL_VERSION,
          occurredAt: nowIso(),
        }),
      );
    }
  }

  private async eventContext(payload: unknown): Promise<{
    projectId?: string;
    taskId?: string;
    vmId?: string;
  }> {
    if (payload === null || typeof payload !== "object") return {};
    const value = payload as Record<string, unknown>;
    const task =
      value.task !== null && typeof value.task === "object"
        ? (value.task as Record<string, unknown>)
        : null;
    const taskId = stringValue(value.taskId) ?? stringValue(task?.id);
    let projectId = stringValue(value.projectId) ?? stringValue(task?.projectId);
    let vmId = stringValue(value.vmId) ?? stringValue(task?.vmId);
    if (taskId && (!projectId || !vmId)) {
      const row = await this.db
        .selectFrom("tasks")
        .select(["project_id", "vm_id"])
        .where("id", "=", taskId)
        .executeTakeFirst();
      projectId ??= row?.project_id;
      vmId ??= row?.vm_id;
    }
    return {
      ...(projectId ? { projectId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(vmId ? { vmId } : {}),
    };
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
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
