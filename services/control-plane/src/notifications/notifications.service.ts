import { randomUUID } from "node:crypto";
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { Kysely } from "kysely";
import type {
  NotificationCenterView,
  NotificationKind,
  NotificationRecord,
  NotificationSeverity,
  TaskStatus,
} from "@agent-in-box/protocol";
import { KYSELY } from "../persistence/tokens";
import { PersistenceError } from "../persistence/errors";
import { OutboxRepository } from "../persistence/repositories/outbox-repository";
import type { DatabaseSchema, NotificationsTable } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { notificationForEvent, type NotificationTaskContext } from "./notification-mapper";

const NOTIFICATION_CURSOR_KEY = "notificationCenter.cursor";
const VALID_KINDS = new Set<NotificationKind>([
  "task",
  "approval",
  "worker",
  "vm",
  "resource",
  "router",
  "bot",
  "system",
]);
const VALID_SEVERITIES = new Set<NotificationSeverity>(["info", "success", "warning", "danger"]);

export interface NotificationServiceOptions {
  pollIntervalMs?: number;
  now?: () => Date;
}

export const NOTIFICATION_OPTIONS = Symbol("NOTIFICATION_OPTIONS");

@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private cursor = 0;
  private timer: NodeJS.Timeout | null = null;
  private processing = false;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly outbox: OutboxRepository,
    @Inject(NOTIFICATION_OPTIONS) private readonly options: NotificationServiceOptions,
  ) {
    this.pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 500);
    this.now = options.now ?? (() => new Date());
  }

  async onModuleInit(): Promise<void> {
    this.cursor = await this.loadCursor();
    this.timer = setInterval(
      () => void this.reconcile().catch(() => undefined),
      this.pollIntervalMs,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async center(
    input: { limit?: number; unreadOnly?: boolean } = {},
  ): Promise<NotificationCenterView> {
    const limit = Math.max(1, Math.min(200, input.limit ?? 60));
    let query = this.db
      .selectFrom("notifications")
      .selectAll()
      .where("dismissed_at", "is", null)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit);
    if (input.unreadOnly) {
      query = query.where("read_at", "is", null);
    }
    const [rows, unread] = await Promise.all([
      query.execute(),
      this.db
        .selectFrom("notifications")
        .select((expression) => expression.fn.count<number>("id").as("count"))
        .where("read_at", "is", null)
        .where("dismissed_at", "is", null)
        .executeTakeFirst(),
    ]);
    return {
      items: rows.map(toRecord),
      unreadCount: Number(unread?.count ?? 0),
      snapshotAt: nowIso(this.now()),
    };
  }

  async markRead(id: string): Promise<NotificationRecord> {
    const readAt = nowIso(this.now());
    const result = await this.db
      .updateTable("notifications")
      .set({ read_at: readAt })
      .where("id", "=", id)
      .where("read_at", "is", null)
      .executeTakeFirst();
    const row = await this.require(id);
    if (Number(result.numUpdatedRows ?? 0) > 0) {
      await this.outbox.append(
        "notification.read",
        { notificationId: id, readAt },
        nowIso(this.now()),
      );
    }
    return toRecord(row);
  }

  async dismiss(id: string): Promise<NotificationRecord> {
    const dismissedAt = nowIso(this.now());
    await this.db
      .updateTable("notifications")
      .set({ dismissed_at: dismissedAt, read_at: dismissedAt })
      .where("id", "=", id)
      .execute();
    const row = await this.require(id);
    await this.outbox.append(
      "notification.dismissed",
      { notificationId: id, dismissedAt },
      nowIso(this.now()),
    );
    return toRecord(row);
  }

  async markAllRead(): Promise<number> {
    const readAt = nowIso(this.now());
    const result = await this.db
      .updateTable("notifications")
      .set({ read_at: readAt })
      .where("read_at", "is", null)
      .where("dismissed_at", "is", null)
      .executeTakeFirst();
    const count = Number(result.numUpdatedRows ?? 0);
    if (count > 0) {
      await this.outbox.append("notification.read_all", { readAt, count }, nowIso(this.now()));
    }
    return count;
  }

  /**
   * Reads durable Outbox rows in order and projects them into notifications.
   * The cursor is persisted, so a control-plane restart does not duplicate or
   * skip user-visible items.
   */
  async reconcile(): Promise<number> {
    if (this.processing) {
      return 0;
    }
    this.processing = true;
    try {
      const rows = await this.db
        .selectFrom("outbox")
        .select(["id", "topic", "payload_json", "created_at"])
        .where("id", ">", this.cursor)
        .orderBy("id", "asc")
        .limit(100)
        .execute();
      if (rows.length === 0) {
        return 0;
      }

      const candidates: Array<{
        row: (typeof rows)[number];
        candidate: ReturnType<typeof notificationForEvent>;
      }> = [];
      for (const row of rows) {
        let payload: unknown;
        try {
          payload = JSON.parse(row.payload_json);
        } catch {
          continue;
        }
        const taskContext = await this.taskContext(payload);
        candidates.push({ row, candidate: notificationForEvent(row.topic, payload, taskContext) });
      }

      const createdAt = nowIso(this.now());
      let inserted = 0;
      await this.db.transaction().execute(async (trx) => {
        for (const { row, candidate } of candidates) {
          if (!candidate) continue;
          const id = randomUUID();
          const result = await trx
            .insertInto("notifications")
            .values({
              id,
              source_event_id: row.id,
              kind: candidate.kind,
              severity: candidate.severity,
              title: candidate.title,
              body: candidate.body,
              project_id: candidate.projectId,
              task_id: candidate.taskId,
              vm_id: candidate.vmId,
              worker_id: candidate.workerId,
              created_at: createdAt,
              read_at: null,
              dismissed_at: null,
            })
            .onConflict((conflict) => conflict.column("source_event_id").doNothing())
            .executeTakeFirst();
          if (Number(result.numInsertedOrUpdatedRows ?? 0) === 0) continue;
          inserted += 1;
          await trx
            .insertInto("outbox")
            .values({
              topic: "notification.created",
              payload_json: JSON.stringify({
                notificationId: id,
                kind: candidate.kind,
                severity: candidate.severity,
                title: candidate.title,
                projectId: candidate.projectId,
                taskId: candidate.taskId,
                vmId: candidate.vmId,
                workerId: candidate.workerId,
              }),
              created_at: createdAt,
              published_at: null,
              attempts: 0,
              last_error: null,
            })
            .execute();
        }
        this.cursor = rows[rows.length - 1]!.id;
        await trx
          .insertInto("app_settings")
          .values({
            key: NOTIFICATION_CURSOR_KEY,
            value_json: JSON.stringify(this.cursor),
            updated_at: createdAt,
          })
          .onConflict((conflict) =>
            conflict.column("key").doUpdateSet({
              value_json: JSON.stringify(this.cursor),
              updated_at: createdAt,
            }),
          )
          .execute();
      });
      return inserted;
    } catch (error) {
      this.logger.error(
        "Notification projection failed; the cursor will retry",
        error instanceof Error ? error.stack : String(error),
      );
      return 0;
    } finally {
      this.processing = false;
    }
  }

  private async loadCursor(): Promise<number> {
    const row = await this.db
      .selectFrom("app_settings")
      .select("value_json")
      .where("key", "=", NOTIFICATION_CURSOR_KEY)
      .executeTakeFirst();
    if (row) {
      try {
        const value = JSON.parse(row.value_json) as unknown;
        if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
          return value;
        }
      } catch {
        // Fall through to the current tail.
      }
    }
    const latest = await this.db
      .selectFrom("outbox")
      .select("id")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    const cursor = latest?.id ?? 0;
    await this.db
      .insertInto("app_settings")
      .values({
        key: NOTIFICATION_CURSOR_KEY,
        value_json: JSON.stringify(cursor),
        updated_at: nowIso(this.now()),
      })
      .onConflict((conflict) =>
        conflict
          .column("key")
          .doUpdateSet({ value_json: JSON.stringify(cursor), updated_at: nowIso(this.now()) }),
      )
      .execute();
    return cursor;
  }

  private async taskContext(payload: unknown): Promise<NotificationTaskContext | null> {
    if (typeof payload !== "object" || payload === null) return null;
    const record = payload as Record<string, unknown>;
    const taskId = typeof record.taskId === "string" ? record.taskId : null;
    if (!taskId) return null;
    const row = await this.db
      .selectFrom("tasks")
      .select([
        "id",
        "project_id",
        "vm_id",
        "objective",
        "status",
        "latest_summary",
        "error_message",
      ])
      .where("id", "=", taskId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      vmId: row.vm_id,
      objective: row.objective,
      status: row.status as TaskStatus,
      latestSummary: row.latest_summary,
      errorMessage: row.error_message,
    };
  }

  private async require(id: string): Promise<NotificationsTable> {
    const row = await this.db
      .selectFrom("notifications")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      throw new PersistenceError("not_found", `通知不存在：${id}`);
    }
    return row;
  }
}

export function toRecord(row: NotificationsTable): NotificationRecord {
  if (!VALID_KINDS.has(row.kind as NotificationKind)) {
    throw new PersistenceError("internal_error", `通知类型无效：${row.kind}`);
  }
  if (!VALID_SEVERITIES.has(row.severity as NotificationSeverity)) {
    throw new PersistenceError("internal_error", `通知严重级别无效：${row.severity}`);
  }
  return {
    id: row.id,
    kind: row.kind as NotificationKind,
    severity: row.severity as NotificationSeverity,
    title: row.title,
    body: row.body,
    projectId: row.project_id,
    taskId: row.task_id,
    vmId: row.vm_id,
    workerId: row.worker_id,
    createdAt: row.created_at,
    readAt: row.read_at,
    dismissedAt: row.dismissed_at,
  };
}
