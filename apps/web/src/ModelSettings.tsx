/* eslint-disable react-hooks/set-state-in-effect -- settings load from server snapshots */
import { useCallback, useEffect, useState } from "react";
import type {
  DesktopBridge,
  DesktopCredentialStatus,
  ModelConfigurationUpdate,
  ModelConfigurationView,
  ModelDefinition,
  ModelProviderView,
  ModelSelection,
  WorkerModelApi,
} from "@agent-in-box/protocol";
import { api } from "./api";
import { credentialStatus } from "./desktop";
import { CUSTOM_PRESET_ID, PROVIDER_PRESETS } from "./provider-presets";

interface ModelSettingsProps {
  bridge: DesktopBridge | null;
  revision?: number;
  onChanged?(): void;
}

const EMPTY_MODELS: ModelDefinition[] = [{ id: "" }];

interface ProviderDraft {
  id: string;
  baseUrl: string;
  api: WorkerModelApi;
  credentialProviderId: string;
  models: ModelDefinition[];
  enabled: boolean;
}

function emptyDraft(): ProviderDraft {
  return {
    id: "",
    baseUrl: "",
    api: "openai-completions",
    credentialProviderId: "",
    models: [...EMPTY_MODELS],
    enabled: true,
  };
}

function draftFromProvider(provider: ModelProviderView): ProviderDraft {
  return {
    id: provider.id,
    baseUrl: provider.baseUrl,
    api: provider.api,
    credentialProviderId: provider.credentialProviderId,
    models: provider.models.map((model) => ({ ...model })),
    enabled: provider.enabled,
  };
}

function selectionFrom(providerId: string, model: string): ModelSelection | null {
  return providerId && model ? { providerId, model } : null;
}

export function ModelSettings({
  bridge,
  revision = 0,
  onChanged,
}: ModelSettingsProps): React.JSX.Element {
  const [configuration, setConfiguration] = useState<ModelConfigurationView | null>(null);
  const [credentials, setCredentials] = useState<DesktopCredentialStatus | null>(null);
  const [draft, setDraft] = useState<ProviderDraft>(emptyDraft);
  const [workerProvider, setWorkerProvider] = useState("");
  const [workerModel, setWorkerModel] = useState("");
  const [routerProvider, setRouterProvider] = useState("");
  const [routerModel, setRouterModel] = useState("");
  const [routerRunning, setRouterRunning] = useState(false);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyConfiguration = useCallback((next: ModelConfigurationView): void => {
    setConfiguration(next);
    const worker = next.selection.worker ?? fallbackSelection(next.providers);
    const router = next.selection.router ?? fallbackSelection(next.providers);
    setWorkerProvider(worker?.providerId ?? "");
    setWorkerModel(worker?.model ?? "");
    setRouterProvider(router?.providerId ?? "");
    setRouterModel(router?.model ?? "");
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [next, credentialState, routerView] = await Promise.all([
        api.modelConfiguration(),
        credentialStatus(bridge).catch(() => null),
        api.router().catch(() => null),
      ]);
      applyConfiguration(next);
      setCredentials(credentialState);
      setRouterRunning(routerView?.status === "running");
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [applyConfiguration, bridge]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  function updateDraft(patch: Partial<ProviderDraft>): void {
    setDraft((current) => {
      const next = { ...current, ...patch };
      // Keep the credential slot in sync with the provider id unless the user
      // deliberately pointed it somewhere else.
      if (
        patch.id !== undefined &&
        (current.credentialProviderId === "" || current.credentialProviderId === current.id)
      ) {
        next.credentialProviderId = patch.id;
      }
      return next;
    });
  }

  function applyPreset(presetId: string): void {
    const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    setDraft({
      id: preset.id,
      baseUrl: preset.baseUrl,
      api: preset.api,
      credentialProviderId: preset.id,
      models: preset.models.map((model) => ({ ...model })),
      enabled: true,
    });
  }

  function updateModel(index: number, patch: Partial<ModelDefinition>): void {
    setDraft((current) => ({
      ...current,
      models: current.models.map((model, modelIndex) =>
        modelIndex === index ? { ...model, ...patch } : model,
      ),
    }));
  }

  async function saveProvider(): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const models = draft.models
        .map((model) => ({
          id: model.id.trim(),
          ...(model.name?.trim() ? { name: model.name.trim() } : {}),
          ...(model.reasoning === true ? { reasoning: true } : {}),
          ...(model.input ? { input: model.input } : {}),
        }))
        .filter((model) => model.id.length > 0);
      const credentialProviderId = draft.credentialProviderId.trim() || draft.id.trim();
      if (!draft.id.trim() || !draft.baseUrl.trim() || !credentialProviderId) {
        throw new Error("Provider ID、Base URL 和凭据 Provider ID 不能为空");
      }
      if (/\{[^}]+\}/.test(draft.baseUrl)) {
        throw new Error("请先把 Base URL 中的 {WorkspaceId} 替换为实际业务空间 ID");
      }
      if (models.length === 0) throw new Error("至少配置一个模型");
      await api.upsertModelProvider(draft.id.trim(), {
        baseUrl: draft.baseUrl.trim(),
        api: draft.api,
        credentialProviderId,
        models,
        enabled: draft.enabled,
      });
      setMessage(`Provider ${draft.id.trim()} 已保存`);
      await load();
      onChanged?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveCredential(): Promise<void> {
    if (!bridge) {
      setError("浏览器模式不能保存长期模型密钥，请使用桌面应用");
      return;
    }
    const providerId = draft.credentialProviderId.trim() || draft.id.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(providerId)) {
      setError("凭据 Provider 标识必须是小写字母、数字、下划线或短横线");
      return;
    }
    if (!secret.trim()) {
      setError("请输入 API Key");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await bridge.credentials.save({
        kind: "model",
        providerId,
        secret: secret.trim(),
      });
      setCredentials(next);
      setSecret("");
      setMessage(`已保存 ${providerId} 的长期密钥到系统安全存储`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function removeCredential(providerId: string): Promise<void> {
    if (!bridge) return;
    if (!window.confirm(`删除 ${providerId} 的长期密钥？删除后需要重新输入。`)) return;
    setBusy(true);
    setError(null);
    try {
      setCredentials(await bridge.credentials.remove("model", providerId));
      setMessage(`已删除 ${providerId} 的长期密钥`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveSelection(applyRouter: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const worker = selectionFrom(workerProvider, workerModel);
      const router = selectionFrom(routerProvider, routerModel);
      if (!worker) throw new Error("请选择 Worker 默认 Provider 和模型");
      if (applyRouter) {
        if (!router) throw new Error("请选择 Router Provider 和模型");
        await api.routerConfigure(router);
      }
      const body: ModelConfigurationUpdate = { worker };
      if (!configuration?.routerLockedByEnv) body.router = router;
      const next = await api.updateModelConfiguration(body);
      applyConfiguration(next);
      setMessage(
        applyRouter
          ? "Worker 默认与 Router 模型已保存；Router 空闲时会使用新模型启动会话"
          : "Worker 默认模型已保存",
      );
      onChanged?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function validateSelected(): Promise<void> {
    const selected = selectionFrom(workerProvider, workerModel);
    if (!selected) {
      setError("请选择要验证的 Worker Provider 和模型");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.validateModel(selected);
      if (!result.ok) {
        setError(result.error?.message ?? "模型验证失败");
      } else {
        setMessage(
          `模型验证通过（${result.latencyMs ?? 0} ms）${
            result.supportsImage ? "，支持虚拟机图片输入" : "；该模型仅适合文本对话"
          }`,
        );
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function providerOptions(): ModelProviderView[] {
    return (configuration?.providers ?? []).filter((provider) => provider.enabled);
  }

  function modelsFor(providerId: string): ModelDefinition[] {
    return providerOptions().find((provider) => provider.id === providerId)?.models ?? [];
  }

  const selectedProvider = configuration?.providers.find((provider) => provider.id === draft.id);
  const credentialIds = new Set(
    (credentials?.providers ?? [])
      .filter((item) => item.kind === "model")
      .map((item) => item.providerId),
  );

  return (
    <section className="panel model-settings" aria-labelledby="model-settings-title">
      <div className="panel-heading">
        <div>
          <h2 id="model-settings-title">模型与 API 配置</h2>
        </div>
        <span className="muted small">{configuration?.providers.length ?? 0} 套配置</span>
      </div>
      {error && <div className="notice">{error}</div>}
      {message && <div className="validation-box ok">{message}</div>}

      <div className="model-settings-grid">
        <div className="model-provider-list">
          <h3>已保存的配置</h3>
          {(configuration?.providers.length ?? 0) === 0 ? (
            <p className="muted small">尚未配置 Provider。</p>
          ) : (
            <ul className="provider-list">
              {configuration?.providers.map((provider) => (
                <li key={provider.id} className={provider.enabled ? "" : "disabled"}>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setDraft(draftFromProvider(provider))}
                  >
                    <strong>{provider.id}</strong>
                  </button>
                  <span>{provider.baseUrl}</span>
                  <span className="muted small">
                    {provider.api} · {provider.models.map((model) => model.id).join(", ")}
                    {provider.enabled ? "" : " · 已停用"}
                  </span>
                  <span className="muted small">
                    凭据：{provider.credentialProviderId}
                    {credentialIds.has(provider.credentialProviderId) ? " · 已保存" : " · 未保存"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="model-provider-editor">
          <h3>{selectedProvider ? `编辑 ${selectedProvider.id}` : "新增配置"}</h3>
          {!selectedProvider && (
            <label className="field">
              <span>从预设创建（仍可修改）</span>
              <select
                value={CUSTOM_PRESET_ID}
                onChange={(event) => applyPreset(event.target.value)}
              >
                <option value={CUSTOM_PRESET_ID}>选择服务商预设…</option>
                {PROVIDER_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="provider-form">
            <label className="field">
              <span>Provider ID（配置名）</span>
              <input
                value={draft.id}
                disabled={Boolean(selectedProvider)}
                onChange={(event) => updateDraft({ id: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Base URL</span>
              <input
                value={draft.baseUrl}
                spellCheck={false}
                onChange={(event) => updateDraft({ baseUrl: event.target.value })}
              />
              {draft.baseUrl.includes("{WorkspaceId}") && (
                <small className="muted">
                  将 {"{WorkspaceId}"} 替换为百炼业务空间 ID；API Key 必须与所选地域一致。
                </small>
              )}
            </label>
            <label className="field">
              <span>API 类型</span>
              <select
                value={draft.api}
                onChange={(event) => updateDraft({ api: event.target.value as WorkerModelApi })}
              >
                <option value="openai-completions">openai-completions</option>
                <option value="anthropic-messages">anthropic-messages</option>
              </select>
            </label>
            <label className="field">
              <span>凭据 Provider ID</span>
              <input
                value={draft.credentialProviderId}
                onChange={(event) => updateDraft({ credentialProviderId: event.target.value })}
              />
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => updateDraft({ enabled: event.target.checked })}
              />
              <span>启用此配置</span>
            </label>
          </div>

          <h4>模型白名单</h4>
          <div className="model-rows">
            {draft.models.map((model, index) => (
              <div className="model-row" key={index}>
                <input
                  placeholder="模型 ID"
                  value={model.id}
                  onChange={(event) => updateModel(index, { id: event.target.value })}
                />
                <input
                  placeholder="显示名称（可选）"
                  value={model.name ?? ""}
                  onChange={(event) => updateModel(index, { name: event.target.value })}
                />
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={model.reasoning === true}
                    onChange={(event) => updateModel(index, { reasoning: event.target.checked })}
                  />
                  <span>Reasoning</span>
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={model.input ? model.input.includes("image") : true}
                    onChange={(event) =>
                      updateModel(index, {
                        input: event.target.checked ? ["text", "image"] : ["text"],
                      })
                    }
                  />
                  <span>支持图片</span>
                </label>
                <button
                  type="button"
                  className="secondary"
                  disabled={draft.models.length <= 1}
                  onClick={() =>
                    updateDraft({ models: draft.models.filter((_, item) => item !== index) })
                  }
                >
                  删除
                </button>
              </div>
            ))}
          </div>
          <p className="muted small">
            Computer Use Worker 必须使用支持图片输入的模型；未勾选“支持图片”的模型只能用于 Router。
          </p>
          <div className="action-row">
            <button
              type="button"
              className="secondary"
              onClick={() => updateDraft({ models: [...draft.models, { id: "" }] })}
            >
              添加模型
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void saveProvider()}
            >
              {busy ? "保存中…" : "保存 Provider"}
            </button>
            {selectedProvider && (
              <button type="button" className="secondary" onClick={() => setDraft(emptyDraft())}>
                新建配置
              </button>
            )}
          </div>

          <h4>长期 API Key</h4>
          {bridge ? (
            <>
              <div className="action-row">
                <label className="field grow">
                  <span>
                    {draft.credentialProviderId || draft.id
                      ? `${draft.credentialProviderId || draft.id} 的 API Key`
                      : "API Key"}
                  </span>
                  <input
                    type="password"
                    value={secret}
                    autoComplete="off"
                    onChange={(event) => setSecret(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void saveCredential()}
                >
                  保存密钥
                </button>
              </div>
              <p className="muted small">
                安全存储：
                {credentials?.secureStorageAvailable
                  ? (credentials.storageBackend ?? "系统默认")
                  : "不可用"}
                {credentials?.message ? ` · ${credentials.message}` : ""}
              </p>
              {(credentials?.providers ?? []).filter((item) => item.kind === "model").length ? (
                <ul className="plain-list">
                  {(credentials?.providers ?? [])
                    .filter((item) => item.kind === "model")
                    .map((item) => (
                      <li key={`${item.kind}:${item.providerId}`}>
                        <code>{item.providerId}</code>
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy}
                          onClick={() => void removeCredential(item.providerId)}
                        >
                          删除密钥
                        </button>
                      </li>
                    ))}
                </ul>
              ) : (
                <p className="muted small">尚未保存长期密钥。</p>
              )}
            </>
          ) : (
            <p className="muted small">浏览器模式不能保存长期模型密钥，请使用桌面应用。</p>
          )}
        </div>
      </div>

      <div className="model-selection">
        <h3>默认与 Router 选择</h3>
        <div className="selection-grid">
          <div>
            <h4>新 Worker 默认模型</h4>
            <label className="field">
              <span>Worker Provider</span>
              <select
                value={workerProvider}
                onChange={(event) => setWorkerProvider(event.target.value)}
              >
                <option value="">未选择</option>
                {providerOptions().map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Worker 模型</span>
              <select value={workerModel} onChange={(event) => setWorkerModel(event.target.value)}>
                <option value="">未选择</option>
                {modelsFor(workerProvider).map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.id}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div>
            <h4>Router 模型</h4>
            <label className="field">
              <span>Router Provider</span>
              <select
                value={routerProvider}
                disabled={configuration?.routerLockedByEnv === true}
                onChange={(event) => setRouterProvider(event.target.value)}
              >
                <option value="">未选择</option>
                {providerOptions().map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Router 模型</span>
              <select
                value={routerModel}
                disabled={configuration?.routerLockedByEnv === true}
                onChange={(event) => setRouterModel(event.target.value)}
              >
                <option value="">未选择</option>
                {modelsFor(routerProvider).map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.id}
                  </option>
                ))}
              </select>
            </label>
            {configuration?.routerLockedByEnv && (
              <p className="notice small">Router 模型由环境变量锁定，界面只能查看。</p>
            )}
          </div>
        </div>
        <div className="action-row">
          <button
            type="button"
            className="secondary"
            disabled={busy || !workerProvider || !workerModel}
            onClick={() => void validateSelected()}
          >
            验证 Worker 默认模型
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void saveSelection(false)}
          >
            保存 Worker 默认
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || routerRunning || configuration?.routerLockedByEnv === true}
            onClick={() => void saveSelection(true)}
          >
            {routerRunning ? "Router 运行中" : "应用并重启 Router 会话"}
          </button>
        </div>
      </div>
    </section>
  );
}

function fallbackSelection(providers: ModelProviderView[]): ModelSelection | null {
  const provider = providers.find((candidate) => candidate.enabled);
  const model = provider?.models[0];
  return provider && model ? { providerId: provider.id, model: model.id } : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
