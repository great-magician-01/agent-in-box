import { describe, expect, it } from "vitest";
import { redactErrorText, redactText, redactValue } from "./redaction";

describe("credential redaction", () => {
  it("redacts access keys, provider keys, bearer tokens and cookies", () => {
    const input = [
      "authorization: Bearer abcdefghijklmnop",
      `access key aib_${"Z".repeat(32)}`,
      "key sk-live-abcdefghijklmnopqrstuvwxyz",
      "anthropic sk-ant-abcdefghijklmnop",
      "QQBot qqbot-token-value-123456",
      "url?access_token=token-value&x=1",
      "Cookie: aib_session=session-value",
    ].join("\n");
    const output = redactText(input);
    for (const secret of [
      "abcdefghijklmnop",
      "Z".repeat(32),
      "abcdefghijklmnopqrstuvwxyz",
      "qqbot-token-value-123456",
      "token-value",
      "session-value",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("[REDACTED]");
  });

  it("redacts verification codes when presented as a key-value pair", () => {
    const output = redactText("短信验证码：654321\nverification_code=998877\n请输入验证码");
    expect(output).not.toContain("654321");
    expect(output).not.toContain("998877");
    expect(output).toContain("请输入验证码");
  });

  it("redacts structured secret keys recursively and bounds depth", () => {
    const output = redactValue({
      authorization: "Bearer abc",
      nested: {
        apiKey: "sk-live-abcdefghijklmnopqrstuvwxyz",
        message: "visible",
        credentials: { value: "hidden" },
      },
      list: [{ token: "hidden" }, "visible"],
    }) as Record<string, unknown>;
    expect(output.authorization).toBe("[REDACTED]");
    const nested = output.nested as Record<string, unknown>;
    expect(nested.apiKey).toBe("[REDACTED]");
    expect(nested.message).toBe("visible");
    expect(nested.credentials).toBe("[REDACTED]");
    const list = output.list as Array<Record<string, unknown> | string>;
    expect(list[0]).toEqual({ token: "[REDACTED]" });
    expect(list[1]).toBe("visible");
  });

  it("redacts errors without changing ordinary messages", () => {
    expect(redactErrorText(new Error("failed with sk-live-abcdefghijklmnopqrstuvwxyz"))).toContain(
      "[REDACTED_API_KEY]",
    );
    expect(redactErrorText(new Error("worker is offline"))).toBe("worker is offline");
  });
});
