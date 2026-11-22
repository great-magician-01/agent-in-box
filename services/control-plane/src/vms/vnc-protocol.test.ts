import { createHash } from "node:crypto";
import { once } from "node:events";
import net, { type AddressInfo } from "node:net";
import tls from "node:tls";
import { describe, expect, it } from "vitest";
import { testCertificates } from "./testing/vnc-certificates";
import {
  ByteStream,
  negotiateVncUpstream,
  VncClientFramer,
  VncDownstreamHandshake,
} from "./vnc-protocol";

const RFB_VERSION = "RFB 003.008\n";

function serverInit(name = "test desktop"): Buffer {
  const init = Buffer.alloc(24);
  init.writeUInt16BE(1280, 0);
  init.writeUInt16BE(800, 2);
  init.writeUInt32BE(Buffer.byteLength(name), 20);
  return Buffer.concat([init, Buffer.from(name)]);
}

async function listen(server: net.Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function connect(port: number): Promise<net.Socket> {
  const socket = net.connect({ host: "127.0.0.1", port });
  await once(socket, "connect");
  return socket;
}

describe("VncDownstreamHandshake", () => {
  it("synthesizes the no-auth server handshake and consumes the client choices", () => {
    const handshake = new VncDownstreamHandshake();
    const first = handshake.feed(Buffer.from(RFB_VERSION));
    expect(first.reply).toEqual(Buffer.from([1, 1]));
    expect(first.done).toBe(false);
    const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
    const second = handshake.feed(Buffer.concat([Buffer.from([1]), key]));
    expect(second.done).toBe(true);
    expect(second.reply).toEqual(Buffer.alloc(4));
    expect(second.pending).toEqual(key);
  });

  it("rejects other RFB versions and security types", () => {
    expect(() => new VncDownstreamHandshake().feed(Buffer.from("RFB 003.003\n"))).toThrow(
      "RFB 3.8",
    );
    const handshake = new VncDownstreamHandshake();
    handshake.feed(Buffer.from(RFB_VERSION));
    expect(() => handshake.feed(Buffer.from([2]))).toThrow("no-auth");
  });
});

describe("negotiateVncUpstream", () => {
  it("performs a plain no-auth handshake and delivers pipelined ServerInit", async () => {
    let sawClientVersion = "";
    let sawSecurityChoice: number | null = null;
    const server = net.createServer(async (socket) => {
      socket.write(RFB_VERSION);
      const reader = new ByteStream(socket);
      sawClientVersion = (await reader.readExactly(12, 2_000)).toString("ascii");
      socket.write(Buffer.from([1, 1]));
      sawSecurityChoice = (await reader.readExactly(1, 2_000))[0] ?? null;
      // Result and ServerInit in one write to exercise the paused-socket buffer.
      socket.write(Buffer.concat([Buffer.alloc(4), serverInit()]));
    });
    const port = await listen(server);
    try {
      const socket = await connect(port);
      const result = await negotiateVncUpstream(socket, { requireTls: false }, 2_000);
      expect(sawClientVersion).toBe(RFB_VERSION);
      expect(sawSecurityChoice).toBe(1);
      expect(result.socket).toBe(socket);
      const delivered = await new Promise<Buffer>((resolve) => {
        result.socket.once("data", (chunk: Buffer) => resolve(chunk));
      });
      expect(delivered).toEqual(serverInit());
      socket.destroy();
    } finally {
      server.close();
    }
  });

  it("refuses an upstream that offers only password authentication", async () => {
    const server = net.createServer((socket) => {
      socket.write(RFB_VERSION);
      socket.once("data", () => {
        socket.write(Buffer.from([1, 2]));
      });
    });
    const port = await listen(server);
    try {
      const socket = await connect(port);
      await expect(negotiateVncUpstream(socket, { requireTls: false }, 2_000)).rejects.toThrow(
        "no-auth",
      );
      socket.destroy();
    } finally {
      server.close();
    }
  });

  it("rejects plain no-auth when TLS is required", async () => {
    const server = net.createServer((socket) => {
      socket.write(RFB_VERSION);
      socket.once("data", () => socket.write(Buffer.from([1, 1])));
    });
    const port = await listen(server);
    try {
      const socket = await connect(port);
      await expect(
        negotiateVncUpstream(
          socket,
          {
            requireTls: true,
            tls: {
              ca: testCertificates.ca,
              cert: testCertificates.clientCert,
              key: testCertificates.clientKey,
              fingerprint: testCertificates.serverFingerprint,
            },
          },
          2_000,
        ),
      ).rejects.toThrow("did not offer TLS");
      socket.destroy();
    } finally {
      server.close();
    }
  });

  it("negotiates VeNCrypt X509 inside TLS with a client certificate and pinned server", async () => {
    let selectedSubtype = 0;
    let peerCN: string | undefined;
    const server = net.createServer((socket) => {
      socket.write(RFB_VERSION);
      const reader = new ByteStream(socket);
      void (async () => {
        await reader.readExactly(12, 2_000);
        socket.write(Buffer.from([1, 19]));
        await reader.readExactly(1, 2_000);
        socket.write(Buffer.from([0, 2, 2]));
        const subtypes = Buffer.alloc(8);
        subtypes.writeUInt32BE(256, 0);
        subtypes.writeUInt32BE(257, 4);
        socket.write(subtypes);
        const choice = await reader.readExactly(4, 2_000);
        selectedSubtype = choice.readUInt32BE(0);
        const secure = new tls.TLSSocket(socket, {
          isServer: true,
          key: testCertificates.serverKey,
          cert: testCertificates.serverCert,
          ca: testCertificates.ca,
          requestCert: true,
          rejectUnauthorized: true,
        });
        secure.on("secure", () => {
          peerCN = secure.getPeerCertificate().subject?.CN as string | undefined;
          secure.write(Buffer.concat([Buffer.alloc(4), serverInit("secure desktop")]));
        });
        secure.on("error", () => socket.destroy());
      })().catch(() => socket.destroy());
    });
    const port = await listen(server);
    try {
      const socket = await connect(port);
      const result = await negotiateVncUpstream(
        socket,
        {
          requireTls: true,
          tls: {
            ca: testCertificates.ca,
            cert: testCertificates.clientCert,
            key: testCertificates.clientKey,
            fingerprint: testCertificates.serverFingerprint,
          },
        },
        5_000,
      );
      expect(selectedSubtype).toBe(257);
      expect(peerCN).toBe("agent-in-box-console");
      const delivered = await new Promise<Buffer>((resolve) => {
        result.socket.once("data", (chunk: Buffer) => resolve(chunk));
      });
      expect(delivered.equals(serverInit("secure desktop"))).toBe(true);
      result.socket.destroy();
    } finally {
      server.close();
    }
  });

  it("fails closed on a certificate fingerprint mismatch", async () => {
    const server = net.createServer((socket) => {
      socket.write(RFB_VERSION);
      const reader = new ByteStream(socket);
      void (async () => {
        await reader.readExactly(12, 2_000);
        socket.write(Buffer.from([1, 19]));
        await reader.readExactly(1, 2_000);
        socket.write(Buffer.from([0, 2, 1]));
        const subtype = Buffer.alloc(4);
        subtype.writeUInt32BE(256, 0);
        socket.write(subtype);
        await reader.readExactly(4, 2_000);
        const secure = new tls.TLSSocket(socket, {
          isServer: true,
          key: testCertificates.serverKey,
          cert: testCertificates.serverCert,
        });
        secure.on("error", () => socket.destroy());
        secure.on("secure", () => secure.write(Buffer.alloc(4)));
      })().catch(() => socket.destroy());
    });
    const port = await listen(server);
    try {
      const socket = await connect(port);
      const wrongFingerprint = createHash("sha256").update("other").digest("hex");
      await expect(
        negotiateVncUpstream(
          socket,
          {
            requireTls: true,
            tls: {
              ca: testCertificates.ca,
              cert: testCertificates.clientCert,
              key: testCertificates.clientKey,
              fingerprint: wrongFingerprint,
            },
          },
          5_000,
        ),
      ).rejects.toThrow("fingerprint");
      socket.destroy();
    } finally {
      server.close();
    }
  });
});

describe("VncClientFramer", () => {
  it("gates key, pointer and clipboard frames across arbitrary WebSocket chunks", () => {
    const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
    const pointer = Buffer.from([5, 1, 0, 100, 0, 200]);
    const update = Buffer.from([3, 1, 0, 0, 0, 0, 0, 100, 0, 100]);
    const cutText = Buffer.alloc(11);
    cutText[0] = 6;
    cutText.writeUInt32BE(3, 4);
    cutText.write("abc", 8);
    const combined = Buffer.concat([update, key, pointer, cutText]);
    const framer = new VncClientFramer();
    const frames = [];
    for (let offset = 0; offset < combined.length; offset += 3) {
      frames.push(...framer.feed(combined.subarray(offset, offset + 3)));
    }
    expect(frames.map((frame) => frame.requiresLease)).toEqual([false, true, true, true]);
    expect(Buffer.concat(frames.map((frame) => frame.data))).toEqual(combined);
  });

  it("supports and Lease-gates the QEMU extended keyboard events used by noVNC", () => {
    const extendedKey = Buffer.from([255, 0, 1, 0, 0, 0, 0, 65, 0, 0, 0, 65]);
    const framer = new VncClientFramer();
    const frames = [];
    frames.push(...framer.feed(extendedKey.subarray(0, 5)));
    expect(frames).toHaveLength(0);
    frames.push(...framer.feed(extendedKey.subarray(5)));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.requiresLease).toBe(true);
    expect(frames[0]?.data).toEqual(extendedKey);
  });

  it("fails closed for unknown messages that could bypass input inspection", () => {
    expect(() => new VncClientFramer().feed(Buffer.from([254, 0, 0, 0]))).toThrow("Unsupported");
    expect(() => new VncClientFramer().feed(Buffer.from([255, 1, 0, 0]))).toThrow("submessage");
  });
});
