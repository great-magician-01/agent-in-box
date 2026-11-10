import { Body, Controller, Get, HttpCode, HttpStatus, Post } from "@nestjs/common";
import type {
  StorageCleanupResult,
  StorageMigrationResult,
  StorageReport,
  StorageValidation,
} from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";
import { StorageService } from "./storage.service";

function requestRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PersistenceError("validation_failed", "请求体必须是 JSON 对象");
  }
  return body as Record<string, unknown>;
}

@Controller("api/v1/storage")
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Get()
  report(): Promise<StorageReport> {
    return this.storage.getReport();
  }

  @Post("validate")
  @HttpCode(HttpStatus.OK)
  validate(@Body() body: unknown): Promise<StorageValidation> {
    const input = requestRecord(body);
    return this.storage.validateRoot(input.path);
  }

  @Post("migrate")
  @HttpCode(HttpStatus.OK)
  migrate(@Body() body: unknown): Promise<StorageMigrationResult> {
    const input = requestRecord(body);
    if (typeof input.targetRoot !== "string" || input.targetRoot.trim() === "") {
      throw new PersistenceError("validation_failed", "必须提供 targetRoot");
    }
    return this.storage.migrateTo(input.targetRoot);
  }

  @Post("cleanup-downloads")
  @HttpCode(HttpStatus.OK)
  cleanupDownloads(): Promise<StorageCleanupResult> {
    return this.storage.cleanupDownloads();
  }
}
