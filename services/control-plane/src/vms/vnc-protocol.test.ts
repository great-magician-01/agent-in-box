import { describe, expect, it } from "vitest";
import { VncClientFramer, VncClientNegotiation, VncServerHandshake } from "./vnc-protocol";

function handshakeBytes(name = "test desktop"): Buffer {
  const init = Buffer.alloc(24);
  init.writeUInt16BE(1280, 0);
  init.writeUInt16BE(800, 2);
  init.writeUInt32BE(Buffer.byteLength(name), 20);
  return Buffer.concat([
    Buffer.from("RFB 003.008\n", "ascii"),
    Buffer.from([1, 1]),
    Buffer.alloc(4),
    init,
    Buffer.from(name),
  ]);
}

describe("VncServerHandshake", () => {
  it("accepts a split no-auth RFB handshake without losing boundaries", () => {
    const handshake = new VncServerHandshake();
    for (const byte of handshakeBytes()) {
      handshake.feed(Buffer.from([byte]));
    }
    expect(handshake.done).toBe(true);
  });

  it("handles an empty desktop name and rejects unauthenticated security negotiation", () => {
    const emptyName = new VncServerHandshake();
    emptyName.feed(handshakeBytes(""));
    expect(emptyName.done).toBe(true);

    const noAuth = new VncServerHandshake();
    expect(() =>
      noAuth.feed(Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 2])])),
    ).toThrow("no-auth");
  });
});

describe("VncClientNegotiation", () => {
  it("allows only exact negotiation messages and buffers early input for later gating", () => {
    const negotiation = new VncClientNegotiation();
    const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
    const version = negotiation.feed(Buffer.from("RFB 003.008\n"));
    expect(version.negotiation).toHaveLength(1);
    expect(version.pending).toHaveLength(0);
    const rest = negotiation.feed(Buffer.concat([Buffer.from([1, 1]), key]));
    expect(rest.negotiation).toHaveLength(2);
    expect(rest.pending).toEqual(key);
  });

  it("rejects a non-auth security selection instead of forwarding it", () => {
    const negotiation = new VncClientNegotiation();
    negotiation.feed(Buffer.from("RFB 003.008\n"));
    expect(() => negotiation.feed(Buffer.from([2]))).toThrow("no-auth");
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
