import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import type {
  LocalUserRecord,
  OnboardingState,
  ResourcePolicy,
  SecuritySettings,
  WorkerLifecyclePolicy,
} from "@agent-in-box/protocol";
import { nowIso } from "../persistence/time";
import { PersistenceError } from "../persistence/errors";
import { KYSELY } from "../persistence/tokens";
import type { DatabaseExecutor } from "../persistence/executor";
import type { DatabaseSchema } from "../persistence/schema";
import {
  DEFAULT_SECURITY_SETTINGS,
  DEFAULT_WORKER_LIFECYCLE_POLICY,
  MAX_WORKER_IDLE_TIMEOUT_MS,
  MIN_HOST_RESERVE_BYTES,
  MIN_WORKER_IDLE_TIMEOUT_MS,
  defaultResourcePolicy,
} from "./defaults";

export const SETTINGS_KEYS = {
  onboarding: "onboarding",
  resourcePolicy: "resourcePolicy",
  security: "security",
  workerLifecycle: "workerLifecycle",
  preferredModelProvider: "preferredModelProvider",
  credentialsConfigured: "credentialsConfigured",
} as const;

export interface OnboardingSettings {
  completedAt: string | null;
}

export interface LocalUserUpsert {
  displayName: string;
}

export interface SettingsSnapshot {
  onboarding: OnboardingSettings | null;
  resourcePolicy: ResourcePolicy;
  security: SecuritySettings;
  workerLifecycle: WorkerLifecyclePolicy;
  preferredModelProvider: string | null;
  credentialsConfigured: boolean;
  localUser: LocalUserRecord | null;
}

const LOCAL_ADMIN_ID = "local-admin";
const MAX_DISPLAY_NAME_LENGTH = 60;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function normalizeDisplayName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new PersistenceError("validation_failed", "显示名称必须是字符串");
  }
  const value = raw.trim();
  if (value.length < 1 || value.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new PersistenceError(
      "validation_failed",
      `显示名称长度必须在 1 到 ${MAX_DISPLAY_NAME_LENGTH} 个字符之间`,
    );
  }
  return value;
}

export function normalizeModelProvider(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  if (typeof raw !== "string" || !PROVIDER_ID_PATTERN.test(raw)) {
    throw new PersistenceError("validation_failed", "模型 Provider 标识格式无效");
  }
  return raw;
}

export function normalizeResourcePolicy(raw: unknown, totalMemoryBytes: number): ResourcePolicy {
  if (typeof raw !== "object" || raw === null) {
    throw new PersistenceError("validation_failed", "资源策略缺失");
  }
  const input = raw as Record<string, unknown>;

  const hostReserveBytes = input.hostReserveBytes;
  if (
    typeof hostReserveBytes !== "number" ||
    !Number.isFinite(hostReserveBytes) ||
    !Number.isInteger(hostReserveBytes) ||
    hostReserveBytes < 0
  ) {
    throw new PersistenceError("validation_failed", "Host Reserve 必须是非负整数字节数");
  }
  if (hostReserveBytes > 0 && hostReserveBytes < MIN_HOST_RESERVE_BYTES) {
    throw new PersistenceError(
      "validation_failed",
      `Host Reserve 至少为 ${Math.round(MIN_HOST_RESERVE_BYTES / 1024 / 1024)} MiB`,
    );
  }
  if (totalMemoryBytes > 0 && hostReserveBytes >= totalMemoryBytes) {
    throw new PersistenceError("validation_failed", "Host Reserve 不能超过宿主机物理内存");
  }

  const autoStartPolicy = input.autoStartPolicy;
  if (autoStartPolicy !== "manual" && autoStartPolicy !== "when_needed") {
    throw new PersistenceError("validation_failed", "自动启动策略无效");
  }

  return { hostReserveBytes, autoStartPolicy };
}

export function normalizeSecuritySettings(raw: unknown): SecuritySettings {
  if (typeof raw !== "object" || raw === null) {
    throw new PersistenceError("validation_failed", "安全设置缺失");
  }
  const input = raw as Record<string, unknown>;
  if (typeof input.requireApprovalForSensitiveActions !== "boolean") {
    throw new PersistenceError("validation_failed", "敏感操作审批设置无效");
  }
  return {
    requireApprovalForSensitiveActions: input.requireApprovalForSensitiveActions,
  };
}

export function normalizeWorkerLifecyclePolicy(raw: unknown): WorkerLifecyclePolicy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PersistenceError("validation_failed", "Worker 空闲归档策略缺失");
  }
  const input = raw as Record<string, unknown>;
  if (typeof input.autoArchiveEnabled !== "boolean") {
    throw new PersistenceError("validation_failed", "Worker 自动归档开关无效");
  }
  if (
    typeof input.idleTimeoutMs !== "number" ||
    !Number.isInteger(input.idleTimeoutMs) ||
    input.idleTimeoutMs < MIN_WORKER_IDLE_TIMEOUT_MS ||
    input.idleTimeoutMs > MAX_WORKER_IDLE_TIMEOUT_MS
  ) {
    throw new PersistenceError(
      "validation_failed",
      `Worker 空闲超时必须为 ${MIN_WORKER_IDLE_TIMEOUT_MS}～${MAX_WORKER_IDLE_TIMEOUT_MS} ms 的整数`,
    );
  }
  return {
    autoArchiveEnabled: input.autoArchiveEnabled,
    idleTimeoutMs: input.idleTimeoutMs,
  };
}

@Injectable()
export class SettingsService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>) {}

  async getJson<T>(key: string, executor: DatabaseExecutor = this.db): Promise<T | undefined> {
    const row = await executor
      .selectFrom("app_settings")
      .select(["value_json"])
      .where("key", "=", key)
      .executeTakeFirst();
    if (!row) {
      return undefined;
    }
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      throw new PersistenceError("internal_error", `设置 ${key} 的内容已损坏`);
    }
  }

  async setJson(key: string, value: unknown, executor: DatabaseExecutor = this.db): Promise<void> {
    const now = nowIso();
    const valueJson = JSON.stringify(value);
    await executor
      .insertInto("app_settings")
      .values({ key, value_json: valueJson, updated_at: now })
      .onConflict((conflict) =>
        conflict.column("key").doUpdateSet({ value_json: valueJson, updated_at: now }),
      )
      .execute();
  }

  async delete(key: string, executor: DatabaseExecutor = this.db): Promise<void> {
    await executor.deleteFrom("app_settings").where("key", "=", key).execute();
  }

  async snapshot(totalMemoryBytes: number): Promise<SettingsSnapshot> {
    const [
      onboarding,
      resourcePolicy,
      security,
      workerLifecycle,
      preferredModelProvider,
      credentialsConfigured,
    ] = await Promise.all([
      this.getJson<OnboardingSettings>(SETTINGS_KEYS.onboarding),
      this.getJson<ResourcePolicy>(SETTINGS_KEYS.resourcePolicy),
      this.getJson<SecuritySettings>(SETTINGS_KEYS.security),
      this.getJson<WorkerLifecyclePolicy>(SETTINGS_KEYS.workerLifecycle),
      this.getJson<string>(SETTINGS_KEYS.preferredModelProvider),
      this.getJson<boolean>(SETTINGS_KEYS.credentialsConfigured),
    ]);

    return {
      onboarding: onboarding ?? null,
      resourcePolicy: resourcePolicy ?? defaultResourcePolicy(totalMemoryBytes),
      security: security ?? DEFAULT_SECURITY_SETTINGS,
      workerLifecycle: workerLifecycle ?? DEFAULT_WORKER_LIFECYCLE_POLICY,
      preferredModelProvider: preferredModelProvider ?? null,
      credentialsConfigured: credentialsConfigured ?? false,
      localUser: await this.getLocalAdmin(),
    };
  }

  async workerLifecyclePolicy(): Promise<WorkerLifecyclePolicy> {
    return (
      (await this.getJson<WorkerLifecyclePolicy>(SETTINGS_KEYS.workerLifecycle)) ??
      DEFAULT_WORKER_LIFECYCLE_POLICY
    );
  }

  async getLocalAdmin(executor: DatabaseExecutor = this.db): Promise<LocalUserRecord | null> {
    const row = await executor
      .selectFrom("local_users")
      .selectAll()
      .where("role", "=", "admin")
      .orderBy("created_at", "asc")
      .executeTakeFirst();
    return row
      ? {
          id: row.id,
          displayName: row.display_name,
          role: "admin",
          createdAt: row.created_at,
          lastActiveAt: row.last_active_at,
        }
      : null;
  }

  async upsertLocalAdmin(
    displayName: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<LocalUserRecord> {
    const existing = await executor
      .selectFrom("local_users")
      .selectAll()
      .where("role", "=", "admin")
      .orderBy("created_at", "asc")
      .executeTakeFirst();
    const now = nowIso();

    if (existing) {
      await executor
        .updateTable("local_users")
        .set({ display_name: displayName, last_active_at: now })
        .where("id", "=", existing.id)
        .execute();
      return {
        id: existing.id,
        displayName,
        role: "admin",
        createdAt: existing.created_at,
        lastActiveAt: now,
      };
    }

    const user: LocalUserRecord = {
      id: LOCAL_ADMIN_ID,
      displayName,
      role: "admin",
      createdAt: now,
      lastActiveAt: now,
    };
    await executor
      .insertInto("local_users")
      .values({
        id: user.id,
        display_name: user.displayName,
        role: user.role,
        created_at: user.createdAt,
        last_active_at: user.lastActiveAt,
      })
      .execute();
    return user;
  }

  async onboardingState(input: {
    dataRoot: string;
    dataRootSource: OnboardingState["dataRootSource"];
    totalMemoryBytes: number;
    restartRequired?: boolean;
    configuredDataRoot?: string | null;
  }): Promise<OnboardingState> {
    const snapshot = await this.snapshot(input.totalMemoryBytes);
    const completedAt = snapshot.onboarding?.completedAt ?? null;
    return {
      required: completedAt === null,
      completedAt,
      dataRoot: input.dataRoot,
      dataRootSource: input.dataRootSource,
      restartRequired: input.restartRequired ?? false,
      configuredDataRoot: input.configuredDataRoot ?? null,
      resourcePolicy: snapshot.resourcePolicy,
      security: snapshot.security,
      localUser: snapshot.localUser,
      preferredModelProvider: snapshot.preferredModelProvider,
      credentialsConfigured: snapshot.credentialsConfigured,
    };
  }

  async persistOnboarding(input: {
    displayName: string;
    resourcePolicy: ResourcePolicy;
    security: SecuritySettings;
    preferredModelProvider: string | null;
    credentialsConfigured: boolean;
  }): Promise<{ completedAt: string; user: LocalUserRecord }> {
    return this.db.transaction().execute(async (trx) => {
      const completedAt = nowIso();
      const user = await this.upsertLocalAdmin(input.displayName, trx);
      await this.setJson(SETTINGS_KEYS.onboarding, { completedAt }, trx);
      await this.setJson(SETTINGS_KEYS.resourcePolicy, input.resourcePolicy, trx);
      await this.setJson(SETTINGS_KEYS.security, input.security, trx);
      await this.setJson(SETTINGS_KEYS.preferredModelProvider, input.preferredModelProvider, trx);
      await this.setJson(SETTINGS_KEYS.credentialsConfigured, input.credentialsConfigured, trx);
      return { completedAt, user };
    });
  }

  async clearOnboarding(): Promise<void> {
    await this.setJson(SETTINGS_KEYS.onboarding, { completedAt: null });
  }

  async updatePreferences(input: {
    resourcePolicy?: ResourcePolicy;
    security?: SecuritySettings;
    workerLifecycle?: WorkerLifecyclePolicy;
  }): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      if (input.resourcePolicy) {
        await this.setJson(SETTINGS_KEYS.resourcePolicy, input.resourcePolicy, trx);
      }
      if (input.security) {
        await this.setJson(SETTINGS_KEYS.security, input.security, trx);
      }
      if (input.workerLifecycle) {
        await this.setJson(SETTINGS_KEYS.workerLifecycle, input.workerLifecycle, trx);
      }
    });
  }
}
