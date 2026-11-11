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
import {
  DEFAULT_MIGRATION_BACKUP_KEEP,
  createPreMigrationBackup,
  type MigrationBackupInfo,
} from "./migration-backup";
import { appliedMigrationIds, pendingMigrationIds } from "./migrations";

export const DATA_ROOT_MARKER_FILENAME = ".agent-in-box-data-root";

function readBackupKeep(): number {
  const raw = Number(process.env.AGENT_IN_BOX_MIGRATION_BACKUP_KEEP);
  return Number.isInteger(raw) && raw >= 1 && raw <= 50 ? raw : DEFAULT_MIGRATION_BACKUP_KEEP;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  readonly filename: string;
  readonly dataRoot: string;
  readonly dataRootSource: DataRootSource;
  readonly configPath: string;
  readonly layout: StorageLayout;
  readonly backupsDirectory: string;
  lastMigrationBackup: MigrationBackupInfo | null = null;
  private readonly appDatabase: AppDatabase;
  private readonly databaseExisted: boolean;
  private readonly backupKeep: number;

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
    this.backupsDirectory = this.layout.backups;
    this.databaseExisted = fs.existsSync(this.filename);
    this.backupKeep = readBackupKeep();
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
    // A brand-new database has nothing to protect. For an existing database,
    // back up before every pending migration and stop startup if that backup
    // cannot be created and verified.
    if (this.databaseExisted) {
      const [applied, pending] = await Promise.all([
        appliedMigrationIds(this.appDatabase.db),
        pendingMigrationIds(this.appDatabase.db),
      ]);
      this.lastMigrationBackup = await createPreMigrationBackup({
        app: this.appDatabase,
        directory: this.backupsDirectory,
        appliedMigrationIds: applied,
        pendingMigrationIds: pending,
        keep: this.backupKeep,
      });
    }
    await this.appDatabase.migrate();
  }

  async onModuleDestroy(): Promise<void> {
    await this.appDatabase.close();
  }

  async backup(destination: string): Promise<void> {
    await this.appDatabase.backup(destination);
  }
}
