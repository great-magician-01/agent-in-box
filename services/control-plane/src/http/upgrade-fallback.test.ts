import { once } from "node:events";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { attachUpgradeFallback } from "./upgrade-fallback";

let server: http.Server;
let port: number;
let detach: () => void;
const sockets = new Set<WebSocket>();

beforeEach(async () => {
  server = http.createServer();
  detach = attachUpgradeFallback(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  port = address.port;
});

afterEach(async () => {
  detach();
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("attachUpgradeFallback", () => {
  it("rejects unknown upgrade paths instead of leaving TCP sockets open", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/unknown/ws`);
    sockets.add(socket);
    const [error] = (await once(socket, "error")) as [Error];
    expect(error.message).toContain("404");
  });
});
