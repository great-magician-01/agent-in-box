/* eslint-disable react-hooks/set-state-in-effect -- initial data fetch effects intentionally set loading/result state */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AutoStartPolicy,
  ControlPlaneState,
  DesktopBridge,
  DesktopPreferences,
  DesktopUpdateStatus,
  HealthResponse,
  HostInspectionReport,
  LocalAuthSessionView,
  OnboardingState,
  RuntimeInfo,
  SettingsView,
  StorageCleanupResult,
  StorageReport,
  StorageValidation,
} from "@agent-in-box/protocol";
import type { AppView } from "./App";
import { api, ApiRequestError } from "./api";
import { chooseDirectory, savePreferences } from "./desktop";
import { VmManager, type ConsoleRequest } from "./VmManager";
import { WorkManager, type WorkView } from "./WorkManager";
import { BotManager } from "./BotManager";
import { ModelSettings } from "./ModelSettings";
import { VmRuntimeSettings } from "./VmRuntimeSettings";
import {
  CONTROL_PLANE_STATE_LABELS,
  DATA_ROOT_SOURCE_LABELS,
  HOST_CHECK_STATUS_LABELS,
  STORAGE_CATEGORY_LABELS,
  formatBytes,
  formatDate,
  formatGb,
  parseGb,
} from "./format";

export interface RestartRequest {
  targetRoot: string;
  reason: string;
}

interface DashboardProps {
  view: Exclude<AppView, "notifications">;
  onboarding: OnboardingState;
  runtime: RuntimeInfo;
  health: HealthResponse;
  bridge: DesktopBridge | null;
  authInfo: LocalAuthSessionView;
  controlPlaneState: ControlPlaneState | null;
  onNavigate(view: string): void;
  onChanged(): Promise<void>;
  onRestartRequired(request: RestartRequest): void;
  onOpenWorker?(projectId: string, workerId: string): void;
  initialProjectId?: string | null;
}

export function Dashboard({
  view,
  onboarding,
  runtime,
  health,
  bridge,
  authInfo,
  controlPlaneState,
  onNavigate,
  onChanged,
  onRestartRequired,
  onOpenWorker,
  initialProjectId,
}: DashboardProps): React.JSX.Element {
  const [host, setHost] = useState<HostInspectionReport | null>(null);
  const [storage, setStorage] = useState<StorageReport | null>(null);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [reserveGb, setReserveGb] = useState(formatGb(onboarding.resourcePolicy.hostReserveBytes));
  const [autoStart, setAutoStart] = useState<AutoStartPolicy>(
    onboarding.resourcePolicy.autoStartPolicy,
  );
  const [softBudgetGb, setSoftBudgetGb] = useState(
    formatGb(onboarding.resourcePolicy.softMemoryBudgetBytes),
  );
  const [idleSuspend, setIdleSuspend] = useState(onboarding.resourcePolicy.idleSuspendEnabled);
  const [idleSuspendMinutes, setIdleSuspendMinutes] = useState(
    String(Math.round(onboarding.resourcePolicy.idleSuspendTimeoutMs / 60_000)),
  );
  const [approval, setApproval] = useState(onboarding.security.requireApprovalForSensitiveActions);
  const [autoArchive, setAutoArchive] = useState(true);
  const [idleMinutes, setIdleMinutes] = useState("30");
  const [policyMessage, setPolicyMessage] = useState<string | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [diagnosticsMessage, setDiagnosticsMessage] = useState<string | null>(null);

  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<DesktopPreferences | null>(null);
  const [preferencesMessage, setPreferencesMessage] = useState<string | null>(null);
  const [updateFeedDraft, setUpdateFeedDraft] = useState("");
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [rotateBusy, setRotateBusy] = useState(false);
  const [rotateMessage, setRotateMessage] = useState<string | null>(null);
  const [showMigration, setShowMigration] = useState(false);
  const [targetRoot, setTargetRoot] = useState("");
  const [migrationValidation, setMigrationValidation] = useState<StorageValidation | null>(null);
  const [migrationAcknowledged, setMigrationAcknowledged] = useState(false);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [consoleRequest, setConsoleRequest] = useState<ConsoleRequest | null>(null);
  const consoleNonce = useRef(0);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      const [nextHost, nextStorage, nextSettings] = await Promise.all([
        api.hostInspection(runtime.dataRoot),
        api.storage(),
        api.settings(),
      ]);
      setHost(nextHost);
      setStorage(nextStorage);
      setSettings(nextSettings);
      setReserveGb(formatGb(nextSettings.resourcePolicy.hostReserveBytes));
      setAutoStart(nextSettings.resourcePolicy.autoStartPolicy);
      setSoftBudgetGb(formatGb(nextSettings.resourcePolicy.softMemoryBudgetBytes));
      setIdleSuspend(nextSettings.resourcePolicy.idleSuspendEnabled);
      setIdleSuspendMinutes(
        String(Math.round(nextSettings.resourcePolicy.idleSuspendTimeoutMs / 60_000)),
      );
      setApproval(nextSettings.security.requireApprovalForSensitiveActions);
      setAutoArchive(nextSettings.workerLifecycle.autoArchiveEnabled);
      setIdleMinutes(String(Math.round(nextSettings.workerLifecycle.idleTimeoutMs / 60_000)));
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, [runtime.dataRoot]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    void bridge.config
      .getPreferences()
      .then((next) => {
        setPreferences(next);
        setUpdateFeedDraft(next.updateFeedUrl ?? "");
      })
      .catch(() => undefined);
    void bridge.updates
      .status()
      .then(setUpdateStatus)
      .catch(() => undefined);
    return bridge.app.onStatus((status) => {
      setUpdateStatus(status.update);
    });
  }, [bridge]);

  async function savePolicy(): Promise<void> {
    const bytes = parseGb(reserveGb);
    if (bytes === null) {
      setPolicyMessage("Host Reserve 必须是有效数字");
      return;
    }
    const softBudgetBytes = parseGb(softBudgetGb);
    if (softBudgetBytes === null) {
      setPolicyMessage("Soft Memory Budget 必须是有效数字（0 表示自动）");
      return;
    }
    const idleSuspendTimeout = Number(idleSuspendMinutes);
    if (
      !Number.isFinite(idleSuspendTimeout) ||
      idleSuspendTimeout < 5 ||
      idleSuspendTimeout > 1440
    ) {
      setPolicyMessage("VM 空闲休眠时间必须为 5～1440 分钟");
      return;
    }
    const minutes = Number(idleMinutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
      setPolicyMessage("Worker 空闲归档时间必须为 1～1440 分钟");
      return;
    }
    setBusy(true);
    setPolicyMessage(null);
    try {
      const next = await api.updateSettings({
        resourcePolicy: {
          hostReserveBytes: bytes,
          softMemoryBudgetBytes: softBudgetBytes,
          autoStartPolicy: autoStart,
          idleSuspendEnabled: idleSuspend,
          idleSuspendTimeoutMs: Math.round(idleSuspendTimeout * 60_000),
        },
        security: { requireApprovalForSensitiveActions: approval },
        workerLifecycle: {
          autoArchiveEnabled: autoArchive,
          idleTimeoutMs: Math.round(minutes * 60_000),
        },
      });
      setSettings(next);
      setPolicyMessage("资源与安全设置已保存");
      await onChanged();
    } catch (error) {
      setPolicyMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function exportDiagnostics(): Promise<void> {
    setDiagnosticsBusy(true);
    setDiagnosticsMessage(null);
    try {
      const report = await api.diagnostics();
      const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `agent-in-box-diagnostics-${report.generatedAt.replace(/[:.]/g, "-")}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setDiagnosticsMessage("诊断报告已导出。报告可能包含路径和日志片段，请检查后再分享。");
    } catch (error) {
      setDiagnosticsMessage(errorMessage(error));
    } finally {
      setDiagnosticsBusy(false);
    }
  }

  async function cleanupDownloads(): Promise<void> {
    setBusy(true);
    setCleanupMessage(null);
    try {
      const result: StorageCleanupResult = await api.cleanupDownloads();
      setCleanupMessage(
        `已清理 ${result.filesDeleted} 个缓存文件，释放 ${formatBytes(result.bytesFreed)}。VM、镜像和项目数据未受影响。`,
      );
      setStorage(await api.storage());
    } catch (error) {
      setCleanupMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function browseTarget(): Promise<void> {
    const selected = await chooseDirectory(bridge, {
      title: "选择新的数据目录",
      defaultPath: runtime.dataRoot,
    });
    if (selected) {
      setTargetRoot(selected);
      setMigrationValidation(null);
    }
  }

  async function validateTarget(): Promise<void> {
    if (!targetRoot.trim()) {
      setMigrationError("请先选择目标目录");
      return;
    }
    setMigrationBusy(true);
    setMigrationError(null);
    try {
      setMigrationValidation(await api.validateStorage(targetRoot.trim()));
    } catch (error) {
      setMigrationError(errorMessage(error));
    } finally {
      setMigrationBusy(false);
    }
  }

  async function migrate(): Promise<void> {
    if (!migrationValidation?.ok || !migrationAcknowledged) {
      return;
    }
    setMigrationBusy(true);
    setMigrationError(null);
    try {
      const result = await api.migrateStorage(migrationValidation.resolvedPath);
      onRestartRequired({
        targetRoot: result.to,
        reason: `数据已从 ${result.from} 迁移到 ${result.to}，需要重启本地服务以使用新目录。`,
      });
    } catch (error) {
      setMigrationError(errorMessage(error));
      setMigrationValidation(null);
    } finally {
      setMigrationBusy(false);
    }
  }

  async function changeCloseBehavior(value: DesktopPreferences["closeBehavior"]): Promise<void> {
    if (!preferences) return;
    setPreferences({ ...preferences, closeBehavior: value });
    try {
      const next = await savePreferences(bridge, { closeBehavior: value });
      if (next) setPreferences(next);
    } catch (error) {
      setPolicyMessage(errorMessage(error));
    }
  }

  async function saveDesktopPreferences(): Promise<void> {
    if (!preferences) return;
    setPreferencesMessage(null);
    try {
      const next = await savePreferences(bridge, {
        launchAtLogin: preferences.launchAtLogin,
        notificationsEnabled: preferences.notificationsEnabled,
        autoUpdateCheck: preferences.autoUpdateCheck,
        updateFeedUrl: updateFeedDraft.trim() ? updateFeedDraft.trim() : null,
      });
      if (next) {
        setPreferences(next);
        setUpdateFeedDraft(next.updateFeedUrl ?? "");
      }
      setPreferencesMessage("桌面与更新设置已保存");
    } catch (error) {
      setPreferencesMessage(errorMessage(error));
    }
  }

  async function runUpdateAction(action: "check" | "download"): Promise<void> {
    if (!bridge || updateBusy) return;
    setUpdateBusy(true);
    setUpdateMessage(null);
    try {
      const next =
        action === "check" ? await bridge.updates.check() : await bridge.updates.download();
      setUpdateStatus(next);
      if (next.state === "error") setUpdateMessage(next.error);
      else if (next.state === "up_to_date") setUpdateMessage("当前已是最新版本");
      else if (next.state === "available") setUpdateMessage(`发现新版本 ${next.availableVersion}`);
      else if (next.state === "ready") setUpdateMessage("更新已下载并通过 SHA-256 校验，可安装");
    } catch (error) {
      setUpdateMessage(errorMessage(error));
    } finally {
      setUpdateBusy(false);
    }
  }

  async function runUpdateInstall(): Promise<void> {
    if (!bridge || updateBusy) return;
    if (
      !window.confirm(
        "安装更新会先停止本地服务，备份 SQLite 数据库和当前应用资源，然后退出并启动安装程序。继续吗？",
      )
    ) {
      return;
    }
    setUpdateBusy(true);
    setUpdateMessage(null);
    try {
      await bridge.updates.install();
    } catch (error) {
      setUpdateMessage(errorMessage(error));
    } finally {
      setUpdateBusy(false);
    }
  }

  async function runUpdateRollback(): Promise<void> {
    if (!bridge || updateBusy) return;
    if (
      !window.confirm("回滚会停止本地服务，恢复上一版本的资源和数据库备份，然后重启应用。继续吗？")
    ) {
      return;
    }
    setUpdateBusy(true);
    setUpdateMessage(null);
    try {
      await bridge.updates.rollback();
    } catch (error) {
      setUpdateMessage(errorMessage(error));
    } finally {
      setUpdateBusy(false);
    }
  }

  async function rotateAccessKey(): Promise<void> {
    if (rotateBusy) return;
    if (
      !window.confirm(
        "更换本机访问密钥会让其他浏览器会话立即失效（当前会话保留）。请准备好重新读取密钥文件。继续吗？",
      )
    ) {
      return;
    }
    setRotateBusy(true);
    setRotateMessage(null);
    try {
      const result = await api.rotateAccessKey();
      setRotateMessage(
        `已更换访问密钥并撤销 ${result.revokedSessions} 个其他会话。新密钥文件：${result.accessKeyPath}`,
      );
    } catch (error) {
      setRotateMessage(errorMessage(error));
    } finally {
      setRotateBusy(false);
    }
  }

  const usedPercent =
    storage && storage.totalBytes > 0
      ? Math.min(
          100,
          Math.max(0, ((storage.totalBytes - storage.freeBytes) / storage.totalBytes) * 100),
        )
      : 0;

  const workView: WorkView | null =
    view === "session" || view === "projects" || view === "tasks" || view === "archive"
      ? view
      : null;

  return (
    <div className="dashboard">
      {loadError && (
        <div className="notice" role="alert">
          {loadError}
        </div>
      )}

      {view === "overview" && (
        <section className="grid dashboard-grid" aria-label="本机总览">
          <article className="card">
            <div className="card-title">
              <h2>本地控制平面</h2>
              <span
                className={`pill ${controlPlaneState === "running" || !controlPlaneState ? "ok" : "warn"}`}
              >
                {controlPlaneState ? CONTROL_PLANE_STATE_LABELS[controlPlaneState] : "运行中"}
              </span>
            </div>
            <dl>
              <div>
                <dt>协议版本</dt>
                <dd>{health.protocolVersion}</dd>
              </div>
              <div>
                <dt>启动时间</dt>
                <dd>{formatDate(health.startedAt)}</dd>
              </div>
              <div>
                <dt>数据目录来源</dt>
                <dd>{DATA_ROOT_SOURCE_LABELS[runtime.dataRootSource]}</dd>
              </div>
              <div>
                <dt>数据库</dt>
                <dd className="truncate" title={runtime.databasePath}>
                  {runtime.databasePath}
                </dd>
              </div>
            </dl>
          </article>

          <article className="card">
            <div className="card-title">
              <h2>宿主机</h2>
              <span className={`pill ${host?.ready ? "ok" : "warn"}`}>
                {host ? (host.ready ? "就绪" : "待修复") : "检查中"}
              </span>
            </div>
            {host ? (
              <>
                <dl>
                  <div>
                    <dt>系统</dt>
                    <dd>
                      {host.platform} · {host.release}
                    </dd>
                  </div>
                  <div>
                    <dt>内存</dt>
                    <dd>{formatBytes(host.totalMemoryBytes)}</dd>
                  </div>
                  <div>
                    <dt>存储可用</dt>
                    <dd>{formatBytes(host.freeDiskBytes)}</dd>
                  </div>
                  <div>
                    <dt>建议 Provider</dt>
                    <dd>{host.recommendedProvider ?? "—"}</dd>
                  </div>
                </dl>
                <ul className="mini-checks">
                  {host.checks.map((check) => (
                    <li key={check.id} className={check.status}>
                      <span>{HOST_CHECK_STATUS_LABELS[check.status]}</span>
                      {check.id}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="muted">正在读取宿主机信息…</p>
            )}
          </article>

          <article className="card">
            <div className="card-title">
              <h2>本机身份与安全</h2>
              <span className="pill ok">管理员</span>
            </div>
            <dl>
              <div>
                <dt>显示名称</dt>
                <dd>
                  {settings?.onboarding.localUser?.displayName ??
                    onboarding.localUser?.displayName ??
                    "—"}
                </dd>
              </div>
              <div>
                <dt>敏感操作审批</dt>
                <dd>{approval ? "开启" : "关闭"}</dd>
              </div>
              <div>
                <dt>模型凭据</dt>
                <dd>
                  {onboarding.credentialsConfigured
                    ? (onboarding.preferredModelProvider ?? "已配置")
                    : "未配置"}
                </dd>
              </div>
              <div>
                <dt>凭据存储</dt>
                <dd>{bridge ? "系统安全存储" : "仅桌面应用可用"}</dd>
              </div>
            </dl>
          </article>
        </section>
      )}

      {workView && (
        <WorkManager
          view={workView}
          {...(onOpenWorker ? { onOpenWorker } : {})}
          {...(initialProjectId ? { focusProjectId: initialProjectId } : {})}
          onOpenVmConsole={(vmId) => {
            consoleNonce.current += 1;
            setConsoleRequest({ vmId, nonce: consoleNonce.current });
            onNavigate("vms");
          }}
        />
      )}

      {view === "overview" && <VmRuntimeSettings bridge={bridge} />}
      {view === "settings" && <ModelSettings bridge={bridge} />}
      {view === "settings" && <VmRuntimeSettings bridge={bridge} />}
      {view === "settings" && <BotManager bridge={bridge} />}

      {view === "vms" && (
        <VmManager
          host={host}
          consoleRequest={consoleRequest}
          onConsoleRequestConsumed={(request) =>
            setConsoleRequest((current) => (current?.nonce === request.nonce ? null : current))
          }
          hostReserveBytes={
            settings?.resourcePolicy.hostReserveBytes ?? onboarding.resourcePolicy.hostReserveBytes
          }
        />
      )}

      {view === "settings" && (
        <section className="panel" aria-labelledby="storage-title">
          <div className="panel-heading">
            <h2 id="storage-title">存储</h2>
            <button
              type="button"
              className="secondary"
              onClick={() => void reload()}
              disabled={busy}
            >
              重新检查
            </button>
          </div>
          {storage ? (
            <>
              <div className="storage-summary">
                <div>
                  <span className="muted small">数据根目录</span>
                  <code>{storage.root}</code>
                </div>
                <div>
                  <span className="muted small">可用 / 总量</span>
                  <strong>
                    {formatBytes(storage.freeBytes)} / {formatBytes(storage.totalBytes)}
                  </strong>
                </div>
              </div>
              <div className="meter" aria-hidden="true">
                <span style={{ width: `${usedPercent}%` }} />
              </div>
              <ul className="usage-list">
                {storage.categories.map((category) => (
                  <li key={category.category}>
                    <span>{STORAGE_CATEGORY_LABELS[category.category]}</span>
                    <span className="muted">{category.files} 个文件</span>
                    <strong>{formatBytes(category.bytes)}</strong>
                  </li>
                ))}
                <li>
                  <span>数据库</span>
                  <span className="muted">元数据</span>
                  <strong>{formatBytes(storage.databaseBytes)}</strong>
                </li>
              </ul>
              {storage.lock && (
                <div className="notice small">
                  存储锁：{storage.lock.operation} · {storage.lock.owner} · pid {storage.lock.pid}
                </div>
              )}
              {storage.pendingMigration && (
                <div className="notice small">
                  检测到未完成迁移：{storage.pendingMigration.targetRoot}（
                  {formatDate(storage.pendingMigration.startedAt)}）。请重新执行迁移或检查日志。
                </div>
              )}
              <div className="action-row">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void cleanupDownloads()}
                  disabled={busy}
                >
                  清理下载缓存
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setShowMigration((value) => !value)}
                  disabled={runtime.dataRootSource === "environment"}
                >
                  {showMigration ? "收起迁移" : "迁移存储位置"}
                </button>
              </div>
              {runtime.dataRootSource === "environment" && (
                <p className="muted small">
                  数据根目录由 AGENT_IN_BOX_DATA_ROOT 管理，当前界面不允许迁移。
                </p>
              )}
              {cleanupMessage && <p className="muted small">{cleanupMessage}</p>}

              {showMigration && (
                <div className="migration-box">
                  <h3>迁移到新目录</h3>
                  <p className="muted small">
                    迁移会在存储锁保护下复制镜像、VM、快照和产物，校验文件哈希与 SQLite
                    完整性，最后更新配置。旧目录不会自动删除。迁移期间不要运行 VM。
                  </p>
                  <div className="input-row">
                    <input
                      value={targetRoot}
                      onChange={(event) => {
                        setTargetRoot(event.target.value);
                        setMigrationValidation(null);
                      }}
                      placeholder="例如 D:\\AgentInBox"
                      spellCheck={false}
                    />
                    {bridge && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => void browseTarget()}
                      >
                        浏览…
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void validateTarget()}
                      disabled={migrationBusy}
                    >
                      检查目标
                    </button>
                  </div>
                  {migrationValidation && (
                    <div className={`validation-box ${migrationValidation.ok ? "ok" : "bad"}`}>
                      <strong>{migrationValidation.ok ? "目标可用" : "目标不可用"}</strong>
                      <span className="muted small">{migrationValidation.resolvedPath}</span>
                      <span className="muted small">
                        可用 {formatBytes(migrationValidation.freeBytes)}
                      </span>
                      {migrationValidation.errors.map((error) => (
                        <span key={error} className="error-line">
                          {error}
                        </span>
                      ))}
                    </div>
                  )}
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={migrationAcknowledged}
                      onChange={(event) => setMigrationAcknowledged(event.target.checked)}
                    />
                    <span>我确认迁移期间没有运行中的 VM，并理解完成后需要重启本地服务。</span>
                  </label>
                  {migrationError && <div className="notice">{migrationError}</div>}
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void migrate()}
                    disabled={migrationBusy || !migrationValidation?.ok || !migrationAcknowledged}
                  >
                    {migrationBusy ? "正在迁移…" : "开始迁移"}
                  </button>
                </div>
              )}
            </>
          ) : (
            <p className="muted">正在读取存储信息…</p>
          )}
        </section>
      )}

      {view === "settings" && (
        <section className="panel" aria-labelledby="resource-title">
          <div className="panel-heading">
            <h2 id="resource-title">资源策略</h2>
            <span className="muted small">
              宿主机内存 {host ? formatBytes(host.totalMemoryBytes) : "未知"}
            </span>
          </div>
          <div className="policy-grid">
            <label className="field">
              <span>Host Reserve（GB）</span>
              <input
                type="number"
                min="0"
                step="0.5"
                value={reserveGb}
                onChange={(event) => setReserveGb(event.target.value)}
              />
            </label>
            <label className="field">
              <span>自动启动</span>
              <select
                value={autoStart}
                onChange={(event) => setAutoStart(event.target.value as AutoStartPolicy)}
              >
                <option value="manual">仅手动启动</option>
                <option value="when_needed">有任务时自动启动</option>
              </select>
            </label>
            <label className="field">
              <span>Soft Memory Budget（GB，0 = 自动）</span>
              <input
                type="number"
                min="0"
                step="0.5"
                value={softBudgetGb}
                onChange={(event) => setSoftBudgetGb(event.target.value)}
              />
            </label>
            <label className="toggle policy-toggle">
              <input
                type="checkbox"
                checked={idleSuspend}
                onChange={(event) => setIdleSuspend(event.target.checked)}
              />
              <span>VM 空闲后自动休眠</span>
            </label>
            <label className="field">
              <span>VM 空闲休眠（分钟）</span>
              <input
                type="number"
                min="5"
                max="1440"
                step="1"
                value={idleSuspendMinutes}
                onChange={(event) => setIdleSuspendMinutes(event.target.value)}
                disabled={!idleSuspend}
              />
            </label>
            <label className="toggle policy-toggle">
              <input
                type="checkbox"
                checked={approval}
                onChange={(event) => setApproval(event.target.checked)}
              />
              <span>敏感操作需要审批</span>
            </label>
            <label className="toggle policy-toggle">
              <input
                type="checkbox"
                checked={autoArchive}
                onChange={(event) => setAutoArchive(event.target.checked)}
              />
              <span>Worker 空闲后自动归档</span>
            </label>
            <label className="field">
              <span>Worker 空闲归档（分钟）</span>
              <input
                type="number"
                min="1"
                max="1440"
                step="1"
                value={idleMinutes}
                onChange={(event) => setIdleMinutes(event.target.value)}
                disabled={!autoArchive}
              />
            </label>
          </div>
          <p className="muted small">
            有运行任务、待审批、排队消息或 Execution Lease 的 Worker 不会被归档；归档只停止 Worker
            会话，不停止 VM。
          </p>
          <div className="action-row">
            <button
              type="button"
              className="primary"
              onClick={() => void savePolicy()}
              disabled={busy}
            >
              {busy ? "保存中…" : "保存设置"}
            </button>
            {policyMessage && <span className="muted small">{policyMessage}</span>}
          </div>
        </section>
      )}

      {view === "settings" && (
        <section className="panel muted-panel" aria-labelledby="runtime-title">
          <div className="panel-heading">
            <h2 id="runtime-title">运行信息</h2>
            <span className="muted small">本机诊断</span>
          </div>
          <dl className="runtime-list">
            <div>
              <dt>配置文件</dt>
              <dd>
                <code>{runtime.configPath}</code>
              </dd>
            </div>
            <div>
              <dt>数据根目录</dt>
              <dd>
                <code>{runtime.dataRoot}</code>
              </dd>
            </div>
            <div>
              <dt>镜像 / 下载</dt>
              <dd>
                <code>{runtime.storage.images}</code>
              </dd>
            </div>
            <div>
              <dt>VM / 快照</dt>
              <dd>
                <code>{runtime.storage.vms}</code>
              </dd>
            </div>
          </dl>
          <div className="action-row">
            <button
              type="button"
              className="secondary"
              onClick={() => void exportDiagnostics()}
              disabled={diagnosticsBusy}
            >
              {diagnosticsBusy ? "生成中…" : "导出本机诊断报告"}
            </button>
            {bridge && (
              <>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void bridge.app.openLogs()}
                >
                  打开日志目录
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void bridge.app.restartControlPlane()}
                >
                  重启本地服务
                </button>
              </>
            )}
          </div>
          <p className="muted small">
            诊断报告包含版本、数据库计数、迁移备份和最近的桌面日志，不会自动上传。报告可能包含本机路径、任务或错误片段等敏感信息，分享前请检查。
          </p>
          {diagnosticsMessage && <p className="muted small">{diagnosticsMessage}</p>}
        </section>
      )}

      {view === "settings" && (
        <DesktopSettingsPanels
          bridge={bridge}
          preferences={preferences}
          setPreferences={setPreferences}
          preferencesMessage={preferencesMessage}
          updateFeedDraft={updateFeedDraft}
          setUpdateFeedDraft={setUpdateFeedDraft}
          updateStatus={updateStatus}
          updateBusy={updateBusy}
          updateMessage={updateMessage}
          onSavePreferences={() => void saveDesktopPreferences()}
          onUpdateAction={(action) => void runUpdateAction(action)}
          onInstall={() => void runUpdateInstall()}
          onRollback={() => void runUpdateRollback()}
          onCloseBehaviorChange={(value) => void changeCloseBehavior(value)}
          authInfo={authInfo}
          rotateBusy={rotateBusy}
          rotateMessage={rotateMessage}
          onRotate={() => void rotateAccessKey()}
          controlPlaneState={controlPlaneState}
        />
      )}
    </div>
  );
}

interface DesktopSettingsPanelsProps {
  bridge: DesktopBridge | null;
  preferences: DesktopPreferences | null;
  setPreferences(value: DesktopPreferences): void;
  preferencesMessage: string | null;
  updateFeedDraft: string;
  setUpdateFeedDraft(value: string): void;
  updateStatus: DesktopUpdateStatus | null;
  updateBusy: boolean;
  updateMessage: string | null;
  onSavePreferences(): void;
  onUpdateAction(action: "check" | "download"): void;
  onInstall(): void;
  onRollback(): void;
  onCloseBehaviorChange(value: DesktopPreferences["closeBehavior"]): void;
  authInfo: LocalAuthSessionView;
  rotateBusy: boolean;
  rotateMessage: string | null;
  onRotate(): void;
  controlPlaneState: ControlPlaneState | null;
}

function DesktopSettingsPanels({
  bridge,
  preferences,
  setPreferences,
  preferencesMessage,
  updateFeedDraft,
  setUpdateFeedDraft,
  updateStatus,
  updateBusy,
  updateMessage,
  onSavePreferences,
  onUpdateAction,
  onInstall,
  onRollback,
  onCloseBehaviorChange,
  authInfo,
  rotateBusy,
  rotateMessage,
  onRotate,
  controlPlaneState,
}: DesktopSettingsPanelsProps): React.JSX.Element {
  return (
    <>
      <section className="panel" aria-labelledby="desktop-settings-title">
        <div className="panel-heading">
          <div>
            <h2 id="desktop-settings-title">桌面与后台服务</h2>
            <p className="muted small">这些选项只在 Electron 桌面应用中可用。</p>
          </div>
          <span className="pill ok">
            {controlPlaneState ? CONTROL_PLANE_STATE_LABELS[controlPlaneState] : "运行中"}
          </span>
        </div>
        {!bridge || !preferences ? (
          <p className="muted">
            当前通过浏览器访问；桌面服务管理、开机启动和原生通知仅桌面应用可用。
          </p>
        ) : (
          <>
            <div className="policy-grid">
              <label className="field">
                <span>关闭窗口时</span>
                <select
                  value={preferences.closeBehavior}
                  onChange={(event) =>
                    onCloseBehaviorChange(event.target.value as DesktopPreferences["closeBehavior"])
                  }
                >
                  <option value="keep_running">后台继续运行</option>
                  <option value="quit">停止服务并退出</option>
                </select>
              </label>
              <label className="toggle policy-toggle">
                <input
                  type="checkbox"
                  checked={preferences.launchAtLogin}
                  onChange={(event) =>
                    setPreferences({ ...preferences, launchAtLogin: event.target.checked })
                  }
                />
                <span>开机时启动（隐藏到托盘）</span>
              </label>
              <label className="toggle policy-toggle">
                <input
                  type="checkbox"
                  checked={preferences.notificationsEnabled}
                  onChange={(event) =>
                    setPreferences({
                      ...preferences,
                      notificationsEnabled: event.target.checked,
                    })
                  }
                />
                <span>任务和审批使用桌面通知</span>
              </label>
              <label className="toggle policy-toggle">
                <input
                  type="checkbox"
                  checked={preferences.autoUpdateCheck}
                  onChange={(event) =>
                    setPreferences({ ...preferences, autoUpdateCheck: event.target.checked })
                  }
                />
                <span>启动后自动检查更新</span>
              </label>
              <label className="field">
                <span>更新源（HTTPS Manifest）</span>
                <input
                  value={updateFeedDraft}
                  placeholder="https://updates.example.com/latest.json"
                  spellCheck={false}
                  onChange={(event) => setUpdateFeedDraft(event.target.value)}
                />
              </label>
            </div>
            <div className="action-row">
              <button type="button" className="primary" onClick={onSavePreferences}>
                保存桌面设置
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => void bridge.app.restartControlPlane()}
              >
                重启本地服务
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => void bridge.app.stopControlPlane()}
              >
                停止本地服务
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => void bridge.app.startControlPlane()}
              >
                启动本地服务
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => void bridge.app.openLogs()}
              >
                打开日志目录
              </button>
            </div>
            {preferencesMessage && <p className="muted small">{preferencesMessage}</p>}
          </>
        )}
      </section>

      <section className="panel" aria-labelledby="updates-title">
        <div className="panel-heading">
          <div>
            <h2 id="updates-title">更新与回滚</h2>
            <p className="muted small">
              安装前备份 SQLite 数据库和当前应用资源；更新失败可在本页回到上一版本。
            </p>
          </div>
          <span className={`pill ${updateStatus?.state === "error" ? "warn" : "ok"}`}>
            {updateStatus?.currentVersion ?? "—"}
          </span>
        </div>
        {!bridge ? (
          <p className="muted">更新只适用于桌面安装版。</p>
        ) : (
          <>
            <dl className="runtime-list">
              <div>
                <dt>当前版本</dt>
                <dd>{updateStatus?.currentVersion ?? "—"}</dd>
              </div>
              <div>
                <dt>可用版本</dt>
                <dd>{updateStatus?.availableVersion ?? "—"}</dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd>{updateStatus?.state ?? "idle"}</dd>
              </div>
            </dl>
            {updateStatus?.notes && <p className="muted small">{updateStatus.notes}</p>}
            {updateStatus?.downloadProgress !== null &&
              updateStatus?.downloadProgress !== undefined && (
                <div
                  className="meter"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(updateStatus.downloadProgress * 100)}
                  aria-label={`下载进度 ${Math.round(updateStatus.downloadProgress * 100)}%`}
                >
                  <span style={{ width: `${Math.round(updateStatus.downloadProgress * 100)}%` }} />
                </div>
              )}
            {updateStatus?.error && (
              <div className="notice" role="alert">
                {updateStatus.error}
              </div>
            )}
            {updateMessage && (
              <p className="muted small" role="status">
                {updateMessage}
              </p>
            )}
            <div className="action-row">
              <button
                type="button"
                className="secondary"
                disabled={updateBusy}
                onClick={() => onUpdateAction("check")}
              >
                检查更新
              </button>
              <button
                type="button"
                className="secondary"
                disabled={updateBusy || updateStatus?.state !== "available"}
                onClick={() => onUpdateAction("download")}
              >
                下载并校验
              </button>
              <button
                type="button"
                className="primary"
                disabled={updateBusy || !updateStatus?.readyToInstall}
                onClick={onInstall}
              >
                安装并重启
              </button>
              <button
                type="button"
                className="secondary"
                disabled={updateBusy || !updateStatus?.rollbackAvailable}
                onClick={onRollback}
              >
                回滚到上一版本
              </button>
            </div>
            {updateStatus?.rollbackAvailable && (
              <p className="muted small">
                可回滚版本：{updateStatus.rollbackAvailable.version} · 数据库备份：
                {updateStatus.rollbackAvailable.databaseBackupPath ?? "无"}
              </p>
            )}
          </>
        )}
      </section>

      <section className="panel" aria-labelledby="auth-settings-title">
        <div className="panel-heading">
          <h2 id="auth-settings-title">本机身份与认证</h2>
          <span className="pill ok">{authInfo.user?.displayName ?? "本机管理员"}</span>
        </div>
        <dl className="runtime-list">
          <div>
            <dt>访问密钥文件</dt>
            <dd>
              <code>{authInfo.accessKeyPath}</code>
            </dd>
          </div>
          <div>
            <dt>会话过期</dt>
            <dd>{authInfo.expiresAt ? formatDate(authInfo.expiresAt) : "—"}</dd>
          </div>
        </dl>
        <p className="muted small">
          控制平面只接受回环地址和同源请求，写操作需要 CSRF
          令牌。更换访问密钥会使其他浏览器会话立即失效。
        </p>
        <div className="action-row">
          <button type="button" className="secondary" disabled={rotateBusy} onClick={onRotate}>
            {rotateBusy ? "正在更换…" : "更换本机访问密钥"}
          </button>
          {rotateMessage && <span className="muted small">{rotateMessage}</span>}
        </div>
      </section>
    </>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
