import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema";

/**
 * Kysely transactions extend Kysely, so repository methods accept this type
 * to participate in a caller-owned transaction.
 */
export type DatabaseExecutor = Kysely<DatabaseSchema>;
