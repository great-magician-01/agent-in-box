import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonLineLogger, redactSensitive, redactText } from "./logger";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "agent-in-box-logger-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("desktop logger", () => {
  it("writes JSON lines and redacts secrets", () => {
    const directory = temporaryDirectory();
    const logger = new JsonLineLogger({
      directory,
      scope: "test",
      now: () => new Date("2026-11-10T00:00:00.000Z"),
    });

    logger.info("模型请求完成", {
      providerId: "anthropic",
      apiKey: "sk-secret-value",
      nested: { authorization: "Bearer token" },
    });

    const lines = readFileSync(path.join(directory, "desktop.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(record).toMatchObject({
      time: "2026-11-10T00:00:00.000Z",
      level: "info",
      scope: "test",
      message: "模型请求完成",
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("sk-secret-value");
    expect(serialized).not.toContain("Bearer token");
    expect(serialized).toContain("[redacted]");
  });

  it("rotates logs instead of growing without bound", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "desktop.log");
    writeFileSync(file, "x".repeat(400));
    const logger = new JsonLineLogger({ directory, maxBytes: 100, maxFiles: 2 });

    logger.info("next line");

    expect(readFileSync(file, "utf8")).toContain("next line");
    expect(readFileSync(`${file}.1`, "utf8")).toHaveLength(400);
  });

  it("redacts secrets embedded in captured control-plane log lines", () => {
    const directory = temporaryDirectory();
    const logger = new JsonLineLogger({ directory, scope: "control-plane" });
    logger.warn("upstream failed with Bearer abcdefghijklmnop and key sk-live-abcdefghijklmnopqrstuvwxyz");
    logger.info("plain message", { note: "token=plain-secret-value" });

    const serialized = readFileSync(path.join(directory, "desktop.log"), "utf8");
    expect(serialized).not.toContain("abcdefghijklmnop");
    expect(serialized).not.toContain("plain-secret-value");
    expect(serialized).toContain("plain message");
  });

  it("handles cyclic data without throwing", () => {
    const value: Record<string, unknown> = { name: "loop" };
    value.self = value;
    expect(() => redactSensitive(value)).not.toThrow();
    expect(redactText("worker is offline")).toBe("worker is offline");
  });
});
