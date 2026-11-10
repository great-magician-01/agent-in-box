import { describe, expect, it } from "vitest";
import { dedupKey, isAuthorizedUser } from "./index";

describe("bot connector helpers", () => {
  it("scopes dedup keys by platform and device", () => {
    expect(dedupKey("feishu", "device-1", "event-1")).toBe("feishu:device-1:event-1");
    expect(dedupKey("qq", "device-1", "event-1")).not.toBe(
      dedupKey("feishu", "device-1", "event-1"),
    );
  });

  it("rejects incomplete dedup keys", () => {
    expect(() => dedupKey("qq", "", "event-1")).toThrow();
  });

  it("checks the local user allowlist", () => {
    const allowed = new Set(["user-1"]);
    expect(isAuthorizedUser(allowed, "user-1")).toBe(true);
    expect(isAuthorizedUser(allowed, "user-2")).toBe(false);
  });
});
