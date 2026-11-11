import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import type { InboxFileRecord } from "@agent-in-box/protocol";
import { DatabaseService } from "../persistence/database.service";
import { PersistenceError } from "../persistence/errors";
import { KYSELY } from "../persistence/tokens";
import type { DatabaseSchema, InboxFilesTable } from "../persistence/schema";
import { nowIso } from "../persistence/time";

export const INBOX_OPTIONS = Symbol("INBOX_OPTIONS");
export const DEFAULT_INBOX_MAX_BYTES = 256 * 1024 * 1024;
const MAX_NAME_LENGTH = 180;

export interface InboxOptions {
  maxBytes?: number;
  now?: () => Date;
}

export function sanitizeFileName(raw: string): string {
  const decoded = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();
  const base = path
    .basename(decoded.replaceAll("\\", "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  const normalized = base || "dropped-file";
  if (normalized.length <= MAX_NAME_LENGTH) {
    return normalized;
  }
  const extension = path.extname(normalized).slice(0, 20);
  return `${normalized.slice(0, MAX_NAME_LENGTH - extension.length)}${extension}`;
}

@Injectable()
export class InboxService {
  private readonly maxBytes: number;
  private readonly now: () => Date;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly database: DatabaseService,
    @Inject(INBOX_OPTIONS) private readonly options: InboxOptions,
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_INBOX_MAX_BYTES;
    this.now = options.now ?? (() => new Date());
  }

  directory(): string {
    return this.database.layout.inbox;
  }

  maxUploadBytes(): number {
    return this.maxBytes;
  }

  async upload(input: {
    fileName: string;
    contentType: string;
    projectId: string | null;
    stream: Readable;
    declaredBytes?: number | null;
  }): Promise<InboxFileRecord> {
    const name = sanitizeFileName(input.fileName);
    if (input.declaredBytes !== undefined && input.declaredBytes !== null) {
      if (!Number.isFinite(input.declaredBytes) || input.declaredBytes < 0) {
        throw new PersistenceError("validation_failed", "Content-Length 无效");
      }
      if (input.declaredBytes > this.maxBytes) {
        throw new PersistenceError(
          "validation_failed",
          `文件超过单次投递上限 ${Math.floor(this.maxBytes / 1024 / 1024)} MiB`,
        );
      }
    }
    if (input.projectId) {
      const project = await this.db
        .selectFrom("projects")
        .select("id")
        .where("id", "=", input.projectId)
        .executeTakeFirst();
      if (!project) {
        throw new PersistenceError("not_found", `项目不存在：${input.projectId}`);
      }
    }

    await fs.promises.mkdir(this.directory(), { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const storedPath = path.join(this.directory(), `${id}-${name}`);
    const temporary = path.join(this.directory(), `.upload-${id}.tmp`);
    const hash = createHash("sha256");
    let size = 0;
    const output = fs.createWriteStream(temporary, { mode: 0o600 });
    try {
      for await (const chunk of input.stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += buffer.length;
        if (size > this.maxBytes) {
          throw new PersistenceError(
            "validation_failed",
            `文件超过单次投递上限 ${Math.floor(this.maxBytes / 1024 / 1024)} MiB`,
          );
        }
        hash.update(buffer);
        if (!output.write(buffer)) {
          await new Promise<void>((resolve, reject) => {
            const onDrain = (): void => {
              cleanup();
              resolve();
            };
            const onError = (error: Error): void => {
              cleanup();
              reject(error);
            };
            const cleanup = (): void => {
              output.off("drain", onDrain);
              output.off("error", onError);
            };
            output.once("drain", onDrain);
            output.once("error", onError);
          });
        }
      }
      await new Promise<void>((resolve, reject) => {
        output.once("error", reject);
        output.end(resolve);
      });
      await fs.promises.rename(temporary, storedPath);
    } catch (error) {
      output.destroy();
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
      await fs.promises.rm(storedPath, { force: true }).catch(() => undefined);
      throw error;
    }

    const createdAt = nowIso(this.now());
    const contentType = input.contentType?.startsWith("application/")
      ? input.contentType
      : "application/octet-stream";
    try {
      await this.db
        .insertInto("inbox_files")
        .values({
          id,
          original_name: name,
          content_type: contentType,
          size_bytes: size,
          sha256: hash.digest("hex"),
          stored_path: storedPath,
          project_id: input.projectId,
          created_at: createdAt,
          deleted_at: null,
        })
        .execute();
    } catch (error) {
      await fs.promises.rm(storedPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return this.require(id);
  }

  async list(
    input: { projectId?: string | null; limit?: number } = {},
  ): Promise<InboxFileRecord[]> {
    let query = this.db
      .selectFrom("inbox_files")
      .selectAll()
      .where("deleted_at", "is", null)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(Math.max(1, Math.min(500, input.limit ?? 200)));
    if (input.projectId) {
      query = query.where("project_id", "=", input.projectId);
    }
    return (await query.execute()).map(toRecord);
  }

  async stream(id: string): Promise<{ record: InboxFileRecord; stream: fs.ReadStream }> {
    const row = await this.requireRow(id);
    const stream = fs.createReadStream(row.stored_path);
    return { record: toRecord(row), stream };
  }

  async remove(id: string): Promise<InboxFileRecord> {
    const row = await this.requireRow(id);
    await fs.promises.rm(row.stored_path, { force: true }).catch(() => undefined);
    const deletedAt = nowIso(this.now());
    await this.db
      .updateTable("inbox_files")
      .set({ deleted_at: deletedAt })
      .where("id", "=", id)
      .execute();
    return toRecord({ ...row, deleted_at: deletedAt });
  }

  private async require(id: string): Promise<InboxFileRecord> {
    return toRecord(await this.requireRow(id));
  }

  private async requireRow(id: string): Promise<InboxFilesTable> {
    const row = await this.db
      .selectFrom("inbox_files")
      .selectAll()
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) {
      throw new PersistenceError("not_found", `投递文件不存在：${id}`);
    }
    return row;
  }
}

function toRecord(row: InboxFilesTable): InboxFileRecord {
  return {
    id: row.id,
    originalName: row.original_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    projectId: row.project_id,
    createdAt: row.created_at,
  };
}
