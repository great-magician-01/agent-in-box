import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type { AppDatabase } from "./database";

export const PRE_MIGRATION_BACKUP_PREFIX = "pre-migration-";
export const DEFAULT_MIGRATION_BACKUP_KEEP = 5;

export interface MigrationBackupInfo {
  fileName: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  pendingMigrations: string[];
}

export interface CreatePreMigrationBackupOptions {
  app: AppDatabase;
  directory: string;
  appliedMigrationIds: string[];
  pendingMigrationIds: string[];
  keep?: number;
  now?: () => Date;
}

function backupFileName(now: Date, pending: string[]): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const target = pending[0]?.replace(/[^a-zA-Z0-9_-]/g, "_") ?? "unknown";
  return `${PRE_MIGRATION_BACKUP_PREFIX}${stamp}-${target}-to-${pending.at(-1) ?? "unknown"}.sqlite`;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

export async function inspectMigrationBackup(file: string): Promise<void> {
  const database = new BetterSqlite3(file, { readonly: true, fileMustExist: true });
  try {
    const result = database.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const value = result[0]?.integrity_check;
    if (value !== "ok") {
      throw new Error(`备份完整性校验失败：${value ?? "没有返回结果"}`);
    }
  } finally {
    database.close();
  }
}

/**
 * SQLite backups are the last line of defence before a schema migration. A
 * failed backup must stop startup instead of silently migrating user data.
 */
export async function createPreMigrationBackup(
  options: CreatePreMigrationBackupOptions,
): Promise<MigrationBackupInfo | null> {
  if (options.pendingMigrationIds.length === 0) {
    return null;
  }
  const now = options.now?.() ?? new Date();
  const directory = path.resolve(options.directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const fileName = backupFileName(now, options.pendingMigrationIds);
  const destination = path.join(directory, fileName);
  const partial = `${destination}.partial`;
  await rm(partial, { force: true });

  try {
    await options.app.backup(partial);
    await inspectMigrationBackup(partial);
    await rm(destination, { force: true });
    await renameIntoPlace(partial, destination);

    const sha256 = await sha256File(destination);
    await writeFile(`${destination}.sha256`, `${sha256}  ${fileName}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const sizeBytes = (await stat(destination)).size;
    await pruneMigrationBackups(directory, options.keep ?? DEFAULT_MIGRATION_BACKUP_KEEP);
    return {
      fileName,
      path: destination,
      sizeBytes,
      sha256,
      createdAt: now.toISOString(),
      pendingMigrations: [...options.pendingMigrationIds],
    };
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    await rm(destination, { force: true }).catch(() => undefined);
    await rm(`${destination}.sha256`, { force: true }).catch(() => undefined);
    throw new Error(
      `数据库迁移前备份失败，已停止启动以避免无备份迁移：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function renameIntoPlace(source: string, destination: string): Promise<void> {
  // On Windows the destination can briefly be locked by an indexer; retry a
  // short bounded number of times instead of failing the migration path.
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function pruneMigrationBackups(directory: string, keep: number): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const backups = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(PRE_MIGRATION_BACKUP_PREFIX))
    .filter((entry) => entry.name.endsWith(".sqlite"));
  const withTimes = await Promise.all(
    backups.map(async (entry) => {
      const file = path.join(directory, entry.name);
      return { file, time: (await stat(file)).mtimeMs };
    }),
  );
  withTimes.sort((left, right) => right.time - left.time);
  const removed: string[] = [];
  for (const { file } of withTimes.slice(Math.max(0, keep))) {
    await rm(file, { force: true });
    await rm(`${file}.sha256`, { force: true });
    removed.push(file);
  }
  return removed;
}

export async function listMigrationBackups(
  directory: string,
  limit = 10,
): Promise<MigrationBackupInfo[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const backups = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(PRE_MIGRATION_BACKUP_PREFIX))
    .filter((entry) => entry.name.endsWith(".sqlite"))
    .map((entry) => path.join(directory, entry.name));
  const rows = await Promise.all(
    backups.map(async (file): Promise<MigrationBackupInfo> => {
      const info = await stat(file);
      const fileName = path.basename(file);
      const checksum = await readFile(`${file}.sha256`, "utf8").catch(() => "");
      return {
        fileName,
        path: file,
        sizeBytes: info.size,
        sha256: checksum.split(/\s+/)[0] ?? "",
        createdAt: info.mtime.toISOString(),
        pendingMigrations: [],
      };
    }),
  );
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

/**
 * Reads the newest bytes of a text file without loading a multi-megabyte log
 * into memory. Used by the diagnostics exporter.
 */
export async function readTextTail(
  file: string,
  maxBytes: number,
): Promise<{ content: string; bytes: number; truncated: boolean }> {
  const info = await stat(file).catch(() => null);
  if (!info || info.size === 0) {
    return { content: "", bytes: 0, truncated: false };
  }
  const length = Math.min(info.size, Math.max(0, maxBytes));
  const start = info.size - length;
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return {
      content: buffer.toString("utf8"),
      bytes: info.size,
      truncated: start > 0,
    };
  } finally {
    await handle.close();
  }
}
