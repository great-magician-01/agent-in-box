import fs from "node:fs";
import path from "node:path";
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

export const DATA_ROOT_MARKER_FILENAME = ".agent-in-box-data-root";

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
      this.writeDataRootMarker();
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

  /**
   * Uninstall cleanup must never delete an arbitrary user-selected folder.
   * The marker is the proof that this directory is an Agent-in-Box data root.
   */
  private writeDataRootMarker(): void {
    const marker = path.join(this.dataRoot, DATA_ROOT_MARKER_FILENAME);
    if (fs.existsSync(marker)) {
      return;
    }
    fs.writeFileSync(
      marker,
      `${JSON.stringify({ product: "Agent-in-Box", version: 1, kind: "data-root" }, null, 2)}\n`,
      { mode: 0o600 },
    );
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
