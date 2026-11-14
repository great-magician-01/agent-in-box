/* eslint-disable react-hooks/set-state-in-effect -- initial storage and credential snapshots load on entry */
import { useCallback, useEffect, useState } from "react";
import type {
  DesktopBridge,
  ModelInputModality,
  ModelValidationResult,
  OnboardingCompleteResult,
  OnboardingState,
  StorageValidation,
  WorkerModelApi,
} from "@agent-in-box/protocol";
import { api, ApiRequestError } from "./api";
import { chooseDirectory, credentialStatus } from "./desktop";
import { DATA_ROOT_SOURCE_LABELS, formatBytes } from "./format";
import { CUSTOM_PRESET_ID, DEFAULT_PRESET_ID, PROVIDER_PRESETS } from "./provider-presets";

interface OnboardingWizardProps {
  initialState: OnboardingState;
  bridge: DesktopBridge | null;
  onCompleted(result: OnboardingCompleteResult): void;
}

const PROVIDER_OPTIONS = [
  ...PROVIDER_PRESETS.map((provider) => ({ id: provider.id, label: provider.label })),
  { id: CUSTOM_PRESET_ID, label: "自定义 OpenAI 兼容 / Anthropic 服务" },
];

export function OnboardingWizard({
  initialState,
  bridge,
  onCompleted,
}: OnboardingWizardProps): React.JSX.Element {
  const [step, setStep] = useState<"storage" | "model">("storage");
  const [dataRoot, setDataRoot] = useState(initialState.dataRoot);
  const [storage, setStorage] = useState<StorageValidation | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [providerId, setProviderId] = useState(
    initialState.preferredModelProvider ?? DEFAULT_PRESET_ID,
  );
  const initialPreset = PROVIDER_PRESETS.find((provider) => provider.id === providerId);
  const [model, setModel] = useState(initialPreset ? preferredModel(initialPreset.models) : "");
  const [workspaceId, setWorkspaceId] = useState("");
  const [secret, setSecret] = useState("");
  const [customProviderId, setCustomProviderId] = useState("custom");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiType, setApiType] = useState<WorkerModelApi>("openai-completions");
  const [supportsImage, setSupportsImage] = useState(true);
  const [knownCredentials, setKnownCredentials] = useState<string[]>([]);
  const [validation, setValidation] = useState<ModelValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function resetValidation(): void {
    setValidation(null);
    setError(null);
  }

  const validateStorage = useCallback(async (value: string) => {
    setStorageBusy(true);
    setError(null);
    try {
      const result = await api.validateStorage(value.trim());
      setStorage(result);
      if (result.ok) setDataRoot(result.resolvedPath);
      if (!result.ok) setError(result.errors.join("；") || "目录不可用");
    } catch (reason) {
      setStorage(null);
      setError(errorMessage(reason));
    } finally {
      setStorageBusy(false);
    }
  }, []);

  useEffect(() => {
    void validateStorage(initialState.dataRoot);
  }, [initialState.dataRoot, validateStorage]);

  useEffect(() => {
    if (!bridge) return;
    void credentialStatus(bridge)
      .then((status) =>
        setKnownCredentials(
          (status?.providers ?? [])
            .filter((item) => item.kind === "model")
            .map((item) => item.providerId),
        ),
      )
      .catch(() => undefined);
  }, [bridge]);

  async function browse(): Promise<void> {
    const selected = await chooseDirectory(bridge, {
      title: "选择 Agent-in-Box 保存目录",
      defaultPath: dataRoot,
    });
    if (!selected) return;
    setDataRoot(selected);
    setStorage(null);
    await validateStorage(selected);
  }

  function changeProvider(value: string): void {
    setProviderId(value);
    setValidation(null);
    setError(null);
    const preset = PROVIDER_PRESETS.find((provider) => provider.id === value);
    setModel(preset ? preferredModel(preset.models) : "");
  }

  async function validateAndSave(): Promise<void> {
    if (!bridge) {
      setError("请在桌面应用中配置模型，密钥需要由系统安全存储保管");
      return;
    }
    setValidating(true);
    setValidation(null);
    setError(null);
    try {
      const preset = PROVIDER_PRESETS.find((provider) => provider.id === providerId);
      const effectiveId = preset?.id ?? customProviderId.trim();
      if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(effectiveId)) {
        throw new Error("Provider 标识需使用小写字母、数字、下划线或短横线");
      }
      if (!model.trim()) throw new Error("请选择或填写默认模型");
      if (preset?.baseUrl.includes("{WorkspaceId}") && !workspaceId.trim()) {
        throw new Error("请输入阿里云百炼业务空间 ID");
      }
      if (!secret && !knownCredentials.includes(effectiveId)) {
        throw new Error("请输入 API Key");
      }
      if (secret) {
        const status = await bridge.credentials.save({
          kind: "model",
          providerId: effectiveId,
          secret,
        });
        setKnownCredentials(
          status.providers.filter((item) => item.kind === "model").map((item) => item.providerId),
        );
        setSecret("");
      }
      // Presets keep their declared modalities: only a fully custom provider
      // needs the operator's image-input checkbox.
      const customInput: ModelInputModality[] = supportsImage ? ["text", "image"] : ["text"];
      const models = preset
        ? preset.models.map((item) => ({
            ...item,
            input: [...(item.input ?? ["text", "image"])] as ModelInputModality[],
          }))
        : [{ id: model.trim(), input: customInput }];
      await api.upsertModelProvider(effectiveId, {
        baseUrl: preset
          ? preset.baseUrl.replace("{WorkspaceId}", workspaceId.trim())
          : baseUrl.trim(),
        api: preset?.api ?? apiType,
        credentialProviderId: effectiveId,
        models,
        enabled: true,
      });
      const selection = { providerId: effectiveId, model: model.trim() };
      const configuration = await api.modelConfiguration();
      await api.updateModelConfiguration(
        configuration.routerLockedByEnv
          ? { worker: selection }
          : { worker: selection, router: selection },
      );
      const result = await api.validateModel({ providerId: effectiveId, model: model.trim() });
      setValidation(result);
      if (!result.ok) setError(result.error?.message ?? "模型验证失败");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setValidating(false);
    }
  }

  async function submit(): Promise<void> {
    if (!storage?.ok) {
      setError("请先确认保存目录可用");
      return;
    }
    if (!validation?.ok) {
      setError("请先完成模型验证");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.completeOnboarding({
        dataRoot: storage.resolvedPath,
        resourcePolicy: {
          ...initialState.resourcePolicy,
          autoStartPolicy: "when_needed",
        },
        security: initialState.security,
        displayName: initialState.localUser?.displayName ?? "本机管理员",
        preferredModelProvider: validation.providerId,
        credentialsConfigured: true,
      });
      window.localStorage.setItem("agent-in-box:bootstrap-autostart", "1");
      if (!result.restartRequired) {
        await api.startBootstrap();
        window.localStorage.removeItem("agent-in-box:bootstrap-autostart");
      }
      onCompleted(result);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="wizard">
      <aside className="wizard-steps">
        <h1>首次启动向导</h1>
        <ol>
          <li className={step === "storage" ? "active" : "done"}>
            <span className="step-index">{step === "storage" ? 1 : "✓"}</span>
            <span>
              <strong>保存位置</strong>
              <small>选择工作文件、镜像和虚拟机的保存目录</small>
            </span>
          </li>
          <li className={step === "model" ? "active" : ""}>
            <span className="step-index">2</span>
            <span>
              <strong>模型</strong>
              <small>验证后即可对话，执行环境会自动准备</small>
            </span>
          </li>
        </ol>
        <p className="wizard-note">
          资源、权限和虚拟机组件使用安全默认值。高级设置仍可在进入工作区后修改。
        </p>
      </aside>

      <section className="wizard-panel">
        <header className="wizard-heading">
          <span className="step-count">第 {step === "storage" ? 1 : 2} / 2 步</span>
          <h2>{step === "storage" ? "选择保存位置" : "配置默认模型"}</h2>
          <p>
            {step === "storage"
              ? "接受默认目录即可，不需要了解内部文件结构。"
              : "保存时会做一次最小模型请求，确认账号和模型确实可用。"}
          </p>
        </header>

        {step === "storage" ? (
          <div className="stack">
            <label className="field">
              <span>保存目录</span>
              <div className="input-row">
                <input
                  value={dataRoot}
                  onChange={(event) => {
                    setDataRoot(event.target.value);
                    setStorage(null);
                  }}
                  disabled={initialState.dataRootSource === "environment"}
                  spellCheck={false}
                />
                {bridge && initialState.dataRootSource !== "environment" && (
                  <button type="button" className="secondary" onClick={() => void browse()}>
                    浏览…
                  </button>
                )}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void validateStorage(dataRoot)}
                  disabled={storageBusy || !dataRoot.trim()}
                >
                  {storageBusy ? "检查中…" : "检查目录"}
                </button>
              </div>
            </label>
            <p className="muted small">{DATA_ROOT_SOURCE_LABELS[initialState.dataRootSource]}</p>
            {storage?.ok && (
              <div className="validation-box ok">
                <strong>目录可用</strong>
                <span className="muted small">
                  可用 {formatBytes(storage.freeBytes)} / 共 {formatBytes(storage.totalBytes)}
                </span>
                {storage.warnings.map((warning) => (
                  <span key={warning} className="warning-line">
                    {warning}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="stack">
            <label className="field">
              <span>服务商</span>
              <select value={providerId} onChange={(event) => changeProvider(event.target.value)}>
                {PROVIDER_OPTIONS.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </label>
            {providerId === CUSTOM_PRESET_ID && (
              <>
                <label className="field">
                  <span>Provider 标识</span>
                  <input
                    value={customProviderId}
                    onChange={(event) => {
                      setCustomProviderId(event.target.value);
                      resetValidation();
                    }}
                  />
                </label>
                <label className="field">
                  <span>Base URL</span>
                  <input
                    value={baseUrl}
                    onChange={(event) => {
                      setBaseUrl(event.target.value);
                      resetValidation();
                    }}
                    placeholder="https://provider.example/v1"
                    spellCheck={false}
                  />
                </label>
                <label className="field">
                  <span>API 类型</span>
                  <select
                    value={apiType}
                    onChange={(event) => {
                      setApiType(event.target.value as WorkerModelApi);
                      resetValidation();
                    }}
                  >
                    <option value="openai-completions">OpenAI-compatible</option>
                    <option value="anthropic-messages">Anthropic Messages</option>
                  </select>
                </label>
              </>
            )}
            {providerId === "qwen" && (
              <label className="field">
                <span>百炼业务空间 ID</span>
                <input
                  value={workspaceId}
                  onChange={(event) => {
                    setWorkspaceId(event.target.value);
                    resetValidation();
                  }}
                />
              </label>
            )}
            {providerId === CUSTOM_PRESET_ID ? (
              <label className="field">
                <span>模型 ID</span>
                <input
                  value={model}
                  onChange={(event) => {
                    setModel(event.target.value);
                    resetValidation();
                  }}
                  spellCheck={false}
                />
              </label>
            ) : (
              <label className="field">
                <span>默认模型</span>
                <select
                  value={model}
                  onChange={(event) => {
                    setModel(event.target.value);
                    resetValidation();
                  }}
                >
                  {(
                    PROVIDER_PRESETS.find((provider) => provider.id === providerId)?.models ?? []
                  ).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name ?? item.id}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              <span>
                API Key
                {knownCredentials.includes(
                  providerId === CUSTOM_PRESET_ID ? customProviderId.trim() : providerId,
                )
                  ? "（已保存，可留空）"
                  : ""}
              </span>
              <input
                type="password"
                value={secret}
                onChange={(event) => {
                  setSecret(event.target.value);
                  resetValidation();
                }}
                autoComplete="off"
                placeholder="仅交由系统安全存储保管"
              />
            </label>
            {providerId === CUSTOM_PRESET_ID && (
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={supportsImage}
                  onChange={(event) => {
                    setSupportsImage(event.target.checked);
                    resetValidation();
                  }}
                />
                <span>该模型支持图片输入（虚拟机任务需要）</span>
              </label>
            )}
            <button
              type="button"
              className="secondary"
              onClick={() => void validateAndSave()}
              disabled={validating}
            >
              {validating ? "正在验证…" : "保存并验证模型"}
            </button>
            {validation?.ok && (
              <div className="validation-box ok">
                <strong>模型验证通过 · {validation.model}</strong>
                {!validation.supportsImage && (
                  <span className="warning-line">
                    可用于对话；执行虚拟机任务还需更换多模态模型。
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {error && <div className="notice">{error}</div>}
        <footer className="wizard-actions">
          <button
            type="button"
            className="secondary"
            disabled={step === "storage" || submitting}
            onClick={() => setStep("storage")}
          >
            上一步
          </button>
          {step === "storage" ? (
            <button
              type="button"
              className="primary"
              disabled={!storage?.ok || storageBusy}
              onClick={() => {
                setError(null);
                setStep("model");
              }}
            >
              下一步
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={!validation?.ok || submitting || validating}
              onClick={() => void submit()}
            >
              {submitting ? "正在启动…" : "完成并开始使用"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function preferredModel<T extends { id: string; input?: readonly string[] }>(
  models: readonly T[],
): string {
  return (
    (models.find((item) => (item.input ?? ["text", "image"]).includes("image")) ?? models[0])?.id ??
    ""
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
