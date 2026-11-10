import { describe, expect, it } from "vitest";
import { BUILT_IN_BOT_PLATFORMS, dedupKey, isAuthorizedUser, type BotPlatform } from "./index";

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

  it("accepts future platforms without changing the core framework", () => {
    const platform: BotPlatform = "onebot";
    expect(BUILT_IN_BOT_PLATFORMS).toEqual(["feishu", "qq"]);
    expect(dedupKey(platform, "device-1", "event-1")).toBe("onebot:device-1:event-1");
    expect(dedupKey("discord", "device-1", "event-1")).toBe("discord:device-1:event-1");
  });

  it("checks the local user allowlist", () => {
    const allowed = new Set(["user-1"]);
    expect(isAuthorizedUser(allowed, "user-1")).toBe(true);
    expect(isAuthorizedUser(allowed, "user-2")).toBe(false);
  });
});
