/* eslint-disable react-hooks/set-state-in-effect -- plugin registry and project snapshots load on entry */
import { useCallback, useEffect, useState } from "react";
import type {
  DesktopBridge,
  PluginEnablementView,
  PluginVersionView,
  ProjectView,
  WorkerView,
} from "@agent-in-box/protocol";
import { api } from "./api";

interface PluginManagerProps {
  bridge: DesktopBridge | null;
  onOpenWorker?: ((projectId: string, workerId: string) => void) | undefined;
}

export function PluginManager({ bridge, onOpenWorker }: PluginManagerProps) {
  const [plugins, setPlugins] = useState<PluginVersionView[]>([]);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [enablements, setEnablements] = useState<PluginEnablementView[]>([]);
  const [projectId, setProjectId] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [autoEnable, setAutoEnable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextPlugins, nextProjects, nextEnablements] = await Promise.all([
        api.plugins(),
        api.projects(false),
        api.pluginEnablements(),
      ]);
      setPlugins(nextPlugins);
      setProjects(nextProjects);
      setEnablements(nextEnablements);
      setProjectId((current) => current || nextProjects[0]?.project.id || "");
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function browse(): Promise<void> {
    if (!bridge) return;
    const selected = await bridge.dialog.chooseDirectory({
      title: "选择包含 manifest.json 的插件目录",
    });
    if (selected) setSourcePath(selected);
  }

  async function register(): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const plugin = await api.registerPlugin({ sourcePath, source: "user" });
      setSourcePath("");
      setMessage(`已注册 ${plugin.displayName} ${plugin.version}；启用后对下一 Worker 会话生效`);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function enable(plugin: PluginVersionView): Promise<void> {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      await api.enablePlugin(plugin.pluginId, {
        version: plugin.version,
        scopeType: "project",
        scopeId: projectId,
      });
      setMessage(`已为当前项目启用 ${plugin.displayName}；下一 Worker 会话生效`);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function disable(pluginId: string): Promise<void> {
    setBusy(true);
    try {
      await api.disablePlugin(pluginId, "project", projectId);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function createDevelopmentWorker(): Promise<WorkerView | null> {
    const project = projects.find((candidate) => candidate.project.id === projectId);
    const binding = project?.bindings.find((candidate) => candidate.binding.isPrimary);
    if (!project || !binding) {
      setError("所选项目还没有主 VM；请先让执行环境就绪");
      return null;
    }
    setBusy(true);
    setError(null);
    try {
      const worker = await api.createWorker({
        projectId,
        vmId: binding.binding.vmId,
        forceNew: true,
        developmentMode: true,
        aiPluginAutoEnable: autoEnable,
      });
      setMessage("Development Worker 已创建，可在会话中直接描述要开发的插件");
      onOpenWorker?.(projectId, worker.worker.id);
      return worker;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return null;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel settings-panel">
      <header className="section-heading">
        <div>
          <h2>Agent 插件</h2>
          <p>导入、测试、注册和按项目启用 Pi 扩展。运行中的会话不会被热替换。</p>
        </div>
        <button type="button" className="secondary" onClick={() => void refresh()} disabled={busy}>
          刷新
        </button>
      </header>

      <div className="credential-box">
        <h3>AI 插件开发模式</h3>
        <p className="muted small">
          创建独立的 Guest Development Worker。AI 可使用模板、文件和 Shell
          开发插件，测试通过后注册到本机。
        </p>
        <label className="field">
          <span>开发项目</span>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((project) => (
              <option key={project.project.id} value={project.project.id}>
                {project.project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={autoEnable}
            onChange={(event) => setAutoEnable(event.target.checked)}
          />
          <span>
            <strong>允许 AI 在当前项目自动启用通过测试的插件</strong>
            <small>不允许跨项目、全局启用或申请宿主权限；可随时关闭。</small>
          </span>
        </label>
        <button
          type="button"
          className="primary"
          disabled={busy || !projectId}
          onClick={() => void createDevelopmentWorker()}
        >
          创建并打开 Development Worker
        </button>
      </div>

      <div className="credential-box">
        <h3>导入本地插件</h3>
        <label className="field">
          <span>插件目录</span>
          <div className="input-row">
            <input
              value={sourcePath}
              onChange={(event) => setSourcePath(event.target.value)}
              placeholder="包含 manifest.json 的本地目录"
              spellCheck={false}
            />
            {bridge && (
              <button type="button" className="secondary" onClick={() => void browse()}>
                浏览…
              </button>
            )}
          </div>
        </label>
        <p className="muted small">
          导入只读取和校验文件，不执行插件。包最大 4 MiB，版本内容不可变。
        </p>
        <button
          type="button"
          className="secondary"
          disabled={busy || !sourcePath.trim()}
          onClick={() => void register()}
        >
          校验并注册
        </button>
      </div>

      {message && <div className="validation-box ok">{message}</div>}
      {error && <div className="notice">{error}</div>}

      <div className="stack">
        <h3>已注册版本</h3>
        {plugins.length === 0 ? (
          <p className="muted">还没有用户或 AI 插件。CUA、Subagent 和开发工具由应用内置。</p>
        ) : (
          <ul className="plugin-list">
            {plugins.map((plugin) => {
              const enabled = enablements.some(
                (item) =>
                  item.pluginId === plugin.pluginId &&
                  item.version === plugin.version &&
                  item.scopeType === "project" &&
                  item.scopeId === projectId &&
                  item.enabled,
              );
              return (
                <li key={`${plugin.pluginId}@${plugin.version}`}>
                  <div>
                    <strong>{plugin.displayName}</strong>
                    <span className="muted small">
                      {plugin.pluginId} · {plugin.version} · {plugin.source}
                    </span>
                    <code title={plugin.packageSha256}>{plugin.packageSha256.slice(0, 16)}…</code>
                  </div>
                  {enabled ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || !projectId}
                      onClick={() => void disable(plugin.pluginId)}
                    >
                      在当前项目禁用
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || !projectId || plugin.status !== "registered"}
                      onClick={() => void enable(plugin)}
                    >
                      在当前项目启用
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
