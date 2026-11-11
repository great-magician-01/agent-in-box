/* eslint-disable react-hooks/set-state-in-effect -- wizard steps load host, storage and credential state on entry */
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AutoStartPolicy,
  CloseBehavior,
  DesktopBridge,
  DesktopCredentialStatus,
  HostInspectionReport,
  OnboardingCompleteResult,
  OnboardingState,
  StorageValidation,
} from "@agent-in-box/protocol";
import { api, ApiRequestError } from "./api";
import { chooseDirectory, credentialStatus, readCloseBehavior, saveCloseBehavior } from "./desktop";
import {
  DATA_ROOT_SOURCE_LABELS,
  HOST_CHECK_STATUS_LABELS,
  formatBytes,
  formatGb,
  parseGb,
} from "./format";

const STEPS = [
  { id: "host", title: "环境检查", hint: "确认这台电脑可以运行 Linux VM" },
  { id: "storage", title: "存储位置", hint: "镜像、VM 和快照都要在下载前选定目录" },
  { id: "resources", title: "资源与后台", hint: "为宿主机保留内存并选择自动启动策略" },
  { id: "credentials", title: "模型凭据", hint: "密钥只保存在系统安全存储中" },
  { id: "profile", title: "本地身份", hint: "创建本机管理员与基础安全设置" },
  { id: "review", title: "确认完成", hint: "检查设置后完成首次启动" },
] as const;

interface OnboardingWizardProps {
  initialState: OnboardingState;
  bridge: DesktopBridge | null;
  onCompleted(result: OnboardingCompleteResult): void;
}

const PROVIDERS = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "google", label: "Google" },
  { id: "custom", label: "其他（自定义）" },
] as const;

export function OnboardingWizard({
  initialState,
  bridge,
  onCompleted,
}: OnboardingWizardProps): React.JSX.Element {
  const [stepIndex, setStepIndex] = useState(0);
  const step = STEPS[stepIndex] ?? STEPS[0];
  const [host, setHost] = useState<HostInspectionReport | null>(null);
  const [hostLoading, setHostLoading] = useState(false);
  const [hostError, setHostError] = useState<string | null>(null);

  const [dataRoot, setDataRoot] = useState(initialState.dataRoot);
  const [validation, setValidation] = useState<StorageValidation | null>(null);
  const [validating, setValidating] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [requestedPath, setRequestedPath] = useState<string | null>(null);

  const [hostReserveGb, setHostReserveGb] = useState(
    initialState.resourcePolicy.hostReserveBytes > 0
      ? formatGb(initialState.resourcePolicy.hostReserveBytes)
      : "1.0",
  );
  const [autoStartPolicy, setAutoStartPolicy] = useState<AutoStartPolicy>(
    initialState.resourcePolicy.autoStartPolicy,
  );
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>("keep_running");
  const [closeBehaviorSaved, setCloseBehaviorSaved] = useState(false);

  const [credentials, setCredentials] = useState<DesktopCredentialStatus | null>(null);
  const knownProvider = PROVIDERS.some(
    (provider) => provider.id === initialState.preferredModelProvider,
  );
  const [credentialProvider, setCredentialProvider] = useState<string>(
    knownProvider
      ? (initialState.preferredModelProvider ?? "anthropic")
      : initialState.preferredModelProvider
        ? "custom"
        : "anthropic",
  );
  const [customProvider, setCustomProvider] = useState(
    knownProvider ? "" : (initialState.preferredModelProvider ?? ""),
  );
  const [secret, setSecret] = useState("");
  const [credentialsLoading, setCredentialsLoading] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [savedProvider, setSavedProvider] = useState<string | null>(
    initialState.preferredModelProvider,
  );

  const [displayName, setDisplayName] = useState(
    initialState.localUser?.displayName ?? "本机管理员",
  );
  const [requireApproval, setRequireApproval] = useState(
    initialState.security.requireApprovalForSensitiveActions,
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const loadHost = useCallback(async (root: string) => {
    setHostLoading(true);
    setHostError(null);
    try {
      setHost(await api.hostInspection(root));
    } catch (error) {
      setHostError(errorMessage(error));
    } finally {
      setHostLoading(false);
    }
  }, []);

  const validateStorage = useCallback(async (path: string) => {
    if (!path.trim()) {
      setStorageError("请先选择存储目录");
      return;
    }
    setValidating(true);
    setStorageError(null);
    setRequestedPath(path.trim());
    try {
      const result = await api.validateStorage(path.trim());
      setValidation(result);
      if (result.ok) {
        setDataRoot(result.resolvedPath);
      }
    } catch (error) {
      setStorageError(errorMessage(error));
      setValidation(null);
    } finally {
      setValidating(false);
    }
  }, []);

  useEffect(() => {
    void loadHost(dataRoot);
    // Only the initial check; the storage step performs its own validation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadHost]);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    void readCloseBehavior(bridge)
      .then((value) => {
        if (value) {
          setCloseBehavior(value);
        }
      })
      .catch(() => undefined);
  }, [bridge]);

  useEffect(() => {
    if (step.id !== "storage" || validation || validating || requestedPath !== null) {
      return;
    }
    void validateStorage(dataRoot);
  }, [step.id, validation, validating, dataRoot, requestedPath, validateStorage]);

  useEffect(() => {
    if (step.id !== "credentials" || !bridge || credentialsLoading || credentials) {
      return;
    }
    setCredentialsLoading(true);
    void credentialStatus(bridge)
      .then((status) => {
        setCredentials(status);
        if (status && status.providers[0] && !savedProvider) {
          setSavedProvider(status.providers[0].providerId);
          setCredentialProvider(status.providers[0].providerId);
        }
      })
      .catch((error: unknown) => setCredentialError(errorMessage(error)))
      .finally(() => setCredentialsLoading(false));
  }, [step.id, bridge, credentialsLoading, credentials, savedProvider]);

  const effectiveProvider =
    credentialProvider === "custom" ? customProvider.trim() : credentialProvider;

  const credentialsConfigured = Boolean(
    (credentials?.providers.length ?? 0) > 0 || initialState.credentialsConfigured,
  );

  const hostReserveBytes = useMemo(() => parseGb(hostReserveGb), [hostReserveGb]);
  const hostReserveValid =
    hostReserveBytes !== null && (hostReserveBytes === 0 || hostReserveBytes >= 512 * 1024 * 1024);

  const canContinue = (() => {
    switch (step.id) {
      case "host":
        return Boolean(host?.ready) && !hostLoading;
      case "storage":
        return Boolean(validation?.ok) && !validating;
      case "resources":
        return hostReserveValid;
      case "credentials":
        return true;
      case "profile":
        return displayName.trim().length >= 1 && displayName.trim().length <= 60;
      default:
        return true;
    }
  })();

  async function browse(): Promise<void> {
    const selected = await chooseDirectory(bridge, {
      title: "选择 Agent-in-Box 数据目录",
      defaultPath: dataRoot,
    });
    if (selected) {
      setDataRoot(selected);
      setValidation(null);
      setRequestedPath(null);
    }
  }

  async function saveCredential(): Promise<void> {
    if (!bridge) {
      return;
    }
    if (!effectiveProvider || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(effectiveProvider)) {
      setCredentialError("Provider 标识必须是小写字母、数字、下划线或短横线");
      return;
    }
    setCredentialsLoading(true);
    setCredentialError(null);
    try {
      const status = await bridge.credentials.save({
        providerId: effectiveProvider,
        secret,
      });
      setCredentials(status);
      setSavedProvider(effectiveProvider);
      setSecret("");
    } catch (error) {
      setCredentialError(errorMessage(error));
    } finally {
      setCredentialsLoading(false);
    }
  }

  async function removeCredential(providerId: string): Promise<void> {
    if (!bridge) {
      return;
    }
    setCredentialsLoading(true);
    setCredentialError(null);
    try {
      const status = await bridge.credentials.remove(providerId);
      setCredentials(status);
      if (savedProvider === providerId) {
        setSavedProvider(status.providers[0]?.providerId ?? null);
      }
    } catch (error) {
      setCredentialError(errorMessage(error));
    } finally {
      setCredentialsLoading(false);
    }
  }

  async function updateCloseBehavior(value: CloseBehavior): Promise<void> {
    setCloseBehavior(value);
    setCloseBehaviorSaved(false);
    try {
      await saveCloseBehavior(bridge, value);
      setCloseBehaviorSaved(true);
    } catch (error) {
      setCloseBehaviorSaved(false);
      setSubmitError(errorMessage(error));
    }
  }

  async function submit(): Promise<void> {
    if (hostReserveBytes === null) {
      setSubmitError("Host Reserve 无效");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.completeOnboarding({
        dataRoot: validation?.resolvedPath ?? dataRoot,
        resourcePolicy: {
          hostReserveBytes,
          softMemoryBudgetBytes: 0,
          autoStartPolicy,
          idleSuspendEnabled: false,
          idleSuspendTimeoutMs: 60 * 60_000,
        },
        security: {
          requireApprovalForSensitiveActions: requireApproval,
        },
        displayName: displayName.trim(),
        preferredModelProvider: credentialsConfigured
          ? (savedProvider ?? (effectiveProvider || null))
          : null,
        credentialsConfigured,
      });
      onCompleted(result);
    } catch (error) {
      setSubmitError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  const errors = host?.checks.filter((check) => check.status === "error") ?? [];

  return (
    <div className="wizard">
      <aside className="wizard-steps">
        <p className="eyebrow">FIRST RUN</p>
        <h1>首次启动向导</h1>
        <ol>
          {STEPS.map((item, index) => (
            <li
              key={item.id}
              className={index === stepIndex ? "active" : index < stepIndex ? "done" : ""}
            >
              <span className="step-index">{index < stepIndex ? "✓" : index + 1}</span>
              <span>
                <strong>{item.title}</strong>
                <small>{item.hint}</small>
              </span>
            </li>
          ))}
        </ol>
        <p className="wizard-note">
          所有大文件都会放在你选择的目录中。模型密钥不会写入普通配置、日志或 VM。
        </p>
      </aside>

      <section className="wizard-panel">
        <header className="wizard-heading">
          <span className="step-count">
            第 {stepIndex + 1} / {STEPS.length} 步
          </span>
          <h2>{step.title}</h2>
          <p>{step.hint}</p>
        </header>

        {step.id === "host" && (
          <div className="stack">
            {hostLoading && <p className="muted">正在检查宿主机…</p>}
            {hostError && <div className="notice">{hostError}</div>}
            {host && (
              <>
                <dl className="summary-grid">
                  <div>
                    <dt>操作系统</dt>
                    <dd>
                      {host.platform} · {host.release}
                    </dd>
                  </div>
                  <div>
                    <dt>物理内存</dt>
                    <dd>{formatBytes(host.totalMemoryBytes)}</dd>
                  </div>
                  <div>
                    <dt>存储目录可用空间</dt>
                    <dd>{formatBytes(host.freeDiskBytes)}</dd>
                  </div>
                  <div>
                    <dt>建议的 Provider</dt>
                    <dd>{host.recommendedProvider ?? "尚未就绪"}</dd>
                  </div>
                </dl>
                <ul className="check-list">
                  {host.checks.map((check) => (
                    <li key={check.id} className={`host-check ${check.status}`}>
                      <span className="check-badge">{HOST_CHECK_STATUS_LABELS[check.status]}</span>
                      <span>
                        <strong>{check.id}</strong>
                        <small>{check.message}</small>
                      </span>
                    </li>
                  ))}
                </ul>
                {errors.length > 0 ? (
                  <div className="notice">
                    有 {errors.length} 项检查未通过。请先按提示修复，再继续首次启动。
                  </div>
                ) : (
                  <p className="muted">
                    警告项不会阻止安装，但会影响可用资源。当前检查通过后即可继续。
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {step.id === "storage" && (
          <div className="stack">
            <label className="field">
              <span>数据根目录</span>
              <div className="input-row">
                <input
                  value={dataRoot}
                  onChange={(event) => {
                    setDataRoot(event.target.value);
                    setValidation(null);
                    setRequestedPath(null);
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
                  disabled={validating}
                >
                  {validating ? "检查中…" : "检查路径"}
                </button>
              </div>
            </label>
            <p className="muted small">
              {DATA_ROOT_SOURCE_LABELS[initialState.dataRootSource]}
              。迁移失败时旧目录仍然可用，旧数据不会自动删除。
            </p>
            {storageError && <div className="notice">{storageError}</div>}
            {validation && (
              <div className={`validation-box ${validation.ok ? "ok" : "bad"}`}>
                <strong>
                  {validation.ok ? "目录可用" : "目录不可用"} · {validation.resolvedPath}
                </strong>
                <span className="muted small">
                  可用 {formatBytes(validation.freeBytes)} / 共 {formatBytes(validation.totalBytes)}
                </span>
                {validation.warnings.map((warning) => (
                  <span key={warning} className="warning-line">
                    {warning}
                  </span>
                ))}
                {validation.errors.map((error) => (
                  <span key={error} className="error-line">
                    {error}
                  </span>
                ))}
              </div>
            )}
            {validation?.ok && (
              <div className="layout-preview">
                {Object.entries(validation.layout).map(([key, value]) => (
                  <div key={key}>
                    <span>{key}</span>
                    <code>{value}</code>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {step.id === "resources" && (
          <div className="stack">
            <label className="field">
              <span>Host Reserve（为宿主机保留的内存，GB）</span>
              <input
                type="number"
                min="0"
                step="0.5"
                value={hostReserveGb}
                onChange={(event) => setHostReserveGb(event.target.value)}
              />
              <small className="muted">
                默认保留物理内存的 25%（不超过 4 GB，至少 1 GB）。宿主机内存为{" "}
                {host ? formatBytes(host.totalMemoryBytes) : "未知"}。
              </small>
            </label>
            <fieldset className="field">
              <legend>自动启动策略</legend>
              <label className="radio">
                <input
                  type="radio"
                  name="autostart"
                  checked={autoStartPolicy === "manual"}
                  onChange={() => setAutoStartPolicy("manual")}
                />
                <span>
                  <strong>仅手动启动</strong>
                  <small>VM 只在你明确点击启动时运行，资源占用最可控。</small>
                </span>
              </label>
              <label className="radio">
                <input
                  type="radio"
                  name="autostart"
                  checked={autoStartPolicy === "when_needed"}
                  onChange={() => setAutoStartPolicy("when_needed")}
                />
                <span>
                  <strong>有任务时自动启动</strong>
                  <small>任务到达时为绑定 VM 启动，仍需满足 Host Reserve。</small>
                </span>
              </label>
            </fieldset>
            {bridge && (
              <label className="field">
                <span>关闭窗口时</span>
                <select
                  value={closeBehavior}
                  onChange={(event) =>
                    void updateCloseBehavior(event.target.value as CloseBehavior)
                  }
                >
                  <option value="keep_running">保留本地服务在后台运行</option>
                  <option value="quit">停止本地服务并退出应用</option>
                </select>
                <small className="muted">
                  {closeBehaviorSaved
                    ? "已保存。后台运行时可从系统托盘重新打开窗口。"
                    : "此设置只影响桌面应用窗口；任务和 VM 状态始终落库。"}
                </small>
              </label>
            )}
            {!hostReserveValid && (
              <div className="notice">Host Reserve 必须是有效数字，且至少 0.5 GB（或填 0）。</div>
            )}
          </div>
        )}

        {step.id === "credentials" && (
          <div className="stack">
            {!bridge ? (
              <div className="notice">
                模型凭据只能在桌面应用中使用系统安全存储配置。本地 Web
                模式无法安全保存长期密钥，可先跳过，稍后在桌面应用中补充。
              </div>
            ) : (
              <>
                <div className="credential-box">
                  <label className="field">
                    <span>Provider</span>
                    <select
                      value={credentialProvider}
                      onChange={(event) => setCredentialProvider(event.target.value)}
                    >
                      {PROVIDERS.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {credentialProvider === "custom" && (
                    <label className="field">
                      <span>自定义 Provider 标识</span>
                      <input
                        value={customProvider}
                        onChange={(event) => setCustomProvider(event.target.value)}
                        placeholder="例如 my-provider"
                        spellCheck={false}
                      />
                    </label>
                  )}
                  <label className="field">
                    <span>API Key</span>
                    <input
                      type="password"
                      value={secret}
                      onChange={(event) => setSecret(event.target.value)}
                      autoComplete="off"
                      placeholder="密钥只会交给系统安全存储"
                    />
                  </label>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void saveCredential()}
                    disabled={credentialsLoading || secret.trim().length === 0}
                  >
                    {credentialsLoading ? "保存中…" : "保存到系统安全存储"}
                  </button>
                </div>
                {credentialError && <div className="notice">{credentialError}</div>}
                {credentials && !credentials.secureStorageAvailable && (
                  <div className="notice">{credentials.message ?? "系统安全存储不可用"}</div>
                )}
                {credentials?.secureStorageAvailable && (
                  <div className="credential-status">
                    <strong>安全存储：{credentials.storageBackend ?? "系统默认"}</strong>
                    {credentials.providers.length === 0 ? (
                      <span className="muted">尚未配置凭据，可跳过。</span>
                    ) : (
                      <ul>
                        {credentials.providers.map((provider) => (
                          <li key={provider.providerId}>
                            <span>{provider.providerId}</span>
                            <small className="muted">
                              更新于 {new Date(provider.updatedAt).toLocaleString("zh-CN")}
                            </small>
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => void removeCredential(provider.providerId)}
                            >
                              删除
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {step.id === "profile" && (
          <div className="stack">
            <label className="field">
              <span>本机管理员显示名称</span>
              <input
                value={displayName}
                maxLength={60}
                onChange={(event) => setDisplayName(event.target.value)}
              />
              <small className="muted">这是本机应用内的身份，不会创建或修改操作系统账户。</small>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={requireApproval}
                onChange={(event) => setRequireApproval(event.target.checked)}
              />
              <span>
                <strong>敏感操作需要审批</strong>
                <small>文件删除、对外发送、凭据使用等动作在策略阶段接入。</small>
              </span>
            </label>
          </div>
        )}

        {step.id === "review" && (
          <div className="stack">
            <dl className="summary-grid">
              <div>
                <dt>数据根目录</dt>
                <dd>{validation?.resolvedPath ?? dataRoot}</dd>
              </div>
              <div>
                <dt>Host Reserve</dt>
                <dd>{hostReserveBytes === null ? "—" : formatBytes(hostReserveBytes)}</dd>
              </div>
              <div>
                <dt>自动启动</dt>
                <dd>{autoStartPolicy === "manual" ? "仅手动" : "有任务时自动启动"}</dd>
              </div>
              <div>
                <dt>本机管理员</dt>
                <dd>{displayName.trim() || "—"}</dd>
              </div>
              <div>
                <dt>模型凭据</dt>
                <dd>
                  {credentialsConfigured
                    ? `已配置${savedProvider ? ` · ${savedProvider}` : ""}`
                    : "未配置（可稍后补充）"}
                </dd>
              </div>
              <div>
                <dt>敏感操作审批</dt>
                <dd>{requireApproval ? "开启" : "关闭"}</dd>
              </div>
            </dl>
            {(validation?.resolvedPath ?? dataRoot) !== initialState.dataRoot && (
              <div className="notice">
                完成向导后会把当前数据迁移到新目录，并重启本地服务。旧目录会保留，确认新目录可用后可手动清理。
              </div>
            )}
            {submitError && <div className="notice">{submitError}</div>}
          </div>
        )}

        <footer className="wizard-actions">
          <button
            type="button"
            className="secondary"
            disabled={stepIndex === 0 || submitting}
            onClick={() => setStepIndex((index) => Math.max(0, index - 1))}
          >
            上一步
          </button>
          {stepIndex < STEPS.length - 1 ? (
            <button
              type="button"
              className="primary"
              disabled={!canContinue}
              onClick={() => setStepIndex((index) => Math.min(STEPS.length - 1, index + 1))}
            >
              下一步
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={submitting}
              onClick={() => void submit()}
            >
              {submitting ? "正在完成…" : "完成首次启动"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
