/* eslint-disable react-hooks/set-state-in-effect -- initial fetch and SSE effects intentionally update state */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GuestHealthState,
  HostInspectionReport,
  ImageCatalog,
  ImageRecord,
  ImageStatus,
  VmConsoleSession,
  VmCreateRequest,
  VmInstanceView,
  VmListResponse,
  VmPowerState,
} from "@agent-in-box/protocol";
import { api, ApiRequestError, subscribeImageEvents, type ImageEventStreamState } from "./api";
import { VmConsole } from "./VmConsole";
import {
  GUEST_HEALTH_LABELS,
  IMAGE_STATUS_LABELS,
  TASK_STATUS_LABELS,
  VM_POWER_STATE_LABELS,
  formatBytes,
  formatProgressPercent,
} from "./format";

const GIB = 1024 * 1024 * 1024;

type VmAction = "start" | "stop" | "suspend" | "resume" | "console";

interface Feedback {
  kind: "ok" | "error";
  text: string;
}

export interface VmManagerProps {
  host: HostInspectionReport | null;
  hostReserveBytes: number;
}

export function VmManager({ host, hostReserveBytes }: VmManagerProps): React.JSX.Element {
  const [catalog, setCatalog] = useState<ImageCatalog | null>(null);
  const [vms, setVms] = useState<VmListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [streamState, setStreamState] = useState<ImageEventStreamState>("reconnecting");

  const [downloadTotals, setDownloadTotals] = useState<Record<string, number>>({});
  const [downloadBusy, setDownloadBusy] = useState<Record<string, boolean>>({});
  const [cancelBusy, setCancelBusy] = useState<Record<string, boolean>>({});
  const [refreshingManifest, setRefreshingManifest] = useState(false);

  const [vmBusy, setVmBusy] = useState<Record<string, VmAction>>({});
  const [consoles, setConsoles] = useState<Record<string, VmConsoleSession>>({});

  const [showCreate, setShowCreate] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [imageId, setImageId] = useState("");
  const [cpuInput, setCpuInput] = useState("2");
  const [memoryInput, setMemoryInput] = useState("4");
  const [diskInput, setDiskInput] = useState("20");
  const [seedInput, setSeedInput] = useState("");

  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const vmBusyRef = useRef<Set<string>>(new Set());
  const downloadBusyRef = useRef<Set<string>>(new Set());
  const cancelBusyRef = useRef<Set<string>>(new Set());
  const cancelRequestedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (silent: boolean): Promise<void> => {
    if (!mountedRef.current || inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    if (!silent) {
      setLoading(true);
    }
    try {
      const [nextCatalog, nextVms] = await Promise.all([api.images(), api.vms()]);
      if (!mountedRef.current) {
        return;
      }
      setCatalog(nextCatalog);
      setVms(nextVms);
      setLoadError(null);
    } catch (error) {
      if (mountedRef.current) {
        setLoadError(errorMessage(error));
      }
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const unsubscribe = subscribeImageEvents((event) => {
      setDownloadTotals((current) => ({ ...current, [event.imageId]: event.totalBytes }));
      setCatalog((current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          items: current.items.map((item) =>
            item.id === event.imageId
              ? {
                  ...item,
                  status: event.status,
                  downloadedBytes: event.downloadedBytes,
                  errorCode: event.errorCode,
                  errorMessage: event.errorMessage,
                  updatedAt: event.occurredAt,
                }
              : item,
          ),
        };
      });
      if (
        event.status === "available" ||
        event.status === "failed" ||
        event.status === "cancelled"
      ) {
        void load(true);
      }
    }, setStreamState);
    return unsubscribe;
  }, [load]);

  const supervisorAvailable = vms?.supervisor.available ?? true;
  const supervisorMessage = vms?.supervisor.message ?? null;

  const availableImages = useMemo(
    () =>
      (catalog?.items ?? []).filter(
        (image) => image.osFamily === "linux" && image.status === "available",
      ),
    [catalog],
  );
  const selectedImageId = availableImages.some((image) => image.id === imageId)
    ? imageId
    : (availableImages[0]?.id ?? "");

  const activeDownloads = useMemo(
    () =>
      (catalog?.items ?? []).some(
        (image) => image.status === "downloading" || image.status === "verifying",
      ),
    [catalog],
  );
  const activeVm = useMemo(
    () =>
      supervisorAvailable &&
      (vms?.items ?? []).some((view) => {
        const power = effectivePower(view);
        return power === "running" || power === "starting" || power === "stopping";
      }),
    [vms, supervisorAvailable],
  );
  // Local in-flight download requests keep polling alive even when SSE is down.
  const downloadRequestActive = Object.keys(downloadBusy).length > 0;
  const autoRefresh = activeDownloads || activeVm || downloadRequestActive;

  useEffect(() => {
    if (!autoRefresh) {
      return;
    }
    const timer = window.setInterval(() => {
      void load(true);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load]);

  async function refreshAll(): Promise<void> {
    if (refreshing) {
      return;
    }
    setRefreshing(true);
    try {
      await load(true);
    } finally {
      if (mountedRef.current) {
        setRefreshing(false);
      }
    }
  }

  function replaceImage(record: ImageRecord): void {
    setCatalog((current) =>
      current === null
        ? current
        : {
            ...current,
            items: current.items.map((item) => (item.id === record.id ? record : item)),
          },
    );
  }

  function replaceVm(next: VmInstanceView): void {
    setVms((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        items: current.items.map((item) => (item.vm.id === next.vm.id ? next : item)),
      };
    });
  }

  async function downloadImage(image: ImageRecord): Promise<void> {
    if (downloadBusyRef.current.has(image.id) || cancelBusyRef.current.has(image.id)) {
      return;
    }
    setFeedback(null);
    cancelRequestedRef.current.delete(image.id);
    downloadBusyRef.current.add(image.id);
    setDownloadBusy((current) => ({ ...current, [image.id]: true }));
    try {
      const record = await api.downloadImage(image.id);
      if (!mountedRef.current) {
        return;
      }
      replaceImage(record);
      setFeedback({
        kind: "ok",
        text: `${record.name} 已下载并校验完成，现在可用于创建 VM。`,
      });
      void load(true);
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      if (cancelRequestedRef.current.has(image.id) || isCancelledDownload(error)) {
        setFeedback({ kind: "ok", text: "下载已取消，已保留的断点数据可用于继续下载。" });
      } else {
        setFeedback({ kind: "error", text: `镜像下载失败：${errorMessage(error)}` });
      }
      void load(true);
    } finally {
      downloadBusyRef.current.delete(image.id);
      if (mountedRef.current) {
        setDownloadBusy((current) => withoutKey(current, image.id));
      }
    }
  }

  async function cancelDownload(image: ImageRecord): Promise<void> {
    if (cancelBusyRef.current.has(image.id)) {
      return;
    }
    setFeedback(null);
    cancelRequestedRef.current.add(image.id);
    cancelBusyRef.current.add(image.id);
    setCancelBusy((current) => ({ ...current, [image.id]: true }));
    try {
      const record = await api.cancelImageDownload(image.id);
      if (!mountedRef.current) {
        return;
      }
      replaceImage(record);
      setFeedback({ kind: "ok", text: `已取消 ${record.name} 的下载，断点数据已保留。` });
      void load(true);
    } catch (error) {
      cancelRequestedRef.current.delete(image.id);
      if (mountedRef.current) {
        setFeedback({ kind: "error", text: `取消下载失败：${errorMessage(error)}` });
      }
    } finally {
      cancelBusyRef.current.delete(image.id);
      if (mountedRef.current) {
        setCancelBusy((current) => withoutKey(current, image.id));
      }
    }
  }

  async function refreshManifest(): Promise<void> {
    if (refreshingManifest) {
      return;
    }
    setRefreshingManifest(true);
    setFeedback(null);
    try {
      const next = await api.refreshImageManifest();
      if (!mountedRef.current) {
        return;
      }
      setCatalog(next);
      setFeedback({ kind: "ok", text: "镜像 Manifest 已刷新。" });
    } catch (error) {
      if (mountedRef.current) {
        setFeedback({ kind: "error", text: `刷新 Manifest 失败：${errorMessage(error)}` });
      }
    } finally {
      if (mountedRef.current) {
        setRefreshingManifest(false);
      }
    }
  }

  async function performVmAction(
    view: VmInstanceView,
    action: VmAction,
    operation: () => Promise<VmInstanceView>,
    doneText: string,
  ): Promise<void> {
    const id = view.vm.id;
    if (vmBusyRef.current.has(id)) {
      return;
    }
    setFeedback(null);
    vmBusyRef.current.add(id);
    setVmBusy((current) => ({ ...current, [id]: action }));
    try {
      const next = await operation();
      if (!mountedRef.current) {
        return;
      }
      replaceVm(next);
      setFeedback({
        kind: "ok",
        text: `${next.vm.name}：${doneText}。当前状态：${
          VM_POWER_STATE_LABELS[next.runtime?.powerState ?? next.vm.powerState]
        }。`,
      });
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setFeedback({ kind: "error", text: `操作失败：${errorMessage(error)}` });
      void load(true);
    } finally {
      vmBusyRef.current.delete(id);
      if (mountedRef.current) {
        setVmBusy((current) => withoutKey(current, id));
      }
    }
  }

  function startVm(view: VmInstanceView): void {
    void performVmAction(view, "start", () => api.startVm(view.vm.id), "启动指令已发送");
  }

  function suspendVm(view: VmInstanceView): void {
    void performVmAction(view, "suspend", () => api.suspendVm(view.vm.id), "已休眠");
  }

  function resumeVm(view: VmInstanceView): void {
    void performVmAction(view, "resume", () => api.resumeVm(view.vm.id), "已恢复");
  }

  function stopVm(view: VmInstanceView, mode: "graceful" | "force"): void {
    if (vmBusyRef.current.has(view.vm.id)) {
      return;
    }
    if (
      mode === "force" &&
      !window.confirm(
        `强制停止「${view.vm.name}」会立即终止 VM 进程，Guest 内未保存的数据可能丢失，且不会等待文件系统正常卸载。确定要强制停止吗？`,
      )
    ) {
      return;
    }
    void performVmAction(
      view,
      "stop",
      () => api.stopVm(view.vm.id, mode),
      mode === "force" ? "已强制停止" : "已优雅停止",
    );
  }

  async function openConsole(view: VmInstanceView): Promise<void> {
    const id = view.vm.id;
    if (vmBusyRef.current.has(id)) {
      return;
    }
    setFeedback(null);
    vmBusyRef.current.add(id);
    setVmBusy((current) => ({ ...current, [id]: "console" }));
    try {
      const control = await api.vmControl(id);
      if (
        control.state === "ai" &&
        !window.confirm(
          `「${view.vm.name}」当前由 AI 控制。人工接管会立即撤销 AI Lease，后续 AI 桌面动作将被拒绝。确定接管吗？`,
        )
      ) {
        return;
      }
      const info = await api.openVmConsole(id);
      if (!mountedRef.current) {
        await api.releaseVmLease(id, info.lease.id).catch(() => undefined);
        return;
      }
      setConsoles((current) => ({ ...current, [id]: info }));
    } catch (error) {
      if (mountedRef.current) {
        setFeedback({ kind: "error", text: `无法获取控制台：${errorMessage(error)}` });
      }
    } finally {
      vmBusyRef.current.delete(id);
      if (mountedRef.current) {
        setVmBusy((current) => withoutKey(current, id));
      }
    }
  }

  const cpuCount = parseInteger(cpuInput);
  const memoryGb = parseInteger(memoryInput);
  const diskGb = parseInteger(diskInput);
  const trimmedName = nameInput.trim();
  const trimmedSeed = seedInput.trim();

  const nameValid = trimmedName.length >= 1 && trimmedName.length <= 64;
  const cpuValid = cpuCount !== null && cpuCount >= 1 && cpuCount <= 32;
  const memoryValid = memoryGb !== null && memoryGb >= 1 && memoryGb <= 64;
  const diskValid = diskGb !== null && diskGb >= 1 && diskGb <= 2048;
  const seedValid = trimmedSeed === "" || isAbsolutePath(trimmedSeed);

  const canCreate =
    !createBusy &&
    supervisorAvailable &&
    nameValid &&
    cpuValid &&
    memoryValid &&
    diskValid &&
    seedValid &&
    selectedImageId !== "";

  const createDisabledReason = !supervisorAvailable
    ? "Supervisor 不可用，暂时无法创建 VM。"
    : availableImages.length === 0
      ? "没有 Available 的 Linux 镜像，请先下载并完成校验。"
      : null;

  const selectedMemoryBytes = memoryGb !== null && memoryGb >= 1 ? memoryGb * GIB : null;
  const hostTotal = host?.totalMemoryBytes ?? null;
  const hostFree = host?.freeMemoryBytes ?? null;
  const suggestedMemoryGb =
    hostFree !== null
      ? Math.max(1, Math.min(16, Math.floor(Math.max(0, hostFree - hostReserveBytes) / GIB)))
      : null;
  const memoryWarning =
    selectedMemoryBytes !== null && hostTotal !== null
      ? selectedMemoryBytes + hostReserveBytes > hostTotal
        ? `所选内存 ${memoryGb} GiB 加上宿主保留 ${formatBytes(
            hostReserveBytes,
          )} 已超过宿主机总内存 ${formatBytes(hostTotal)}。`
        : hostFree !== null && selectedMemoryBytes + hostReserveBytes > hostFree
          ? `所选内存 ${memoryGb} GiB 加上宿主保留后超过当前可用内存 ${formatBytes(
              hostFree,
            )}，运行 Guest 时可能挤压宿主机。`
          : null
      : null;

  async function createVm(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canCreate || cpuCount === null || memoryGb === null || diskGb === null) {
      return;
    }
    const body: VmCreateRequest = {
      name: trimmedName,
      imageId: selectedImageId,
      cpuCount,
      memoryGb,
      diskGb,
    };
    if (trimmedSeed !== "") {
      body.seedImagePath = trimmedSeed;
    }
    setCreateBusy(true);
    setFeedback(null);
    try {
      const created = await api.createVm(body);
      if (!mountedRef.current) {
        return;
      }
      setVms((current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          items: [created, ...current.items.filter((item) => item.vm.id !== created.vm.id)],
        };
      });
      setNameInput("");
      setSeedInput("");
      setShowCreate(false);
      setFeedback({
        kind: "ok",
        text: `已创建「${created.vm.name}」，当前为停止状态。磁盘、配置和项目绑定会保留；请手动点击“启动”开始运行。`,
      });
      void load(true);
    } catch (error) {
      if (mountedRef.current) {
        setFeedback({ kind: "error", text: `创建 VM 失败：${errorMessage(error)}` });
      }
    } finally {
      if (mountedRef.current) {
        setCreateBusy(false);
      }
    }
  }

  const items = vms?.items ?? [];
  const images = catalog?.items ?? [];

  return (
    <section className="panel vm-section" aria-labelledby="vm-section-title">
      <div className="panel-heading vm-heading">
        <div>
          <h2 id="vm-section-title">虚拟机与镜像</h2>
          <p className="muted small">
            镜像需下载并校验为 Available 后才能创建 Linux
            VM。创建不会自动启动，停止后仍保留磁盘、配置与项目绑定。
          </p>
        </div>
        <div className="vm-toolbar">
          {autoRefresh && (
            <span className="muted small" role="status">
              自动刷新中 · 每 2 秒
            </span>
          )}
          <button
            type="button"
            className="secondary"
            onClick={() => void refreshAll()}
            disabled={refreshing || loading}
            aria-busy={refreshing}
          >
            {refreshing ? "刷新中…" : "刷新状态"}
          </button>
        </div>
      </div>

      <div aria-live="polite">
        {loading && catalog === null && vms === null && (
          <p className="muted small">正在读取镜像目录与 VM 列表…</p>
        )}
        {loadError && (
          <div className="notice" role="alert">
            <strong>读取镜像或 VM 列表失败。</strong>
            <span>{loadError}</span>
            <button
              type="button"
              className="secondary"
              onClick={() => void refreshAll()}
              disabled={refreshing}
            >
              重试
            </button>
          </div>
        )}
        {feedback && (
          <div
            className={`notice ${feedback.kind === "ok" ? "ok" : ""}`}
            role={feedback.kind === "ok" ? "status" : "alert"}
          >
            {feedback.text}
          </div>
        )}
      </div>

      {vms && !supervisorAvailable && (
        <div className="notice supervisor-notice" role="alert">
          <strong>Supervisor 不可用，VM 操作暂不可用。</strong>
          <span>{supervisorMessage ?? "无法连接本机 Supervisor 服务。"}</span>
          <span>
            下方 VM 来自已持久化记录，电源与 Guest Health
            仅代表最后已知状态，不代表当前就绪。启动、停止、休眠、恢复与控制台已暂时禁用。
          </span>
        </div>
      )}

      <div className="vm-subheading-row">
        <h3 className="vm-subheading">镜像目录</h3>
        <div className="vm-toolbar">
          {streamState === "reconnecting" && activeDownloads && (
            <span className="muted small" role="status">
              下载进度实时通道重连中；仍会每 2 秒轮询。
            </span>
          )}
          <button
            type="button"
            className="secondary"
            onClick={() => void refreshManifest()}
            disabled={refreshingManifest}
            aria-busy={refreshingManifest}
          >
            {refreshingManifest ? "刷新 Manifest 中…" : "刷新 Manifest"}
          </button>
        </div>
      </div>

      {images.length === 0 ? (
        <p className="muted small">
          {loading
            ? "正在读取镜像目录…"
            : "还没有镜像记录，请刷新 Manifest 获取阶段 0 Linux 基线。"}
        </p>
      ) : (
        <div className="image-grid">
          {images.map((image) => {
            const isDownloading = image.status === "downloading" || image.status === "verifying";
            const canDownload =
              image.status === "not_downloaded" ||
              image.status === "cancelled" ||
              image.status === "failed";
            const totalBytes = Math.max(downloadTotals[image.id] ?? 0, image.sizeBytes);
            const percent =
              image.status === "available"
                ? 100
                : formatProgressPercent(image.downloadedBytes, totalBytes);
            const isDownloadBusy = downloadBusy[image.id] ?? false;
            const isCancelBusy = cancelBusy[image.id] ?? false;
            const showCancel = isDownloading || isDownloadBusy;
            const downloadLabel = isDownloadBusy
              ? "下载中…"
              : image.downloadedBytes > 0
                ? "继续下载"
                : image.status === "failed"
                  ? "重试下载"
                  : "下载";
            return (
              <article className="image-card" key={image.id} aria-label={`镜像 ${image.name}`}>
                <div className="image-card-head">
                  <div>
                    <h4>{image.name}</h4>
                    <p className="muted small">
                      {image.osFamily === "linux" ? "Linux" : "Windows"} {image.osVersion} ·{" "}
                      {image.architecture} · 版本 {image.version}
                    </p>
                  </div>
                  <span className={`pill ${imageStatusPillClass(image.status)}`}>
                    {IMAGE_STATUS_LABELS[image.status]}
                  </span>
                </div>

                <div className="image-meta">
                  <span className="muted small">大小 {formatBytes(image.sizeBytes)}</span>
                  <span className="muted small">
                    已下载 {formatBytes(image.downloadedBytes)}
                    {percent !== null ? ` · ${percent}%` : ""}
                  </span>
                </div>

                <div
                  className="progress-track"
                  role="progressbar"
                  aria-label={`${image.name} 下载进度`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent ?? undefined}
                >
                  <span
                    className={percent === null && isDownloading ? "indeterminate" : undefined}
                    style={percent !== null ? { width: `${percent}%` } : undefined}
                  />
                </div>

                {image.status === "available" && image.localPath && (
                  <code className="image-path truncate" title={image.localPath}>
                    {image.localPath}
                  </code>
                )}

                {image.errorMessage && (
                  <p
                    className={`small ${
                      image.status === "cancelled" ? "warning-line" : "error-line"
                    }`}
                  >
                    {image.errorCode ? `[${image.errorCode}] ` : ""}
                    {image.errorMessage}
                  </p>
                )}

                <div className="action-row image-actions">
                  {showCancel ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void cancelDownload(image)}
                      disabled={isCancelBusy}
                      aria-busy={isCancelBusy}
                    >
                      {isCancelBusy ? "取消中…" : "取消下载"}
                    </button>
                  ) : canDownload ? (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void downloadImage(image)}
                      disabled={isDownloadBusy || isCancelBusy}
                      aria-busy={isDownloadBusy}
                    >
                      {downloadLabel}
                    </button>
                  ) : (
                    <span className="muted small">可用于创建 VM</span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <div className="vm-subheading-row">
        <h3 className="vm-subheading">虚拟机</h3>
        <div className="vm-toolbar">
          <button
            type="button"
            className="secondary"
            onClick={() => setShowCreate((value) => !value)}
            disabled={!supervisorAvailable}
            title={supervisorAvailable ? undefined : "Supervisor 不可用，无法创建 VM。"}
            aria-expanded={showCreate}
            aria-controls="vm-create-form"
          >
            {showCreate ? "收起创建表单" : "创建 VM"}
          </button>
        </div>
      </div>

      {createDisabledReason && <p className="muted small">{createDisabledReason}</p>}

      {showCreate && (
        <form
          id="vm-create-form"
          className="create-form"
          onSubmit={(event) => void createVm(event)}
        >
          <div className="create-grid">
            <div className="field">
              <label htmlFor="vm-name">名称</label>
              <input
                id="vm-name"
                value={nameInput}
                onChange={(event) => setNameInput(event.target.value)}
                placeholder="例如：agent-linux-01"
                maxLength={64}
                autoComplete="off"
                aria-describedby="vm-name-hint"
              />
              <span className="form-hint" id="vm-name-hint">
                1～64 个字符。
              </span>
            </div>

            <div className="field">
              <label htmlFor="vm-image">Linux 镜像</label>
              <select
                id="vm-image"
                value={selectedImageId}
                onChange={(event) => setImageId(event.target.value)}
                disabled={availableImages.length === 0}
                aria-describedby="vm-image-hint"
              >
                {availableImages.length === 0 ? (
                  <option value="">没有 Available 的 Linux 镜像</option>
                ) : (
                  availableImages.map((image) => (
                    <option key={image.id} value={image.id}>
                      {image.name} · {image.version} · {image.architecture} ·{" "}
                      {formatBytes(image.sizeBytes)}
                    </option>
                  ))
                )}
              </select>
              <span className="form-hint" id="vm-image-hint">
                仅列出已下载且校验通过的 Linux 镜像。
              </span>
            </div>

            <div className="field">
              <label htmlFor="vm-cpu">CPU（核）</label>
              <input
                id="vm-cpu"
                type="number"
                min={1}
                max={32}
                step={1}
                inputMode="numeric"
                value={cpuInput}
                onChange={(event) => setCpuInput(event.target.value)}
                aria-describedby="vm-cpu-hint"
              />
              <span className="form-hint" id="vm-cpu-hint">
                1～32 的整数。
              </span>
            </div>

            <div className="field">
              <label htmlFor="vm-memory">内存（GiB）</label>
              <input
                id="vm-memory"
                type="number"
                min={1}
                max={64}
                step={1}
                inputMode="numeric"
                value={memoryInput}
                onChange={(event) => setMemoryInput(event.target.value)}
                aria-describedby="vm-resource-guide"
              />
              <span className="form-hint">1～64 的整数。</span>
            </div>

            <div className="field">
              <label htmlFor="vm-disk">磁盘（GiB）</label>
              <input
                id="vm-disk"
                type="number"
                min={1}
                max={2048}
                step={1}
                inputMode="numeric"
                value={diskInput}
                onChange={(event) => setDiskInput(event.target.value)}
                aria-describedby="vm-disk-hint"
              />
              <span className="form-hint" id="vm-disk-hint">
                1～2048 的整数，创建独立的覆盖盘。
              </span>
            </div>

            <div className="field create-seed">
              <label htmlFor="vm-seed">NoCloud Seed（可选，绝对路径）</label>
              <input
                id="vm-seed"
                value={seedInput}
                onChange={(event) => setSeedInput(event.target.value)}
                placeholder="例如：D:\\AgentInBox\\artifacts\\seed.iso"
                spellCheck={false}
                aria-describedby="vm-seed-hint"
              />
              <span className="form-hint" id="vm-seed-hint">
                阶段 0 生成的 NoCloud artifact（包含 SSH 公钥与 Guest
                初始化配置）绝对路径。留空则不注入；不会从模型输入自动生成。
              </span>
              {!seedValid && <span className="error-line small">Seed 必须是绝对路径。</span>}
            </div>
          </div>

          <div className="resource-guide" id="vm-resource-guide">
            <span>
              宿主机总内存 {hostTotal !== null ? formatBytes(hostTotal) : "读取中"} · 当前可用{" "}
              {hostFree !== null ? formatBytes(hostFree) : "读取中"} · 宿主保留{" "}
              {formatBytes(hostReserveBytes)}
            </span>
            <span>
              {suggestedMemoryGb !== null
                ? `建议 VM 内存不超过 ${suggestedMemoryGb} GiB（仅为参考，可手动调整）。`
                : "宿主机内存信息加载中，请保守设置内存。"}
            </span>
            {memoryWarning && (
              <span className="warning-line" role="status">
                {memoryWarning}
              </span>
            )}
          </div>

          <div className="action-row">
            <button type="submit" className="primary" disabled={!canCreate} aria-busy={createBusy}>
              {createBusy ? "创建中…" : "创建 VM（不自动启动）"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setShowCreate(false)}
              disabled={createBusy}
            >
              取消
            </button>
            <span className="muted small">创建完成后需手动点击“启动”。</span>
          </div>
        </form>
      )}

      {items.length === 0 ? (
        <p className="muted small">
          {loading ? "正在读取 VM 列表…" : "还没有 VM。创建后不会自动启动，确认配置后再手动启动。"}
        </p>
      ) : (
        <div className="vm-grid">
          {items.map((view) => {
            const power = effectivePower(view);
            const runtime = view.runtime;
            const busyAction = vmBusy[view.vm.id];
            const consoleInfo = consoles[view.vm.id];
            const consoleAllowed =
              supervisorAvailable && (power === "running" || power === "suspended");
            const guestHealth: GuestHealthState = supervisorAvailable
              ? power === "running"
                ? (runtime?.guestHealth ?? view.vm.guestHealth)
                : "unknown"
              : "unknown";
            const diskPercent =
              view.vm.diskBytes > 0
                ? Math.min(
                    100,
                    Math.max(0, Math.round((view.diskUsageBytes / view.vm.diskBytes) * 1000) / 10),
                  )
                : null;
            const powerLabel = `${supervisorAvailable ? "" : "最后已知："}${
              VM_POWER_STATE_LABELS[power]
            }`;
            return (
              <article
                className="vm-card"
                id={`vm-${view.vm.id}`}
                key={view.vm.id}
                aria-label={`虚拟机 ${view.vm.name}`}
              >
                <div className="vm-card-head">
                  <div>
                    <h4>{view.vm.name}</h4>
                    <p className="muted small">
                      Linux · {view.vm.cpuCount} 核 · {formatBytes(view.vm.memoryBytes)} 内存 ·{" "}
                      {formatBytes(view.vm.diskBytes)} 磁盘
                    </p>
                  </div>
                  <div className="badge-stack">
                    <span className="pill" title="VM 记录、磁盘、配置和项目绑定在停止后仍保留">
                      已拥有
                    </span>
                    <span
                      className={`pill ${
                        supervisorAvailable
                          ? powerPillClass(power)
                          : power === "error"
                            ? "bad"
                            : "warn"
                      }`}
                    >
                      {powerLabel}
                    </span>
                  </div>
                </div>

                <p className="ownership-note small">
                  <strong>已拥有</strong>：停止后仍保留覆盖盘、配置和项目绑定。
                  <strong>正在运行</strong>：仅在 Supervisor 可用且电源状态为运行中时成立； Guest
                  Health 是独立于电源状态的 Guest 检查结果。
                </p>

                <dl className="vm-facts">
                  <div>
                    <dt>电源状态</dt>
                    <dd>{powerLabel}</dd>
                  </div>
                  <div>
                    <dt>Guest Health</dt>
                    <dd>
                      {supervisorAvailable
                        ? GUEST_HEALTH_LABELS[guestHealth]
                        : "未知（Supervisor 不可用）"}
                    </dd>
                  </div>
                  <div>
                    <dt>存储根目录</dt>
                    <dd>
                      <code title={view.vm.storageRoot}>{view.vm.storageRoot}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>独立覆盖盘</dt>
                    <dd>
                      <code title={runtime?.diskPath ?? undefined}>
                        {runtime?.diskPath ?? "—（Supervisor 可用时显示）"}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>实际磁盘占用</dt>
                    <dd>
                      {formatBytes(view.diskUsageBytes)} / {formatBytes(view.vm.diskBytes)}
                      {diskPercent !== null ? ` · ${diskPercent}%` : ""}
                    </dd>
                  </div>
                  <div>
                    <dt>绑定项目</dt>
                    <dd>
                      {view.boundProjects.length > 0
                        ? view.boundProjects
                            .map(
                              (project) =>
                                `${project.name}${project.archivedAt ? "（已归档）" : ""}${project.isPrimary ? "（主）" : ""}`,
                            )
                            .join("、")
                        : "未绑定项目"}
                    </dd>
                  </div>
                  <div>
                    <dt>当前任务</dt>
                    <dd>
                      {view.currentTask
                        ? `${view.currentTask.objective}（${
                            TASK_STATUS_LABELS[view.currentTask.status]
                          }）`
                        : "无"}
                    </dd>
                  </div>
                  <div>
                    <dt>最后错误</dt>
                    <dd className={runtime?.lastError ? "error-line" : undefined}>
                      {supervisorAvailable
                        ? runtime?.lastError || "无"
                        : "Supervisor 不可用，无法读取最新错误"}
                    </dd>
                  </div>
                </dl>

                {view.boundProjects.length > 1 && (
                  <p className="shared-warning">
                    共享 VM：{view.boundProjects.map((project) => project.name).join("、")}
                    共用桌面、软件和系统状态；所有项目的任务在此 VM 上串行执行。
                  </p>
                )}

                {diskPercent !== null && (
                  <div
                    className="progress-track vm-disk-track"
                    role="progressbar"
                    aria-label={`${view.vm.name} 磁盘占用`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={diskPercent}
                  >
                    <span style={{ width: `${diskPercent}%` }} />
                  </div>
                )}

                <div className="action-row vm-actions">
                  {power === "stopped" && (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => startVm(view)}
                      disabled={Boolean(busyAction) || !supervisorAvailable}
                      aria-busy={busyAction === "start"}
                    >
                      {busyAction === "start" ? "启动中…" : "启动"}
                    </button>
                  )}
                  {power === "running" && (
                    <>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => suspendVm(view)}
                        disabled={Boolean(busyAction) || !supervisorAvailable}
                        aria-busy={busyAction === "suspend"}
                        title="保存 Guest 运行状态并暂停"
                      >
                        {busyAction === "suspend" ? "休眠中…" : "休眠"}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => stopVm(view, "graceful")}
                        disabled={Boolean(busyAction) || !supervisorAvailable}
                        aria-busy={busyAction === "stop"}
                        title="请求 Guest 正常关机，等待文件系统安全卸载"
                      >
                        {busyAction === "stop" ? "停止中…" : "优雅停止"}
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => stopVm(view, "force")}
                        disabled={Boolean(busyAction) || !supervisorAvailable}
                        title="立即终止 VM 进程，可能丢失 Guest 内未保存的数据"
                      >
                        强制停止
                      </button>
                    </>
                  )}
                  {power === "suspended" && (
                    <>
                      <button
                        type="button"
                        className="primary"
                        onClick={() => resumeVm(view)}
                        disabled={Boolean(busyAction) || !supervisorAvailable}
                        aria-busy={busyAction === "resume"}
                      >
                        {busyAction === "resume" ? "恢复中…" : "恢复"}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => stopVm(view, "graceful")}
                        disabled={Boolean(busyAction) || !supervisorAvailable}
                        title="请求 Guest 正常关机，等待文件系统安全卸载"
                      >
                        {busyAction === "stop" ? "停止中…" : "优雅停止"}
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => stopVm(view, "force")}
                        disabled={Boolean(busyAction) || !supervisorAvailable}
                        title="立即终止 VM 进程，可能丢失 Guest 内未保存的数据"
                      >
                        强制停止
                      </button>
                    </>
                  )}
                  {power === "error" && (
                    <>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => startVm(view)}
                        disabled={Boolean(busyAction) || !supervisorAvailable}
                      >
                        {busyAction === "start" ? "启动中…" : "尝试启动"}
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => stopVm(view, "force")}
                        disabled={Boolean(busyAction) || !supervisorAvailable}
                        title="立即终止 VM 进程，可能丢失 Guest 内未保存的数据"
                      >
                        强制停止
                      </button>
                    </>
                  )}
                  {(power === "starting" || power === "stopping") && (
                    <span className="muted small" role="status">
                      {VM_POWER_STATE_LABELS[power]}，请稍候…
                    </span>
                  )}
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void openConsole(view)}
                    disabled={
                      Boolean(busyAction) ||
                      !supervisorAvailable ||
                      (power !== "running" && power !== "suspended")
                    }
                    aria-busy={busyAction === "console"}
                    title={
                      consoleAllowed
                        ? "获取仅绑定回环地址的控制台地址"
                        : "仅运行或休眠中的 VM 可以提供控制台"
                    }
                  >
                    {busyAction === "console" ? "获取控制台…" : "打开控制台"}
                  </button>
                </div>

                <p className="muted small vm-action-hint">
                  优雅停止会请求 Guest 正常关机；强制停止会立即终止进程，Guest
                  内未保存的数据可能丢失。
                </p>

                {consoleInfo && (
                  <VmConsole
                    key={consoleInfo.lease.id}
                    session={consoleInfo}
                    vmName={view.vm.name}
                    onClose={() =>
                      setConsoles((current) => {
                        const next = { ...current };
                        delete next[view.vm.id];
                        return next;
                      })
                    }
                    onReconnect={() => void openConsole(view)}
                  />
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function effectivePower(view: VmInstanceView): VmPowerState {
  return view.runtime?.powerState ?? view.vm.powerState;
}

function imageStatusPillClass(status: ImageStatus): string {
  switch (status) {
    case "available":
      return "ok";
    case "downloading":
    case "verifying":
      return "warn";
    case "failed":
      return "bad";
    default:
      return "";
  }
}

function powerPillClass(power: VmPowerState): string {
  switch (power) {
    case "running":
      return "ok";
    case "starting":
    case "stopping":
    case "suspended":
      return "warn";
    case "error":
      return "bad";
    default:
      return "";
  }
}

function parseInteger(value: string): number | null {
  if (value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\");
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function isCancelledDownload(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    (error.code === "download_cancelled" || error.message.includes("取消"))
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
