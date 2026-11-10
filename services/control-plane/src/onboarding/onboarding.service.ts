import os from "node:os";
import path from "node:path";
import { Injectable } from "@nestjs/common";
import type {
  OnboardingCompleteResult,
  OnboardingState,
  ResourcePolicy,
  SecuritySettings,
  SettingsView,
} from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";
import { HostInspectionService } from "../host/host-inspection.service";
import { SettingsService } from "../settings/settings.service";
import {
  normalizeDisplayName,
  normalizeModelProvider,
  normalizeResourcePolicy,
  normalizeSecuritySettings,
} from "../settings/settings.service";
import { StorageService } from "../storage/storage.service";

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PersistenceError("validation_failed", "请求体必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly settings: SettingsService,
    private readonly storage: StorageService,
    private readonly host: HostInspectionService,
  ) {}

  async state(): Promise<OnboardingState> {
    const configuration = this.storage.configurationStatus();
    return this.settings.onboardingState({
      dataRoot: this.storage.currentRoot(),
      dataRootSource: this.storage.currentSource(),
      totalMemoryBytes: os.totalmem(),
      restartRequired: configuration.restartRequired,
      configuredDataRoot: configuration.configuredRoot,
    });
  }

  async complete(body: unknown): Promise<OnboardingCompleteResult> {
    const input = asRecord(body);
    if (typeof input.dataRoot !== "string" || input.dataRoot.trim() === "") {
      throw new PersistenceError("validation_failed", "必须选择数据根目录");
    }

    const displayName = normalizeDisplayName(input.displayName);
    const resourcePolicy = normalizeResourcePolicy(input.resourcePolicy, os.totalmem());
    const security = normalizeSecuritySettings(input.security);
    const preferredModelProvider = normalizeModelProvider(input.preferredModelProvider);
    const credentialsConfigured = input.credentialsConfigured === true;

    const validation = await this.storage.validateRoot(input.dataRoot);
    if (!validation.ok) {
      throw new PersistenceError("validation_failed", "数据根目录不可用", {
        errors: validation.errors,
      });
    }
    const targetRoot = validation.resolvedPath;

    const inspection = await this.host.inspect(targetRoot);
    if (!inspection.ready) {
      throw new PersistenceError("validation_failed", "宿主机检查未通过", {
        checks: inspection.checks.filter((check) => check.status === "error"),
      });
    }

    const currentRoot = this.storage.currentRoot();
    const moving = !samePath(currentRoot, targetRoot);
    if (moving && this.storage.currentSource() === "environment") {
      throw new PersistenceError(
        "conflict",
        "数据根目录由 AGENT_IN_BOX_DATA_ROOT 管理，不能通过首次启动向导迁移",
      );
    }

    await this.settings.persistOnboarding({
      displayName,
      resourcePolicy,
      security,
      preferredModelProvider,
      credentialsConfigured,
    });

    let migration = null;
    let restartRequired = false;
    try {
      if (moving) {
        migration = await this.storage.migrateTo(targetRoot);
        restartRequired = true;
      } else if (this.storage.currentSource() !== "environment") {
        await this.storage.configureCurrentRoot(targetRoot);
      }
    } catch (error) {
      // The wizard must stay incomplete if the storage move fails. The old
      // database and files are still intact, and the user can retry.
      await this.settings.clearOnboarding().catch(() => undefined);
      throw error;
    }

    const configuration = this.storage.configurationStatus();
    const state = await this.settings.onboardingState({
      dataRoot: moving ? targetRoot : currentRoot,
      dataRootSource: this.storage.currentSource() === "environment" ? "environment" : "config",
      totalMemoryBytes: os.totalmem(),
      restartRequired: configuration.restartRequired,
      configuredDataRoot: configuration.configuredRoot,
    });

    return { state, restartRequired, storageMigration: migration };
  }

  async updateSettings(body: unknown): Promise<OnboardingState> {
    const input = asRecord(body);
    const resourcePolicy =
      input.resourcePolicy === undefined
        ? undefined
        : normalizeResourcePolicy(input.resourcePolicy, os.totalmem());
    const security =
      input.security === undefined ? undefined : normalizeSecuritySettings(input.security);

    await this.settings.updatePreferences({
      ...(resourcePolicy ? { resourcePolicy } : {}),
      ...(security ? { security } : {}),
    });

    return this.state();
  }
}

export type { ResourcePolicy, SecuritySettings, SettingsView };
