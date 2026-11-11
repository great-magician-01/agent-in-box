import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import {
  COMPUTER_ACTION_TYPES,
  type ComputerActionType,
  type CuaPolicy,
  type CuaPolicyUpdateRequest,
  type CuaPolicyView,
  type SecuritySettings,
} from "@agent-in-box/protocol";
import { NotFoundError, PersistenceError } from "../persistence/errors";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import { SettingsService, SETTINGS_KEYS } from "../settings/settings.service";
import { DEFAULT_SECURITY_SETTINGS } from "../settings/defaults";

const ACTION_TYPES = new Set<ComputerActionType>(COMPUTER_ACTION_TYPES);

export const DEFAULT_CUA_POLICY: CuaPolicy = {
  maxSteps: 80,
  maxDurationMs: 15 * 60_000,
  noProgressLimit: 4,
  duplicateActionLimit: 3,
  approvalTimeoutMs: 2 * 60_000,
  approvalActionTypes: [],
  network: { mode: "broker_only", allowedHosts: [] },
  fileExchange: { enabled: true, maxBytes: 256 * 1024 * 1024, allowedRoots: ["/home", "/tmp"] },
  credentials: { allowInGuest: false },
};

/** Sensitive-by-default actions when the global approval setting is enabled. */
export const DEFAULT_SENSITIVE_ACTIONS: ComputerActionType[] = ["type_text", "keypress", "drag"];

@Injectable()
export class CuaPolicyService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    private readonly settings: SettingsService,
  ) {}

  async view(projectId: string): Promise<CuaPolicyView> {
    await this.requireProject(projectId);
    const row = await this.db
      .selectFrom("project_policies")
      .selectAll()
      .where("project_id", "=", projectId)
      .executeTakeFirst();
    const security = await this.security();
    if (!row) {
      return {
        projectId,
        policy: this.defaultPolicy(security),
        source: "default",
        updatedAt: null,
      };
    }
    return {
      projectId,
      policy: this.mergePolicy(parsePolicy(row.policy_json), this.defaultPolicy(security)),
      source: "project",
      updatedAt: row.updated_at,
    };
  }

  /** Effective policy used by the execution layer. Missing project policy means global defaults. */
  async effective(projectId: string): Promise<CuaPolicy> {
    return (await this.view(projectId)).policy;
  }

  async effectiveForTask(taskId: string): Promise<CuaPolicy> {
    const task = await this.db
      .selectFrom("tasks")
      .select("project_id")
      .where("id", "=", taskId)
      .executeTakeFirst();
    if (!task) throw new NotFoundError(`任务不存在：${taskId}`);
    return this.effective(task.project_id);
  }

  async update(projectId: string, input: CuaPolicyUpdateRequest): Promise<CuaPolicyView> {
    await this.requireProject(projectId);
    const security = await this.security();
    const current = await this.view(projectId);
    const next = normalizePolicyInput(input, current.policy);
    const now = nowIso();
    await this.db
      .insertInto("project_policies")
      .values({ project_id: projectId, policy_json: JSON.stringify(next), updated_at: now })
      .onConflict((conflict) =>
        conflict
          .column("project_id")
          .doUpdateSet({ policy_json: JSON.stringify(next), updated_at: now }),
      )
      .execute();
    return {
      projectId,
      policy: this.mergePolicy(next, this.defaultPolicy(security)),
      source: "project",
      updatedAt: now,
    };
  }

  private async security(): Promise<SecuritySettings> {
    return (
      (await this.settings.getJson<SecuritySettings>(SETTINGS_KEYS.security)) ??
      DEFAULT_SECURITY_SETTINGS
    );
  }

  private defaultPolicy(security: SecuritySettings): CuaPolicy {
    return {
      ...DEFAULT_CUA_POLICY,
      network: { ...DEFAULT_CUA_POLICY.network, allowedHosts: [] },
      fileExchange: {
        ...DEFAULT_CUA_POLICY.fileExchange,
        allowedRoots: [...DEFAULT_CUA_POLICY.fileExchange.allowedRoots],
      },
      credentials: { ...DEFAULT_CUA_POLICY.credentials },
      approvalActionTypes: security.requireApprovalForSensitiveActions
        ? [...DEFAULT_SENSITIVE_ACTIONS]
        : [],
    };
  }

  private mergePolicy(stored: Partial<CuaPolicy>, defaults: CuaPolicy): CuaPolicy {
    return {
      ...defaults,
      ...stored,
      network: { ...defaults.network, ...(stored.network ?? {}) },
      fileExchange: { ...defaults.fileExchange, ...(stored.fileExchange ?? {}) },
      credentials: { ...defaults.credentials, ...(stored.credentials ?? {}) },
    };
  }

  private async requireProject(projectId: string): Promise<void> {
    const project = await this.db
      .selectFrom("projects")
      .select("id")
      .where("id", "=", projectId)
      .executeTakeFirst();
    if (!project) throw new NotFoundError(`项目不存在：${projectId}`);
  }
}

function parsePolicy(value: string): Partial<CuaPolicy> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Partial<CuaPolicy>) : {};
  } catch {
    return {};
  }
}

function normalizePolicyInput(input: CuaPolicyUpdateRequest, base: CuaPolicy): CuaPolicy {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new PersistenceError("validation_failed", "策略必须是对象");
  }
  const maxSteps = optionalInteger(input.maxSteps, base.maxSteps, 1, 1000, "maxSteps");
  const maxDurationMs = optionalInteger(
    input.maxDurationMs,
    base.maxDurationMs,
    1_000,
    24 * 60 * 60_000,
    "maxDurationMs",
  );
  const noProgressLimit = optionalInteger(
    input.noProgressLimit,
    base.noProgressLimit,
    2,
    50,
    "noProgressLimit",
  );
  const duplicateActionLimit = optionalInteger(
    input.duplicateActionLimit,
    base.duplicateActionLimit,
    2,
    50,
    "duplicateActionLimit",
  );
  const approvalTimeoutMs = optionalInteger(
    input.approvalTimeoutMs,
    base.approvalTimeoutMs,
    1_000,
    24 * 60 * 60_000,
    "approvalTimeoutMs",
  );
  const approvalActionTypes =
    input.approvalActionTypes === undefined
      ? [...base.approvalActionTypes]
      : normalizeApprovalActions(input.approvalActionTypes);
  const network = normalizeNetwork(input.network, base.network);
  const fileExchange = normalizeFileExchange(input.fileExchange, base.fileExchange);
  const credentials = normalizeCredentials(input.credentials, base.credentials);
  return {
    maxSteps,
    maxDurationMs,
    noProgressLimit,
    duplicateActionLimit,
    approvalTimeoutMs,
    approvalActionTypes,
    network,
    fileExchange,
    credentials,
  };
}

function optionalInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new PersistenceError("validation_failed", `${field} 必须在 ${min}～${max} 范围内`);
  }
  return value as number;
}

function normalizeApprovalActions(value: unknown): ComputerActionType[] {
  if (!Array.isArray(value) || value.length > COMPUTER_ACTION_TYPES.length) {
    throw new PersistenceError("validation_failed", "approvalActionTypes 必须是动作类型数组");
  }
  for (const action of value) {
    if (typeof action !== "string" || !ACTION_TYPES.has(action as ComputerActionType)) {
      throw new PersistenceError("validation_failed", "approvalActionTypes 包含不支持的动作类型");
    }
  }
  return [...new Set(value as ComputerActionType[])];
}

function normalizeNetwork(
  input: Partial<CuaPolicy["network"]> | undefined,
  base: CuaPolicy["network"],
): CuaPolicy["network"] {
  const mode = input?.mode ?? base.mode;
  if (mode !== "broker_only" && mode !== "unrestricted") {
    throw new PersistenceError("validation_failed", "network.mode 无效");
  }
  const allowedHosts = input?.allowedHosts ?? base.allowedHosts;
  if (!Array.isArray(allowedHosts) || allowedHosts.length > 50) {
    throw new PersistenceError("validation_failed", "network.allowedHosts 最多 50 项");
  }
  for (const host of allowedHosts) {
    if (
      typeof host !== "string" ||
      !host.trim() ||
      host.length > 253 ||
      host.includes("/") ||
      host.includes("\\") ||
      host.includes("@") ||
      host.includes("://")
    ) {
      throw new PersistenceError("validation_failed", "network.allowedHosts 包含无效主机名");
    }
  }
  return { mode, allowedHosts: [...new Set(allowedHosts.map((host) => host.trim()))] };
}

function normalizeFileExchange(
  input: Partial<CuaPolicy["fileExchange"]> | undefined,
  base: CuaPolicy["fileExchange"],
): CuaPolicy["fileExchange"] {
  const enabled = input?.enabled ?? base.enabled;
  if (typeof enabled !== "boolean") {
    throw new PersistenceError("validation_failed", "fileExchange.enabled 必须是布尔值");
  }
  const maxBytes = input?.maxBytes ?? base.maxBytes;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 ** 4) {
    throw new PersistenceError("validation_failed", "fileExchange.maxBytes 超出范围");
  }
  const allowedRoots = input?.allowedRoots ?? base.allowedRoots;
  if (!Array.isArray(allowedRoots) || allowedRoots.length > 20) {
    throw new PersistenceError("validation_failed", "fileExchange.allowedRoots 最多 20 项");
  }
  for (const root of allowedRoots) {
    if (
      typeof root !== "string" ||
      !root.startsWith("/") ||
      root.length > 240 ||
      root.split("/").includes("..") ||
      root.includes("\0")
    ) {
      throw new PersistenceError(
        "validation_failed",
        "fileExchange.allowedRoots 必须是安全绝对路径",
      );
    }
  }
  return { enabled, maxBytes, allowedRoots: [...new Set(allowedRoots)] };
}

function normalizeCredentials(
  input: Partial<CuaPolicy["credentials"]> | undefined,
  base: CuaPolicy["credentials"],
): CuaPolicy["credentials"] {
  const allowInGuest = input?.allowInGuest ?? base.allowInGuest;
  if (typeof allowInGuest !== "boolean") {
    throw new PersistenceError("validation_failed", "credentials.allowInGuest 必须是布尔值");
  }
  return { allowInGuest };
}
