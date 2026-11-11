import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { AuthService, SESSION_COOKIE_NAME } from "../auth/auth.service";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import { TaskRepository } from "../persistence/repositories/task-repository";
import { TaskService } from "../persistence/services/task-service";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import { EventsService } from "./events.service";

let ctx: TestContext;
let events: EventsService;
let server: http.Server;
let port: number;
let tasks: TaskService;
let sessionCookie: string;
let authDirectory: string;
const sockets = new Set<WebSocket>();

beforeEach(async () => {
  ctx = await createTestContext();
  authDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-in-box-events-auth-"));
  const auth = new AuthService(ctx.app.db, {
    accessKeyPath: path.join(authDirectory, "web-access-key"),
  });
  await auth.onModuleInit();
  const login = await auth.login({ accessKey: auth.ensureAccessKey() });
  sessionCookie = `${SESSION_COOKIE_NAME}=${login.token}`;
  const outbox = new OutboxRepository(ctx.app.db);
  tasks = new TaskService(ctx.app.db, new TaskRepository(ctx.app.db), outbox);
  events = new EventsService(outbox, ctx.app.db, auth);
  events.onModuleInit();
  server = http.createServer();
  events.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  port = address.port;
});

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  events.onModuleDestroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await ctx.close();
  fs.rmSync(authDirectory, { recursive: true, force: true });
});

async function connect(
  origin = `http://127.0.0.1:${port}`,
  messages?: Array<Record<string, unknown>>,
): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events/ws`, {
    origin,
    headers: { cookie: sessionCookie },
  });
  sockets.add(socket);
  if (messages) {
    socket.on("message", (data) =>
      messages.push(JSON.parse(String(data)) as Record<string, unknown>),
    );
  }
  await once(socket, "open");
  return socket;
}

async function createTask(key: string) {
  return tasks.create({
    projectId: ctx.projectId,
    vmId: ctx.vmId,
    originConversationId: ctx.conversationId,
    objective: `Task ${key}`,
    idempotencyKey: key,
  });
}

describe("EventsService", () => {
  it("publishes committed outbox events with versioned context and monotonic IDs", async () => {
    const messages: Array<Record<string, unknown>> = [];
    await connect(undefined, messages);
    await createTask("event-task");
    await events.publishPending();
    await waitFor(() => messages.some((message) => message.topic === "task.created"));
    const event = messages.find((message) => message.topic === "task.created")!;
    expect(event.type).toBe("invalidate");
    expect(event.eventVersion).toBe(1);
    expect(event.projectId).toBe(ctx.projectId);
    expect(event.vmId).toBe(ctx.vmId);
    expect(typeof event.taskId).toBe("string");
    expect(Number(event.eventId)).toBeGreaterThan(0);
    await waitFor(() => messages[0]?.type === "ready");
  });

  it("supports full database resynchronization after reconnect instead of replay assumptions", async () => {
    const first = await connect();
    const closed = once(first, "close");
    first.close();
    await closed;
    await createTask("while-offline");
    const messages: Array<Record<string, unknown>> = [];
    await connect(undefined, messages);
    await waitFor(() => messages.some((event) => event.type === "ready"));
    expect(messages.find((event) => event.type === "ready")?.eventCursor).toBeGreaterThan(0);
    expect((await tasks.board()).tasks).toHaveLength(1);
  });

  it("rejects non-loopback browser origins", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events/ws`, {
      origin: "http://malicious.example",
      headers: { cookie: sessionCookie },
    });
    sockets.add(socket);
    const [error] = (await once(socket, "error")) as [Error];
    expect(error.message).toContain("403");
  });

  it("rejects an authenticated-origin connection without a session", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events/ws`, {
      origin: `http://127.0.0.1:${port}`,
    });
    sockets.add(socket);
    const [error] = (await once(socket, "error")) as [Error];
    expect(error.message).toContain("401");
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for WebSocket event");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
