import type { Kysely } from "kysely";
import type { DatabaseSchema } from "../schema";

export class EventDedupRepository {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  /**
   * Claim an event exactly once. Returns true when the caller owns the event
   * and should process it, false when it was already processed.
   */
  async claim(dedupKey: string, processedAt: string): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("processed_events")
        .select(["dedup_key"])
        .where("dedup_key", "=", dedupKey)
        .executeTakeFirst();

      if (existing) {
        return false;
      }

      await trx
        .insertInto("processed_events")
        .values({ dedup_key: dedupKey, processed_at: processedAt })
        .execute();
      return true;
    });
  }

  async isProcessed(dedupKey: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("processed_events")
      .select(["dedup_key"])
      .where("dedup_key", "=", dedupKey)
      .executeTakeFirst();
    return row !== undefined;
  }
}
