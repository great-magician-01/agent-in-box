import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseService } from "../persistence/database.service";
import { createTestContext, type TestContext } from "../persistence/testing/fixtures";
import { InboxService, sanitizeFileName } from "./inbox.service";

let ctx: TestContext;
let directory: string;
let inbox: InboxService;

beforeEach(async () => {
  ctx = await createTestContext();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-in-box-inbox-"));
  const database = {
    layout: { inbox: directory },
  } as unknown as DatabaseService;
  inbox = new InboxService(ctx.app.db, database, { maxBytes: 32 });
});

afterEach(async () => {
  await ctx.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function upload(name: string, content: string, projectId: string | null = null) {
  return inbox.upload({
    fileName: name,
    contentType: "text/plain",
    projectId,
    stream: Readable.from([Buffer.from(content)]),
    declaredBytes: Buffer.byteLength(content),
  });
}

describe("InboxService", () => {
  it("stores checksummed files, lists by project and streams their content", async () => {
    const record = await upload("周报 2026.txt", "hello phase11", ctx.projectId);
    expect(record.originalName).toBe("周报 2026.txt");
    expect(record.sizeBytes).toBe(Buffer.byteLength("hello phase11"));
    expect(record.sha256).toHaveLength(64);
    expect(record.projectId).toBe(ctx.projectId);

    const list = await inbox.list({ projectId: ctx.projectId });
    expect(list).toHaveLength(1);
    expect(await inbox.list({ projectId: "other-project" })).toHaveLength(0);

    const { stream } = await inbox.stream(record.id);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString("utf8")).toBe("hello phase11");

    const removed = await inbox.remove(record.id);
    expect(removed.id).toBe(record.id);
    expect(await inbox.list()).toHaveLength(0);
    expect(fs.existsSync(path.join(directory, `${record.id}-周报 2026.txt`))).toBe(false);
  });

  it("rejects oversized uploads and unknown projects", async () => {
    await expect(upload("large.bin", "x".repeat(40))).rejects.toMatchObject({
      code: "validation_failed",
    });
    expect(await inbox.list()).toHaveLength(0);

    await expect(upload("note.txt", "ok", "missing-project")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("never allows traversal outside the inbox directory", async () => {
    const record = await upload("../../etc/passwd", "safe");
    expect(record.originalName).toBe("passwd");
    expect(fs.readdirSync(directory).every((name) => !name.includes(".."))).toBe(true);
  });
});

describe("sanitizeFileName", () => {
  it("removes path separators and control characters", () => {
    expect(sanitizeFileName("..\\..\\Windows\\system.ini")).toBe("system.ini");
    expect(sanitizeFileName("a\u0000b|c?.txt")).toBe("ab_c_.txt");
    expect(sanitizeFileName("%2e%2e%2fsecret.txt")).toBe("secret.txt");
    expect(sanitizeFileName("   ")).toBe("dropped-file");
  });
});
