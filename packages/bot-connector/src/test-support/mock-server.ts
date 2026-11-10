/** Local HTTP + WebSocket mock server used by the bot-connector tests. */

import { Buffer } from "node:buffer";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export interface MockHttpRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export type MockHttpHandler = (
  request: MockHttpRequest,
  response: ServerResponse,
) => boolean | Promise<boolean>;

export interface MockServerOptions {
  onHttp?: MockHttpHandler;
  onWsConnection?: (socket: WebSocket, request: IncomingMessage) => void | Promise<void>;
}

export interface MockServer {
  readonly httpUrl: string;
  readonly wsUrl: string;
  readonly connections: readonly WebSocket[];
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startMockServer(options: MockServerOptions = {}): Promise<MockServer> {
  const connections: WebSocket[] = [];
  const webSocketServer = new WebSocketServer({ noServer: true });

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const body = await readBody(request);
        const parsed = new URL(request.url ?? "/", "http://127.0.0.1");
        const handled = await options.onHttp?.(
          {
            method: request.method ?? "GET",
            path: parsed.pathname + parsed.search,
            headers: request.headers,
            body,
          },
          response,
        );
        if (!handled) {
          response.statusCode = 404;
          response.end("not found");
        }
      } catch (error) {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : "mock handler failed");
      }
    })();
  });

  server.on("upgrade", (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      connections.push(webSocket);
      void Promise.resolve(options.onWsConnection?.(webSocket, request)).catch(() => {
        webSocket.close();
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const httpUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}`;

  return {
    httpUrl,
    wsUrl,
    connections,
    async close(): Promise<void> {
      for (const connection of connections) {
        connection.terminate();
      }
      await new Promise<void>((resolve) => {
        webSocketServer.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

export function sendJson(socket: WebSocket, value: unknown): void {
  socket.send(JSON.stringify(value));
}

export function sendBinary(socket: WebSocket, value: Uint8Array): void {
  socket.send(Buffer.from(value));
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

export async function waitForValue<T>(
  getter: () => T | undefined,
  timeoutMs = 3_000,
  label = "value",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = getter();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}
