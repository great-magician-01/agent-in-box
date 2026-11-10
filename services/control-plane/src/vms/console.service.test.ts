import { createServer, type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { LeaseRepository } from "../persistence/repositories/lease-repository";
import { LeaseService } from "../persistence/services/lease-service";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import { ConsoleService } from "./console.service";
import type { VmService } from "./vm.service";

function rfbHandshake(): Buffer {
  const init = Buffer.alloc(24);
  init.writeUInt16BE(1280, 0);
  init.writeUInt16BE(800, 2);
  init.writeUInt32BE(4, 20);
  return Buffer.concat([
    Buffer.from("RFB 003.008\n"),
    Buffer.from([1, 1]),
    Buffer.alloc(4),
    init,
    Buffer.from("test"),
  ]);
}

describe("ConsoleService", () => {
  let ctx: TestContext;
  let leases: LeaseService;
  let consoles: ConsoleService;
  let httpServer: Server;
  let vncServer: net.Server;
  let httpPort: number;
  let vncPort: number;
  let upstreamData: Buffer;
  let splitHandshake: boolean;

  beforeEach(async () => {
    ctx = await createTestContext();
    leases = new LeaseService(ctx.app.db, new LeaseRepository(ctx.app.db));
    upstreamData = Buffer.alloc(0);
    splitHandshake = false;
    vncServer = net.createServer((socket) => {
      const handshake = rfbHandshake();
      if (splitHandshake) {
        socket.write(handshake.subarray(0, 12));
        setTimeout(() => {
          if (!socket.destroyed) socket.write(handshake.subarray(12));
        }, 20);
      } else {
        socket.write(handshake);
      }
      socket.on("data", (chunk) => {
        upstreamData = Buffer.concat([upstreamData, chunk]);
      });
    });
    vncServer.listen(0, "127.0.0.1");
    await once(vncServer, "listening");
    vncPort = (vncServer.address() as AddressInfo).port;

    const vms = {
      console: async (vmId: string) => ({
        vmId,
        consoleUrl: `vnc://127.0.0.1:${vncPort}`,
        message: "test",
      }),
    } as unknown as VmService;
    consoles = new ConsoleService(vms, leases);
    httpServer = createServer();
    consoles.attach(httpServer);
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    httpPort = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    consoles.onModuleDestroy();
    httpServer.close();
    vncServer.close();
    await ctx.close();
  });

  it("uses one-time tickets and enforces the human Lease on every RFB input", async () => {
    const session = await consoles.openSession(ctx.vmId);
    const url = `ws://127.0.0.1:${httpPort}${session.webSocketUrl}`;
    const socket = new WebSocket(url);
    await once(socket, "open");
    const [firstFrame] = (await once(socket, "message")) as [Buffer];
    expect(firstFrame.subarray(0, 12).toString()).toBe("RFB 003.008\n");

    const reusedTicket = new WebSocket(url);
    const [ticketError] = await once(reusedTicket, "error");
    expect(String(ticketError)).toContain("403");

    const update = Buffer.from([3, 1, 0, 0, 0, 0, 0, 100, 0, 100]);
    const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
    socket.send(Buffer.concat([update, key]), { binary: true });
    await waitFor(() => upstreamData.length === update.length + key.length);
    expect(upstreamData).toEqual(Buffer.concat([update, key]));

    await leases.release(ctx.vmId, session.lease.id);
    const closed = once(socket, "close");
    socket.send(Buffer.from([5, 1, 0, 100, 0, 200]), { binary: true });
    const [code] = (await closed) as [number];
    expect(code).toBe(1008);
    expect(upstreamData.length).toBe(update.length + key.length);
  });

  it("does not let early input bypass the Lease when ServerInit is split", async () => {
    splitHandshake = true;
    const session = await consoles.openSession(ctx.vmId);
    const socket = new WebSocket(`ws://127.0.0.1:${httpPort}${session.webSocketUrl}`);
    await once(socket, "open");
    await once(socket, "message"); // Only the 12-byte RFB version has arrived.
    const closed = once(socket, "close");
    socket.send(Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]), { binary: true });
    await leases.release(ctx.vmId, session.lease.id);
    const [code] = (await closed) as [number];
    expect(code).toBe(1008);
    expect(upstreamData).toHaveLength(0);
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for VNC proxy input");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
