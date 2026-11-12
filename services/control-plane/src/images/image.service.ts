import { readFile, stat } from "node:fs/promises";
import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from "@nestjs/common";
import type {
  ImageArtifactManifest,
  ImageCatalog,
  ImageDownloadEvent,
  ImageManifest,
  ImageManifestEntry,
  ImageRecord,
  ImageStatus,
} from "@agent-in-box/protocol";
import type { Kysely } from "kysely";
import { Subject } from "rxjs";
import { DatabaseService } from "../persistence/database.service";
import { NotFoundError, PersistenceError } from "../persistence/errors";
import { toImageRecord } from "../persistence/mappers";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import { DEFAULT_IMAGE_MANIFEST } from "./default-manifest";
import {
  ImageDownloadError,
  ResumableImageDownloader,
  type ImageDownloadProgress,
} from "./resumable-downloader";

export const IMAGE_OPTIONS = Symbol("AGENT_IN_BOX_IMAGE_OPTIONS");

export interface ImageServiceOptions {
  manifestPath?: string;
  fetchImpl?: typeof fetch;
  autoResume?: boolean;
  maxBytes?: number;
}

interface ActiveDownload {
  controller: AbortController;
  promise: Promise<ImageRecord>;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PersistenceError("validation_failed", `镜像 Manifest 缺少 ${field}`);
  }
  return value.trim();
}

function normalizeArtifact(value: unknown, field: string): ImageArtifactManifest {
  if (typeof value !== "object" || value === null) {
    throw new PersistenceError("validation_failed", `${field} 必须是对象`);
  }
  const artifact = value as Partial<ImageArtifactManifest>;
  if (
    typeof artifact.sizeBytes !== "number" ||
    !Number.isSafeInteger(artifact.sizeBytes) ||
    artifact.sizeBytes < 0
  ) {
    throw new PersistenceError("validation_failed", `${field}.sizeBytes 无效`);
  }
  const sha256 = requiredText(artifact.sha256, `${field}.sha256`).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new PersistenceError("validation_failed", `${field}.sha256 无效`);
  }
  return {
    url: requiredText(artifact.url, `${field}.url`),
    fileName: requiredText(artifact.fileName, `${field}.fileName`),
    sizeBytes: artifact.sizeBytes,
    sha256,
  };
}

function normalizeProvisioningProfile(value: unknown, imageId: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new PersistenceError("validation_failed", `镜像 ${imageId} 的 provisioning profile 无效`);
  }
  return value;
}

function normalizeManifest(value: unknown): ImageManifest {
  if (typeof value !== "object" || value === null) {
    throw new PersistenceError("validation_failed", "镜像 Manifest 必须是 JSON 对象");
  }
  const input = value as Partial<ImageManifest>;
  if (
    input.schemaVersion !== 1 ||
    !Array.isArray(input.allowedHosts) ||
    !Array.isArray(input.images)
  ) {
    throw new PersistenceError("validation_failed", "不支持的镜像 Manifest 结构");
  }
  const allowedHosts = input.allowedHosts.map((host) =>
    requiredText(host, "allowedHosts").toLowerCase(),
  );
  if (new Set(allowedHosts).size !== allowedHosts.length || allowedHosts.length === 0) {
    throw new PersistenceError("validation_failed", "镜像来源白名单不能为空或包含重复项");
  }
  const images = input.images.map((value) => {
    if (typeof value !== "object" || value === null) {
      throw new PersistenceError("validation_failed", "images 条目必须是对象");
    }
    const input = value as Partial<ImageManifestEntry>;
    const id = requiredText(input.id, "images.id");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      throw new PersistenceError("validation_failed", `镜像 ID 不安全：${id}`);
    }
    if (input.osFamily !== "linux" && input.osFamily !== "windows") {
      throw new PersistenceError("validation_failed", `镜像 ${id} 的 osFamily 无效`);
    }
    if (input.architecture !== "amd64" && input.architecture !== "arm64") {
      throw new PersistenceError("validation_failed", `镜像 ${id} 的 architecture 无效`);
    }
    return {
      ...normalizeArtifact(input, `images.${id}`),
      id,
      name: requiredText(input.name, `images.${id}.name`),
      osFamily: input.osFamily,
      osVersion: requiredText(input.osVersion, `images.${id}.osVersion`),
      architecture: input.architecture,
      version: requiredText(input.version, `images.${id}.version`),
      ...(input.seed ? { seed: normalizeArtifact(input.seed, `images.${id}.seed`) } : {}),
      ...(input.provisioning !== undefined
        ? { provisioning: normalizeProvisioningProfile(input.provisioning, id) }
        : {}),
    };
  });
  const ids = images.map((image) => image.id);
  const names = images.flatMap((image) => [
    image.fileName,
    ...(image.seed ? [image.seed.fileName] : []),
  ]);
  if (new Set(ids).size !== ids.length || new Set(names).size !== names.length) {
    throw new PersistenceError("validation_failed", "镜像 ID 和工件文件名必须唯一");
  }
  return { schemaVersion: 1, allowedHosts, images };
}

@Injectable()
export class ImageService implements OnModuleInit, OnModuleDestroy {
  private readonly active = new Map<string, ActiveDownload>();
  private readonly eventSubject = new Subject<ImageDownloadEvent>();
  readonly events = this.eventSubject.asObservable();
  private manifest: ImageManifest = DEFAULT_IMAGE_MANIFEST;
  private readonly manifestPath: string;

  constructor(
    private readonly database: DatabaseService,
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    @Optional() @Inject(IMAGE_OPTIONS) private readonly options: ImageServiceOptions = {},
  ) {
    this.manifestPath =
      options.manifestPath ?? process.env.AGENT_IN_BOX_IMAGE_MANIFEST?.trim() ?? "";
  }

  async onModuleInit(): Promise<void> {
    await this.refresh();
    const interrupted = await this.db
      .selectFrom("images")
      .select("id")
      .where("status", "in", ["downloading", "verifying"])
      .execute();
    for (const row of interrupted) {
      await this.db
        .updateTable("images")
        .set({
          status: "not_downloaded",
          error_code: "interrupted",
          error_message: "应用曾中断下载；正在从已保存的断点恢复",
          updated_at: nowIso(),
        })
        .where("id", "=", row.id)
        .execute();
      if (this.options.autoResume !== false) {
        void this.download(row.id).catch(() => undefined);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    const downloads = [...this.active.values()];
    for (const download of downloads) {
      download.controller.abort();
    }
    await Promise.allSettled(downloads.map((download) => download.promise));
    this.eventSubject.complete();
  }

  async refresh(): Promise<ImageCatalog> {
    if (this.manifestPath) {
      const info = await stat(this.manifestPath);
      if (!info.isFile() || info.size > 1024 * 1024) {
        throw new PersistenceError(
          "validation_failed",
          "镜像 Manifest 必须是小于 1 MiB 的普通文件",
        );
      }
      this.manifest = normalizeManifest(JSON.parse(await readFile(this.manifestPath, "utf8")));
    } else {
      this.manifest = normalizeManifest(DEFAULT_IMAGE_MANIFEST);
    }

    for (const entry of this.manifest.images) {
      const existing = await this.db
        .selectFrom("images")
        .selectAll()
        .where("id", "=", entry.id)
        .executeTakeFirst();
      const encoded = JSON.stringify(entry);
      if (existing?.manifest_json && existing.manifest_json !== encoded) {
        throw new PersistenceError(
          "conflict",
          `镜像 ${entry.id} 的内容发生变化；更新必须采用新的版本 ID 和文件名`,
        );
      }
      if (!existing) {
        const now = nowIso();
        await this.db
          .insertInto("images")
          .values({
            id: entry.id,
            name: entry.name,
            os_family: entry.osFamily,
            os_version: entry.osVersion,
            architecture: entry.architecture,
            version: entry.version,
            status: "not_downloaded",
            size_bytes: entry.sizeBytes + (entry.seed?.sizeBytes ?? 0),
            checksum: entry.sha256,
            local_path: null,
            created_at: now,
            verified_at: null,
            source_url: entry.url,
            file_name: entry.fileName,
            downloaded_bytes: 0,
            error_code: null,
            error_message: null,
            updated_at: now,
            seed_local_path: null,
            manifest_json: encoded,
            provisioning_profile: entry.provisioning ?? null,
          })
          .execute();
      }
    }
    return this.list();
  }

  async list(): Promise<ImageCatalog> {
    const rows = await this.db
      .selectFrom("images")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("id", "asc")
      .execute();
    return {
      source: this.manifestPath || "builtin:phase0-linux-baseline",
      allowedHosts: this.manifest.allowedHosts,
      items: rows.map(toImageRecord),
    };
  }

  async get(id: string): Promise<ImageRecord> {
    const row = await this.db
      .selectFrom("images")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      throw new NotFoundError(`镜像不存在：${id}`);
    }
    return toImageRecord(row);
  }

  download(id: string): Promise<ImageRecord> {
    const existing = this.active.get(id);
    if (existing) {
      return existing.promise;
    }
    const controller = new AbortController();
    const promise = this.performDownload(id, controller.signal).finally(() => {
      if (this.active.get(id)?.promise === promise) {
        this.active.delete(id);
      }
    });
    this.active.set(id, { controller, promise });
    return promise;
  }

  async cancel(id: string): Promise<ImageRecord> {
    const image = await this.get(id);
    const active = this.active.get(id);
    if (active) {
      active.controller.abort();
      await active.promise.catch(() => undefined);
      return this.get(id);
    }
    if (image.status === "downloading" || image.status === "verifying") {
      await this.setState(id, "cancelled", {
        errorCode: "download_cancelled",
        errorMessage: "下载已取消，可稍后从断点继续",
      });
      return this.get(id);
    }
    if (image.status !== "available") {
      return this.setState(id, "cancelled", {
        errorCode: "download_cancelled",
        errorMessage: "尚未开始下载",
      });
    }
    throw new PersistenceError("conflict", "已可用镜像不需要取消");
  }

  private async persistedEntry(id: string): Promise<ImageManifestEntry> {
    const row = await this.db
      .selectFrom("images")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      throw new NotFoundError(`镜像不存在：${id}`);
    }
    const current = this.manifest.images.find((entry) => entry.id === id);
    if (current) {
      return current;
    }
    if (!row.manifest_json) {
      throw new PersistenceError("unavailable", "该镜像没有可恢复的 Manifest");
    }
    return normalizeManifest({
      schemaVersion: 1,
      allowedHosts: this.manifest.allowedHosts,
      images: [JSON.parse(row.manifest_json)],
    }).images[0]!;
  }

  private async performDownload(id: string, signal: AbortSignal): Promise<ImageRecord> {
    const initial = await this.get(id);
    if (initial.status === "available") {
      return initial;
    }
    const entry = await this.persistedEntry(id);
    const downloader = new ResumableImageDownloader(this.database.layout.images, {
      allowedHosts: this.manifest.allowedHosts,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.maxBytes !== undefined ? { maxBytes: this.options.maxBytes } : {}),
    });
    let actualSeedBytes = 0;
    await this.setState(id, "downloading", { errorCode: null, errorMessage: null });
    try {
      const base = await downloader.download(entry, {
        signal,
        onVerifying: async () => {
          await this.setState(id, "verifying");
        },
        onProgress: (progress) => this.progress(id, progress, 0),
      });
      let seedPath: string | null = null;
      if (entry.seed) {
        await this.setState(id, "downloading");
        const seed = await downloader.download(entry.seed, {
          signal,
          onVerifying: async () => {
            await this.setState(id, "verifying");
          },
          onProgress: (progress) => this.progress(id, progress, base.sizeBytes),
        });
        seedPath = seed.path;
        actualSeedBytes = seed.sizeBytes;
      }
      const now = nowIso();
      await this.db
        .updateTable("images")
        .set({
          status: "available",
          size_bytes: base.sizeBytes + actualSeedBytes,
          downloaded_bytes: base.sizeBytes + actualSeedBytes,
          local_path: base.path,
          seed_local_path: seedPath,
          verified_at: now,
          updated_at: now,
          error_code: null,
          error_message: null,
        })
        .where("id", "=", id)
        .execute();
      const available = await this.get(id);
      this.emit(available);
      return available;
    } catch (error) {
      const cancelled =
        signal.aborted ||
        (error instanceof ImageDownloadError && error.code === "download_cancelled");
      const status: ImageStatus = cancelled ? "cancelled" : "failed";
      const code = cancelled
        ? "download_cancelled"
        : error instanceof ImageDownloadError
          ? error.code
          : "download_failed";
      const message = cancelled
        ? "下载已取消，已保留可续传数据"
        : error instanceof Error
          ? error.message
          : String(error);
      await this.setState(id, status, { errorCode: code, errorMessage: message });
      if (cancelled) {
        return this.get(id);
      }
      throw error;
    }
  }

  private async progress(
    id: string,
    progress: ImageDownloadProgress,
    baseOffset: number,
  ): Promise<void> {
    const now = nowIso();
    await this.db
      .updateTable("images")
      .set({
        status: "downloading",
        downloaded_bytes: baseOffset + progress.downloadedBytes,
        updated_at: now,
        error_code: null,
        error_message: null,
      })
      .where("id", "=", id)
      .execute();
    const image = await this.get(id);
    this.emit(image, baseOffset + progress.totalBytes);
  }

  private async setState(
    id: string,
    status: ImageStatus,
    errors?: { errorCode?: string | null; errorMessage?: string | null },
  ): Promise<ImageRecord> {
    await this.db
      .updateTable("images")
      .set({
        status,
        updated_at: nowIso(),
        ...(errors
          ? { error_code: errors.errorCode ?? null, error_message: errors.errorMessage ?? null }
          : {}),
      })
      .where("id", "=", id)
      .execute();
    const image = await this.get(id);
    this.emit(image);
    return image;
  }

  private emit(image: ImageRecord, totalBytes = image.sizeBytes): void {
    this.eventSubject.next({
      imageId: image.id,
      status: image.status,
      downloadedBytes: image.downloadedBytes,
      totalBytes,
      errorCode: image.errorCode,
      errorMessage: image.errorMessage,
      occurredAt: nowIso(),
    });
  }
}
