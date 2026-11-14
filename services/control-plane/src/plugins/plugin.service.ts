import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import type {
  PluginEnableRequest,
  PluginEnablementView,
  PluginRegisterRequest,
  PluginSessionExtension,
  PluginSessionSnapshot,
  PluginSource,
  PluginVersionStatus,
  PluginVersionView,
} from "@agent-in-box/protocol";
import {
  inspectPluginPackage,
  resolvePluginEntry,
  type InspectedPluginPackage,
} from "@agent-in-box/plugin-runtime";
import type { WorkerPluginPackageSpec } from "@agent-in-box/agent-runtime";
import type { Kysely } from "kysely";
import { DatabaseService } from "../persistence/database.service";
import { NotFoundError, PersistenceError } from "../persistence/errors";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";

@Injectable()
export class PluginService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly database: DatabaseService,
  ) {}

  async list(): Promise<PluginVersionView[]> {
    const rows = await this.db
      .selectFrom("plugin_versions")
      .innerJoin("plugins", "plugins.id", "plugin_versions.plugin_id")
      .selectAll("plugin_versions")
      .select([
        "plugins.display_name",
        "plugins.source",
        "plugin_versions.source as version_source",
      ])
      .orderBy("plugin_versions.created_at", "desc")
      .execute();
    return rows.map((row) => this.versionView(row));
  }

  async enablements(scopeType?: string, scopeId?: string): Promise<PluginEnablementView[]> {
    let query = this.db.selectFrom("plugin_enablements").selectAll();
    if (scopeType) query = query.where("scope_type", "=", scopeType);
    if (scopeId) query = query.where("scope_id", "=", scopeId);
    const rows = await query.orderBy("updated_at", "desc").execute();
    return rows.map((row) => ({
      id: row.id,
      pluginId: row.plugin_id,
      version: row.version,
      scopeType: scopeTypeValue(row.scope_type),
      scopeId: row.scope_id,
      enabled: row.enabled === 1,
      updatedAt: row.updated_at,
    }));
  }

  async inspectTransferredPackage(
    files: Array<{ path: string; dataBase64: string }>,
  ): Promise<{ manifest: Record<string, unknown>; packageSha256: string }> {
    const staging = await this.stageTransfer(files);
    try {
      const inspected = await inspectPluginPackage(staging, transferLimits());
      return {
        manifest: inspected.manifest as unknown as Record<string, unknown>,
        packageSha256: inspected.packageSha256,
      };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async registerTransferredPackage(
    files: Array<{ path: string; dataBase64: string }>,
    testReport: Record<string, unknown>,
  ): Promise<PluginVersionView> {
    const staging = await this.stageTransfer(files);
    try {
      return await this.register({ sourcePath: staging, source: "ai", testReport });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async register(input: PluginRegisterRequest): Promise<PluginVersionView> {
    if (typeof input !== "object" || input === null) {
      throw new PersistenceError("validation_failed", "插件注册参数无效");
    }
    const source = input.source;
    if (source !== "user" && source !== "ai") {
      throw new PersistenceError("validation_failed", "插件来源必须是 user 或 ai");
    }
    if (typeof input.sourcePath !== "string" || !path.isAbsolute(input.sourcePath)) {
      throw new PersistenceError("validation_failed", "插件源目录必须使用绝对路径");
    }
    const inspected = await inspectPluginPackage(input.sourcePath, {
      maxFileBytes: 2 * 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
    });
    if (inspected.manifest.targets.some((target) => target !== "worker")) {
      throw new PersistenceError("validation_failed", "第三方插件首版只允许加载到 Guest Worker");
    }
    if (source === "ai") {
      const report = input.testReport;
      if (
        !report ||
        report.status !== "passed" ||
        report.packageSha256 !== inspected.packageSha256
      ) {
        throw new PersistenceError(
          "validation_failed",
          "AI 插件注册需要与当前包哈希匹配的通过测试记录",
        );
      }
    }

    const pluginId = inspected.manifest.id;
    const version = inspected.manifest.version;
    const existing = await this.versionRow(pluginId, version);
    if (existing) {
      if (existing.package_sha256 !== inspected.packageSha256) {
        throw new PersistenceError(
          "conflict",
          "同一插件版本的内容不可变；修改代码后必须提升版本号",
        );
      }
      return this.versionView(existing);
    }

    const finalRoot = path.join(this.pluginRoot(), pluginId, version);
    const staging = path.join(this.pluginRoot(), ".staging", `${randomUUID()}`);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      await copyInspectedPackage(inspected, staging);
      const copied = await inspectPluginPackage(staging);
      if (copied.packageSha256 !== inspected.packageSha256) {
        throw new PersistenceError("conflict", "插件源目录在导入过程中发生变化，请重试");
      }
      await mkdir(path.dirname(finalRoot), { recursive: true, mode: 0o700 });
      try {
        await rename(staging, finalRoot);
      } catch (error) {
        if (
          ["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
        ) {
          throw new PersistenceError("conflict", "插件版本已被其他请求注册");
        }
        throw error;
      }
      const now = nowIso();
      try {
        await this.db.transaction().execute(async (trx) => {
          await trx
            .insertInto("plugins")
            .values({
              id: pluginId,
              display_name: inspected.manifest.displayName,
              source,
              created_at: now,
              updated_at: now,
            })
            .onConflict((conflict) =>
              conflict.column("id").doUpdateSet({
                display_name: inspected.manifest.displayName,
                updated_at: now,
              }),
            )
            .execute();
          await trx
            .insertInto("plugin_versions")
            .values({
              plugin_id: pluginId,
              version,
              status: "registered",
              manifest_json: JSON.stringify(inspected.manifest),
              package_root: finalRoot,
              package_sha256: inspected.packageSha256,
              source,
              test_report_json: input.testReport ? JSON.stringify(input.testReport) : null,
              error_message: null,
              created_at: now,
              registered_at: now,
            })
            .execute();
        });
      } catch (error) {
        await rm(finalRoot, { recursive: true, force: true });
        throw error;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return this.getVersion(pluginId, version);
  }

  async enable(pluginId: string, input: PluginEnableRequest): Promise<PluginEnablementView> {
    if (
      typeof input !== "object" ||
      input === null ||
      (input.scopeType !== "project" && input.scopeType !== "worker") ||
      typeof input.scopeId !== "string" ||
      !input.scopeId ||
      typeof input.version !== "string"
    ) {
      throw new PersistenceError("validation_failed", "插件启用参数无效");
    }
    await this.assertScope(input.scopeType, input.scopeId);
    const version = await this.versionRow(pluginId, input.version);
    if (!version) throw new NotFoundError("插件版本不存在");
    if (version.status !== "registered") {
      throw new PersistenceError("conflict", "只有已注册且未隔离的插件版本可以启用");
    }
    const inspected = await inspectPluginPackage(version.package_root);
    if (inspected.packageSha256 !== version.package_sha256) {
      await this.quarantine(pluginId, input.version, "插件文件哈希与注册版本不一致");
      throw new PersistenceError("conflict", "插件内容已变化，已隔离该版本");
    }
    const now = nowIso();
    const existing = await this.db
      .selectFrom("plugin_enablements")
      .selectAll()
      .where("plugin_id", "=", pluginId)
      .where("scope_type", "=", input.scopeType)
      .where("scope_id", "=", input.scopeId)
      .executeTakeFirst();
    const id = existing?.id ?? randomUUID();
    if (existing) {
      await this.db
        .updateTable("plugin_enablements")
        .set({
          version: input.version,
          enabled: 1,
          updated_at: now,
        })
        .where("id", "=", existing.id)
        .execute();
    } else {
      await this.db
        .insertInto("plugin_enablements")
        .values({
          id,
          plugin_id: pluginId,
          version: input.version,
          scope_type: input.scopeType,
          scope_id: input.scopeId,
          enabled: 1,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
    return {
      id,
      pluginId,
      version: input.version,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      enabled: true,
      updatedAt: now,
    };
  }

  async disable(
    pluginId: string,
    scopeType: "project" | "worker",
    scopeId: string,
  ): Promise<{ disabled: true }> {
    await this.db
      .updateTable("plugin_enablements")
      .set({ enabled: 0, updated_at: nowIso() })
      .where("plugin_id", "=", pluginId)
      .where("scope_type", "=", scopeType)
      .where("scope_id", "=", scopeId)
      .execute();
    return { disabled: true };
  }

  async snapshot(workerId: string, projectId: string): Promise<PluginSessionSnapshot> {
    const enabled = await this.db
      .selectFrom("plugin_enablements")
      .selectAll()
      .where("enabled", "=", 1)
      .where((builder) =>
        builder.or([
          builder.and([builder("scope_type", "=", "project"), builder("scope_id", "=", projectId)]),
          builder.and([builder("scope_type", "=", "worker"), builder("scope_id", "=", workerId)]),
        ]),
      )
      .execute();
    const extensions: PluginSessionExtension[] = [];
    const selected = new Map<string, (typeof enabled)[number]>();
    for (const item of enabled.sort((left, right) =>
      left.plugin_id.localeCompare(right.plugin_id),
    )) {
      // Worker scope is the explicit override; do not load a project-level copy twice.
      if (item.scope_type === "worker" || !selected.has(item.plugin_id)) {
        selected.set(item.plugin_id, item);
      }
    }
    for (const item of [...selected.values()].sort((left, right) =>
      left.plugin_id.localeCompare(right.plugin_id),
    )) {
      const version = await this.versionRow(item.plugin_id, item.version);
      if (!version || version.status !== "registered") continue;
      const inspected = await inspectPluginPackage(version.package_root);
      if (inspected.packageSha256 !== version.package_sha256) {
        await this.quarantine(item.plugin_id, item.version, "会话启动前发现插件内容哈希变化");
        throw new PersistenceError("conflict", `插件 ${item.plugin_id} 内容变化，已隔离`);
      }
      const entryPath = await resolvePluginEntry(version.package_root, "worker");
      extensions.push({
        pluginId: item.plugin_id,
        version: item.version,
        packageSha256: version.package_sha256,
        target: "worker",
        entryPath:
          inspected.manifest.entrypoints.worker ?? path.relative(version.package_root, entryPath),
      });
    }
    const id = randomUUID();
    const createdAt = nowIso();
    await this.db
      .insertInto("plugin_session_snapshots")
      .values({
        id,
        worker_id: workerId,
        project_id: projectId,
        extensions_json: JSON.stringify(extensions),
        created_at: createdAt,
      })
      .execute();
    return { id, workerId, projectId, extensions, createdAt };
  }

  async packages(snapshot: PluginSessionSnapshot): Promise<WorkerPluginPackageSpec[]> {
    const packages: WorkerPluginPackageSpec[] = [];
    for (const extension of snapshot.extensions) {
      const version = await this.versionRow(extension.pluginId, extension.version);
      if (!version || version.status !== "registered") {
        throw new PersistenceError("conflict", `插件 ${extension.pluginId} 的会话版本不可用`);
      }
      const inspected = await inspectPluginPackage(version.package_root, {
        maxFileBytes: 2 * 1024 * 1024,
        maxTotalBytes: 4 * 1024 * 1024,
      });
      if (inspected.packageSha256 !== extension.packageSha256) {
        await this.quarantine(extension.pluginId, extension.version, "插件同步前发现内容哈希变化");
        throw new PersistenceError("conflict", `插件 ${extension.pluginId} 内容变化，已隔离`);
      }
      packages.push({
        pluginId: extension.pluginId,
        version: extension.version,
        packageSha256: extension.packageSha256,
        entryPath: extension.entryPath,
        files: await Promise.all(
          inspected.files.map(async (file) => ({
            path: file.path,
            dataBase64: (
              await readFile(path.join(inspected.root, ...file.path.split("/")))
            ).toString("base64"),
          })),
        ),
      });
    }
    return packages;
  }

  async snapshotById(id: string): Promise<PluginSessionSnapshot | null> {
    const row = await this.db
      .selectFrom("plugin_session_snapshots")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id,
      workerId: row.worker_id,
      projectId: row.project_id,
      extensions: JSON.parse(row.extensions_json) as PluginSessionExtension[],
      createdAt: row.created_at,
    };
  }

  private async getVersion(pluginId: string, version: string): Promise<PluginVersionView> {
    const row = await this.versionRow(pluginId, version);
    if (!row) throw new NotFoundError("插件版本不存在");
    return this.versionView(row);
  }

  private async versionRow(pluginId: string, version: string) {
    return this.db
      .selectFrom("plugin_versions")
      .innerJoin("plugins", "plugins.id", "plugin_versions.plugin_id")
      .selectAll("plugin_versions")
      .select([
        "plugins.display_name",
        "plugins.source",
        "plugin_versions.source as version_source",
      ])
      .where("plugin_versions.plugin_id", "=", pluginId)
      .where("plugin_versions.version", "=", version)
      .executeTakeFirst();
  }

  private versionView(row: {
    plugin_id: string;
    version: string;
    status: string;
    manifest_json: string;
    package_sha256: string;
    test_report_json: string | null;
    error_message: string | null;
    created_at: string;
    registered_at: string | null;
    display_name: string;
    source: string;
    version_source: string;
  }): PluginVersionView {
    return {
      pluginId: row.plugin_id,
      displayName: row.display_name,
      version: row.version,
      status: row.status as PluginVersionStatus,
      source: row.version_source as PluginSource,
      packageSha256: row.package_sha256,
      manifest: JSON.parse(row.manifest_json) as Record<string, unknown>,
      testReport: row.test_report_json
        ? (JSON.parse(row.test_report_json) as Record<string, unknown>)
        : null,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      registeredAt: row.registered_at,
    };
  }

  private async assertScope(scopeType: "project" | "worker", scopeId: string): Promise<void> {
    const table = scopeType === "project" ? "projects" : "workers";
    const row = await this.db
      .selectFrom(table)
      .select("id")
      .where("id", "=", scopeId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError(`${scopeType === "project" ? "项目" : "Worker"} 不存在`);
  }

  private async quarantine(pluginId: string, version: string, message: string): Promise<void> {
    await this.db
      .updateTable("plugin_versions")
      .set({ status: "quarantined", error_message: message })
      .where("plugin_id", "=", pluginId)
      .where("version", "=", version)
      .execute();
  }

  private async stageTransfer(files: Array<{ path: string; dataBase64: string }>): Promise<string> {
    if (!Array.isArray(files) || files.length < 1 || files.length > 2048) {
      throw new PersistenceError("validation_failed", "插件传输文件数量无效");
    }
    const staging = path.join(this.database.layout.root, "plugin-incoming", randomUUID());
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const seen = new Set<string>();
    let total = 0;
    try {
      for (const file of files) {
        if (
          typeof file.path !== "string" ||
          !isSafeTransferPath(file.path) ||
          seen.has(file.path) ||
          typeof file.dataBase64 !== "string"
        ) {
          throw new PersistenceError("validation_failed", "插件传输包含重复或不安全路径");
        }
        seen.add(file.path);
        const bytes = Buffer.from(file.dataBase64, "base64");
        if (bytes.toString("base64") !== file.dataBase64 || bytes.byteLength > 2 * 1024 * 1024) {
          throw new PersistenceError("validation_failed", "插件传输包含无效 Base64 或超大文件");
        }
        total += bytes.byteLength;
        if (total > 4 * 1024 * 1024) {
          throw new PersistenceError("validation_failed", "插件传输包不能超过 4 MiB");
        }
        const target = path.join(staging, ...file.path.split("/"));
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { flag: "wx", mode: 0o700 });
      }
      return staging;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private pluginRoot(): string {
    return path.join(this.database.layout.root, "plugins");
  }
}

async function copyInspectedPackage(
  inspected: InspectedPluginPackage,
  destination: string,
): Promise<void> {
  for (const file of inspected.files) {
    const source = path.join(inspected.root, ...file.path.split("/"));
    const target = path.join(destination, ...file.path.split("/"));
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size) {
      throw new PersistenceError("conflict", `插件文件在导入过程中变化：${file.path}`);
    }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const bytes = await readFile(source);
    await writeFile(target, bytes, { flag: "wx", mode: 0o700 });
  }
}

function scopeTypeValue(value: string): "project" | "worker" {
  return value === "worker" ? "worker" : "project";
}

function transferLimits(): { maxFileBytes: number; maxTotalBytes: number } {
  return { maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 };
}

function isSafeTransferPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes(":") &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    value.split("/").every((segment) => segment && segment !== "." && segment !== "..")
  );
}
