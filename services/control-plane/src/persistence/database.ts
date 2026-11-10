import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { migrateToLatest } from "./migrations";
import type { DatabaseSchema } from "./schema";

export interface OpenDatabaseOptions {
  filename: string;
}

export class AppDatabase {
  readonly sqlite: BetterSqlite3.Database;
  readonly db: Kysely<DatabaseSchema>;
  readonly filename: string;

  private constructor(
    sqlite: BetterSqlite3.Database,
    db: Kysely<DatabaseSchema>,
    filename: string,
  ) {
    this.sqlite = sqlite;
    this.db = db;
    this.filename = filename;
  }

  static open(options: OpenDatabaseOptions): AppDatabase {
    const filename = options.filename;
    const isMemory = filename === ":memory:";

    if (!isMemory) {
      mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    }

    const sqlite = new BetterSqlite3(filename);
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    if (!isMemory) {
      sqlite.pragma("journal_mode = WAL");
    }

    const db = new Kysely<DatabaseSchema>({
      dialect: new SqliteDialect({ database: sqlite }),
    });

    return new AppDatabase(sqlite, db, filename);
  }

  async migrate(): Promise<string[]> {
    return migrateToLatest(this.db);
  }

  async backup(destination: string): Promise<void> {
    mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
    await this.sqlite.backup(destination);
  }

  async close(): Promise<void> {
    await this.db.destroy();
    if (this.sqlite.open) {
      this.sqlite.close();
    }
  }
}
