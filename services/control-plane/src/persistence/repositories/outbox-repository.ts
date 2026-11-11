import { Inject } from "@nestjs/common";
import type { Kysely } from "kysely";
import type { DatabaseExecutor } from "../executor";
import type { DatabaseSchema } from "../schema";
import { KYSELY } from "../tokens";

export interface OutboxMessage {
  id: number;
  topic: string;
  payload: unknown;
  createdAt: string;
  attempts: number;
  lastError: string | null;
}

export class OutboxRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>) {}

  async append(
    topic: string,
    payload: unknown,
    createdAt: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<number> {
    const result = await executor
      .insertInto("outbox")
      .values({
        topic,
        payload_json: JSON.stringify(payload),
        created_at: createdAt,
        published_at: null,
        attempts: 0,
        last_error: null,
      })
      .executeTakeFirst();

    return Number(result.insertId ?? 0);
  }

  async listPending(limit = 50, executor: DatabaseExecutor = this.db): Promise<OutboxMessage[]> {
    const rows = await executor
      .selectFrom("outbox")
      .selectAll()
      .where("published_at", "is", null)
      .orderBy("id", "asc")
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      topic: row.topic,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: row.created_at,
      attempts: row.attempts,
      lastError: row.last_error,
    }));
  }

  async markPublished(
    ids: readonly number[],
    publishedAt: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await executor
      .updateTable("outbox")
      .set({ published_at: publishedAt })
      .where("id", "in", [...ids])
      .execute();
  }

  async markFailed(id: number, error: string, executor: DatabaseExecutor = this.db): Promise<void> {
    await executor
      .updateTable("outbox")
      .set((builder) => ({
        attempts: builder("attempts", "+", 1),
        last_error: error,
      }))
      .where("id", "=", id)
      .execute();
  }
}
