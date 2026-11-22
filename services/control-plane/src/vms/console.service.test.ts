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

const RFB_VERSION = "RFB 003.008\n";

function serverInit(): Buffer {
  const init = Buffer.alloc(24);
  init.writeUInt16BE(1280, 0);
  init.writeUInt16BE(800, 2);
  init.writeUInt32BE(4, 20);
  return Buffer.concat([init, Buffer.from("test")]);
}

/** Reads exactly n bytes from a socket without assuming chunk boundaries. */
function readExactly(socket: net.Socket, count: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= count) {
        cleanup();
        socket.pause();
        socket.off("data", onData);
        const value = buffer.subarray(0, count);
        const rest = buffer.subarray(count);
        if (rest.length > 0) socket.unshift(rest);
        resolve(value);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.resume();
  });
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
  let activeSockets: net.Socket[];

  beforeEach(async () => {
    ctx = await createTestContext();
    leases = new LeaseService(ctx.app.db, new LeaseRepository(ctx.app.db));
    upstreamData = Buffer.alloc(0);
    splitHandshake = false;
    activeSockets = [];
    vncServer = net.createServer((socket) => {
      activeSockets.push(socket);
      socket.write(RFB_VERSION);
      void (async () => {
        await readExactly(socket, 12); // client version
        const security = Buffer.from([1, 1]);
        if (splitHandshake) {
          socket.write(security.subarray(0, 1));
          await new Promise((resolve) => setTimeout(resolve, 20));
          socket.write(security.subarray(1));
        } else {
          socket.write(security);
        }
        await readExactly(socket, 1); // None
        socket.write(Buffer.concat([Buffer.alloc(4), serverInit()]));
        socket.on("data", (chunk: Buffer) => {
          upstreamData = Buffer.concat([upstreamData, chunk]);
        });
        // readExactly pauses the socket; flowing mode is needed to observe the
        // frames the proxy forwards after ServerInit.
        socket.resume();
      })().catch(() => socket.destroy());
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
    for (const socket of activeSockets) socket.destroy();
    httpServer.close();
    vncServer.close();
    await ctx.close();
  });

  async function openConsole(session: { webSocketUrl: string }): Promise<{
    socket: WebSocket;
    next: () => Promise<Buffer>;
  }> {
    const socket = new WebSocket(`ws://127.0.0.1:${httpPort}${session.webSocketUrl}`);
    const pending: Buffer[] = [];
    const waiters: Array<(value: Buffer) => void> = [];
    // Attach before "open": the proxy sends its RFB version immediately after
    // the upgrade, which may happen before the open event is observed.
    socket.on("message", (data: Buffer) => {
      const waiter = waiters.shift();
      if (waiter) waiter(data);
      else pending.push(data);
    });
    await once(socket, "open");
    const next = (): Promise<Buffer> => {
      const value = pending.shift();
      if (value) return Promise.resolve(value);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no console frame")), 2_000);
        waiters.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      });
    };
    // The proxy speaks RFB 3.8 first, then a single None security type.
    const version = await next();
    expect(version.toString("ascii")).toBe(RFB_VERSION);
    socket.send(Buffer.from(RFB_VERSION), { binary: true });
    const security = await next();
    expect(security).toEqual(Buffer.from([1, 1]));
    socket.send(Buffer.from([1]), { binary: true });
    const securityResult = await next();
    expect(securityResult).toEqual(Buffer.alloc(4));
    const init = await next();
    expect(init.equals(serverInit())).toBe(true);
    return { socket, next };
  }

  it("uses one-time tickets and enforces the human Lease on every RFB input", async () => {
    const session = await consoles.openSession(ctx.vmId);
    expect(session.viewOnly).toBe(false);
    expect(session.lease).not.toBeNull();
    const url = `ws://127.0.0.1:${httpPort}${session.webSocketUrl}`;
    const { socket } = await openConsole(session);

    const reusedTicket = new WebSocket(url);
    const [ticketError] = await once(reusedTicket, "error");
    expect(String(ticketError)).toContain("403");

    const update = Buffer.from([3, 1, 0, 0, 0, 0, 0, 100, 0, 100]);
    const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
    socket.send(Buffer.concat([update, key]), { binary: true });
    await waitFor(() => upstreamData.length === update.length + key.length);
    expect(upstreamData).toEqual(Buffer.concat([update, key]));

    await leases.release(ctx.vmId, session.lease!.id);
    const closed = once(socket, "close");
    socket.send(Buffer.from([5, 1, 0, 100, 0, 200]), { binary: true });
    const [code] = (await closed) as [number];
    expect(code).toBe(1008);
    expect(upstreamData.length).toBe(update.length + key.length);
  });

  it("opens a passive view-only session without a Lease and drops all input", async () => {
    const session = await consoles.openSession(ctx.vmId, { viewOnly: true });
    expect(session.viewOnly).toBe(true);
    expect(session.lease).toBeNull();
    expect((await leases.control(ctx.vmId)).state).toBe("idle");

    const { socket } = await openConsole(session);
    const update = Buffer.from([3, 1, 0, 0, 0, 0, 0, 100, 0, 100]);
    const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
    const pointer = Buffer.from([5, 1, 0, 100, 0, 200]);
    socket.send(Buffer.concat([update, key, pointer]), { binary: true });
    await waitFor(() => upstreamData.length === update.length);
    // Only the framebuffer update request reaches QEMU; keyboard and pointer
    // events are discarded server-side.
    expect(upstreamData).toEqual(update);
    expect((await leases.control(ctx.vmId)).state).toBe("idle");
    socket.close();
  });

  it("buffers ServerInit when the security-type frame is split", async () => {
    splitHandshake = true;
    const session = await consoles.openSession(ctx.vmId);
    // openConsole waits for ServerInit, which must arrive despite the split.
    const { socket } = await openConsole(session);
    socket.close();
  });

  it("rejects input after the Lease is gone without forwarding bytes", async () => {
    const session = await consoles.openSession(ctx.vmId);
    const { socket } = await openConsole(session);
    await leases.release(ctx.vmId, session.lease!.id);
    const closed = once(socket, "close");
    socket.send(Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]), { binary: true });
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
