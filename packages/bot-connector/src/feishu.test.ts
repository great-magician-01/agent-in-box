import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { RawData, WebSocket } from "ws";
import { createFeishuBotConnector } from "./feishu";
import {
  decodeFeishuFrame,
  encodeFeishuFrame,
  feishuJsonPayload,
  getFeishuHeader,
  type FeishuFrame,
} from "./test-support/feishu-frame-codec";
import type { MockHttpRequest, MockServer } from "./test-support/mock-server";
import { sendBinary, startMockServer, waitFor } from "./test-support/mock-server";

// The official SDK validates appId as cli_ + 16 hex characters.
const APP_ID = "cli_0123456789abcdef";
const APP_SECRET = "super-secret-app-value";

type CapturedRequest = MockHttpRequest;

interface FeishuFixture {
  server: MockServer;
  sockets: WebSocket[];
  bootstrapBodies: Record<string, unknown>[];
  tokenBodies: Record<string, unknown>[];
  messageRequests: CapturedRequest[];
  acks: FeishuFrame[];
  pings: number;
  sendEvent(socket: WebSocket, payload: unknown, messageId: string): void;
}

function toBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return new Uint8Array(data);
}

function feishuEvent(messageId: string, text: string, eventId = "event-header-1"): unknown {
  return {
    schema: "2.0",
    header: {
      event_id: eventId,
      event_type: "im.message.receive_v1",
      create_time: "1762700000000",
    },
    event: {
      sender: {
        sender_id: { open_id: "ou_user_1" },
        sender_type: "user",
      },
      message: {
        message_id: messageId,
        chat_id: "oc_chat_1",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text }),
        create_time: "1762700000000",
      },
    },
  };
}

async function startFeishuFixture(
  overrides: {
    bootstrapResponse?: unknown;
    tokenResponse?: unknown;
    messageResponse?: unknown;
  } = {},
): Promise<FeishuFixture> {
  const sockets: WebSocket[] = [];
  const bootstrapBodies: Record<string, unknown>[] = [];
  const tokenBodies: Record<string, unknown>[] = [];
  const messageRequests: CapturedRequest[] = [];
  const acks: FeishuFrame[] = [];
  const fixture: Partial<FeishuFixture> = {};

  const server = await startMockServer({
    onHttp: (request, response) => {
      const path = request.path.split("?")[0];
      if (request.method === "POST" && path === "/callback/ws/endpoint") {
        bootstrapBodies.push(JSON.parse(request.body) as Record<string, unknown>);
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            overrides.bootstrapResponse ?? {
              code: 0,
              msg: "ok",
              data: {
                URL: `${server.wsUrl}/ws?device_id=device-1&service_id=155`,
                ClientConfig: {
                  PingInterval: 30,
                  // One second makes the SDK's reconnect loop observable in tests.
                  ReconnectInterval: 1,
                  ReconnectCount: 10,
                  ReconnectNonce: 0,
                },
              },
            },
          ),
        );
        return true;
      }
      if (request.method === "POST" && path === "/open-apis/auth/v3/tenant_access_token/internal") {
        tokenBodies.push(JSON.parse(request.body) as Record<string, unknown>);
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            overrides.tokenResponse ?? {
              code: 0,
              msg: "ok",
              tenant_access_token: "t-test-token",
              expire: 7_200,
            },
          ),
        );
        return true;
      }
      if (request.method === "POST" && path === "/open-apis/im/v1/messages") {
        messageRequests.push(request);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(overrides.messageResponse ?? { code: 0, msg: "success" }));
        return true;
      }
      return false;
    },
    onWsConnection: (socket) => {
      sockets.push(socket);
      socket.on("message", (data, isBinary) => {
        if (!isBinary) {
          return;
        }
        let frame: FeishuFrame;
        try {
          frame = decodeFeishuFrame(toBytes(data));
        } catch {
          return;
        }
        const type = getFeishuHeader(frame, "type");
        if (type === "ping") {
          fixture.pings = (fixture.pings ?? 0) + 1;
          // Delay slightly so the SDK has attached its message listener.
          setTimeout(() => {
            sendBinary(
              socket,
              encodeFeishuFrame({
                ...frame,
                method: 0,
                payload: new TextEncoder().encode(
                  JSON.stringify({
                    PingInterval: 30,
                    ReconnectCount: 10,
                    ReconnectInterval: 1,
                    ReconnectNonce: 0,
                  }),
                ),
                headers: [{ key: "type", value: "pong" }],
              }),
            );
          }, 5);
          return;
        }
        if (frame.method === 1 && type === "event") {
          acks.push(frame);
        }
      });
    },
  });

  fixture.server = server;
  fixture.sockets = sockets;
  fixture.bootstrapBodies = bootstrapBodies;
  fixture.tokenBodies = tokenBodies;
  fixture.messageRequests = messageRequests;
  fixture.acks = acks;
  fixture.pings = 0;
  fixture.sendEvent = (socket, payload, messageId) => {
    sendBinary(
      socket,
      encodeFeishuFrame({
        seqId: 1n,
        logId: 2n,
        service: 155,
        method: 1,
        headers: [
          { key: "type", value: "event" },
          { key: "message_id", value: messageId },
          { key: "sum", value: "1" },
          { key: "seq", value: "0" },
          { key: "trace_id", value: "trace-1" },
        ],
        payload: new TextEncoder().encode(JSON.stringify(payload)),
      }),
    );
  };
  return fixture as FeishuFixture;
}

describe("Official Feishu SDK connector", () => {
  it("bootstraps through the official WSClient, receives an event, ACKs, and dedupes", async () => {
    const fixture = await startFeishuFixture();
    const connector = createFeishuBotConnector({
      appId: APP_ID,
      appSecret: APP_SECRET,
      deviceId: "device-1",
      domain: fixture.server.httpUrl,
      autoDispatchIngress: false,
    });
    try {
      await connector.connect();
      expect(connector.getStatus().state).toBe("connected");
      expect(fixture.bootstrapBodies[0]).toEqual({ AppID: APP_ID, AppSecret: APP_SECRET });

      await waitFor(() => fixture.sockets.length === 1, 3_000, "feishu ws connection");
      await waitFor(() => fixture.pings >= 1, 3_000, "feishu ping");

      const socket = fixture.sockets[0]!;
      fixture.sendEvent(socket, feishuEvent("om_message_1", "hello"), "om_message_1");
      await waitFor(() => connector.getIngressSize() === 1, 3_000, "feishu ingress");
      await waitFor(() => fixture.acks.length >= 1, 3_000, "feishu ack");

      const ack = fixture.acks[0]!;
      const ackPayload = feishuJsonPayload(ack) as { code?: number } | null;
      expect(ackPayload?.code).toBe(200);
      expect(getFeishuHeader(ack, "message_id")).toBe("om_message_1");
      expect(getFeishuHeader(ack, "biz_rt")).toBeDefined();

      const message = connector.drainIngress()[0]!;
      expect(message).toMatchObject({
        platform: "feishu",
        eventId: "om_message_1",
        platformUserId: "ou_user_1",
        conversationId: "oc_chat_1",
        text: "hello",
      });

      fixture.sendEvent(socket, feishuEvent("om_message_1", "hello"), "om_message_1");
      await waitFor(() => fixture.acks.length >= 2, 3_000, "duplicate feishu ack");
      await waitFor(() => connector.getMetrics().duplicates === 1, 3_000, "feishu dedupe");
      expect(connector.getIngressSize()).toBe(0);
      expect(connector.getMetrics().enqueued).toBe(1);
    } finally {
      await connector.disconnect();
      await fixture.server.close();
    }
  });

  it("reconnects through the official WSClient after an unexpected close", async () => {
    const fixture = await startFeishuFixture();
    const connector = createFeishuBotConnector({
      appId: APP_ID,
      appSecret: APP_SECRET,
      deviceId: "device-1",
      domain: fixture.server.httpUrl,
      autoDispatchIngress: false,
    });
    try {
      await connector.connect();
      await waitFor(() => fixture.sockets.length === 1, 3_000, "first feishu socket");
      fixture.sockets[0]!.terminate();
      // The official SDK retries the first reconnect immediately and only
      // later applies the server-provided interval, so `degraded` is transient.
      // Verify the SDK reconnect callbacks and the re-established connection.
      await waitFor(() => fixture.sockets.length >= 2, 5_000, "feishu reconnect socket");
      await waitFor(() => fixture.bootstrapBodies.length >= 2, 5_000, "feishu re-bootstrap");
      await waitFor(() => connector.getStatus().state === "connected", 5_000, "feishu reconnected");
      expect(connector.getMetrics().reconnectEvents).toBeGreaterThanOrEqual(1);
    } finally {
      await connector.disconnect();
      await fixture.server.close();
    }
  });

  it("does not reconnect after disconnect", async () => {
    const fixture = await startFeishuFixture();
    const connector = createFeishuBotConnector({
      appId: APP_ID,
      appSecret: APP_SECRET,
      deviceId: "device-1",
      domain: fixture.server.httpUrl,
      autoDispatchIngress: false,
    });
    await connector.connect();
    const socketCount = fixture.sockets.length;
    await connector.disconnect();
    expect(connector.getStatus().state).toBe("disconnected");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(fixture.sockets.length).toBe(socketCount);
    await fixture.server.close();
  });

  it("sends a text message through the official HTTP API without leaking the secret", async () => {
    const fixture = await startFeishuFixture();
    const connector = createFeishuBotConnector({
      appId: APP_ID,
      appSecret: APP_SECRET,
      deviceId: "device-1",
      domain: fixture.server.httpUrl,
      autoDispatchIngress: false,
    });
    try {
      await connector.send({
        platform: "feishu",
        conversationId: "oc_chat_1",
        text: "reply from bot",
      });
      expect(fixture.tokenBodies[0]).toEqual({ app_id: APP_ID, app_secret: APP_SECRET });
      expect(fixture.messageRequests).toHaveLength(1);
      const request = fixture.messageRequests[0]!;
      expect(request.headers.authorization).toBe("Bearer t-test-token");
      expect(request.path).toBe("/open-apis/im/v1/messages?receive_id_type=chat_id");
      const body = JSON.parse(request.body) as {
        receive_id: string;
        msg_type: string;
        content: string;
      };
      expect(body.receive_id).toBe("oc_chat_1");
      expect(body.msg_type).toBe("text");
      expect(JSON.parse(body.content)).toEqual({ text: "reply from bot" });
      expect(request.body).not.toContain(APP_SECRET);
    } finally {
      await connector.disconnect();
      await fixture.server.close();
    }
  });

  it("surfaces SDK auth failure as a terminal error with redacted status and logs", async () => {
    const fixture = await startFeishuFixture({
      // The SDK destructures `data` before checking `code`; include an empty
      // object so the real 514 handler (not a TypeError retry) is exercised.
      bootstrapResponse: { code: 514, msg: `auth failed for ${APP_SECRET}`, data: {} },
    });
    const logLines: string[] = [];
    const connector = createFeishuBotConnector({
      appId: APP_ID,
      appSecret: APP_SECRET,
      deviceId: "device-1",
      domain: fixture.server.httpUrl,
      autoDispatchIngress: false,
      logger: {
        debug: (message) => logLines.push(message),
        info: (message) => logLines.push(message),
        warn: (message) => logLines.push(message),
        error: (message) => logLines.push(message),
      },
    });
    await expect(connector.connect()).rejects.toThrow("code=514");
    expect(connector.getStatus().state).toBe("disconnected");
    expect(connector.getStatus().lastError ?? "").not.toContain(APP_SECRET);
    expect(logLines.join("\n")).not.toContain(APP_SECRET);
    expect(fixture.sockets.length).toBe(0);
    await connector.disconnect();
    await fixture.server.close();
  });

  it("rejects an appId shape that the official SDK would silently ignore", async () => {
    const connector = createFeishuBotConnector({
      appId: "not-a-valid-app-id",
      appSecret: APP_SECRET,
      deviceId: "device-1",
    });
    await expect(connector.connect()).rejects.toThrow("cli_");
    expect(connector.getStatus().state).toBe("disconnected");
  });
});
