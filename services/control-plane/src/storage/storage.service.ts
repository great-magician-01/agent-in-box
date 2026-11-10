import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type {
  DataRootSource,
  StorageCategoryUsage,
  StorageCleanupResult,
  StorageLayoutInfo,
  StorageLockInfo,
  StorageMigrationResult,
  StorageReport,
  StorageValidation,
} from "@agent-in-box/protocol";
import { STORAGE_CATEGORIES } from "@agent-in-box/protocol";
import {
  readAppConfig,
  storageLayout,
  writeAppConfig,
  type AppConfigFile,
} from "@agent-in-box/config";
import BetterSqlite3 from "better-sqlite3";
import { DatabaseService } from "../persistence/database.service";
import { nowIso } from "../persistence/time";
import {
  copyTreeVerified,
  directoryStats,
  diskSpace,
  pathExists,
  removeDirectoryContents,
} from "./fs-utils";
import { StorageError, StorageLockedError } from "./storage-errors";

const execFileAsync = promisify(execFile);
const GIB = 1024 * 1024 * 1024;
const LOW_SPACE_WARNING_BYTES = 2 * GIB;
const MAX_WINDOWS_PATH_WARNING = 180;
const LOCK_STALE_AGE_MS = 10 * 60 * 1000;

export const STORAGE_OPTIONS = Symbol("AGENT_IN_BOX_STORAGE_OPTIONS");

export interface StorageServiceOptions {
  platform?: NodeJS.Platform;
  hostname?: string;
  pid?: number;
  owner?: string;
  lockPath?: string;
  configPath?: string;
  configuredRoot?: string;
  dataRootSource?: DataRootSource;
  processAlive?: (pid: number) => boolean;
  qemuImg?: string | null;
  now?: () => Date;
}

interface LockRecord extends StorageLockInfo {
  token: string;
}

interface LockHandle {
  info: StorageLockInfo;
  release(): Promise<void>;
}

interface MigrationAudit {
  id: string;
  fromRoot: string;
  toRoot: string;
  startedAt: string;
}

function defaultOwner(hostname: string): string {
  try {
    return `${os.userInfo().username}@${hostname}`;
  } catch {
    return `local-user@${hostname}`;
  }
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isPathInside(parent: string, candidate: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string): string =>
    platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const relative = path.relative(normalize(parent), normalize(candidate));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string): string =>
    platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function formatBytes(bytes: number): string {
  if (bytes >= GIB) {
    return `${(bytes / GIB).toFixed(1)} GiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function listFiles(root: string, predicate: (name: string) => boolean): Promise<string[]> {
  if (!(await pathExists(root))) {
    return [];
  }
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      break;
    }
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && predicate(entry.name)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

@Injectable()
export class StorageService {
  private readonly platform: NodeJS.Platform;
  private readonly hostname: string;
  private readonly pid: number;
  private readonly now: () => Date;

  constructor(
    private readonly database: DatabaseService,
    @Optional()
    @Inject(STORAGE_OPTIONS)
    private readonly options: StorageServiceOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.hostname = options.hostname ?? os.hostname();
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? (() => new Date());
  }

  currentRoot(): string {
    return path.resolve(this.options.configuredRoot ?? this.database.dataRoot);
  }

  currentSource(): DataRootSource {
    return this.options.dataRootSource ?? this.database.dataRootSource;
  }

  currentLayout(): StorageLayoutInfo {
    return storageLayout(this.currentRoot()) as StorageLayoutInfo;
  }

  configPath(): string {
    return this.options.configPath ?? this.database.configPath;
  }

  private lockPath(): string {
    return this.options.lockPath ?? path.join(path.dirname(this.configPath()), "storage.lock");
  }

  private processAlive(pid: number): boolean {
    return (this.options.processAlive ?? defaultProcessAlive)(pid);
  }

  private owner(): string {
    return this.options.owner ?? defaultOwner(this.hostname);
  }

  private readConfig(): AppConfigFile {
    return readAppConfig(this.configPath());
  }

  async validateRoot(rawPath: unknown): Promise<StorageValidation> {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (typeof rawPath !== "string" || rawPath.trim() === "") {
      return this.invalidValidation(rawPath, "存储路径不能为空", errors);
    }
    const requested = rawPath.trim();
    if (requested.includes("\0")) {
      return this.invalidValidation(requested, "存储路径包含非法字符", errors);
    }
    if (!path.isAbsolute(requested)) {
      return this.invalidValidation(requested, "存储路径必须是绝对路径", errors);
    }

    let resolved = path.resolve(requested);
    const filesystemRoot = path.parse(resolved).root;
    if (samePath(resolved, filesystemRoot, this.platform)) {
      return this.invalidValidation(
        requested,
        "不能直接使用磁盘根目录，请选择或创建专用文件夹",
        errors,
      );
    }

    let exists = await pathExists(resolved);
    let isDirectory = false;
    if (exists) {
      const stats = await lstat(resolved);
      if (stats.isSymbolicLink()) {
        try {
          resolved = await realpath(resolved);
        } catch (error) {
          return this.invalidValidation(
            requested,
            `符号链接无法解析：${error instanceof Error ? error.message : String(error)}`,
            errors,
          );
        }
        exists = await pathExists(resolved);
        warnings.push("所选路径是符号链接，已解析到真实目录");
      }
      if (exists) {
        const targetStats = await lstat(resolved);
        if (!targetStats.isDirectory()) {
          return this.invalidValidation(requested, "所选路径已存在但不是目录", errors);
        }
        isDirectory = true;
      }
    }

    try {
      await mkdir(resolved, { recursive: true, mode: 0o700 });
      exists = true;
      isDirectory = true;
    } catch (error) {
      errors.push(`无法创建目录：${error instanceof Error ? error.message : String(error)}`);
    }

    let writable = false;
    if (isDirectory) {
      const probe = path.join(resolved, `.agent-in-box-write-${this.pid}-${randomUUID()}`);
      try {
        await writeFile(probe, "ok", { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rm(probe, { force: true });
        writable = true;
      } catch (error) {
        errors.push(`目录不可写：${error instanceof Error ? error.message : String(error)}`);
        await rm(probe, { force: true }).catch(() => undefined);
      }
    }

    const space = await diskSpace(resolved);
    if (space.totalBytes > 0 && space.freeBytes < LOW_SPACE_WARNING_BYTES) {
      warnings.push(`可用空间仅 ${formatBytes(space.freeBytes)}，镜像和 VM 需要更多空间`);
    }
    if (this.platform === "win32" && resolved.length > MAX_WINDOWS_PATH_WARNING) {
      warnings.push("Windows 路径较长，可能受短路径/兼容性问题影响；建议使用较短的自定义目录");
    }
    const systemDrive = process.env.SystemDrive?.trim();
    const systemRoot = systemDrive ? path.parse(`${systemDrive}\\`).root : null;
    if (systemRoot && isPathInside(systemRoot, resolved, "win32")) {
      warnings.push("存储目录位于系统盘；建议改用非系统盘以降低空间压力");
    }

    const layout = storageLayout(resolved);
    return {
      path: requested,
      resolvedPath: resolved,
      exists,
      directory: isDirectory,
      writable,
      freeBytes: space.freeBytes,
      totalBytes: space.totalBytes,
      layout: layout as StorageLayoutInfo,
      warnings,
      errors,
      ok: errors.length === 0,
    };
  }

  private invalidValidation(
    rawPath: unknown,
    message: string,
    errors: string[],
  ): StorageValidation {
    const requested = typeof rawPath === "string" ? rawPath : "";
    const layout = storageLayout(path.resolve(requested || os.homedir())) as StorageLayoutInfo;
    return {
      path: requested,
      resolvedPath: layout.root,
      exists: false,
      directory: false,
      writable: false,
      freeBytes: 0,
      totalBytes: 0,
      layout,
      warnings: [],
      errors: [...errors, message],
      ok: false,
    };
  }

  /**
   * Persists a root that is already the active root. Use migrateTo() when the
   * location changes; this method never moves data.
   */
  configurationStatus(): { restartRequired: boolean; configuredRoot: string | null } {
    if (this.currentSource() === "environment") {
      return { restartRequired: false, configuredRoot: this.currentRoot() };
    }
    try {
      const configuredRoot = this.readConfig().dataRoot ?? null;
      return {
        restartRequired:
          configuredRoot !== null && !samePath(configuredRoot, this.currentRoot(), this.platform),
        configuredRoot,
      };
    } catch {
      return { restartRequired: false, configuredRoot: null };
    }
  }

  async configureCurrentRoot(root: string): Promise<void> {
    if (this.currentSource() === "environment") {
      throw new StorageError(
        "conflict",
        "数据根目录由 AGENT_IN_BOX_DATA_ROOT 管理，不能通过向导修改",
      );
    }
    if (!samePath(root, this.currentRoot(), this.platform)) {
      throw new StorageError("validation_failed", "只能原地配置当前数据根目录");
    }
    const config = this.readConfig();
    writeAppConfig(this.configPath(), { ...config, dataRoot: path.resolve(root) });
  }

  async migrateTo(targetRoot: string): Promise<StorageMigrationResult> {
    if (this.currentSource() === "environment") {
      throw new StorageError("conflict", "数据根目录由 AGENT_IN_BOX_DATA_ROOT 管理，不能执行迁移");
    }

    const fromRoot = this.currentRoot();
    const requestedTarget = path.resolve(targetRoot);
    if (samePath(fromRoot, requestedTarget, this.platform)) {
      throw new StorageError("validation_failed", "目标目录与当前数据根目录相同");
    }
    if (
      isPathInside(fromRoot, requestedTarget, this.platform) ||
      isPathInside(requestedTarget, fromRoot, this.platform)
    ) {
      throw new StorageError("validation_failed", "目标目录不能位于当前数据目录内部，反之亦然");
    }
    const targetExisted = await pathExists(requestedTarget);
    const validation = await this.validateRoot(targetRoot);
    if (!validation.ok) {
      throw new StorageError("validation_failed", "目标存储目录不可用", {
        errors: validation.errors,
      });
    }
    const toRoot = validation.resolvedPath;

    if (samePath(fromRoot, toRoot, this.platform)) {
      throw new StorageError("validation_failed", "目标目录与当前数据根目录相同");
    }
    if (
      isPathInside(fromRoot, toRoot, this.platform) ||
      isPathInside(toRoot, fromRoot, this.platform)
    ) {
      throw new StorageError("validation_failed", "目标目录不能位于当前数据目录内部，反之亦然");
    }

    const fromLayout = storageLayout(fromRoot);
    const toLayout = storageLayout(toRoot);
    const lock = await this.acquireLock("storage_migrate");
    const startedAt = nowIso(this.now());
    const audit: MigrationAudit = {
      id: randomUUID(),
      fromRoot,
      toRoot,
      startedAt,
    };
    let configUpdated = false;

    try {
      await this.prepareMigrationMarker(toLayout.root, fromRoot, startedAt);
      await this.insertAudit(audit, "running");

      const config = this.readConfig();
      writeAppConfig(this.configPath(), {
        ...config,
        pendingMigration: {
          targetRoot: toRoot,
          startedAt,
          operation: "storage_migrate",
        },
      });

      let filesCopied = 0;
      let bytesCopied = 0;
      let verifiedFiles = 0;
      const copyWarnings: string[] = [];
      for (const category of STORAGE_CATEGORIES) {
        const copied = await copyTreeVerified(fromLayout[category], toLayout[category]);
        filesCopied += copied.filesCopied;
        bytesCopied += copied.bytesCopied;
        verifiedFiles += copied.verifiedFiles;
        copyWarnings.push(...copied.warnings);
      }

      await this.database.backup(toLayout.database);
      await verifySqliteDatabase(toLayout.database);
      const qemuWarnings = await this.verifyQemuImages(this.options.qemuImg, toLayout, fromRoot);

      const latestConfig = this.readConfig();
      const nextConfig: AppConfigFile = { ...latestConfig, dataRoot: toRoot };
      delete nextConfig.pendingMigration;
      writeAppConfig(this.configPath(), nextConfig);
      configUpdated = true;

      const durationMs = Math.max(0, this.now().getTime() - new Date(startedAt).getTime());
      const warnings = [...validation.warnings, ...copyWarnings, ...qemuWarnings];

      // The migration is committed once the config points at the new root.
      // Audit/marker cleanup must not turn a successful move into an error.
      await this.finishMigrationAudit(audit, "completed", {
        filesCopied,
        bytesCopied,
      }).catch(() => undefined);
      await this.removeMigrationMarker(toLayout.root).catch(() => undefined);
      await this.updateAuditInDatabase(toLayout.database, audit, "completed", {
        filesCopied,
        bytesCopied,
      }).catch(() => undefined);

      return {
        from: fromRoot,
        to: toRoot,
        filesCopied,
        bytesCopied,
        durationMs,
        verifiedFiles,
        warnings,
        configUpdated,
        restartRequired: true,
        oldDataRetained: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finishMigrationAudit(audit, "failed", {
        error: message,
        filesCopied: 0,
        bytesCopied: 0,
      }).catch(() => undefined);
      if (!configUpdated) {
        await this.clearPendingMigration().catch(() => undefined);
        await this.removeMigrationMarker(toLayout.root).catch(() => undefined);
        if (!targetExisted) {
          await rm(toRoot, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError("internal_error", `存储迁移失败：${message}`);
    } finally {
      await lock.release();
    }
  }

  private async prepareMigrationMarker(
    targetRoot: string,
    fromRoot: string,
    startedAt: string,
  ): Promise<void> {
    const marker = path.join(targetRoot, ".migration-in-progress.json");
    if (await pathExists(marker)) {
      const raw = await readFile(marker, "utf8").catch(() => "");
      let previous: { fromRoot?: string } = {};
      try {
        previous = JSON.parse(raw) as { fromRoot?: string };
      } catch {
        previous = {};
      }
      if (previous.fromRoot && !samePath(previous.fromRoot, fromRoot, this.platform)) {
        throw new StorageError(
          "conflict",
          "目标目录存在来自其他数据根目录的未完成迁移，请检查后手动处理",
        );
      }
      // Same source: a previous attempt was interrupted. Verified copies are
      // rewritten atomically, so it is safe to continue.
      await rm(marker, { force: true });
    }
    await mkdir(targetRoot, { recursive: true, mode: 0o700 });
    await writeFile(
      marker,
      JSON.stringify({ fromRoot, startedAt, operation: "storage_migrate" }, null, 2),
      { mode: 0o600 },
    );
  }

  private async removeMigrationMarker(targetRoot: string): Promise<void> {
    await rm(path.join(targetRoot, ".migration-in-progress.json"), { force: true });
  }

  private async clearPendingMigration(): Promise<void> {
    const config = this.readConfig();
    if (!config.pendingMigration) {
      return;
    }
    const next = { ...config };
    delete next.pendingMigration;
    writeAppConfig(this.configPath(), next);
  }

  async getLockInfo(): Promise<StorageLockInfo | null> {
    try {
      const raw = await readFile(this.lockPath(), "utf8");
      const parsed = JSON.parse(raw) as Partial<LockRecord>;
      if (
        typeof parsed.owner !== "string" ||
        typeof parsed.pid !== "number" ||
        typeof parsed.hostname !== "string" ||
        typeof parsed.acquiredAt !== "string" ||
        typeof parsed.operation !== "string"
      ) {
        return null;
      }
      return {
        owner: parsed.owner,
        pid: parsed.pid,
        hostname: parsed.hostname,
        acquiredAt: parsed.acquiredAt,
        operation: parsed.operation,
      };
    } catch {
      return null;
    }
  }

  async acquireLock(operation: string): Promise<LockHandle> {
    const lockPath = this.lockPath();
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    const token = randomUUID();
    const record: LockRecord = {
      token,
      owner: this.owner(),
      pid: this.pid,
      hostname: this.hostname,
      acquiredAt: nowIso(this.now()),
      operation,
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
        } finally {
          await handle.close();
        }
        await chmod(lockPath, 0o600).catch(() => undefined);
        return {
          info: {
            owner: record.owner,
            pid: record.pid,
            hostname: record.hostname,
            acquiredAt: record.acquiredAt,
            operation: record.operation,
          },
          release: () => this.releaseLock(lockPath, token),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new StorageError("unavailable", `无法获取存储锁：${String(error)}`);
        }
        const stale = await this.lockIsStale(lockPath);
        if (stale) {
          await rm(lockPath, { force: true });
          continue;
        }
        const info = await this.getLockInfo();
        throw new StorageLockedError(
          `存储正在被其他操作占用：${info?.operation ?? "unknown"} (${info?.owner ?? "unknown"})`,
        );
      }
    }

    throw new StorageLockedError("无法获取存储锁");
  }

  private async lockIsStale(lockPath: string): Promise<boolean> {
    try {
      const raw = await readFile(lockPath, "utf8");
      const record = JSON.parse(raw) as Partial<LockRecord>;
      if (
        typeof record.pid === "number" &&
        typeof record.hostname === "string" &&
        record.hostname === this.hostname &&
        !this.processAlive(record.pid)
      ) {
        return true;
      }
      if (typeof record.pid !== "number") {
        const stats = await stat(lockPath);
        return Date.now() - stats.mtimeMs > LOCK_STALE_AGE_MS;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async releaseLock(lockPath: string, token: string): Promise<void> {
    try {
      const raw = await readFile(lockPath, "utf8");
      const record = JSON.parse(raw) as Partial<LockRecord>;
      if (record.token === token) {
        await rm(lockPath, { force: true });
      }
    } catch {
      // The lock may already be gone; releasing is idempotent.
    }
  }

  private async insertAudit(audit: MigrationAudit, status: string): Promise<void> {
    await this.database.db
      .insertInto("storage_migrations")
      .values({
        id: audit.id,
        from_root: audit.fromRoot,
        to_root: audit.toRoot,
        status,
        started_at: audit.startedAt,
        completed_at: null,
        error: null,
        files_copied: 0,
        bytes_copied: 0,
      })
      .execute();
  }

  private async finishMigrationAudit(
    audit: MigrationAudit,
    status: string,
    values: { filesCopied: number; bytesCopied: number; error?: string },
  ): Promise<void> {
    await this.database.db
      .updateTable("storage_migrations")
      .set({
        status,
        completed_at: nowIso(this.now()),
        error: values.error ?? null,
        files_copied: values.filesCopied,
        bytes_copied: values.bytesCopied,
      })
      .where("id", "=", audit.id)
      .execute();
  }

  private async updateAuditInDatabase(
    databasePath: string,
    audit: MigrationAudit,
    status: string,
    values: { filesCopied: number; bytesCopied: number },
  ): Promise<void> {
    if (!(await pathExists(databasePath))) {
      return;
    }
    const database = new BetterSqlite3(databasePath);
    try {
      database
        .prepare(
          "update storage_migrations set status = ?, completed_at = ?, files_copied = ?, bytes_copied = ? where id = ?",
        )
        .run(status, nowIso(this.now()), values.filesCopied, values.bytesCopied, audit.id);
    } finally {
      database.close();
    }
  }

  async getReport(): Promise<StorageReport> {
    const root = this.currentRoot();
    const layout = this.currentLayout();
    const space = await diskSpace(root);
    const categories = await Promise.all(
      STORAGE_CATEGORIES.map(async (category): Promise<StorageCategoryUsage> => {
        const usage = await directoryStats(layout[category]);
        return { category, path: layout[category], bytes: usage.bytes, files: usage.files };
      }),
    );

    let databaseBytes = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = `${layout.database}${suffix}`;
      if (await pathExists(file)) {
        databaseBytes += (await stat(file)).size;
      }
    }

    let pendingMigration = null;
    try {
      pendingMigration = this.readConfig().pendingMigration ?? null;
    } catch {
      pendingMigration = null;
    }

    return {
      root,
      databasePath: layout.database,
      databaseBytes,
      totalBytes: space.totalBytes,
      freeBytes: space.freeBytes,
      categories,
      lock: await this.getLockInfo(),
      pendingMigration,
    };
  }

  async cleanupDownloads(): Promise<StorageCleanupResult> {
    const downloads = this.currentLayout().downloads;
    const lock = await this.acquireLock("cleanup_downloads");
    try {
      const deleted = await removeDirectoryContents(downloads);
      await mkdir(downloads, { recursive: true, mode: 0o700 });
      return {
        path: downloads,
        bytesFreed: deleted.bytes,
        filesDeleted: deleted.files,
      };
    } finally {
      await lock.release();
    }
  }

  private async verifyQemuImages(
    configuredQemuImg: string | null | undefined,
    layout: StorageLayoutInfo,
    oldRoot: string,
  ): Promise<string[]> {
    const images = [
      ...(await listFiles(layout.vms, (name) => name.endsWith(".qcow2"))),
      ...(await listFiles(layout.snapshots, (name) => name.endsWith(".qcow2"))),
    ];
    if (images.length === 0) {
      return [];
    }

    const qemuImg = await this.findQemuImg(configuredQemuImg);
    if (!qemuImg) {
      return ["未找到 qemu-img，未能校验迁移后的 qcow2/快照链"];
    }

    const warnings: string[] = [];
    for (const image of images) {
      try {
        await execFileAsync(qemuImg, ["check", image], {
          timeout: 120_000,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        });
      } catch (error) {
        throw new StorageError(
          "internal_error",
          `迁移后的磁盘镜像校验失败：${path.basename(image)} (${error instanceof Error ? error.message : String(error)})`,
        );
      }

      try {
        const { stdout } = await execFileAsync(qemuImg, ["info", "--output=json", image], {
          timeout: 30_000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        });
        const info = JSON.parse(stdout) as {
          "full-backing-filename"?: string;
          "backing-filename"?: string;
        };
        const backing = info["full-backing-filename"] ?? info["backing-filename"];
        if (backing && isPathInside(oldRoot, backing, this.platform)) {
          warnings.push(
            `镜像 ${path.basename(image)} 的 backing file 仍指向旧数据目录，旧目录在确认迁移前不能删除`,
          );
        }
      } catch {
        warnings.push(`无法读取镜像 ${path.basename(image)} 的 backing file 信息`);
      }
    }
    return warnings;
  }

  private async findQemuImg(configured: string | null | undefined): Promise<string | null> {
    if (configured === null) {
      return null;
    }
    const candidates = configured
      ? [configured]
      : this.platform === "win32"
        ? ["qemu-img.exe", "qemu-img"]
        : ["qemu-img"];
    for (const candidate of candidates) {
      try {
        await execFileAsync(candidate, ["--version"], { timeout: 5000, windowsHide: true });
        return candidate;
      } catch {
        // Try the next candidate.
      }
    }
    return null;
  }
}

async function verifySqliteDatabase(databasePath: string): Promise<void> {
  const database = new BetterSqlite3(databasePath, { fileMustExist: true });
  try {
    const rows = database.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
      throw new StorageError("internal_error", "迁移后的数据库完整性检查失败");
    }
  } finally {
    database.close();
  }
}
