import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import {
  createQqBotConnector,
  qqConversationId,
  qqPassiveReply,
  type QqOutboundBotMessage,
} from "./qq";
import type { InboundBotMessage } from "./contracts";
import type { MockHttpRequest, MockServer } from "./test-support/mock-server";
import { sendJson, startMockServer, waitFor } from "./test-support/mock-server";

const APP_ID = "qq-app-id";
const CLIENT_SECRET = "qq-client-secret-value";

interface QqFixture {
  server: MockServer;
  sockets: WebSocket[];
  tokenBodies: Record<string, unknown>[];
  gatewayAuthorizations: string[];
  identifies: Array<Record<string, unknown>>;
  resumes: Array<Record<string, unknown>>;
  heartbeats: Array<Record<string, unknown>>;
  outboundRequests: MockHttpRequest[];
  sendEvent(socket: WebSocket, payload: unknown): void;
}

async function startQqFixture(
  overrides: {
    tokenResponse?: unknown;
    gatewayResponse?: (wsUrl: string) => unknown;
    identifyAction?: "ready" | "close-4014" | "close-4004";
    closeAfterReadyCode?: number;
    sendResponse?: unknown;
  } = {},
): Promise<QqFixture> {
  const sockets: WebSocket[] = [];
  const tokenBodies: Record<string, unknown>[] = [];
  const gatewayAuthorizations: string[] = [];
  const identifies: Array<Record<string, unknown>> = [];
  const resumes: Array<Record<string, unknown>> = [];
  const heartbeats: Array<Record<string, unknown>> = [];
  const outboundRequests: MockHttpRequest[] = [];
  const fixture: Partial<QqFixture> = {};

  const server = await startMockServer({
    onHttp: (request, response) => {
      const path = request.path.split("?")[0];
      if (request.method === "POST" && path === "/app/getAppAccessToken") {
        tokenBodies.push(JSON.parse(request.body) as Record<string, unknown>);
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            overrides.tokenResponse ?? { access_token: "qq-access-token", expires_in: "7200" },
          ),
        );
        return true;
      }
      if (request.method === "GET" && path === "/gateway") {
        const authorization = request.headers.authorization;
        gatewayAuthorizations.push(typeof authorization === "string" ? authorization : "");
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            overrides.gatewayResponse?.(server.wsUrl) ?? {
              url: `${server.wsUrl}/websocket`,
            },
          ),
        );
        return true;
      }
      if (
        request.method === "POST" &&
        (path.startsWith("/v2/groups/") || path.startsWith("/v2/users/"))
      ) {
        outboundRequests.push(request);
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            overrides.sendResponse ?? { id: "ROBOT1.0_reply", timestamp: "2026-11-10T00:00:00Z" },
          ),
        );
        return true;
      }
      return false;
    },
    onWsConnection: (socket) => {
      sockets.push(socket);
      sendJson(socket, { op: 10, d: { heartbeat_interval: 500 } });
      socket.on("message", (data) => {
        const payload = JSON.parse(data.toString()) as Record<string, unknown>;
        const op = payload.op;
        if (op === 2) {
          identifies.push(payload);
          if (overrides.identifyAction === "close-4014") {
            socket.close(4014, "disallowed intents");
            return;
          }
          if (overrides.identifyAction === "close-4004" && identifies.length === 1) {
            socket.close(4004, "invalid token");
            return;
          }
          sendJson(socket, {
            op: 0,
            s: 1,
            t: "READY",
            d: {
              version: 1,
              session_id: "session-1",
              user: { id: "bot-1", username: "test-bot", bot: true },
              shard: [0, 1],
            },
          });
          if (overrides.closeAfterReadyCode !== undefined && identifies.length === 1) {
            setTimeout(() => socket.close(overrides.closeAfterReadyCode!, "test close"), 10);
          }
          return;
        }
        if (op === 6) {
          resumes.push(payload);
          sendJson(socket, { op: 0, s: 100, t: "RESUMED", d: "" });
          return;
        }
        if (op === 1) {
          heartbeats.push(payload);
          sendJson(socket, { op: 11 });
        }
      });
    },
  });

  fixture.server = server;
  fixture.sockets = sockets;
  fixture.tokenBodies = tokenBodies;
  fixture.gatewayAuthorizations = gatewayAuthorizations;
  fixture.identifies = identifies;
  fixture.resumes = resumes;
  fixture.heartbeats = heartbeats;
  fixture.outboundRequests = outboundRequests;
  fixture.sendEvent = (socket, payload) => sendJson(socket, payload);
  return fixture as QqFixture;
}

const FAST_RECONNECT = {
  initialDelayMs: 20,
  maxDelayMs: 20,
  multiplier: 2,
  jitterRatio: 0,
  maxAttempts: 10,
};

function c2cEvent(sequence: number, messageId: string, text: string): unknown {
  return {
    id: `outer-${sequence}`,
    op: 0,
    s: sequence,
    t: "C2C_MESSAGE_CREATE",
    d: {
      id: messageId,
      content: text,
      timestamp: "2026-11-10T00:00:00+08:00",
      author: { user_openid: "user-1", username: "tester", bot: false },
      message_scene: { source: "default", ext: ["msg_idx=idx-1"] },
      message_type: 0,
    },
  };
}

function groupEvent(sequence: number, messageId: string, text: string): unknown {
  return {
    id: `outer-group-${sequence}`,
    op: 0,
    s: sequence,
    t: "GROUP_AT_MESSAGE_CREATE",
    d: {
      id: messageId,
      content: text,
      timestamp: "2026-11-10T00:00:00+08:00",
      group_openid: "group-1",
      author: { member_openid: "member-1", username: "tester", bot: false },
      message_type: 0,
    },
  };
}

describe("QQ gateway adapter", () => {
  it("performs the Hello/Identify/READY handshake and maps real event fields", async () => {
    const fixture = await startQqFixture();
    const connector = createQqBotConnector({
      appId: APP_ID,
      clientSecret: CLIENT_SECRET,
      deviceId: "device-1",
      apiBase: fixture.server.httpUrl,
      reconnect: FAST_RECONNECT,
      autoDispatchIngress: false,
    });
    try {
      await connector.connect();
      expect(connector.getStatus().state).toBe("connected");
      expect(fixture.tokenBodies[0]).toEqual({ appId: APP_ID, clientSecret: CLIENT_SECRET });
      expect(fixture.gatewayAuthorizations[0]).toBe("QQBot qq-access-token");
      await waitFor(() => fixture.identifies.length === 1, 3_000, "qq identify");

      const identify = fixture.identifies[0]!;
      expect(identify.op).toBe(2);
      expect(identify.d).toMatchObject({
        token: "QQBot qq-access-token",
        intents: 1 << 25,
        shard: [0, 1],
        properties: {
          $os: process.platform,
          $browser: "agent-in-box",
          $device: "agent-in-box",
        },
      });

      const socket = fixture.sockets[0]!;
      fixture.sendEvent(socket, c2cEvent(2, "msg-1", "hello"));
      await waitFor(() => connector.getIngressSize() === 1, 3_000, "qq c2c ingress");
      const c2c = connector.drainIngress()[0]!;
      expect(c2c).toMatchObject({
        platform: "qq",
        eventId: "msg-1",
        platformUserId: "user-1",
        conversationId: qqConversationId("c2c", "user-1"),
        text: "hello",
      });

      fixture.sendEvent(socket, groupEvent(3, "msg-2", "group hello"));
      await waitFor(() => connector.getIngressSize() === 1, 3_000, "qq group ingress");
      const group = connector.drainIngress()[0]!;
      expect(group).toMatchObject({
        platform: "qq",
        eventId: "msg-2",
        platformUserId: "member-1",
        conversationId: qqConversationId("group", "group-1"),
        text: "group hello",
      });
    } finally {
      await connector.disconnect();
      await fixture.server.close();
    }
  });

  it("dedupes repeated message pushes", async () => {
    const fixture = await startQqFixture();
    const connector = createQqBotConnector({
      appId: APP_ID,
      clientSecret: CLIENT_SECRET,
      deviceId: "device-1",
      apiBase: fixture.server.httpUrl,
      reconnect: FAST_RECONNECT,
      autoDispatchIngress: false,
    });
    try {
      await connector.connect();
      await waitFor(() => fixture.sockets.length === 1, 3_000, "qq socket");
      const socket = fixture.sockets[0]!;
      fixture.sendEvent(socket, c2cEvent(2, "msg-dup", "hello"));
      await waitFor(() => connector.getIngressSize() === 1, 3_000, "first qq ingress");
      fixture.sendEvent(socket, c2cEvent(2, "msg-dup", "hello"));
      await waitFor(() => connector.getMetrics().duplicates === 1, 3_000, "qq dedupe");
      expect(connector.getIngressSize()).toBe(1);
      expect(connector.getMetrics().enqueued).toBe(1);
    } finally {
      await connector.disconnect();
      await fixture.server.close();
    }
  });

  it("resumes the session after an unexpected close", async () => {
    const fixture = await startQqFixture();
    const connector = createQqBotConnector({
      appId: APP_ID,
      clientSecret: CLIENT_SECRET,
      deviceId: "device-1",
      apiBase: fixture.server.httpUrl,
      reconnect: FAST_RECONNECT,
      autoDispatchIngress: false,
    });
    try {
      await connector.connect();
      await waitFor(() => fixture.sockets.length === 1, 3_000, "first qq socket");
      fixture.sendEvent(fixture.sockets[0]!, c2cEvent(2, "msg-before-resume", "hello"));
      await waitFor(() => connector.getIngressSize() === 1, 3_000, "qq ingress before resume");
      connector.drainIngress();

      fixture.sockets[0]!.terminate();
      await waitFor(() => connector.getStatus().state === "degraded", 3_000, "qq degraded");
      await waitFor(() => fixture.sockets.length >= 2, 3_000, "qq reconnect socket");
      await waitFor(() => fixture.resumes.length >= 1, 3_000, "qq resume");
      await waitFor(() => connector.getStatus().state === "connected", 3_000, "qq resumed state");

      expect(fixture.resumes[0]).toMatchObject({
        op: 6,
        d: {
          token: "QQBot qq-access-token",
          session_id: "session-1",
          seq: 2,
        },
      });
      expect(connector.getMetrics().reconnectsScheduled).toBeGreaterThanOrEqual(1);
    } finally {
      await connector.disconnect();
      await fixture.server.close();
    }
  });

  it("refreshes the token and re-identifies after close code 4004", async () => {
    const fixture = await startQqFixture({ identifyAction: "close-4004" });
    const connector = createQqBotConnector({
      appId: APP_ID,
      clientSecret: CLIENT_SECRET,
      deviceId: "device-1",
      apiBase: fixture.server.httpUrl,
      tokenBaseUrl: fixture.server.httpUrl,
      reconnect: FAST_RECONNECT,
      autoDispatchIngress: false,
    });
    try {
      await connector.connect();
      expect(connector.getStatus().state).toBe("connected");
      expect(fixture.identifies.length).toBeGreaterThanOrEqual(2);
      expect(fixture.tokenBodies.length).toBeGreaterThanOrEqual(2);
      expect(fixture.resumes).toHaveLength(0);
      expect(connector.getStatus().lastError).toBeNull();
    } finally {
      await connector.disconnect();
      await fixture.server.close();
    }
  });

  it("clears the session and re-identifies after close code 4009", async () => {
    const fixture = await startQqFixture({ closeAfterReadyCode: 4009 });
    const connector = createQqBotConnector({
      appId: APP_ID,
      clientSecret: CLIENT_SECRET,
      deviceId: "device-1",
      apiBase: fixture.server.httpUrl,
      tokenBaseUrl: fixture.server.httpUrl,
      reconnect: FAST_RECONNECT,
      autoDispatchIngress: false,
    });
    try {
      await connector.connect();
      await waitFor(() => fixture.sockets.length >= 2, 5_000, "4009 reconnect");
      await waitFor(() => fixture.identifies.length >= 2, 5_000, "4009 identify");
      await waitFor(() => connector.getStatus().state === "connected", 5_000, "4009 connected");
      expect(fixture.resumes).toHaveLength(0);
      expect(fixture.tokenBodies.length).toBeGreaterThanOrEqual(2);
    } finally {
      await connector.disconnect();
      await fixture.server.close();
    }
  });

  it("keeps the session when opcode 9 reports a resumable session", async () => {
    const fixture = await startQqFixture();
    const connector = createQqBotConnector({
      appId: APP_ID,
      clientSecret: CLIENT_SECRET,
      deviceId: "device-1",
      apiBase: fixture.server.httpUrl,
      tokenBaseUrl: fixture.server.httpUrl,
      reconnect: FAST_RECONNECT,
      autoDispatchIngress: false,
    });
    try {
      await connector.connect();
      await waitFor(() => fixture.sockets.length === 1, 3_000, "op9 socket");
      fixture.sendEvent(fixture.sockets[0]!, { op: 9, d: true });
      await waitFor(() => fixture.sockets.length >= 2, 5_000, "op9 reconnect");
      await waitFor(() => fixture.resumes.length >= 1, 5_000, "op9 resume");
      expect(fixture.resumes[0]).toMatchObject({
        op: 6,
        d: { session_id: "session-1", seq: 1 },
      });
    } finally {
      await connector.disconnect();
      await fixture.server.close();
    }
  });

  it("does not reconnect after disconnect", async () => {
    const fixture = await startQqFixture();
    const connector = createQqBotConnector({
      appId: APP_ID,
      clientSecret: CLIENT_SECRET,
      deviceId: "device-1",
      apiBase: fixture.server.httpUrl,
      reconnect: FAST_RECONNECT,
      autoDispatchIngress: false,
    });
    await connector.connect();
    const socketCount = fixture.sockets.length;
    await connector.disconnect();
    expect(connector.getStatus().state).toBe("disconnected");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fixture.sockets.length).toBe(socketCount);
    await fixture.server.close();
  });

  it("sends group and C2C messages through the official HTTP API", async () => {
    const fixture = await startQqFixture();
    const connector = createQqBotConnector({
      appId: APP_ID,
      clientSecret: CLIENT_SECRET,
      deviceId: "device-1",
      apiBase: fixture.server.httpUrl,
      reconnect: FAST_RECONNECT,
      autoDispatchIngress: false,
    });
    try {
      const groupMessage: QqOutboundBotMessage = {
        platform: "qq",
        conversationId: qqConversationId("group", "group-1"),
        text: "group reply",
        replyToMessageId: "msg-2",
        msgSeq: 2,
      };
      await connector.send(groupMessage);
      const c2cMessage: QqOutboundBotMessage = {
        platform: "qq",
        conversationId: qqConversationId("c2c", "user-1"),
        text: "c2c reply",
      };
      await connector.send(c2cMessage);

      expect(fixture.outboundRequests).toHaveLength(2);
      const groupRequest = fixture.outboundRequests[0]!;
      expect(groupRequest.path).toBe("/v2/groups/group-1/messages");
      expect(groupRequest.headers.authorization).toBe("QQBot qq-access-token");
      expect(JSON.parse(groupRequest.body)).toEqual({
        msg_type: 0,
        content: "group reply",
        msg_id: "msg-2",
        msg_seq: 2,
      });

      const c2cRequest = fixture.outboundRequests[1]!;
      expect(c2cRequest.path).toBe("/v2/users/user-1/messages");
      expect(JSON.parse(c2cRequest.body)).toEqual({
        msg_type: 0,
        content: "c2c reply",
      });
      expect(groupRequest.body).not.toContain(CLIENT_SECRET);
    } finally {
      await connector.disconnect();
      await fixture.server.close();
    }
  });

  it("stops on terminal gateway close codes such as 4014", async () => {
    const fixture = await startQqFixture({ identifyAction: "close-4014" });
    const connector = createQqBotConnector({
      appId: APP_ID,
      clientSecret: CLIENT_SECRET,
      deviceId: "device-1",
      apiBase: fixture.server.httpUrl,
      reconnect: FAST_RECONNECT,
      autoDispatchIngress: false,
    });
    await expect(connector.connect()).rejects.toThrow("4014");
    expect(connector.getStatus().state).toBe("disconnected");
    expect(connector.getMetrics().terminalErrors).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fixture.sockets.length).toBe(1);
    await connector.disconnect();
    await fixture.server.close();
  });

  it("rejects invalid app credentials as a terminal error without leaking the secret", async () => {
    const fixture = await startQqFixture({
      tokenResponse: { code: 100016, message: `invalid secret ${CLIENT_SECRET}` },
    });
    const connector = createQqBotConnector({
      appId: APP_ID,
      clientSecret: CLIENT_SECRET,
      deviceId: "device-1",
      apiBase: fixture.server.httpUrl,
      reconnect: FAST_RECONNECT,
      autoDispatchIngress: false,
    });
    await expect(connector.connect()).rejects.toThrow("code 100016");
    expect(connector.getStatus().state).toBe("disconnected");
    expect(connector.getStatus().lastError ?? "").not.toContain(CLIENT_SECRET);
    expect(fixture.sockets.length).toBe(0);
    await connector.disconnect();
    await fixture.server.close();
  });

  it("builds a passive reply from an inbound message", () => {
    const inbound: InboundBotMessage = {
      platform: "qq",
      eventId: "msg-1",
      platformUserId: "user-1",
      conversationId: qqConversationId("c2c", "user-1"),
      text: "hello",
      receivedAt: "2026-11-10T00:00:00.000Z",
      raw: c2cEvent(2, "msg-1", "hello"),
    };
    expect(qqPassiveReply(inbound, "reply")).toEqual({
      platform: "qq",
      conversationId: "c2c:user-1",
      text: "reply",
      replyToMessageId: "msg-1",
    });
  });
});
