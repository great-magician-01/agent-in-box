import { describe, expect, it } from "vitest";
import {
  BUILT_IN_BOT_PLATFORMS,
  InboundPipeline,
  dedupKey,
  isAuthorizedUser,
  type BotPlatform,
  type InboundBotMessage,
} from "./index";

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

  it("persists the full message through a durable ingress store before admitting it", async () => {
    const persisted: Array<{ key: string; message: InboundBotMessage }> = [];
    const pipeline = new InboundPipeline({
      platform: "feishu",
      deviceId: "device-1",
      autoDispatchIngress: false,
      ingressStore: {
        admit(key, message) {
          if (persisted.some((item) => item.key === key)) return false;
          persisted.push({ key, message });
          return true;
        },
      },
    });
    const draft = {
      eventId: "event-1",
      platformUserId: "user-1",
      conversationId: "chat-1",
      text: "hello",
      receivedAt: "2026-11-11T00:00:00.000Z",
      raw: { id: 1 },
    };
    expect(await pipeline.accept(draft)).toBe("enqueued");
    expect(await pipeline.accept(draft)).toBe("duplicate");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.key).toBe("feishu:device-1:event-1");
    expect(persisted[0]?.message.text).toBe("hello");
  });
});
