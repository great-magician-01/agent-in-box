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
  "004_phase5_projects_tasks": {
    async up(db: Kysely<DatabaseSchema>): Promise<void> {
      await db.schema
        .alterTable("projects")
        .addColumn("workspace_config_json", "text", (column) =>
          column.notNull().defaultTo('{"defaultGuestWorkspacePath":"/home/worker/workspace"}'),
        )
        .execute();
      await db.schema
        .alterTable("projects")
        .addColumn("updated_at", "text", (column) => column.notNull().defaultTo(""))
        .execute();

      await db.schema
        .alterTable("tasks")
        .addColumn("attempt_count", "integer", (column) => column.notNull().defaultTo(0))
        .execute();
      await db.schema.alterTable("tasks").addColumn("result_json", "text").execute();
      await db.schema.alterTable("tasks").addColumn("error_message", "text").execute();
      await db.schema
        .alterTable("tasks")
        .addColumn("updated_at", "text", (column) => column.notNull().defaultTo(""))
        .execute();

      await db.schema
        .createTable("task_dependencies")
        .addColumn("task_id", "text", (column) => column.notNull())
        .addColumn("dependency_task_id", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addPrimaryKeyConstraint("task_dependencies_pk", ["task_id", "dependency_task_id"])
        .addForeignKeyConstraint(
          "task_dependencies_task_fk",
          ["task_id"],
          "tasks",
          ["id"],
          (constraint) => constraint.onDelete("cascade"),
        )
        .addForeignKeyConstraint(
          "task_dependencies_dependency_fk",
          ["dependency_task_id"],
          "tasks",
          ["id"],
          (constraint) => constraint.onDelete("cascade"),
        )
        .execute();
      await db.schema
        .createIndex("task_dependencies_dependency_idx")
        .on("task_dependencies")
        .column("dependency_task_id")
        .execute();

      await db.schema
        .createTable("task_artifacts")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("project_id", "text", (column) => column.notNull())
        .addColumn("task_id", "text", (column) => column.notNull())
        .addColumn("name", "text", (column) => column.notNull())
        .addColumn("relative_path", "text", (column) => column.notNull())
        .addColumn("media_type", "text", (column) => column.notNull())
        .addColumn("size_bytes", "integer", (column) => column.notNull())
        .addColumn("sha256", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("verified_at", "text")
        .addForeignKeyConstraint(
          "task_artifacts_project_fk",
          ["project_id"],
          "projects",
          ["id"],
          (constraint) => constraint.onDelete("restrict"),
        )
        .addForeignKeyConstraint("task_artifacts_task_fk", ["task_id"], "tasks", ["id"], (c) =>
          c.onDelete("cascade"),
        )
        .execute();
      await db.schema
        .createIndex("task_artifacts_project_idx")
        .on("task_artifacts")
        .columns(["project_id", "created_at"])
        .execute();
      await db.schema
        .createIndex("task_artifacts_task_idx")
        .on("task_artifacts")
        .column("task_id")
        .execute();

      await db.schema
        .createTable("project_activities")
        .addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
        .addColumn("project_id", "text", (column) => column.notNull())
        .addColumn("type", "text", (column) => column.notNull())
        .addColumn("payload_json", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addForeignKeyConstraint(
          "project_activities_project_fk",
          ["project_id"],
          "projects",
          ["id"],
          (constraint) => constraint.onDelete("cascade"),
        )
        .execute();
      await db.schema
        .createIndex("project_activities_project_idx")
        .on("project_activities")
        .columns(["project_id", "id"])
        .execute();

      // A waiting approval still owns the active execution. Other queued tasks,
      // including tasks from another project, cannot claim the same VM.
      await sql`
        create unique index tasks_single_execution_idx on tasks(vm_id)
        where status in ('running', 'waiting_approval')
      `.execute(db);
    },

    async down(db: Kysely<DatabaseSchema>): Promise<void> {
      await db.schema.dropIndex("tasks_single_execution_idx").ifExists().execute();
      for (const table of ["project_activities", "task_artifacts", "task_dependencies"]) {
        await db.schema.dropTable(table).ifExists().execute();
      }
      for (const column of ["updated_at", "error_message", "result_json", "attempt_count"]) {
        await db.schema.alterTable("tasks").dropColumn(column).execute();
      }
      for (const column of ["updated_at", "workspace_config_json"]) {
        await db.schema.alterTable("projects").dropColumn(column).execute();
      }
    },
  },

  "005_phase6_workers_models": {
    async up(db: Kysely<DatabaseSchema>): Promise<void> {
      for (const column of [
        "agent_session_ref",
        "session_version",
        "last_heartbeat_at",
        "archive_summary",
        "last_error_code",
        "last_error_message",
        "broker_token_id",
        "provider_id",
        "model_id",
      ]) {
        await db.schema.alterTable("workers").addColumn(column, "text").execute();
      }

      await db.schema
        .createTable("model_providers")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("base_url", "text", (column) => column.notNull())
        .addColumn("api", "text", (column) => column.notNull())
        .addColumn("credential_provider_id", "text", (column) => column.notNull())
        .addColumn("models_json", "text", (column) => column.notNull())
        .addColumn("enabled", "integer", (column) => column.notNull().defaultTo(1))
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("updated_at", "text", (column) => column.notNull())
        .execute();

      await db.schema
        .createTable("model_tokens")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("token_hash", "text", (column) => column.notNull().unique())
        .addColumn("worker_id", "text", (column) => column.notNull())
        .addColumn("task_id", "text")
        .addColumn("vm_id", "text", (column) => column.notNull())
        .addColumn("provider_id", "text", (column) => column.notNull())
        .addColumn("model", "text", (column) => column.notNull())
        .addColumn("session_id", "text", (column) => column.notNull())
        .addColumn("expires_at", "text", (column) => column.notNull())
        .addColumn("revoked_at", "text")
        .addColumn("revoke_reason", "text")
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("last_used_at", "text")
        .addForeignKeyConstraint("model_tokens_worker_fk", ["worker_id"], "workers", ["id"], (c) =>
          c.onDelete("cascade"),
        )
        .addForeignKeyConstraint("model_tokens_task_fk", ["task_id"], "tasks", ["id"], (c) =>
          c.onDelete("set null"),
        )
        .addForeignKeyConstraint("model_tokens_vm_fk", ["vm_id"], "vm_instances", ["id"], (c) =>
          c.onDelete("cascade"),
        )
        .execute();
      await db.schema
        .createIndex("model_tokens_worker_idx")
        .on("model_tokens")
        .columns(["worker_id", "created_at"])
        .execute();

      await db.schema
        .createTable("model_requests")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("token_id", "text")
        .addColumn("provider_id", "text", (column) => column.notNull())
        .addColumn("model", "text", (column) => column.notNull())
        .addColumn("worker_id", "text", (column) => column.notNull())
        .addColumn("task_id", "text")
        .addColumn("vm_id", "text", (column) => column.notNull())
        .addColumn("status", "text", (column) => column.notNull())
        .addColumn("upstream_status", "integer")
        .addColumn("attempts", "integer", (column) => column.notNull().defaultTo(1))
        .addColumn("duration_ms", "integer")
        .addColumn("usage_json", "text")
        .addColumn("error_code", "text")
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("completed_at", "text")
        .addForeignKeyConstraint(
          "model_requests_token_fk",
          ["token_id"],
          "model_tokens",
          ["id"],
          (c) => c.onDelete("set null"),
        )
        .execute();
      await db.schema
        .createIndex("model_requests_created_idx")
        .on("model_requests")
        .columns(["created_at", "id"])
        .execute();

      await db.schema
        .createTable("conversation_messages")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("conversation_id", "text", (column) => column.notNull())
        .addColumn("worker_id", "text", (column) => column.notNull())
        .addColumn("task_id", "text")
        .addColumn("role", "text", (column) => column.notNull())
        .addColumn("mode", "text", (column) => column.notNull())
        .addColumn("content", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addForeignKeyConstraint(
          "conversation_messages_conversation_fk",
          ["conversation_id"],
          "conversations",
          ["id"],
          (c) => c.onDelete("cascade"),
        )
        .addForeignKeyConstraint(
          "conversation_messages_worker_fk",
          ["worker_id"],
          "workers",
          ["id"],
          (c) => c.onDelete("cascade"),
        )
        .addForeignKeyConstraint(
          "conversation_messages_task_fk",
          ["task_id"],
          "tasks",
          ["id"],
          (c) => c.onDelete("set null"),
        )
        .execute();
      await db.schema
        .createIndex("conversation_messages_conversation_idx")
        .on("conversation_messages")
        .columns(["conversation_id", "created_at", "id"])
        .execute();
    },

    async down(db: Kysely<DatabaseSchema>): Promise<void> {
      for (const table of [
        "conversation_messages",
        "model_requests",
        "model_tokens",
        "model_providers",
      ]) {
        await db.schema.dropTable(table).ifExists().execute();
      }
      for (const column of [
        "model_id",
        "provider_id",
        "broker_token_id",
        "last_error_message",
        "last_error_code",
        "archive_summary",
        "last_heartbeat_at",
        "session_version",
        "agent_session_ref",
      ]) {
        await db.schema.alterTable("workers").dropColumn(column).execute();
      }
    },
  },

  "006_phase7_computer_use": {
    async up(db: Kysely<DatabaseSchema>): Promise<void> {
      await db.schema
        .createTable("project_policies")
        .addColumn("project_id", "text", (column) => column.primaryKey())
        .addColumn("policy_json", "text", (column) => column.notNull())
        .addColumn("updated_at", "text", (column) => column.notNull())
        .addForeignKeyConstraint(
          "project_policies_project_fk",
          ["project_id"],
          "projects",
          ["id"],
          (c) => c.onDelete("cascade"),
        )
        .execute();

      await db.schema
        .createTable("task_execution_state")
        .addColumn("task_id", "text", (column) => column.primaryKey())
        .addColumn("worker_id", "text", (column) => column.notNull())
        .addColumn("vm_id", "text", (column) => column.notNull())
        .addColumn("started_at", "text", (column) => column.notNull())
        .addColumn("deadline_at", "text", (column) => column.notNull())
        .addColumn("step_count", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("action_count", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("no_progress_streak", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("duplicate_streak", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("completion_attempts", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("requires_observation", "integer", (column) => column.notNull().defaultTo(1))
        .addColumn("last_action_signature", "text")
        .addColumn("last_action_at", "text")
        .addColumn("ended_at", "text")
        .addColumn("outcome", "text")
        .addForeignKeyConstraint(
          "task_execution_state_task_fk",
          ["task_id"],
          "tasks",
          ["id"],
          (c) => c.onDelete("cascade"),
        )
        .addForeignKeyConstraint(
          "task_execution_state_worker_fk",
          ["worker_id"],
          "workers",
          ["id"],
          (c) => c.onDelete("cascade"),
        )
        .addForeignKeyConstraint(
          "task_execution_state_vm_fk",
          ["vm_id"],
          "vm_instances",
          ["id"],
          (c) => c.onDelete("cascade"),
        )
        .execute();

      await db.schema
        .createTable("cua_screenshots")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("task_id", "text", (column) => column.notNull())
        .addColumn("worker_id", "text", (column) => column.notNull())
        .addColumn("vm_id", "text", (column) => column.notNull())
        .addColumn("kind", "text", (column) => column.notNull())
        .addColumn("width", "integer", (column) => column.notNull())
        .addColumn("height", "integer", (column) => column.notNull())
        .addColumn("dpi", "real")
        .addColumn("scale_factor", "real")
        .addColumn("sha256", "text", (column) => column.notNull())
        .addColumn("file_path", "text", (column) => column.notNull())
        .addColumn("size_bytes", "integer", (column) => column.notNull())
        .addColumn("captured_at", "text", (column) => column.notNull())
        .addForeignKeyConstraint("cua_screenshots_task_fk", ["task_id"], "tasks", ["id"], (c) =>
          c.onDelete("cascade"),
        )
        .addForeignKeyConstraint(
          "cua_screenshots_worker_fk",
          ["worker_id"],
          "workers",
          ["id"],
          (c) => c.onDelete("cascade"),
        )
        .addForeignKeyConstraint("cua_screenshots_vm_fk", ["vm_id"], "vm_instances", ["id"], (c) =>
          c.onDelete("cascade"),
        )
        .execute();
      await db.schema
        .createIndex("cua_screenshots_task_idx")
        .on("cua_screenshots")
        .columns(["task_id", "captured_at"])
        .execute();

      await db.schema
        .createTable("cua_actions")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("task_id", "text", (column) => column.notNull())
        .addColumn("worker_id", "text", (column) => column.notNull())
        .addColumn("vm_id", "text", (column) => column.notNull())
        .addColumn("lease_id", "text", (column) => column.notNull())
        .addColumn("action_type", "text", (column) => column.notNull())
        .addColumn("action_json", "text", (column) => column.notNull())
        .addColumn("source_screenshot_id", "text")
        .addColumn("before_screenshot_id", "text")
        .addColumn("after_screenshot_id", "text")
        .addColumn("display_json", "text", (column) => column.notNull())
        .addColumn("status", "text", (column) => column.notNull())
        .addColumn("result_json", "text")
        .addColumn("error_code", "text")
        .addColumn("error_message", "text")
        .addColumn("approval_id", "text")
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("executed_at", "text")
        .addColumn("duration_ms", "integer")
        .addForeignKeyConstraint("cua_actions_task_fk", ["task_id"], "tasks", ["id"], (c) =>
          c.onDelete("cascade"),
        )
        .addForeignKeyConstraint("cua_actions_worker_fk", ["worker_id"], "workers", ["id"], (c) =>
          c.onDelete("cascade"),
        )
        .addForeignKeyConstraint("cua_actions_vm_fk", ["vm_id"], "vm_instances", ["id"], (c) =>
          c.onDelete("cascade"),
        )
        .execute();
      await db.schema
        .createIndex("cua_actions_task_idx")
        .on("cua_actions")
        .columns(["task_id", "created_at", "id"])
        .execute();

      await db.schema
        .createTable("cua_approvals")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("task_id", "text", (column) => column.notNull())
        .addColumn("worker_id", "text", (column) => column.notNull())
        .addColumn("action_id", "text", (column) => column.notNull())
        .addColumn("action_type", "text", (column) => column.notNull())
        .addColumn("action_json", "text", (column) => column.notNull())
        .addColumn("context_summary", "text", (column) => column.notNull())
        .addColumn("status", "text", (column) => column.notNull())
        .addColumn("requested_at", "text", (column) => column.notNull())
        .addColumn("expires_at", "text", (column) => column.notNull())
        .addColumn("resolved_at", "text")
        .addColumn("resolved_by", "text")
        .addColumn("resolution_note", "text")
        .addForeignKeyConstraint("cua_approvals_task_fk", ["task_id"], "tasks", ["id"], (c) =>
          c.onDelete("cascade"),
        )
        .addForeignKeyConstraint(
          "cua_approvals_action_fk",
          ["action_id"],
          "cua_actions",
          ["id"],
          (c) => c.onDelete("cascade"),
        )
        .execute();
      await db.schema
        .createIndex("cua_approvals_status_idx")
        .on("cua_approvals")
        .columns(["status", "requested_at"])
        .execute();

      await db.schema
        .createTable("cua_tokens")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("token_hash", "text", (column) => column.notNull().unique())
        .addColumn("worker_id", "text", (column) => column.notNull())
        .addColumn("vm_id", "text", (column) => column.notNull())
        .addColumn("session_id", "text", (column) => column.notNull())
        .addColumn("task_id", "text")
        .addColumn("expires_at", "text", (column) => column.notNull())
        .addColumn("revoked_at", "text")
        .addColumn("revoke_reason", "text")
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("last_used_at", "text")
        .addForeignKeyConstraint("cua_tokens_worker_fk", ["worker_id"], "workers", ["id"], (c) =>
          c.onDelete("cascade"),
        )
        .addForeignKeyConstraint("cua_tokens_vm_fk", ["vm_id"], "vm_instances", ["id"], (c) =>
          c.onDelete("cascade"),
        )
        .addForeignKeyConstraint("cua_tokens_task_fk", ["task_id"], "tasks", ["id"], (c) =>
          c.onDelete("set null"),
        )
        .execute();
      await db.schema
        .createIndex("cua_tokens_worker_idx")
        .on("cua_tokens")
        .columns(["worker_id", "created_at"])
        .execute();
    },

    async down(db: Kysely<DatabaseSchema>): Promise<void> {
      for (const table of [
        "cua_tokens",
        "cua_approvals",
        "cua_actions",
        "cua_screenshots",
        "task_execution_state",
        "project_policies",
      ]) {
        await db.schema.dropTable(table).ifExists().execute();
      }
    },
  },

  "007_phase8_router_archive": {
    async up(db: Kysely<DatabaseSchema>): Promise<void> {
      await db.schema
        .createTable("worker_archives")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("worker_id", "text", (column) => column.notNull())
        .addColumn("project_id", "text", (column) => column.notNull())
        .addColumn("vm_id", "text", (column) => column.notNull())
        .addColumn("conversation_id", "text", (column) => column.notNull())
        .addColumn("archive_ref", "text", (column) => column.notNull())
        .addColumn("engine_type", "text", (column) => column.notNull())
        .addColumn("engine_version", "text", (column) => column.notNull())
        .addColumn("session_version", "text", (column) => column.notNull())
        .addColumn("summary", "text", (column) => column.notNull())
        .addColumn("restore_point_json", "text")
        .addColumn("artifacts_json", "text", (column) => column.notNull().defaultTo("[]"))
        .addColumn("source", "text", (column) => column.notNull())
        .addColumn("status", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("restored_at", "text")
        .addForeignKeyConstraint(
          "worker_archives_worker_fk",
          ["worker_id"],
          "workers",
          ["id"],
          (c) => c.onDelete("cascade"),
        )
        .addForeignKeyConstraint(
          "worker_archives_project_fk",
          ["project_id"],
          "projects",
          ["id"],
          (c) => c.onDelete("restrict"),
        )
        .addForeignKeyConstraint("worker_archives_vm_fk", ["vm_id"], "vm_instances", ["id"], (c) =>
          c.onDelete("restrict"),
        )
        .addForeignKeyConstraint(
          "worker_archives_conversation_fk",
          ["conversation_id"],
          "conversations",
          ["id"],
          (c) => c.onDelete("cascade"),
        )
        .execute();
      await db.schema
        .createIndex("worker_archives_worker_idx")
        .on("worker_archives")
        .columns(["worker_id", "created_at"])
        .execute();
      await db.schema
        .createIndex("worker_archives_project_idx")
        .on("worker_archives")
        .columns(["project_id", "created_at"])
        .execute();
      await db.schema
        .createIndex("worker_archives_status_idx")
        .on("worker_archives")
        .columns(["status", "created_at"])
        .execute();

      await db.schema
        .createTable("worker_resume_contexts")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("worker_id", "text", (column) => column.notNull())
        .addColumn("archive_id", "text")
        .addColumn("restore_mode", "text", (column) => column.notNull())
        .addColumn("screenshot_path", "text")
        .addColumn("screenshot_sha256", "text")
        .addColumn("screenshot_width", "integer")
        .addColumn("screenshot_height", "integer")
        .addColumn("environment_json", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addForeignKeyConstraint(
          "worker_resume_contexts_worker_fk",
          ["worker_id"],
          "workers",
          ["id"],
          (c) => c.onDelete("cascade"),
        )
        .addForeignKeyConstraint(
          "worker_resume_contexts_archive_fk",
          ["archive_id"],
          "worker_archives",
          ["id"],
          (c) => c.onDelete("set null"),
        )
        .execute();
      await db.schema
        .createIndex("worker_resume_contexts_worker_idx")
        .on("worker_resume_contexts")
        .columns(["worker_id", "created_at"])
        .execute();

      await db.schema
        .createTable("worker_inputs")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("worker_id", "text", (column) => column.notNull())
        .addColumn("kind", "text", (column) => column.notNull())
        .addColumn("content", "text", (column) => column.notNull())
        .addColumn("status", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("delivered_at", "text")
        .addForeignKeyConstraint("worker_inputs_worker_fk", ["worker_id"], "workers", ["id"], (c) =>
          c.onDelete("cascade"),
        )
        .execute();
      await db.schema
        .createIndex("worker_inputs_worker_idx")
        .on("worker_inputs")
        .columns(["worker_id", "status", "created_at"])
        .execute();

      await db.schema
        .createTable("router_sessions")
        .addColumn("conversation_id", "text", (column) => column.primaryKey())
        .addColumn("status", "text", (column) => column.notNull())
        .addColumn("session_ref", "text")
        .addColumn("engine_type", "text", (column) => column.notNull())
        .addColumn("engine_version", "text", (column) => column.notNull())
        .addColumn("session_version", "text", (column) => column.notNull())
        .addColumn("provider_id", "text")
        .addColumn("model_id", "text")
        .addColumn("tool_token_hash", "text")
        .addColumn("tool_token_expires_at", "text")
        .addColumn("last_active_at", "text", (column) => column.notNull())
        .addColumn("last_error", "text")
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("updated_at", "text", (column) => column.notNull())
        .addForeignKeyConstraint(
          "router_sessions_conversation_fk",
          ["conversation_id"],
          "conversations",
          ["id"],
          (c) => c.onDelete("cascade"),
        )
        .execute();
      await db.schema
        .createIndex("router_sessions_status_idx")
        .on("router_sessions")
        .columns(["status", "last_active_at"])
        .execute();

      await db.schema
        .createTable("router_messages")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("conversation_id", "text", (column) => column.notNull())
        .addColumn("role", "text", (column) => column.notNull())
        .addColumn("content", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addForeignKeyConstraint(
          "router_messages_conversation_fk",
          ["conversation_id"],
          "conversations",
          ["id"],
          (c) => c.onDelete("cascade"),
        )
        .execute();
      await db.schema
        .createIndex("router_messages_conversation_idx")
        .on("router_messages")
        .columns(["conversation_id", "created_at", "id"])
        .execute();

      await db.schema
        .createTable("router_tool_calls")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("conversation_id", "text", (column) => column.notNull())
        .addColumn("tool_name", "text", (column) => column.notNull())
        .addColumn("args_json", "text", (column) => column.notNull())
        .addColumn("result_json", "text")
        .addColumn("status", "text", (column) => column.notNull())
        .addColumn("error_code", "text")
        .addColumn("error_message", "text")
        .addColumn("duration_ms", "integer", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addForeignKeyConstraint(
          "router_tool_calls_conversation_fk",
          ["conversation_id"],
          "conversations",
          ["id"],
          (c) => c.onDelete("cascade"),
        )
        .execute();
      await db.schema
        .createIndex("router_tool_calls_conversation_idx")
        .on("router_tool_calls")
        .columns(["conversation_id", "created_at", "id"])
        .execute();

      await db.schema
        .createTable("router_model_tokens")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("token_hash", "text", (column) => column.notNull().unique())
        .addColumn("conversation_id", "text", (column) => column.notNull())
        .addColumn("provider_id", "text", (column) => column.notNull())
        .addColumn("model", "text", (column) => column.notNull())
        .addColumn("expires_at", "text", (column) => column.notNull())
        .addColumn("revoked_at", "text")
        .addColumn("revoke_reason", "text")
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("last_used_at", "text")
        .addForeignKeyConstraint(
          "router_model_tokens_conversation_fk",
          ["conversation_id"],
          "conversations",
          ["id"],
          (c) => c.onDelete("cascade"),
        )
        .execute();
      await db.schema
        .createIndex("router_model_tokens_conversation_idx")
        .on("router_model_tokens")
        .columns(["conversation_id", "created_at"])
        .execute();
    },

    async down(db: Kysely<DatabaseSchema>): Promise<void> {
      for (const table of [
        "router_model_tokens",
        "router_tool_calls",
        "router_messages",
        "router_sessions",
        "worker_inputs",
        "worker_resume_contexts",
        "worker_archives",
      ]) {
        await db.schema.dropTable(table).ifExists().execute();
      }
    },
  },

  "008_phase9_resources_sharing": {
    async up(db: Kysely<DatabaseSchema>): Promise<void> {
      await db.schema
        .createTable("vm_snapshots")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("vm_id", "text", (column) => column.notNull())
        .addColumn("tag", "text", (column) => column.notNull())
        .addColumn("label", "text", (column) => column.notNull())
        .addColumn("status", "text", (column) => column.notNull())
        .addColumn("affected_projects_json", "text", (column) => column.notNull().defaultTo("[]"))
        .addColumn("size_bytes", "integer")
        .addColumn("error_message", "text")
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("updated_at", "text", (column) => column.notNull())
        .addColumn("restored_at", "text")
        .addForeignKeyConstraint("vm_snapshots_vm_fk", ["vm_id"], "vm_instances", ["id"], (c) =>
          c.onDelete("cascade"),
        )
        .execute();
      await db.schema
        .createIndex("vm_snapshots_vm_idx")
        .on("vm_snapshots")
        .columns(["vm_id", "created_at"])
        .execute();
      await db.schema
        .createIndex("vm_snapshots_tag_idx")
        .on("vm_snapshots")
        .columns(["vm_id", "tag"])
        .unique()
        .execute();

      await db.schema
        .createTable("project_backups")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("project_id", "text", (column) => column.notNull())
        .addColumn("label", "text", (column) => column.notNull())
        .addColumn("status", "text", (column) => column.notNull())
        .addColumn("artifact_snapshot_json", "text", (column) => column.notNull().defaultTo("[]"))
        .addColumn("error_message", "text")
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("completed_at", "text")
        .addColumn("restored_at", "text")
        .addForeignKeyConstraint(
          "project_backups_project_fk",
          ["project_id"],
          "projects",
          ["id"],
          (c) => c.onDelete("cascade"),
        )
        .execute();
      await db.schema
        .createIndex("project_backups_project_idx")
        .on("project_backups")
        .columns(["project_id", "created_at"])
        .execute();

      await db.schema
        .createTable("project_backup_bindings")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("backup_id", "text", (column) => column.notNull())
        .addColumn("binding_id", "text", (column) => column.notNull())
        .addColumn("vm_id", "text", (column) => column.notNull())
        .addColumn("vm_name", "text", (column) => column.notNull())
        .addColumn("guest_workspace_path", "text", (column) => column.notNull())
        .addColumn("file_path", "text")
        .addColumn("sha256", "text")
        .addColumn("size_bytes", "integer")
        .addColumn("file_count", "integer")
        .addColumn("status", "text", (column) => column.notNull())
        .addColumn("error_message", "text")
        .addForeignKeyConstraint(
          "project_backup_bindings_backup_fk",
          ["backup_id"],
          "project_backups",
          ["id"],
          (c) => c.onDelete("cascade"),
        )
        .execute();
      await db.schema
        .createIndex("project_backup_bindings_backup_idx")
        .on("project_backup_bindings")
        .column("backup_id")
        .execute();
      await db.schema
        .createIndex("project_backup_bindings_vm_idx")
        .on("project_backup_bindings")
        .column("vm_id")
        .execute();
    },

    async down(db: Kysely<DatabaseSchema>): Promise<void> {
      for (const table of ["project_backup_bindings", "project_backups", "vm_snapshots"]) {
        await db.schema.dropTable(table).ifExists().execute();
      }
    },
  },

  "009_phase10_bots": {
    async up(db: Kysely<DatabaseSchema>): Promise<void> {
      await db.schema
        .createTable("bot_accounts")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("platform", "text", (column) => column.notNull())
        .addColumn("name", "text", (column) => column.notNull())
        .addColumn("enabled", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("app_id", "text", (column) => column.notNull())
        .addColumn("credential_provider_id", "text", (column) => column.notNull())
        .addColumn("config_json", "text", (column) => column.notNull().defaultTo("{}"))
        .addColumn("device_id", "text")
        .addColumn("state", "text", (column) => column.notNull().defaultTo("disabled"))
        .addColumn("last_connected_at", "text")
        .addColumn("last_error", "text")
        .addColumn("last_event_at", "text")
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("updated_at", "text", (column) => column.notNull())
        .execute();
      await db.schema
        .createIndex("bot_accounts_platform_idx")
        .on("bot_accounts")
        .columns(["platform", "app_id"])
        .unique()
        .execute();

      await db.schema
        .createTable("bot_identities")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("platform", "text", (column) => column.notNull())
        .addColumn("platform_user_id", "text", (column) => column.notNull())
        .addColumn("display_name", "text", (column) => column.notNull().defaultTo(""))
        .addColumn("role", "text", (column) => column.notNull().defaultTo("member"))
        .addColumn("bound", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("local_user_id", "text")
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("last_seen_at", "text", (column) => column.notNull())
        .addForeignKeyConstraint(
          "bot_identities_local_user_fk",
          ["local_user_id"],
          "local_users",
          ["id"],
          (constraint) => constraint.onDelete("set null"),
        )
        .execute();
      await db.schema
        .createIndex("bot_identities_platform_user_idx")
        .on("bot_identities")
        .columns(["platform", "platform_user_id"])
        .unique()
        .execute();

      await db.schema
        .createTable("bot_chats")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("platform", "text", (column) => column.notNull())
        .addColumn("conversation_id", "text", (column) => column.notNull())
        .addColumn("kind", "text", (column) => column.notNull())
        .addColumn("title", "text", (column) => column.notNull().defaultTo(""))
        .addColumn("allowed", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("project_id", "text")
        .addColumn("last_message_id", "text")
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("last_seen_at", "text", (column) => column.notNull())
        .addForeignKeyConstraint(
          "bot_chats_project_fk",
          ["project_id"],
          "projects",
          ["id"],
          (constraint) => constraint.onDelete("set null"),
        )
        .execute();
      await db.schema
        .createIndex("bot_chats_platform_conversation_idx")
        .on("bot_chats")
        .columns(["platform", "conversation_id"])
        .unique()
        .execute();

      await db.schema
        .createTable("bot_events")
        .addColumn("dedup_key", "text", (column) => column.primaryKey())
        .addColumn("account_id", "text", (column) => column.notNull())
        .addColumn("platform", "text", (column) => column.notNull())
        .addColumn("event_id", "text", (column) => column.notNull())
        .addColumn("platform_user_id", "text", (column) => column.notNull())
        .addColumn("conversation_id", "text", (column) => column.notNull())
        .addColumn("text", "text", (column) => column.notNull())
        .addColumn("received_at", "text", (column) => column.notNull())
        .addColumn("raw_json", "text", (column) => column.notNull())
        .addColumn("state", "text", (column) => column.notNull())
        .addColumn("attempts", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("last_error", "text")
        .addColumn("next_attempt_at", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("updated_at", "text", (column) => column.notNull())
        .addColumn("processed_at", "text")
        .addForeignKeyConstraint(
          "bot_events_account_fk",
          ["account_id"],
          "bot_accounts",
          ["id"],
          (constraint) => constraint.onDelete("cascade"),
        )
        .execute();
      await db.schema
        .createIndex("bot_events_state_idx")
        .on("bot_events")
        .columns(["state", "next_attempt_at"])
        .execute();

      await db.schema
        .createTable("bot_outbound")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("account_id", "text", (column) => column.notNull())
        .addColumn("platform", "text", (column) => column.notNull())
        .addColumn("conversation_id", "text", (column) => column.notNull())
        .addColumn("text", "text", (column) => column.notNull())
        .addColumn("kind", "text", (column) => column.notNull())
        .addColumn("ref_id", "text")
        .addColumn("dedupe_key", "text", (column) => column.notNull().unique())
        .addColumn("reply_to_message_id", "text")
        .addColumn("state", "text", (column) => column.notNull())
        .addColumn("attempts", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("next_attempt_at", "text", (column) => column.notNull())
        .addColumn("last_error", "text")
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("sent_at", "text")
        .addForeignKeyConstraint(
          "bot_outbound_account_fk",
          ["account_id"],
          "bot_accounts",
          ["id"],
          (constraint) => constraint.onDelete("cascade"),
        )
        .execute();
      await db.schema
        .createIndex("bot_outbound_state_idx")
        .on("bot_outbound")
        .columns(["state", "next_attempt_at"])
        .execute();

      await db.schema
        .createTable("bot_turns")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("account_id", "text", (column) => column.notNull())
        .addColumn("platform", "text", (column) => column.notNull())
        .addColumn("platform_conversation_id", "text", (column) => column.notNull())
        .addColumn("local_conversation_id", "text", (column) => column.notNull())
        .addColumn("user_text", "text", (column) => column.notNull())
        .addColumn("status", "text", (column) => column.notNull())
        .addColumn("assistant_text", "text")
        .addColumn("error_message", "text")
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("updated_at", "text", (column) => column.notNull())
        .addColumn("completed_at", "text")
        .addForeignKeyConstraint(
          "bot_turns_account_fk",
          ["account_id"],
          "bot_accounts",
          ["id"],
          (constraint) => constraint.onDelete("cascade"),
        )
        .addForeignKeyConstraint(
          "bot_turns_conversation_fk",
          ["local_conversation_id"],
          "conversations",
          ["id"],
          (constraint) => constraint.onDelete("cascade"),
        )
        .execute();
      await db.schema
        .createIndex("bot_turns_conversation_idx")
        .on("bot_turns")
        .columns(["local_conversation_id", "status", "created_at"])
        .execute();

      await db.schema
        .createTable("bot_task_links")
        .addColumn("task_id", "text", (column) => column.primaryKey())
        .addColumn("turn_id", "text", (column) => column.notNull())
        .addColumn("account_id", "text", (column) => column.notNull())
        .addColumn("platform", "text", (column) => column.notNull())
        .addColumn("platform_conversation_id", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addForeignKeyConstraint("bot_task_links_task_fk", ["task_id"], "tasks", ["id"], (c) =>
          c.onDelete("cascade"),
        )
        .addForeignKeyConstraint("bot_task_links_turn_fk", ["turn_id"], "bot_turns", ["id"], (c) =>
          c.onDelete("cascade"),
        )
        .addForeignKeyConstraint(
          "bot_task_links_account_fk",
          ["account_id"],
          "bot_accounts",
          ["id"],
          (c) => c.onDelete("cascade"),
        )
        .execute();

      await db.schema
        .createTable("bot_approval_links")
        .addColumn("approval_id", "text", (column) => column.primaryKey())
        .addColumn("task_id", "text", (column) => column.notNull())
        .addColumn("account_id", "text", (column) => column.notNull())
        .addColumn("platform", "text", (column) => column.notNull())
        .addColumn("platform_conversation_id", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addForeignKeyConstraint(
          "bot_approval_links_approval_fk",
          ["approval_id"],
          "cua_approvals",
          ["id"],
          (c) => c.onDelete("cascade"),
        )
        .addForeignKeyConstraint("bot_approval_links_task_fk", ["task_id"], "tasks", ["id"], (c) =>
          c.onDelete("cascade"),
        )
        .addForeignKeyConstraint(
          "bot_approval_links_account_fk",
          ["account_id"],
          "bot_accounts",
          ["id"],
          (c) => c.onDelete("cascade"),
        )
        .execute();

      await db.schema
        .createTable("bot_access_codes")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("code_hash", "text", (column) => column.notNull().unique())
        .addColumn("role", "text", (column) => column.notNull())
        .addColumn("expires_at", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("used_at", "text")
        .addColumn("used_by", "text")
        .execute();

      await db.schema
        .createTable("bot_confirmations")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("platform", "text", (column) => column.notNull())
        .addColumn("conversation_id", "text", (column) => column.notNull())
        .addColumn("platform_user_id", "text", (column) => column.notNull())
        .addColumn("action", "text", (column) => column.notNull())
        .addColumn("ref_id", "text", (column) => column.notNull())
        .addColumn("expires_at", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .execute();
      await db.schema
        .createIndex("bot_confirmations_lookup_idx")
        .on("bot_confirmations")
        .columns(["platform", "conversation_id", "platform_user_id", "created_at"])
        .execute();
    },

    async down(db: Kysely<DatabaseSchema>): Promise<void> {
      for (const table of [
        "bot_confirmations",
        "bot_access_codes",
        "bot_approval_links",
        "bot_task_links",
        "bot_turns",
        "bot_outbound",
        "bot_events",
        "bot_chats",
        "bot_identities",
        "bot_accounts",
      ]) {
        await db.schema.dropTable(table).ifExists().execute();
      }
    },
  },
  "010_phase11_web_desktop": {
    async up(db: Kysely<DatabaseSchema>): Promise<void> {
      await db.schema
        .createTable("auth_sessions")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("user_id", "text", (column) => column.notNull())
        .addColumn("role", "text", (column) => column.notNull())
        .addColumn("csrf_token", "text", (column) => column.notNull())
        .addColumn("label", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("last_seen_at", "text", (column) => column.notNull())
        .addColumn("expires_at", "text", (column) => column.notNull())
        .execute();
      await db.schema
        .createIndex("auth_sessions_expires_idx")
        .on("auth_sessions")
        .columns(["expires_at"])
        .execute();

      await db.schema
        .createTable("notifications")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("source_event_id", "integer", (column) => column.unique())
        .addColumn("kind", "text", (column) => column.notNull())
        .addColumn("severity", "text", (column) => column.notNull())
        .addColumn("title", "text", (column) => column.notNull())
        .addColumn("body", "text", (column) => column.notNull())
        .addColumn("project_id", "text")
        .addColumn("task_id", "text")
        .addColumn("vm_id", "text")
        .addColumn("worker_id", "text")
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("read_at", "text")
        .addColumn("dismissed_at", "text")
        .execute();
      await db.schema
        .createIndex("notifications_created_idx")
        .on("notifications")
        .columns(["created_at"])
        .execute();
      await db.schema
        .createIndex("notifications_unread_idx")
        .on("notifications")
        .columns(["read_at", "dismissed_at"])
        .execute();

      await db.schema
        .createTable("inbox_files")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("original_name", "text", (column) => column.notNull())
        .addColumn("content_type", "text", (column) => column.notNull())
        .addColumn("size_bytes", "integer", (column) => column.notNull())
        .addColumn("sha256", "text", (column) => column.notNull())
        .addColumn("stored_path", "text", (column) => column.notNull())
        .addColumn("project_id", "text")
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("deleted_at", "text")
        .execute();
      await db.schema
        .createIndex("inbox_files_project_idx")
        .on("inbox_files")
        .columns(["project_id", "created_at"])
        .execute();
    },

    async down(db: Kysely<DatabaseSchema>): Promise<void> {
      for (const table of ["inbox_files", "notifications", "auth_sessions"]) {
        await db.schema.dropTable(table).ifExists().execute();
      }
    },
  },
  "011_phase12_hardening": {
    async up(db: Kysely<DatabaseSchema>): Promise<void> {
      // Phase 12 acceptance runs large task histories and many idle/active
      // Workers. These indexes keep board filters, worker roster rebuilds and
      // archive lookups predictable without changing the domain model.
      await db.schema
        .createIndex("tasks_status_created_idx")
        .ifNotExists()
        .on("tasks")
        .columns(["status", "created_at"])
        .execute();
      await db.schema
        .createIndex("tasks_worker_created_idx")
        .ifNotExists()
        .on("tasks")
        .columns(["assigned_worker_id", "created_at"])
        .execute();
      await db.schema
        .createIndex("workers_status_created_idx")
        .ifNotExists()
        .on("workers")
        .columns(["status", "created_at"])
        .execute();
      await db.schema
        .createIndex("workers_project_vm_idx")
        .ifNotExists()
        .on("workers")
        .columns(["project_id", "vm_id"])
        .execute();
    },

    async down(db: Kysely<DatabaseSchema>): Promise<void> {
      for (const index of [
        "workers_project_vm_idx",
        "workers_status_created_idx",
        "tasks_worker_created_idx",
        "tasks_status_created_idx",
      ]) {
        await db.schema.dropIndex(index).ifExists().execute();
      }
    },
  },
};

/** Migration ids in the order the runner applies them. */
export function migrationIds(): string[] {
  return Object.keys(migrations);
}

/**
 * Migration ids that have not been recorded yet. Missing schema_migrations
 * means every migration is pending (a brand-new or legacy database).
 */
export async function pendingMigrationIds(db: Kysely<DatabaseSchema>): Promise<string[]> {
  const table = await sql<{ name: string }>`
    select name from sqlite_master where type = 'table' and name = 'schema_migrations'
  `.execute(db);
  if (table.rows.length === 0) {
    return migrationIds();
  }
  const rows = await db.selectFrom("schema_migrations").select("id").execute();
  const applied = new Set(rows.map((row) => row.id));
  return migrationIds().filter((id) => !applied.has(id));
}

export async function appliedMigrationIds(db: Kysely<DatabaseSchema>): Promise<string[]> {
  const table = await sql<{ name: string }>`
    select name from sqlite_master where type = 'table' and name = 'schema_migrations'
  `.execute(db);
  if (table.rows.length === 0) {
    return [];
  }
  const rows = await db
    .selectFrom("schema_migrations")
    .select("id")
    .orderBy("id", "asc")
    .execute();
  return rows.map((row) => row.id);
}

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
