import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "./testing/fixtures";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await ctx.close();
});

describe("database migrations", () => {
  it("creates the phase 1 tables", async () => {
    const rows = ctx.app.sqlite
      .prepare("select name from sqlite_master where type = 'table'")
      .all() as Array<{ name: string }>;
    const names = rows.map((row) => row.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "images",
        "vm_instances",
        "projects",
        "project_vm_bindings",
        "conversations",
        "workers",
        "tasks",
        "task_events",
        "task_dependencies",
        "task_artifacts",
        "project_activities",
        "outbox",
        "vm_leases",
        "processed_events",
        "idempotency_keys",
        "app_settings",
        "local_users",
        "storage_migrations",
      ]),
    );
  });

  it("is idempotent", async () => {
    const applied = await ctx.app.migrate();
    expect(applied).toEqual([]);
  });

  it("enables WAL and foreign keys", () => {
    const journalMode = ctx.app.sqlite.pragma("journal_mode", { simple: true });
    const foreignKeys = ctx.app.sqlite.pragma("foreign_keys", { simple: true });

    expect(String(journalMode).toLowerCase()).toBe("wal");
    expect(Number(foreignKeys)).toBe(1);
  });

  it("persists data across reopen", async () => {
    await ctx.app.close();
    const reopened = await import("./database").then(({ AppDatabase }) =>
      AppDatabase.open({ filename: `${ctx.dir}/test.sqlite` }),
    );

    const row = await reopened.db
      .selectFrom("projects")
      .select(["id"])
      .where("id", "=", ctx.projectId)
      .executeTakeFirst();

    expect(row?.id).toBe(ctx.projectId);
    // afterEach closes the reopened instance and removes the temporary directory.
    ctx.app = reopened;
  });
});
