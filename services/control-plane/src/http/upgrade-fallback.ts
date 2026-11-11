import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

/**
 * Register after all specific WebSocket owners. Node leaves unknown upgrade
 * sockets open whenever at least one upgrade listener exists, so the final
 * listener must explicitly reject paths that no owner claimed.
 */
export function attachUpgradeFallback(server: HttpServer): () => void {
  const listener = (request: IncomingMessage, socket: Duplex): void => {
    let pathname = "";
    try {
      pathname = new URL(request.url ?? "", "http://127.0.0.1").pathname;
    } catch {
      pathname = "";
    }
    if (pathname === "/api/v1/events/ws" || /^\/api\/v1\/vms\/[^/]+\/console\/ws$/.test(pathname)) {
      return;
    }
    if (socket.destroyed) return;
    socket.write(
      "HTTP/1.1 404 WebSocket route not found\r\n" +
        "Connection: close\r\n" +
        "Content-Length: 0\r\n" +
        "X-Content-Type-Options: nosniff\r\n\r\n",
    );
    socket.destroy();
  };
  server.on("upgrade", listener);
  return () => server.off("upgrade", listener);
}
