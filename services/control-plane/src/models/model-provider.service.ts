import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Kysely } from "kysely";
import type {
  ModelDefinition,
  ModelInputModality,
  ModelProviderUpsert,
  ModelProviderView,
  WorkerModelApi,
} from "@agent-in-box/protocol";
import { NotFoundError, PersistenceError } from "../persistence/errors";
import type { DatabaseSchema } from "../persistence/schema";
import { nowIso } from "../persistence/time";
import { KYSELY } from "../persistence/tokens";
import { SettingsService } from "../settings/settings.service";

export interface ResolvedModel {
  provider: ModelProviderView;
  model: ModelDefinition;
}

@Injectable()
export class ModelProviderService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DatabaseSchema>,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  async list(): Promise<ModelProviderView[]> {
    const rows = await this.db
      .selectFrom("model_providers")
      .selectAll()
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(toView);
  }

  async get(id: string): Promise<ModelProviderView> {
    const row = await this.db
      .selectFrom("model_providers")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) throw new NotFoundError(`模型 Provider 不存在：${id}`);
    return toView(row);
  }

  async upsert(id: string, input: ModelProviderUpsert): Promise<ModelProviderView> {
    const providerId = normalizeProviderId(id);
    const baseUrl = normalizeBaseUrl(input?.baseUrl);
    const api = normalizeApi(input?.api);
    const credentialProviderId = normalizeProviderId(input?.credentialProviderId);
    const models = normalizeModels(input?.models);
    const enabled = input?.enabled !== false;
    const now = nowIso();
    await this.db
      .insertInto("model_providers")
      .values({
        id: providerId,
        base_url: baseUrl,
        api,
        credential_provider_id: credentialProviderId,
        models_json: JSON.stringify(models),
        enabled: enabled ? 1 : 0,
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet({
          base_url: baseUrl,
          api,
          credential_provider_id: credentialProviderId,
          models_json: JSON.stringify(models),
          enabled: enabled ? 1 : 0,
          updated_at: now,
        }),
      )
      .execute();
    return this.get(providerId);
  }

  async resolve(
    providerId?: string,
    modelId?: string,
    scope: "worker" | "router" = "worker",
  ): Promise<ResolvedModel> {
    const providers = (await this.list()).filter((provider) => provider.enabled);
    let provider = providerId
      ? providers.find((candidate) => candidate.id === providerId)
      : undefined;
    let selectedModel = modelId;
    if (!provider && !providerId) {
      const selection = (await this.settings?.modelSelection())?.[scope] ?? null;
      if (selection) {
        provider = providers.find((candidate) => candidate.id === selection.providerId);
        if (!provider) {
          throw new PersistenceError(
            "validation_failed",
            `已选择的模型 Provider 不可用或已停用：${selection.providerId}`,
          );
        }
        selectedModel = modelId ?? selection.model;
      }
    }
    if (!provider) {
      if (providerId) {
        throw new PersistenceError("validation_failed", `模型 Provider 不可用：${providerId}`);
      }
      provider = providers[0];
    }
    if (!provider) {
      throw new PersistenceError("validation_failed", "尚未配置可用的模型 Provider");
    }
    const model = selectedModel
      ? provider.models.find((candidate) => candidate.id === selectedModel)
      : provider.models[0];
    if (!model) {
      throw new PersistenceError(
        "validation_failed",
        `模型 ${selectedModel ?? ""} 不在 Provider ${provider.id} 的白名单中`,
      );
    }
    return { provider, model };
  }

  async validateSelection(selection: {
    providerId: string;
    model: string;
  }): Promise<ResolvedModel> {
    return this.resolve(selection.providerId, selection.model, "worker");
  }
}

function toView(row: {
  id: string;
  base_url: string;
  api: string;
  credential_provider_id: string;
  models_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}): ModelProviderView {
  return {
    id: row.id,
    baseUrl: row.base_url,
    api: normalizeApi(row.api),
    credentialProviderId: row.credential_provider_id,
    models: JSON.parse(row.models_json) as ModelDefinition[],
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeProviderId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(value)) {
    throw new PersistenceError("validation_failed", "Provider 标识格式无效");
  }
  return value;
}

function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PersistenceError("validation_failed", "Provider baseUrl 不能为空");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PersistenceError("validation_failed", "Provider baseUrl 无效");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new PersistenceError(
      "validation_failed",
      "Provider 必须使用 HTTPS；仅本机回环地址允许 HTTP，且不能包含凭据、查询或锚点",
    );
  }
  return value.replace(/\/$/, "");
}

function normalizeApi(value: unknown): WorkerModelApi {
  if (value !== "openai-completions" && value !== "anthropic-messages") {
    throw new PersistenceError("validation_failed", "Provider API 类型不受支持");
  }
  return value;
}

function normalizeModels(value: unknown): ModelDefinition[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new PersistenceError("validation_failed", "模型白名单必须包含 1～50 个模型");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new PersistenceError("validation_failed", "模型定义无效");
    }
    const model = item as Record<string, unknown>;
    if (
      typeof model.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model.id) ||
      seen.has(model.id)
    ) {
      throw new PersistenceError("validation_failed", "模型 ID 无效或重复");
    }
    seen.add(model.id);
    if (
      (model.name !== undefined && (typeof model.name !== "string" || model.name.length > 200)) ||
      (model.reasoning !== undefined && typeof model.reasoning !== "boolean")
    ) {
      throw new PersistenceError("validation_failed", "模型名称或 reasoning 配置无效");
    }
    const input = normalizeModelInput(model.input);
    return {
      id: model.id,
      ...(typeof model.name === "string" ? { name: model.name } : {}),
      ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
      ...(input ? { input } : {}),
    };
  });
}

function normalizeModelInput(value: unknown): ModelInputModality[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    throw new PersistenceError("validation_failed", "模型 input 必须包含 text 或 image");
  }
  const allowed = new Set<ModelInputModality>(["text", "image"]);
  const seen = new Set<ModelInputModality>();
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item as ModelInputModality)) {
      throw new PersistenceError("validation_failed", "模型 input 只支持 text 和 image");
    }
    seen.add(item as ModelInputModality);
  }
  if (!seen.has("text")) {
    throw new PersistenceError("validation_failed", "模型 input 必须包含 text");
  }
  return [...seen];
}
