import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { defaultDataRoot, storageLayout } from "@agent-in-box/config";
import type { Kysely } from "kysely";
import { AppDatabase } from "./database";
import type { DatabaseSchema } from "./schema";

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  readonly filename: string;
  private readonly appDatabase: AppDatabase;

  constructor() {
    const layout = storageLayout(defaultDataRoot());
    this.filename = layout.database;
    this.appDatabase = AppDatabase.open({ filename: this.filename });
  }

  get db(): Kysely<DatabaseSchema> {
    return this.appDatabase.db;
  }

  async onModuleInit(): Promise<void> {
    await this.appDatabase.migrate();
  }

  async onModuleDestroy(): Promise<void> {
    await this.appDatabase.close();
  }

  async backup(destination: string): Promise<void> {
    await this.appDatabase.backup(destination);
  }
}
