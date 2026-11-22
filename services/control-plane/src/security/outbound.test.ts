import { describe, expect, it } from "vitest";
import { assertSafeOutboundUrl } from "./outbound";

describe("assertSafeOutboundUrl", () => {
  it("rejects metadata, private and non-HTTP destinations", async () => {
    await expect(assertSafeOutboundUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(
      "私有",
    );
    await expect(assertSafeOutboundUrl("https://10.0.0.5/v1")).rejects.toThrow("私有");
    await expect(assertSafeOutboundUrl("https://192.168.1.1/v1")).rejects.toThrow("私有");
    await expect(assertSafeOutboundUrl("file:///etc/passwd")).rejects.toThrow("HTTP");
  });

  it("classifies WebSocket URLs with the same address rules", async () => {
    await expect(assertSafeOutboundUrl("wss://10.0.0.5/gateway")).rejects.toThrow("私有");
    await expect(
      assertSafeOutboundUrl("ws://127.0.0.1:8080/gateway", { allowLoopback: true }),
    ).resolves.toBeUndefined();
    await expect(assertSafeOutboundUrl("ws://169.254.169.254/latest")).rejects.toThrow("私有");
    await expect(assertSafeOutboundUrl("ftp://example.com/file")).rejects.toThrow("HTTP");
  });

  it("rejects IPv4-mapped loopback and private IPv6 literals", async () => {
    await expect(assertSafeOutboundUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow("回环");
    await expect(
      assertSafeOutboundUrl("http://[::ffff:127.0.0.1]/", { allowLoopback: true }),
    ).resolves.toBeUndefined();
    await expect(assertSafeOutboundUrl("http://[::ffff:10.0.0.5]/")).rejects.toThrow("私有");
  });

  it("allows loopback only when explicitly requested", async () => {
    await expect(assertSafeOutboundUrl("http://127.0.0.1:11434/v1")).rejects.toThrow("回环");
    await expect(
      assertSafeOutboundUrl("http://127.0.0.1:11434/v1", { allowLoopback: true }),
    ).resolves.toBeUndefined();
  });
});
