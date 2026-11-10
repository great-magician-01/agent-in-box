import { describe, expect, it } from "vitest";
import {
  InMemoryDedupeStore,
  ManagedBotConnection,
  TerminalBotError,
  type BotProtocol,
  type BotProtocolSession,
  type ProtocolContext,
  type ProtocolSendTransport,
  type ResolvedBotConnection,
} from "./connection";
import type { OutboundBotMessage } from "./contracts";
import { DefaultWsConnector, type WsData } from "./ws";
import { sendJson, startMockServer, waitFor, type MockServer } from "./test-support/mock-server";

interface JsonEvent {
  type: "event";
  message: {
    eventId: string;
    platformUserId: string;
    conversationId: string;
    text: string;
    receivedAt: string;
    raw: unknown;
  };
}

class JsonTestProtocol implements BotProtocol {
  readonly platform = "feishu" as const;
  insideCallback = false;

  constructor(
    private readonly wsUrl: string,
    private readonly heartbeatMs?: number,
  ) {}

  async resolveConnection(): Promise<ResolvedBotConnection> {
    return { url: this.wsUrl };
  }

  createSession(context: ProtocolContext): BotProtocolSession {
    return {
      onOpen: () => {
        context.markReady();
        if (this.heartbeatMs !== undefined) {
          context.setHeartbeat(this.heartbeatMs, () => {
            context.sendRaw("heartbeat");
          });
        }
      },
      onMessage: async (data: WsData) => {
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        if (text === "heartbeat-ack") {
          return;
        }
        const payload = JSON.parse(text) as JsonEvent;
        if (payload.type !== "event") {
          return;
        }
        this.insideCallback = true;
        try {
          await context.acceptInbound(payload.message);
          context.sendRaw(JSON.stringify({ ack: payload.message.eventId }));
        } finally {
          this.insideCallback = false;
        }
      },
    };
  }

  async sendMessage(message: OutboundBotMessage, transport: ProtocolSendTransport): Promise<void> {
    transport.sendRaw(JSON.stringify({ send: message }));
  }
}

class TerminalProtocol implements BotProtocol {
  readonly platform = "qq" as const;

  async resolveConnection(): Promise<ResolvedBotConnection> {
    throw new TerminalBotError("test credentials rejected");
  }

  createSession(): BotProtocolSession {
    return { onOpen: () => {}, onMessage: () => {} };
  }
}

function testEvent(eventId: string): JsonEvent {
  return {
    type: "event",
    message: {
      eventId,
      platformUserId: "user-1",
      conversationId: "conversation-1",
      text: "hello",
      receivedAt: "2026-11-10T00:00:00.000Z",
      raw: { eventId },
    },
  };
}

const FAST_RECONNECT = {
  initialDelayMs: 20,
  maxDelayMs: 20,
  multiplier: 2,
  jitterRatio: 0,
  maxAttempts: 10,
};

async function withServer<T>(
  run: (server: MockServer) => Promise<T>,
  onWsConnection?: (socket: import("ws").WebSocket) => void,
): Promise<T> {
  const server = await startMockServer({ onWsConnection });
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

describe("ManagedBotConnection", () => {
  it("connects, receives events into ingress, and sends outbound frames", async () => {
    await withServer(async (server) => {
      const protocol = new JsonTestProtocol(server.wsUrl);
      const connector = new ManagedBotConnection({
        protocol,
        deviceId: "device-1",
        wsConnector: new DefaultWsConnector(),
        reconnect: FAST_RECONNECT,
        autoDispatchIngress: false,
      });
      try {
        await connector.connect();
        expect(connector.getStatus().state).toBe("connected");
        expect(connector.getStatus().lastConnectedAt).not.toBeNull();

        const socket = server.connections[0];
        expect(socket).toBeDefined();
        const received: string[] = [];
        socket!.on("message", (data) => received.push(data.toString()));

        sendJson(socket!, testEvent("event-1"));
        await waitFor(() => connector.getIngressSize() === 1, 3_000, "ingress event");

        const drained = connector.drainIngress();
        expect(drained).toHaveLength(1);
        expect(drained[0]).toMatchObject({
          platform: "feishu",
          eventId: "event-1",
          platformUserId: "user-1",
          conversationId: "conversation-1",
          text: "hello",
        });

        await connector.send({
          platform: "feishu",
          conversationId: "conversation-1",
          text: "reply",
        });
        await waitFor(
          () => received.some((line) => line.includes('"send"')),
          3_000,
          "outbound frame",
        );
      } finally {
        await connector.disconnect();
      }
    });
  });

  it("admits a duplicate event only once", async () => {
    await withServer(async (server) => {
      const protocol = new JsonTestProtocol(server.wsUrl);
      const connector = new ManagedBotConnection({
        protocol,
        deviceId: "device-1",
        wsConnector: new DefaultWsConnector(),
        reconnect: FAST_RECONNECT,
        autoDispatchIngress: false,
      });
      try {
        await connector.connect();
        const socket = server.connections[0]!;
        sendJson(socket, testEvent("event-dup"));
        sendJson(socket, testEvent("event-dup"));
        await waitFor(() => connector.getMetrics().duplicates === 1, 3_000, "duplicate admission");
        expect(connector.getIngressSize()).toBe(1);
        expect(connector.getMetrics().enqueued).toBe(1);
      } finally {
        await connector.disconnect();
      }
    });
  });

  it("reuses a caller-provided dedupe store across connector restarts", async () => {
    await withServer(async (server) => {
      const dedupeStore = new InMemoryDedupeStore();
      const makeConnector = () =>
        new ManagedBotConnection({
          protocol: new JsonTestProtocol(server.wsUrl),
          deviceId: "device-1",
          wsConnector: new DefaultWsConnector(),
          dedupeStore,
          reconnect: FAST_RECONNECT,
          autoDispatchIngress: false,
        });

      const first = makeConnector();
      try {
        await first.connect();
        sendJson(server.connections[0]!, testEvent("event-restart"));
        await waitFor(() => first.getIngressSize() === 1, 3_000, "first ingress");
        first.drainIngress();
      } finally {
        await first.disconnect();
      }

      // Simulates a fresh process reusing the same durable dedupe table.
      const second = makeConnector();
      try {
        await second.connect();
        await waitFor(() => server.connections.length >= 2, 3_000, "second connection");
        sendJson(server.connections[1]!, testEvent("event-restart"));
        await waitFor(() => second.getMetrics().duplicates === 1, 3_000, "restart duplicate");
        expect(second.getIngressSize()).toBe(0);
        expect(second.getMetrics().enqueued).toBe(0);
      } finally {
        await second.disconnect();
      }
    });
  });

  it("dispatches listeners after the websocket callback, not inside it", async () => {
    await withServer(async (server) => {
      const protocol = new JsonTestProtocol(server.wsUrl);
      const connector = new ManagedBotConnection({
        protocol,
        deviceId: "device-1",
        wsConnector: new DefaultWsConnector(),
        reconnect: FAST_RECONNECT,
      });
      const observedCallbackPhase: boolean[] = [];
      const messages: string[] = [];
      connector.onMessage((message) => {
        observedCallbackPhase.push(protocol.insideCallback);
        messages.push(message.eventId);
        expect(message.eventId).toBe("event-async");
      });
      try {
        await connector.connect();
        sendJson(server.connections[0]!, testEvent("event-async"));
        await waitFor(() => messages.length === 1, 3_000, "async dispatch");
        expect(observedCallbackPhase).toEqual([false]);
        expect(connector.getIngressSize()).toBe(0);
      } finally {
        await connector.disconnect();
      }
    });
  });

  it("reconnects with backoff after an unexpected close", async () => {
    await withServer(async (server) => {
      const protocol = new JsonTestProtocol(server.wsUrl);
      const connector = new ManagedBotConnection({
        protocol,
        deviceId: "device-1",
        wsConnector: new DefaultWsConnector(),
        reconnect: FAST_RECONNECT,
        autoDispatchIngress: false,
      });
      try {
        await connector.connect();
        expect(connector.getStatus().state).toBe("connected");

        server.connections[0]!.terminate();
        await waitFor(() => connector.getStatus().state === "degraded", 3_000, "degraded state");
        await waitFor(() => server.connections.length >= 2, 3_000, "reconnect");
        await waitFor(
          () => connector.getStatus().state === "connected",
          3_000,
          "reconnected state",
        );
        expect(connector.getMetrics().reconnectsScheduled).toBeGreaterThanOrEqual(1);
        expect(connector.getMetrics().connectAttempts).toBeGreaterThanOrEqual(2);
      } finally {
        await connector.disconnect();
      }
    });
  });

  it("does not reconnect after an explicit disconnect", async () => {
    await withServer(async (server) => {
      const connector = new ManagedBotConnection({
        protocol: new JsonTestProtocol(server.wsUrl),
        deviceId: "device-1",
        wsConnector: new DefaultWsConnector(),
        reconnect: FAST_RECONNECT,
        autoDispatchIngress: false,
      });
      await connector.connect();
      const connectionsBefore = server.connections.length;
      await connector.disconnect();
      expect(connector.getStatus().state).toBe("disconnected");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(server.connections.length).toBe(connectionsBefore);
    });
  });

  it("stops instead of retrying terminal authentication errors", async () => {
    await withServer(async (server) => {
      const connector = new ManagedBotConnection({
        protocol: new TerminalProtocol(),
        deviceId: "device-1",
        wsConnector: new DefaultWsConnector(),
        reconnect: FAST_RECONNECT,
      });
      await expect(connector.connect()).rejects.toThrow("test credentials rejected");
      expect(connector.getStatus().state).toBe("disconnected");
      expect(connector.getStatus().lastError).toContain("TerminalBotError");
      expect(connector.getMetrics().terminalErrors).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(server.connections.length).toBe(0);
      await connector.disconnect();
    });
  });

  it("reconnects when heartbeat activity times out", async () => {
    await withServer(async (server) => {
      const connector = new ManagedBotConnection({
        protocol: new JsonTestProtocol(server.wsUrl, 20),
        deviceId: "device-1",
        wsConnector: new DefaultWsConnector(),
        reconnect: FAST_RECONNECT,
        autoDispatchIngress: false,
        heartbeatTimeoutMs: 30,
      });
      try {
        await connector.connect();
        await waitFor(() => server.connections.length >= 2, 3_000, "heartbeat reconnect");
      } finally {
        await connector.disconnect();
      }
    });
  });
});
