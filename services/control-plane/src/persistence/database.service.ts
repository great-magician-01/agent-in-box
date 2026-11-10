import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import {
  ensureStorageLayout,
  resolveDataRoot,
  storageLayout,
  type DataRootSource,
  type StorageLayout,
} from "@agent-in-box/config";
import type { Kysely } from "kysely";
import { AppDatabase } from "./database";
import type { DatabaseSchema } from "./schema";

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  readonly filename: string;
  readonly dataRoot: string;
  readonly dataRootSource: DataRootSource;
  readonly configPath: string;
  readonly layout: StorageLayout;
  private readonly appDatabase: AppDatabase;

  constructor() {
    const resolved = resolveDataRoot();
    this.dataRoot = resolved.root;
    this.dataRootSource = resolved.source;
    this.configPath = resolved.configPath;
    this.layout = storageLayout(this.dataRoot);
    try {
      ensureStorageLayout(this.layout);
    } catch (error) {
      throw new Error(
        `无法初始化数据目录 ${this.dataRoot}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    this.filename = this.layout.database;
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
