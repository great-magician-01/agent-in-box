import { describe, expect, it } from "vitest";
import { computeBackoffDelay, DEFAULT_RECONNECT_POLICY, resolveReconnectPolicy } from "./reconnect";

describe("reconnect backoff", () => {
  it("grows exponentially and caps at maxDelayMs", () => {
    const policy = resolveReconnectPolicy({
      initialDelayMs: 10,
      maxDelayMs: 35,
      multiplier: 2,
      jitterRatio: 0,
    });
    expect(computeBackoffDelay(1, policy)).toBe(10);
    expect(computeBackoffDelay(2, policy)).toBe(20);
    expect(computeBackoffDelay(3, policy)).toBe(35);
    expect(computeBackoffDelay(4, policy)).toBe(35);
  });

  it("applies bounded deterministic jitter", () => {
    const policy = resolveReconnectPolicy({
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      multiplier: 2,
      jitterRatio: 0.2,
    });
    expect(computeBackoffDelay(1, policy, () => 0)).toBe(80);
    expect(computeBackoffDelay(1, policy, () => 0.5)).toBe(100);
    expect(computeBackoffDelay(1, policy, () => 1)).toBe(120);
  });

  it("rejects invalid policies and attempt numbers", () => {
    expect(() => resolveReconnectPolicy({ initialDelayMs: 10, maxDelayMs: 5 })).toThrow();
    expect(() => resolveReconnectPolicy({ multiplier: 0.5 })).toThrow();
    expect(() => resolveReconnectPolicy({ jitterRatio: 2 })).toThrow();
    expect(() => resolveReconnectPolicy({ maxAttempts: 0 })).toThrow();
    expect(() => computeBackoffDelay(0, DEFAULT_RECONNECT_POLICY)).toThrow();
  });
});
