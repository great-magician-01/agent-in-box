import { describe, expect, it } from "vitest";
import { redactSecrets, safeErrorMessage } from "./logger";

describe("secret redaction", () => {
  it("removes bearer/QQBot tokens and secret JSON fields", () => {
    const redacted = redactSecrets(
      'Authorization: Bearer t-secret-token QQBot qq-secret {"app_secret":"shh","clientSecret":"shh2"}',
    );
    expect(redacted).not.toContain("t-secret-token");
    expect(redacted).not.toContain("qq-secret");
    expect(redacted).not.toContain("shh");
    expect(redacted).toContain("[REDACTED]");
  });

  it("bounds long error messages", () => {
    expect(safeErrorMessage(new Error("x".repeat(1_000)))).toHaveLength(503);
  });
});
