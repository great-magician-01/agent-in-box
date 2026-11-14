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

  it("allows loopback only when explicitly requested", async () => {
    await expect(assertSafeOutboundUrl("http://127.0.0.1:11434/v1")).rejects.toThrow("回环");
    await expect(
      assertSafeOutboundUrl("http://127.0.0.1:11434/v1", { allowLoopback: true }),
    ).resolves.toBeUndefined();
  });
});
