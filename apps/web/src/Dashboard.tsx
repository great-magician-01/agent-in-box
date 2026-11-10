/* eslint-disable react-hooks/set-state-in-effect -- initial data fetch effects intentionally set loading/result state */
import { useCallback, useEffect, useState } from "react";
import type {
  AutoStartPolicy,
  CloseBehavior,
  ControlPlaneState,
  DesktopBridge,
  HealthResponse,
  HostInspectionReport,
  OnboardingState,
  RuntimeInfo,
  SettingsView,
  StorageCleanupResult,
  StorageReport,
  StorageValidation,
} from "@agent-in-box/protocol";
import { api, ApiRequestError } from "./api";
import { chooseDirectory, saveCloseBehavior } from "./desktop";
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
  onboarding: OnboardingState;
  runtime: RuntimeInfo;
  health: HealthResponse;
  bridge: DesktopBridge | null;
  controlPlaneState: ControlPlaneState | null;
  onChanged(): Promise<void>;
  onRestartRequired(request: RestartRequest): void;
}

export function Dashboard({
  onboarding,
  runtime,
  health,
  bridge,
  controlPlaneState,
  onChanged,
  onRestartRequired,
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
  const [approval, setApproval] = useState(onboarding.security.requireApprovalForSensitiveActions);
  const [policyMessage, setPolicyMessage] = useState<string | null>(null);

  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior | null>(null);
  const [showMigration, setShowMigration] = useState(false);
  const [targetRoot, setTargetRoot] = useState("");
  const [migrationValidation, setMigrationValidation] = useState<StorageValidation | null>(null);
  const [migrationAcknowledged, setMigrationAcknowledged] = useState(false);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationError, setMigrationError] = useState<string | null>(null);

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
      setApproval(nextSettings.security.requireApprovalForSensitiveActions);
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
      .getCloseBehavior()
      .then(setCloseBehavior)
      .catch(() => undefined);
  }, [bridge]);

  async function savePolicy(): Promise<void> {
    const bytes = parseGb(reserveGb);
    if (bytes === null) {
      setPolicyMessage("Host Reserve 必须是有效数字");
      return;
    }
    setBusy(true);
    setPolicyMessage(null);
    try {
      const next = await api.updateSettings({
        resourcePolicy: { hostReserveBytes: bytes, autoStartPolicy: autoStart },
        security: { requireApprovalForSensitiveActions: approval },
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

  async function changeCloseBehavior(value: CloseBehavior): Promise<void> {
    setCloseBehavior(value);
    try {
      await saveCloseBehavior(bridge, value);
    } catch (error) {
      setPolicyMessage(errorMessage(error));
    }
  }

  const usedPercent =
    storage && storage.totalBytes > 0
      ? Math.min(
          100,
          Math.max(0, ((storage.totalBytes - storage.freeBytes) / storage.totalBytes) * 100),
        )
      : 0;

  return (
    <div className="dashboard">
      {loadError && <div className="notice">{loadError}</div>}

      <section className="grid dashboard-grid">
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

      <section className="panel">
        <div className="panel-heading">
          <h2>存储</h2>
          <button type="button" className="secondary" onClick={() => void reload()} disabled={busy}>
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
                    <button type="button" className="secondary" onClick={() => void browseTarget()}>
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

      <section className="panel">
        <div className="panel-heading">
          <h2>资源策略</h2>
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
          {bridge && closeBehavior && (
            <label className="field">
              <span>关闭窗口时</span>
              <select
                value={closeBehavior}
                onChange={(event) => void changeCloseBehavior(event.target.value as CloseBehavior)}
              >
                <option value="keep_running">后台继续运行</option>
                <option value="quit">停止服务并退出</option>
              </select>
            </label>
          )}
          <label className="toggle policy-toggle">
            <input
              type="checkbox"
              checked={approval}
              onChange={(event) => setApproval(event.target.checked)}
            />
            <span>敏感操作需要审批</span>
          </label>
        </div>
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

      <section className="panel muted-panel">
        <div className="panel-heading">
          <h2>运行信息</h2>
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
        {bridge && (
          <div className="action-row">
            <button type="button" className="secondary" onClick={() => void bridge.app.openLogs()}>
              打开日志目录
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void bridge.app.restartControlPlane()}
            >
              重启本地服务
            </button>
          </div>
        )}
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
