/* eslint-disable react-hooks/set-state-in-effect -- initial fetch and SSE effects intentionally update state */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GuestHealthState,
  HostInspectionReport,
  ImageCatalog,
  ImageRecord,
  ImageStatus,
  ResourceReport,
  TaskStreamState,
  VmConsoleSession,
  VmCreateRequest,
  VmInstanceView,
  VmListResponse,
  VmPowerState,
  VmSnapshotImpact,
  VmSnapshotRecord,
} from "@agent-in-box/protocol";
import {
  api,
  ApiRequestError,
  subscribeImageEvents,
  subscribeTaskEvents,
  type ImageEventStreamState,
} from "./api";
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

type VmAction = "start" | "stop" | "suspend" | "resume" | "console" | "delete";

interface Feedback {
  kind: "ok" | "error";
  text: string;
}

export interface ConsoleRequest {
  vmId: string;
  nonce: number;
}

export interface VmManagerProps {
  host: HostInspectionReport | null;
  hostReserveBytes: number;
  consoleRequest?: ConsoleRequest | null;
}

export function VmManager({
  host,
  hostReserveBytes,
  consoleRequest,
}: VmManagerProps): React.JSX.Element {
  const [catalog, setCatalog] = useState<ImageCatalog | null>(null);
  const [vms, setVms] = useState<VmListResponse | null>(null);
  const [resources, setResources] = useState<ResourceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [streamState, setStreamState] = useState<ImageEventStreamState>("reconnecting");
  const [taskStreamState, setTaskStreamState] = useState<TaskStreamState>("reconnecting");
  const [snapshots, setSnapshots] = useState<Record<string, VmSnapshotRecord[]>>({});
  const [snapshotLabel, setSnapshotLabel] = useState<Record<string, string>>({});
  const [snapshotBusy, setSnapshotBusy] = useState<Record<string, boolean>>({});
  const [restoreImpact, setRestoreImpact] = useState<VmSnapshotImpact | null>(null);
  const [restoreAcknowledged, setRestoreAcknowledged] = useState(false);
  const lastConsoleNonce = useRef(0);

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
  const [quickStart, setQuickStart] = useState<{
    stage: "idle" | "image" | "create" | "start" | "provision" | "ready" | "failed";
    message: string;
    vmId: string | null;
  } | null>(null);

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
      const [nextCatalog, nextVms, nextResources] = await Promise.all([
        api.images(),
        api.vms(),
        api.resources().catch(() => null),
      ]);
      if (!mountedRef.current) {
        return;
      }
      const snapshotEntries = await Promise.all(
        nextVms.items.map(async (view) => {
          const list = await api.vmSnapshots(view.vm.id).catch(() => []);
          return [view.vm.id, list] as const;
        }),
      );
      if (!mountedRef.current) {
        return;
      }
      setCatalog(nextCatalog);
      setVms(nextVms);
      setResources(nextResources);
      setSnapshots(Object.fromEntries(snapshotEntries));
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

  useEffect(() => subscribeTaskEvents(() => void load(true), setTaskStreamState), [load]);

  const supervisorAvailable = vms?.supervisor.available ?? true;
  const supervisorMessage = vms?.supervisor.message ?? null;

  useEffect(() => {
    if (!consoleRequest || consoleRequest.nonce === lastConsoleNonce.current) return;
    const view = (vms?.items ?? []).find((item) => item.vm.id === consoleRequest.vmId);
    if (!view) return;
    lastConsoleNonce.current = consoleRequest.nonce;
    document
      .getElementById(`vm-${view.vm.id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    const power = effectivePower(view);
    if (supervisorAvailable && (power === "running" || power === "suspended")) {
      void openConsole(view);
    } else if (!supervisorAvailable || (power !== "running" && power !== "suspended")) {
      setFeedback({
        kind: "error",
        text:
          power === "stopped"
            ? "目标 VM 已停止，启动后才能打开实时控制台。"
            : "目标 VM 当前不可用，无法打开实时控制台。",
      });
    }
  }, [consoleRequest, vms, supervisorAvailable]);

  const availableImages = useMemo(
    () => (catalog?.items ?? []).filter((image) => image.status === "available"),
    [catalog],
  );
  const selectedImageId = availableImages.some((image) => image.id === imageId)
    ? imageId
    : (availableImages[0]?.id ?? "");
  const selectedImage = availableImages.find((image) => image.id === selectedImageId) ?? null;
  const selectedIsWindows = selectedImage?.osFamily === "windows";

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
        if (info.lease) {
          await api.releaseVmLease(id, info.lease.id).catch(() => undefined);
        }
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

  async function createSnapshot(view: VmInstanceView): Promise<void> {
    const id = view.vm.id;
    if (snapshotBusy[id]) return;
    setSnapshotBusy((current) => ({ ...current, [id]: true }));
    setFeedback(null);
    const trimmedLabel = snapshotLabel[id]?.trim() ?? "";
    try {
      await api.createVmSnapshot(id, trimmedLabel ? { label: trimmedLabel } : {});
      setSnapshotLabel((current) => withoutKey(current, id));
      setFeedback({ kind: "ok", text: `已创建「${view.vm.name}」整机快照` });
      await load(true);
    } catch (error) {
      setFeedback({ kind: "error", text: `创建快照失败：${errorMessage(error)}` });
    } finally {
      setSnapshotBusy((current) => withoutKey(current, id));
    }
  }

  async function inspectSnapshotRestore(
    view: VmInstanceView,
    snapshot: VmSnapshotRecord,
  ): Promise<void> {
    setFeedback(null);
    try {
      const impact = await api.vmSnapshotImpact(view.vm.id, snapshot.id);
      setRestoreImpact(impact);
      setRestoreAcknowledged(false);
      document
        .getElementById("snapshot-restore-impact")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      setFeedback({ kind: "error", text: `读取快照影响失败：${errorMessage(error)}` });
    }
  }

  async function confirmSnapshotRestore(): Promise<void> {
    if (!restoreImpact || snapshotBusy[restoreImpact.vmId]) return;
    if (restoreImpact.requiresConfirmation && !restoreAcknowledged) {
      setFeedback({ kind: "error", text: "请先确认共享 VM 的受影响项目" });
      return;
    }
    const id = restoreImpact.vmId;
    setSnapshotBusy((current) => ({ ...current, [id]: true }));
    try {
      await api.restoreVmSnapshot(id, restoreImpact.snapshot.id, {
        confirmSharedImpact: true,
      });
      setFeedback({
        kind: "ok",
        text: `已恢复整机快照「${restoreImpact.snapshot.label}」，受影响项目：${restoreImpact.affectedProjects
          .map((project) => project.name)
          .join("、")}`,
      });
      setRestoreImpact(null);
      setRestoreAcknowledged(false);
      await load(true);
    } catch (error) {
      setFeedback({ kind: "error", text: `恢复快照失败：${errorMessage(error)}` });
    } finally {
      setSnapshotBusy((current) => withoutKey(current, id));
    }
  }

  async function deleteVm(view: VmInstanceView): Promise<void> {
    if (
      !window.confirm(
        `删除「${view.vm.name}」会移除 VM 记录、覆盖盘和整机快照，且不可恢复。仅当 VM 已停止、没有项目绑定、任务或 Worker 历史时允许删除。确定继续吗？`,
      )
    ) {
      return;
    }
    if (vmBusyRef.current.has(view.vm.id)) return;
    vmBusyRef.current.add(view.vm.id);
    setVmBusy((current) => ({ ...current, [view.vm.id]: "delete" }));
    setFeedback(null);
    try {
      await api.deleteVm(view.vm.id);
      setFeedback({ kind: "ok", text: `已删除 VM「${view.vm.name}」` });
      await load(true);
    } catch (error) {
      setFeedback({ kind: "error", text: `删除 VM 失败：${errorMessage(error)}` });
    } finally {
      vmBusyRef.current.delete(view.vm.id);
      setVmBusy((current) => withoutKey(current, view.vm.id));
    }
  }

  const cpuCount = parseInteger(cpuInput);
  const memoryGb = parseInteger(memoryInput);
  const diskGb = parseInteger(diskInput);
  const trimmedName = nameInput.trim();
  const trimmedSeed = seedInput.trim();

  const minMemoryGb = selectedIsWindows ? 4 : 1;
  const minDiskGb = selectedIsWindows ? 32 : 1;
  const nameValid = trimmedName.length >= 1 && trimmedName.length <= 64;
  const cpuValid = cpuCount !== null && cpuCount >= 1 && cpuCount <= 32;
  const memoryValid = memoryGb !== null && memoryGb >= minMemoryGb && memoryGb <= 64;
  const diskValid = diskGb !== null && diskGb >= minDiskGb && diskGb <= 2048;
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
      ? "没有 Available 的 Linux 或 Windows 镜像，请先下载或导入并完成校验。"
      : selectedIsWindows && !memoryValid
        ? "Windows Guest 至少需要 4 GiB 内存。"
        : selectedIsWindows && !diskValid
          ? "Windows Guest 至少需要 32 GiB 磁盘。"
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

  function selectImage(nextId: string): void {
    setImageId(nextId);
    const image = availableImages.find((item) => item.id === nextId);
    if (image?.osFamily !== "windows") return;
    const memory = parseInteger(memoryInput);
    if (memory === null || memory < 4) setMemoryInput("8");
    const disk = parseInteger(diskInput);
    if (disk === null || disk < 32) setDiskInput("64");
  }

  async function quickCreateLinuxVm(): Promise<void> {
    const image = (catalog?.items ?? []).find(
      (item) => item.osFamily === "linux" && item.provisioningProfile,
    );
    if (!image) {
      setQuickStart({
        stage: "failed",
        message: "默认 Manifest 中没有带 cloud-init provisioning profile 的 Linux 镜像。",
        vmId: null,
      });
      return;
    }
    setFeedback(null);
    let activeVmId: string | null = null;
    try {
      let readyImage = image;
      if (readyImage.status !== "available") {
        setQuickStart({
          stage: "image",
          message: "正在下载并校验 Ubuntu 官方镜像…",
          vmId: null,
        });
        await api.downloadImage(readyImage.id);
        readyImage = await waitForImageAvailable(readyImage.id);
      }
      setQuickStart({
        stage: "create",
        message: "正在创建 qcow2 覆盖盘并写入初始化配置…",
        vmId: null,
      });
      const created = await api.createVm({
        name: `Linux 工作 VM ${new Date().toLocaleDateString("zh-CN")}`,
        imageId: readyImage.id,
        cpuCount: 4,
        memoryGb: 8,
        diskGb: 40,
        provisioning: "auto",
      });
      if (!mountedRef.current) return;
      replaceVm(created);
      activeVmId = created.vm.id;
      setQuickStart({
        stage: "start",
        message: "正在启动 VM；首次启动会安装桌面、Guest Agent 与 Worker…",
        vmId: created.vm.id,
      });
      let view = await api.startVm(created.vm.id);
      if (!mountedRef.current) return;
      replaceVm(view);
      const deadline = Date.now() + 45 * 60_000;
      while (Date.now() < deadline) {
        view = await api.vm(created.vm.id);
        if (!mountedRef.current) return;
        replaceVm(view);
        const provisioning = view.vm.provisioning;
        if (provisioning.state === "ready") {
          setQuickStart({
            stage: "ready",
            message: "桌面、Guest Agent 与 Worker 已就绪。下一步可创建项目并绑定 VM。",
            vmId: created.vm.id,
          });
          setFeedback({
            kind: "ok",
            text: `「${view.vm.name}」已完成初始化，可以打开只读观察或绑定项目。`,
          });
          void load(true);
          return;
        }
        if (provisioning.state === "failed") {
          throw new Error(provisioning.message ?? "Guest 初始化失败");
        }
        setQuickStart({
          stage: "provision",
          message: provisioning.message ?? "正在等待 Guest 完成桌面、Guest Agent 与 Worker 安装…",
          vmId: created.vm.id,
        });
        await sleep(2000);
      }
      throw new Error("Guest 初始化超过 45 分钟，请检查 VM 控制台和 Guest 日志");
    } catch (error) {
      if (mountedRef.current) {
        setQuickStart({
          stage: "failed",
          message: errorMessage(error),
          vmId: activeVmId,
        });
      }
      void load(true);
    }
  }

  async function waitForImageAvailable(imageId: string): Promise<ImageRecord> {
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline) {
      const next = await api.images();
      if (mountedRef.current) setCatalog(next);
      const found = next.items.find((item) => item.id === imageId);
      if (!found) throw new Error("镜像记录在下载后消失");
      if (found.status === "available") return found;
      if (found.status === "failed") {
        throw new Error(found.errorMessage ?? "镜像下载或校验失败");
      }
      await sleep(2000);
    }
    throw new Error("镜像下载超过 30 分钟，请检查网络或镜像源");
  }

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
            可以一键下载 Ubuntu 官方镜像并创建已初始化桌面、Guest Agent 与 Worker 的 Linux
            VM；也可以手动下载镜像、创建 VM 后再启动。
          </p>
        </div>
        <div className="vm-toolbar">
          {autoRefresh && (
            <span className="muted small" role="status">
              自动刷新中 · 每 2 秒
            </span>
          )}
          {taskStreamState === "reconnecting" && (
            <span className="muted small" role="status">
              任务事件重连中；恢复后完整同步
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

      <section className="quick-start-card" aria-labelledby="quick-start-title">
        <div>
          <p className="eyebrow">ONE-CLICK LINUX WORK VM</p>
          <h3 id="quick-start-title">一键创建 Linux 工作 VM</h3>
          <p className="muted small">
            下载并校验 Ubuntu 24.04 官方镜像，创建 4 vCPU / 8 GiB / 40 GiB VM，首次启动通过
            cloud-init 安装 XFCE 桌面、Guest Agent 与 Pi Worker。首次初始化可能需要 5～20 分钟。
          </p>
        </div>
        <button
          type="button"
          className="primary"
          disabled={
            quickStart?.stage === "image" ||
            quickStart?.stage === "create" ||
            quickStart?.stage === "start" ||
            quickStart?.stage === "provision"
          }
          onClick={() => void quickCreateLinuxVm()}
        >
          {quickStart && !["ready", "failed"].includes(quickStart.stage)
            ? "正在初始化…"
            : "下载并创建可用 VM"}
        </button>
        {quickStart && (
          <div className={`quick-start-status ${quickStart.stage}`} role="status">
            <strong>
              {quickStart.stage === "ready"
                ? "已就绪"
                : quickStart.stage === "failed"
                  ? "初始化失败"
                  : "进行中"}
            </strong>
            <span>{quickStart.message}</span>
            {quickStart.vmId && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  const view = (vms?.items ?? []).find((item) => item.vm.id === quickStart.vmId);
                  if (view) void openConsole(view);
                }}
              >
                打开控制台
              </button>
            )}
          </div>
        )}
      </section>

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

      {resources && (
        <div className={`resource-banner pressure-${resources.pressure}`} role="status">
          <div>
            <strong>资源调度</strong>
            <span className="muted small">
              已分配 {formatBytes(resources.allocatedMemoryBytes)} / 预算{" "}
              {formatBytes(resources.effectiveBudgetBytes)} · 宿主可用{" "}
              {formatBytes(resources.freeMemoryBytes)}（保留{" "}
              {formatBytes(resources.hostReserveBytes)}）
            </span>
          </div>
          <div className="resource-badges">
            <span className="pill">运行 {resources.runningVmCount}</span>
            <span className="pill">休眠 {resources.suspendedVmCount}</span>
            <span className={`pill ${resources.waitingResourceTaskCount > 0 ? "warn" : ""}`}>
              等待资源 {resources.waitingResourceTaskCount}
            </span>
            <span className="pill">等待 VM {resources.waitingVmTaskCount}</span>
            <span className="pill">排队 {resources.queuedTaskCount}</span>
            <span className="pill">
              {resources.autoStartPolicy === "when_needed" ? "有任务时自动启动" : "仅手动启动"}
            </span>
            <span className="pill">
              {resources.idleSuspendEnabled
                ? `空闲 ${Math.round(resources.idleSuspendTimeoutMs / 60_000)} 分钟休眠`
                : "空闲不休眠"}
            </span>
          </div>
          {resources.blockedAutoStarts.map((blocked) => (
            <p key={blocked.vmId} className="warning-line small">
              「{blocked.vmName}」等待自动启动：{blocked.reason}
            </p>
          ))}
          {resources.pressure !== "ok" && (
            <p className="warning-line small">
              宿主内存压力偏高；系统不会停止有任务的 VM，请手动调整预算或结束任务。
            </p>
          )}
        </div>
      )}

      {restoreImpact && (
        <section id="snapshot-restore-impact" className="panel snapshot-impact" role="alertdialog">
          <div className="panel-heading">
            <h3>恢复整机快照：{restoreImpact.snapshot.label}</h3>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setRestoreImpact(null);
                setRestoreAcknowledged(false);
              }}
            >
              取消
            </button>
          </div>
          <p className="warning-line">{restoreImpact.warning}</p>
          <p className="muted small">
            快照时间：{new Date(restoreImpact.snapshot.createdAt).toLocaleString("zh-CN")} · VM
            当前状态：
            {VM_POWER_STATE_LABELS[restoreImpact.vmPowerState]} · 快照时绑定项目：
            {restoreImpact.snapshot.affectedProjects.map((project) => project.name).join("、") ||
              "无"}
          </p>
          {restoreImpact.bindingSetChanged && (
            <p className="warning-line small">
              快照创建后项目绑定发生了变化；恢复会影响当前全部绑定项目。
            </p>
          )}
          <ul className="plain-list">
            {restoreImpact.affectedProjects.map((project) => (
              <li key={project.id}>
                <strong>{project.name}</strong>
                <span className="muted small">
                  {project.archivedAt ? "（已归档）" : ""} · 活动任务 {project.activeTaskCount} ·
                  最近活动{" "}
                  {project.lastActivityAt
                    ? new Date(project.lastActivityAt).toLocaleString("zh-CN")
                    : "无记录"}
                </span>
              </li>
            ))}
          </ul>
          {restoreImpact.blocked && (
            <div className="notice">
              {restoreImpact.conflicts.map((conflict) => (
                <p key={conflict.reason}>{conflict.message}</p>
              ))}
            </div>
          )}
          {restoreImpact.requiresConfirmation && !restoreImpact.blocked && (
            <label className="toggle">
              <input
                type="checkbox"
                checked={restoreAcknowledged}
                onChange={(event) => setRestoreAcknowledged(event.target.checked)}
              />
              <span>
                我确认恢复整机快照会影响上述全部 {restoreImpact.affectedProjects.length} 个项目。
              </span>
            </label>
          )}
          <button
            type="button"
            className="danger"
            disabled={
              restoreImpact.blocked ||
              snapshotBusy[restoreImpact.vmId] ||
              (restoreImpact.requiresConfirmation && !restoreAcknowledged)
            }
            onClick={() => void confirmSnapshotRestore()}
          >
            {snapshotBusy[restoreImpact.vmId] ? "恢复中…" : "恢复整机快照"}
          </button>
        </section>
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
            : "还没有镜像记录，请刷新 Manifest 获取 Linux 基线，或通过自定义 Manifest 加入合法的 Windows Golden Image。"}
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
              <label htmlFor="vm-image">Guest 镜像</label>
              <select
                id="vm-image"
                value={selectedImageId}
                onChange={(event) => selectImage(event.target.value)}
                disabled={availableImages.length === 0}
                aria-describedby="vm-image-hint"
              >
                {availableImages.length === 0 ? (
                  <option value="">没有 Available 的 Linux 或 Windows 镜像</option>
                ) : (
                  availableImages.map((image) => (
                    <option key={image.id} value={image.id}>
                      {image.osFamily === "windows" ? "Windows" : "Linux"} · {image.name} ·{" "}
                      {image.version} · {image.architecture} · {formatBytes(image.sizeBytes)}
                    </option>
                  ))
                )}
              </select>
              <span className="form-hint" id="vm-image-hint">
                仅列出已下载且校验通过的 Linux/Windows 镜像。Windows 镜像必须来自合法 ISO
                或评估镜像的自建 Golden Image。
              </span>
              {selectedIsWindows && (
                <span className="form-hint">
                  Windows 至少 4 GiB 内存和 32 GiB 磁盘；锁屏、UAC 与安全桌面会暂停 AI
                  操作并要求人工接管，不绕过系统安全机制。
                </span>
              )}
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
                min={minMemoryGb}
                max={64}
                step={1}
                inputMode="numeric"
                value={memoryInput}
                onChange={(event) => setMemoryInput(event.target.value)}
                aria-describedby="vm-resource-guide"
              />
              <span className="form-hint">{minMemoryGb}～64 的整数。</span>
            </div>

            <div className="field">
              <label htmlFor="vm-disk">磁盘（GiB）</label>
              <input
                id="vm-disk"
                type="number"
                min={minDiskGb}
                max={2048}
                step={1}
                inputMode="numeric"
                value={diskInput}
                onChange={(event) => setDiskInput(event.target.value)}
                aria-describedby="vm-disk-hint"
              />
              <span className="form-hint" id="vm-disk-hint">
                {minDiskGb}～2048 的整数，创建独立的覆盖盘。
              </span>
            </div>

            <div className="field create-seed">
              <label htmlFor="vm-seed">Seed / Provisioning 介质（可选，绝对路径）</label>
              <input
                id="vm-seed"
                value={seedInput}
                onChange={(event) => setSeedInput(event.target.value)}
                placeholder="例如：D:\\AgentInBox\\artifacts\\seed.iso"
                spellCheck={false}
                aria-describedby="vm-seed-hint"
              />
              <span className="form-hint" id="vm-seed-hint">
                Linux 使用阶段 0 生成的 NoCloud artifact；Windows 可使用受控的 token/初始化介质。
                留空则不注入，不会从模型输入自动生成。
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
                      {view.vm.osFamily === "windows" ? "Windows" : "Linux"} · {view.vm.cpuCount} 核
                      · {formatBytes(view.vm.memoryBytes)} 内存 · {formatBytes(view.vm.diskBytes)}{" "}
                      磁盘
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
                  {view.vm.provisioning.state !== "none" && (
                    <div>
                      <dt>初始化</dt>
                      <dd>
                        {view.vm.provisioning.state === "ready"
                          ? "Desktop / Agent / Worker 已就绪"
                          : view.vm.provisioning.state === "failed"
                            ? `失败：${view.vm.provisioning.message ?? "未知错误"}`
                            : (view.vm.provisioning.message ?? "初始化中")}
                      </dd>
                    </div>
                  )}
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

                {view.sharing.warning && <p className="shared-warning">{view.sharing.warning}</p>}

                <section className="vm-subsection">
                  <h5>调度与队列</h5>
                  <p className="muted small">
                    {view.scheduling.autoStartPolicy === "when_needed"
                      ? view.scheduling.canAutoStart
                        ? "有等待任务时会按 Soft Memory Budget 自动启动。"
                        : view.scheduling.blockedReason
                          ? `当前不会自动启动：${view.scheduling.blockedReason}`
                          : "没有等待启动的任务。"
                      : "仅手动启动；等待任务不会自动拉起 VM。"}
                    {view.scheduling.idleSuspendEnabled
                      ? ` 空闲休眠：${
                          view.scheduling.idleSuspendEligibleAt
                            ? `最早 ${new Date(
                                view.scheduling.idleSuspendEligibleAt,
                              ).toLocaleString("zh-CN")}`
                            : "已配置"
                        }${
                          view.scheduling.idleSuspendBlockers.length > 0
                            ? `；当前阻塞：${view.scheduling.idleSuspendBlockers.join("、")}`
                            : ""
                        }。`
                      : " 空闲不休眠。"}
                  </p>
                  {view.scheduling.warnings.map((warning) => (
                    <p key={warning} className="warning-line small">
                      {warning}
                    </p>
                  ))}
                  {view.queue.length > 0 ? (
                    <ul className="plain-list vm-queue-list">
                      {view.queue.slice(0, 8).map((item) => (
                        <li key={item.taskId}>
                          <div>
                            <strong>{item.projectName}</strong>
                            <span className="muted small">
                              {" "}
                              · {TASK_STATUS_LABELS[item.status]}
                            </span>
                            {item.queuePosition !== null && (
                              <span className="pill small">队列第 {item.queuePosition} 位</span>
                            )}
                            <span className="muted small"> {item.objective.slice(0, 100)}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted small">当前没有排队或运行中的任务。</p>
                  )}
                  {view.activeWorkers.length > 0 && (
                    <ul className="plain-list vm-worker-list">
                      {view.activeWorkers.map((worker) => (
                        <li key={worker.workerId}>
                          <strong>{worker.projectName}</strong>
                          <span className="muted small">
                            {" "}
                            · Worker {worker.workerId.slice(0, 8)} · {worker.status}
                            {worker.currentTaskId
                              ? ` · 当前任务 ${worker.currentTaskId.slice(0, 8)}`
                              : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="vm-subsection">
                  <div className="section-heading">
                    <h5>整机快照</h5>
                    <span className="muted small">仅 stopped 状态可创建与恢复</span>
                  </div>
                  {(snapshots[view.vm.id] ?? []).length > 0 ? (
                    <ul className="plain-list snapshot-list">
                      {(snapshots[view.vm.id] ?? []).map((snapshot) => (
                        <li key={snapshot.id}>
                          <div>
                            <strong>{snapshot.label}</strong>
                            <span className="muted small">
                              {" "}
                              · {new Date(snapshot.createdAt).toLocaleString("zh-CN")} ·{" "}
                              {SNAPSHOT_STATUS_LABELS[snapshot.status]}
                              {snapshot.restoredAt
                                ? ` · 最近恢复 ${new Date(snapshot.restoredAt).toLocaleString("zh-CN")}`
                                : ""}
                            </span>
                            <span className="muted small">
                              {" "}
                              · 影响项目：
                              {snapshot.affectedProjects
                                .map((project) => project.name)
                                .join("、") || "无"}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="secondary"
                            disabled={
                              power !== "stopped" ||
                              snapshot.status !== "available" ||
                              Boolean(snapshotBusy[view.vm.id])
                            }
                            onClick={() => void inspectSnapshotRestore(view, snapshot)}
                          >
                            恢复…
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted small">还没有整机快照。</p>
                  )}
                  <div className="action-row">
                    <input
                      value={snapshotLabel[view.vm.id] ?? ""}
                      maxLength={80}
                      placeholder="快照标签（可选）"
                      onChange={(event) =>
                        setSnapshotLabel((current) => ({
                          ...current,
                          [view.vm.id]: event.target.value,
                        }))
                      }
                    />
                    <button
                      type="button"
                      className="secondary"
                      disabled={power !== "stopped" || Boolean(snapshotBusy[view.vm.id])}
                      onClick={() => void createSnapshot(view)}
                    >
                      {snapshotBusy[view.vm.id] ? "处理中…" : "创建整机快照"}
                    </button>
                  </div>
                  <p className="muted small">
                    整机快照影响全部绑定项目；项目级备份请在项目页单独创建与恢复。
                  </p>
                </section>

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
                  {power === "stopped" && (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void deleteVm(view)}
                      disabled={Boolean(busyAction) || !supervisorAvailable}
                      title="删除前会检查项目绑定、任务、Worker 历史和项目备份依赖"
                    >
                      {busyAction === "delete" ? "删除中…" : "删除 VM"}
                    </button>
                  )}
                </div>

                <p className="muted small vm-action-hint">
                  优雅停止会请求 Guest 正常关机；强制停止会立即终止进程，Guest
                  内未保存的数据可能丢失。
                </p>

                {consoleInfo && (
                  <VmConsole
                    key={consoleInfo.lease?.id ?? `${view.vm.id}-view-only`}
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

const SNAPSHOT_STATUS_LABELS: Record<VmSnapshotRecord["status"], string> = {
  creating: "创建中",
  available: "可用",
  failed: "失败",
};

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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
