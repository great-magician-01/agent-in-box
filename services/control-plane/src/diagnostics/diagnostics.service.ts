import { constants as fsConstants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import { PROTOCOL_VERSION, type DiagnosticsReport } from "@agent-in-box/protocol";
import { sql, type Kysely } from "kysely";
import { KYSELY } from "../persistence/tokens";
import type { DatabaseSchema } from "../persistence/schema";
import { DatabaseService } from "../persistence/database.service";
import { appliedMigrationIds, pendingMigrationIds } from "../persistence/migrations";
import { listMigrationBackups, readTextTail } from "../persistence/migration-backup";
import { SettingsService } from "../settings/settings.service";
import { diskSpace } from "../storage/fs-utils";
import { redactText } from "../security/redaction";

const COUNTED_TABLES = [
  "projects",
  "images",
  "vm_instances",
  "project_vm_bindings",
  "conversations",
  "tasks",
  "task_events",
  "task_artifacts",
  "workers",
  "worker_archives",
  "cua_actions",
  "cua_screenshots",
  "human_verifications",
  "notifications",
  "inbox_files",
  "bot_events",
  "bot_outbound",
  "auth_sessions",
  "outbox",
] as const;

const LOW_SPACE_WARNING_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_LOG_BYTES = 256 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const WARNING =
  "本报告可能包含本机路径、日志片段和错误详情，属于潜在敏感信息。导出前请检查内容；它只保存在本机，不会自动上传。";

const packageRequire = createRequire(__filename);

function productVersion(): string {
  try {
    // Works in development (dist -> package root) and in the packaged bundle
    // (dist -> bundle root, which keeps package.json).
    const packageJson = packageRequire(path.join(__dirname, "..", "package.json")) as {
      version?: unknown;
    };
    return typeof packageJson.version === "string" ? packageJson.version : "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function logBytesFromEnv(): number {
  const raw = Number(process.env.AGENT_IN_BOX_DIAGNOSTICS_LOG_BYTES);
  if (!Number.isInteger(raw) || raw < 16 * 1024 || raw > 4 * 1024 * 1024) {
    return DEFAULT_LOG_BYTES;
  }
  return raw;
}

async function fileSize(file: string): Promise<number> {
  const info = await stat(file).catch(() => null);
  return info?.size ?? 0;
}

@Injectable()
export class DiagnosticsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly settings: SettingsService,
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
  ) {}

  async report(): Promise<DiagnosticsReport> {
    const [applied, pending, logReport] = await Promise.all([
      appliedMigrationIds(this.db),
      pendingMigrationIds(this.db),
      this.readLogs(),
    ]);
    const [tableCounts, tasksByStatus, vmsByPower, workersByStatus, imagesByStatus] =
      await Promise.all([
        this.countTables(),
        this.groupCount("tasks", "status"),
        this.groupCount("vm_instances", "power_state"),
        this.groupCount("workers", "status"),
        this.groupCount("images", "status"),
      ]);
    const [pendingOutbox, unreadNotifications, backups, settings, space] = await Promise.all([
      this.countWhere("outbox", "published_at is null"),
      this.countWhere("notifications", "read_at is null and dismissed_at is null"),
      listMigrationBackups(this.database.backupsDirectory),
      this.settings.snapshot(os.totalmem()),
      diskSpace(this.database.dataRoot),
    ]);

    const quickCheckRows = await sql<{ quick_check: string }>`pragma quick_check`.execute(this.db);
    const quickCheck = quickCheckRows.rows[0]?.quick_check ?? "unknown";
    const host = process.env.CONTROL_PLANE_HOST?.trim() || "127.0.0.1";
    const loopbackOnly = LOOPBACK_HOSTS.has(host);

    const checks: DiagnosticsReport["checks"] = [
      {
        name: "SQLite 完整性",
        status: quickCheck === "ok" ? "ok" : "error",
        detail: quickCheck,
      },
      {
        name: "Schema Migration",
        status: pending.length === 0 ? "ok" : "error",
        detail:
          pending.length === 0
            ? `已应用 ${applied.length} 个迁移`
            : `仍有未应用迁移：${pending.join(", ")}`,
      },
      {
        name: "迁移前备份目录",
        status: (await this.writable(this.database.backupsDirectory)) ? "ok" : "warning",
        detail:
          backups.length === 0
            ? this.database.backupsDirectory
            : `${this.database.backupsDirectory}（${backups.length} 个备份）`,
      },
      {
        name: "数据目录空间",
        status:
          space.totalBytes === 0 || space.freeBytes >= LOW_SPACE_WARNING_BYTES ? "ok" : "warning",
        detail: `可用 ${space.freeBytes} / 总计 ${space.totalBytes} 字节`,
      },
      {
        name: "本机回环监听",
        status: loopbackOnly ? "ok" : "error",
        detail: host,
      },
      {
        name: "访问密钥文件",
        status: (await this.accessKeyExists()) ? "ok" : "warning",
        detail: "仅检查存在性，不读取或输出访问密钥",
      },
    ];

    return {
      generatedAt: new Date().toISOString(),
      warning: WARNING,
      product: {
        version: productVersion(),
        protocolVersion: PROTOCOL_VERSION,
        nodeVersion: process.version,
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
      },
      runtime: {
        platform: process.platform,
        architecture: process.arch,
        release: os.release(),
        hostname: os.hostname(),
        dataRoot: this.database.dataRoot,
        dataRootSource: this.database.dataRootSource,
        configPath: this.database.configPath,
        databasePath: this.database.filename,
        logsPath: path.join(path.dirname(this.database.configPath), "logs"),
        loopbackOnly,
      },
      database: {
        sizeBytes: await fileSize(this.database.filename),
        walBytes: await fileSize(`${this.database.filename}-wal`),
        shmBytes: await fileSize(`${this.database.filename}-shm`),
        appliedMigrations: applied,
        pendingMigrations: pending,
        quickCheck,
        tableCounts,
        migrationBackups: backups.map((backup) => ({
          fileName: backup.fileName,
          sizeBytes: backup.sizeBytes,
          sha256: backup.sha256,
          createdAt: backup.createdAt,
        })),
      },
      storage: {
        freeBytes: space.freeBytes,
        totalBytes: space.totalBytes,
      },
      state: {
        tasksByStatus,
        vmsByPower,
        workersByStatus,
        imagesByStatus,
        pendingOutbox,
        unreadNotifications,
      },
      settings: {
        resourcePolicy: settings.resourcePolicy,
        security: settings.security,
        workerLifecycle: settings.workerLifecycle,
        preferredModelProvider: settings.preferredModelProvider,
        credentialsConfigured: settings.credentialsConfigured,
      },
      logs: logReport,
      checks,
    };
  }

  private async countTables(): Promise<Record<string, number>> {
    const entries = await Promise.all(
      COUNTED_TABLES.map(async (table) => {
        const result = await sql<{ count: number }>`
          select count(*) as count from ${sql.table(table)}
        `.execute(this.db);
        return [table, Number(result.rows[0]?.count ?? 0)] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  private async groupCount(table: string, column: string): Promise<Record<string, number>> {
    // Table and column are internal constants, never request input.
    const result = await sql<{ key: string; count: number }>`
      select ${sql.ref(column)} as key, count(*) as count
      from ${sql.table(table)}
      group by ${sql.ref(column)}
      order by ${sql.ref(column)}
    `.execute(this.db);
    return Object.fromEntries(
      result.rows.map((row) => [String(row.key ?? "unknown"), Number(row.count ?? 0)]),
    );
  }

  private async countWhere(table: string, predicate: string): Promise<number> {
    const result = await sql<{ count: number }>`
      select count(*) as count from ${sql.table(table)} where ${sql.raw(predicate)}
    `.execute(this.db);
    return Number(result.rows[0]?.count ?? 0);
  }

  private async writable(directory: string): Promise<boolean> {
    try {
      await access(directory, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async accessKeyExists(): Promise<boolean> {
    const file = path.join(path.dirname(this.database.configPath), "web-access-key");
    return (await stat(file).catch(() => null)) !== null;
  }

  private async readLogs(): Promise<DiagnosticsReport["logs"]> {
    const directory = path.join(path.dirname(this.database.configPath), "logs");
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const files = entries
      .filter((entry) => entry.isFile() && /\.log(?:\.\d+)?$/i.test(entry.name))
      .map((entry) => path.join(directory, entry.name));
    const withTimes = await Promise.all(
      files.map(async (file) => ({
        file,
        time: (await stat(file)).mtimeMs,
      })),
    );
    withTimes.sort((left, right) => left.time - right.time);

    const maxBytes = logBytesFromEnv();
    const perFile = Math.max(16 * 1024, Math.floor(maxBytes / Math.max(1, withTimes.length)));
    const chunks: string[] = [];
    const metadata: DiagnosticsReport["logs"]["files"] = [];
    let truncated = false;
    for (const { file } of withTimes) {
      const tail = await readTextTail(file, perFile);
      metadata.push({
        name: path.basename(file),
        bytes: tail.bytes,
        truncated: tail.truncated,
      });
      truncated ||= tail.truncated;
      if (tail.content) {
        chunks.push(`--- ${path.basename(file)} ---\n${tail.content}`);
      }
    }
    let content = chunks.join("\n");
    if (Buffer.byteLength(content) > maxBytes) {
      const buffer = Buffer.from(content);
      content = buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString("utf8");
      truncated = true;
    }
    return {
      files: metadata,
      // Log lines are free-form, so scrub credential shapes after assembling.
      content: redactText(content),
      truncated,
    };
  }
}
