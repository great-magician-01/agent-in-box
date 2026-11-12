import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistenceError } from "../persistence/errors";
import { ApiExceptionFilter } from "./api-exception.filter";

function mockHost(): {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  host: Parameters<ApiExceptionFilter["catch"]>[1];
} {
  const status = vi.fn();
  const json = vi.fn();
  const response = { status: status.mockReturnValue({ json }), json };
  return {
    status,
    json,
    host: {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as Parameters<ApiExceptionFilter["catch"]>[1],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ApiExceptionFilter", () => {
  it("does not expose unhandled stack traces or credentials", () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { json, host } = mockHost();
    new ApiExceptionFilter().catch(
      new Error(
        "upstream failed with Bearer abcdefghijklmnop and key sk-live-abcdefghijklmnopqrstuvwxyz",
      ),
      host,
    );
    const body = json.mock.calls[0]?.[0] as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).not.toContain("abcdefghijklmnop");
    expect(body.error.message).not.toContain("sk-live");
    expect(body.error.message).toContain("诊断");
  });

  it("redacts credentials in persistence errors but keeps the code", () => {
    const { status, json, host } = mockHost();
    new ApiExceptionFilter().catch(
      new PersistenceError("validation_failed", "bad token Bearer abcdefghijklmnop"),
      host,
    );
    expect(status).toHaveBeenCalledWith(400);
    const body = json.mock.calls[0]?.[0] as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.message).not.toContain("abcdefghijklmnop");
    expect(body.error.message).toContain("[REDACTED]");
  });
});
