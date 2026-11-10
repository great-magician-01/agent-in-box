import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema";

interface MigrationDefinition {
  up(db: Kysely<DatabaseSchema>): Promise<void>;
  down(db: Kysely<DatabaseSchema>): Promise<void>;
}

const migrations: Record<string, MigrationDefinition> = {
  "001_initial_schema": {
    async up(db: Kysely<DatabaseSchema>): Promise<void> {
      await db.schema
        .createTable("images")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("name", "text", (column) => column.notNull())
        .addColumn("os_family", "text", (column) => column.notNull())
        .addColumn("os_version", "text", (column) => column.notNull())
        .addColumn("architecture", "text", (column) => column.notNull())
        .addColumn("version", "text", (column) => column.notNull())
        .addColumn("status", "text", (column) => column.notNull())
        .addColumn("size_bytes", "integer", (column) => column.notNull())
        .addColumn("checksum", "text", (column) => column.notNull())
        .addColumn("local_path", "text")
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("verified_at", "text")
        .execute();

      await db.schema
        .createTable("vm_instances")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("name", "text", (column) => column.notNull())
        .addColumn("image_id", "text", (column) => column.notNull())
        .addColumn("os_family", "text", (column) => column.notNull())
        .addColumn("cpu_count", "integer", (column) => column.notNull())
        .addColumn("memory_bytes", "integer", (column) => column.notNull())
        .addColumn("disk_bytes", "integer", (column) => column.notNull())
        .addColumn("storage_root", "text", (column) => column.notNull())
        .addColumn("power_state", "text", (column) => column.notNull())
        .addColumn("guest_health", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("last_started_at", "text")
        .addForeignKeyConstraint(
          "vm_instances_image_fk",
          ["image_id"],
          "images",
          ["id"],
          (constraint) => constraint.onDelete("restrict"),
        )
        .execute();

      await db.schema
        .createTable("projects")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("name", "text", (column) => column.notNull())
        .addColumn("description", "text", (column) => column.notNull())
        .addColumn("default_vm_binding_id", "text")
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("archived_at", "text")
        .execute();

      await db.schema
        .createTable("project_vm_bindings")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("project_id", "text", (column) => column.notNull())
        .addColumn("vm_id", "text", (column) => column.notNull())
        .addColumn("guest_workspace_path", "text", (column) => column.notNull())
        .addColumn("is_primary", "integer", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addForeignKeyConstraint(
          "project_vm_bindings_project_fk",
          ["project_id"],
          "projects",
          ["id"],
          (constraint) => constraint.onDelete("cascade"),
        )
        .addForeignKeyConstraint(
          "project_vm_bindings_vm_fk",
          ["vm_id"],
          "vm_instances",
          ["id"],
          (constraint) => constraint.onDelete("restrict"),
        )
        .execute();

      await db.schema
        .createIndex("project_vm_bindings_unique_idx")
        .on("project_vm_bindings")
        .columns(["project_id", "vm_id"])
        .unique()
        .execute();

      await db.schema
        .createTable("conversations")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("kind", "text", (column) => column.notNull())
        .addColumn("project_id", "text")
        .addColumn("title", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("last_message_at", "text", (column) => column.notNull())
        .addForeignKeyConstraint(
          "conversations_project_fk",
          ["project_id"],
          "projects",
          ["id"],
          (constraint) => constraint.onDelete("cascade"),
        )
        .execute();

      await db.schema
        .createTable("workers")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("project_id", "text", (column) => column.notNull())
        .addColumn("vm_id", "text", (column) => column.notNull())
        .addColumn("conversation_id", "text", (column) => column.notNull())
        .addColumn("engine_type", "text", (column) => column.notNull())
        .addColumn("engine_version", "text", (column) => column.notNull())
        .addColumn("status", "text", (column) => column.notNull())
        .addColumn("current_task_id", "text")
        .addColumn("capability_set", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("last_active_at", "text", (column) => column.notNull())
        .addColumn("archived_at", "text")
        .addForeignKeyConstraint(
          "workers_project_fk",
          ["project_id"],
          "projects",
          ["id"],
          (constraint) => constraint.onDelete("restrict"),
        )
        .addForeignKeyConstraint("workers_vm_fk", ["vm_id"], "vm_instances", ["id"], (constraint) =>
          constraint.onDelete("restrict"),
        )
        .addForeignKeyConstraint(
          "workers_conversation_fk",
          ["conversation_id"],
          "conversations",
          ["id"],
          (constraint) => constraint.onDelete("restrict"),
        )
        .execute();

      await db.schema
        .createTable("tasks")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("project_id", "text", (column) => column.notNull())
        .addColumn("vm_id", "text", (column) => column.notNull())
        .addColumn("origin_conversation_id", "text", (column) => column.notNull())
        .addColumn("assigned_worker_id", "text")
        .addColumn("parent_task_id", "text")
        .addColumn("objective", "text", (column) => column.notNull())
        .addColumn("status", "text", (column) => column.notNull())
        .addColumn("priority", "integer", (column) => column.notNull())
        .addColumn("latest_summary", "text")
        .addColumn("error_code", "text")
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("started_at", "text")
        .addColumn("completed_at", "text")
        .addForeignKeyConstraint(
          "tasks_project_fk",
          ["project_id"],
          "projects",
          ["id"],
          (constraint) => constraint.onDelete("restrict"),
        )
        .addForeignKeyConstraint("tasks_vm_fk", ["vm_id"], "vm_instances", ["id"], (constraint) =>
          constraint.onDelete("restrict"),
        )
        .addForeignKeyConstraint(
          "tasks_conversation_fk",
          ["origin_conversation_id"],
          "conversations",
          ["id"],
          (constraint) => constraint.onDelete("restrict"),
        )
        .addForeignKeyConstraint(
          "tasks_worker_fk",
          ["assigned_worker_id"],
          "workers",
          ["id"],
          (constraint) => constraint.onDelete("set null"),
        )
        .addForeignKeyConstraint(
          "tasks_parent_fk",
          ["parent_task_id"],
          "tasks",
          ["id"],
          (constraint) => constraint.onDelete("set null"),
        )
        .execute();

      await db.schema
        .createIndex("tasks_vm_status_idx")
        .on("tasks")
        .columns(["vm_id", "status"])
        .execute();
      await db.schema
        .createIndex("tasks_project_status_idx")
        .on("tasks")
        .columns(["project_id", "status"])
        .execute();
      await db.schema
        .createIndex("tasks_created_idx")
        .on("tasks")
        .columns(["created_at", "id"])
        .execute();

      await db.schema
        .createTable("task_events")
        .addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
        .addColumn("task_id", "text", (column) => column.notNull())
        .addColumn("type", "text", (column) => column.notNull())
        .addColumn("payload_json", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addForeignKeyConstraint(
          "task_events_task_fk",
          ["task_id"],
          "tasks",
          ["id"],
          (constraint) => constraint.onDelete("cascade"),
        )
        .execute();

      await db.schema
        .createIndex("task_events_task_idx")
        .on("task_events")
        .column("task_id")
        .execute();

      await db.schema
        .createTable("outbox")
        .addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
        .addColumn("topic", "text", (column) => column.notNull())
        .addColumn("payload_json", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("published_at", "text")
        .addColumn("attempts", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("last_error", "text")
        .execute();

      await db.schema
        .createIndex("outbox_pending_idx")
        .on("outbox")
        .column("published_at")
        .execute();

      await db.schema
        .createTable("vm_leases")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("vm_id", "text", (column) => column.notNull())
        .addColumn("owner", "text", (column) => column.notNull())
        .addColumn("task_id", "text")
        .addColumn("acquired_at", "text", (column) => column.notNull())
        .addColumn("expires_at", "text", (column) => column.notNull())
        .addForeignKeyConstraint(
          "vm_leases_vm_fk",
          ["vm_id"],
          "vm_instances",
          ["id"],
          (constraint) => constraint.onDelete("cascade"),
        )
        .execute();

      await db.schema
        .createIndex("vm_leases_unique_idx")
        .on("vm_leases")
        .column("vm_id")
        .unique()
        .execute();

      await db.schema
        .createTable("processed_events")
        .addColumn("dedup_key", "text", (column) => column.primaryKey())
        .addColumn("processed_at", "text", (column) => column.notNull())
        .execute();

      await db.schema
        .createTable("idempotency_keys")
        .addColumn("key", "text", (column) => column.primaryKey())
        .addColumn("task_id", "text", (column) => column.notNull())
        .addColumn("request_hash", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addForeignKeyConstraint(
          "idempotency_keys_task_fk",
          ["task_id"],
          "tasks",
          ["id"],
          (constraint) => constraint.onDelete("cascade"),
        )
        .execute();
    },

    async down(db: Kysely<DatabaseSchema>): Promise<void> {
      for (const table of [
        "idempotency_keys",
        "processed_events",
        "vm_leases",
        "outbox",
        "task_events",
        "tasks",
        "workers",
        "conversations",
        "project_vm_bindings",
        "projects",
        "vm_instances",
        "images",
      ]) {
        await db.schema.dropTable(table).ifExists().execute();
      }
    },
  },

  "002_phase2_settings": {
    async up(db: Kysely<DatabaseSchema>): Promise<void> {
      await db.schema
        .createTable("app_settings")
        .addColumn("key", "text", (column) => column.primaryKey())
        .addColumn("value_json", "text", (column) => column.notNull())
        .addColumn("updated_at", "text", (column) => column.notNull())
        .execute();

      await db.schema
        .createTable("local_users")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("display_name", "text", (column) => column.notNull())
        .addColumn("role", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("last_active_at", "text", (column) => column.notNull())
        .execute();

      await db.schema
        .createTable("storage_migrations")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("from_root", "text", (column) => column.notNull())
        .addColumn("to_root", "text", (column) => column.notNull())
        .addColumn("status", "text", (column) => column.notNull())
        .addColumn("started_at", "text", (column) => column.notNull())
        .addColumn("completed_at", "text")
        .addColumn("error", "text")
        .addColumn("files_copied", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("bytes_copied", "integer", (column) => column.notNull().defaultTo(0))
        .execute();

      await db.schema
        .createIndex("storage_migrations_started_idx")
        .on("storage_migrations")
        .column("started_at")
        .execute();
    },

    async down(db: Kysely<DatabaseSchema>): Promise<void> {
      for (const table of ["storage_migrations", "local_users", "app_settings"]) {
        await db.schema.dropTable(table).ifExists().execute();
      }
    },
  },
  "003_phase3_images": {
    async up(db: Kysely<DatabaseSchema>): Promise<void> {
      await db.schema
        .alterTable("images")
        .addColumn("source_url", "text", (column) => column.notNull().defaultTo(""))
        .execute();
      await db.schema
        .alterTable("images")
        .addColumn("file_name", "text", (column) => column.notNull().defaultTo(""))
        .execute();
      await db.schema
        .alterTable("images")
        .addColumn("downloaded_bytes", "integer", (column) => column.notNull().defaultTo(0))
        .execute();
      await db.schema.alterTable("images").addColumn("error_code", "text").execute();
      await db.schema.alterTable("images").addColumn("error_message", "text").execute();
      await db.schema
        .alterTable("images")
        .addColumn("updated_at", "text", (column) => column.notNull().defaultTo(""))
        .execute();
      await db.schema.alterTable("images").addColumn("seed_local_path", "text").execute();
      await db.schema
        .alterTable("images")
        .addColumn("manifest_json", "text", (column) => column.notNull().defaultTo(""))
        .execute();
      await db.schema.createIndex("images_status_idx").on("images").column("status").execute();
    },

    async down(db: Kysely<DatabaseSchema>): Promise<void> {
      await db.schema.dropIndex("images_status_idx").ifExists().execute();
      for (const column of [
        "manifest_json",
        "seed_local_path",
        "updated_at",
        "error_message",
        "error_code",
        "downloaded_bytes",
        "file_name",
        "source_url",
      ]) {
        await db.schema.alterTable("images").dropColumn(column).execute();
      }
    },
  },
};

export async function migrateToLatest(db: Kysely<DatabaseSchema>): Promise<string[]> {
  await sql`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at text not null
    )
  `.execute(db);

  const appliedRows = await db.selectFrom("schema_migrations").select("id").execute();
  const applied = new Set(appliedRows.map((row) => row.id));
  const newlyApplied: string[] = [];

  for (const [id, migration] of Object.entries(migrations)) {
    if (applied.has(id)) {
      continue;
    }

    await db.transaction().execute(async (trx) => {
      await migration.up(trx);
      await trx
        .insertInto("schema_migrations")
        .values({ id, applied_at: new Date().toISOString() })
        .execute();
    });

    newlyApplied.push(id);
  }

  return newlyApplied;
}
