import { contextBridge, ipcRenderer } from "electron";
import type {
  CredentialSaveRequest,
  DesktopAppStatus,
  DesktopBridge,
  DesktopCredentialStatus,
  DesktopNotificationRequest,
  DesktopPreferences,
  DesktopPreferencesPatch,
  DesktopUpdateStatus,
  VmRuntimeStatus,
} from "@agent-in-box/protocol";

// Sandboxed preload scripts only get a limited require polyfill, so channel
// names must be inlined instead of imported from another local module.
// Keep these values identical to ipc-channels.ts.
const IPC_CHANNELS = {
  appStatus: "agent-in-box:app-status",
  appStatusEvent: "agent-in-box:app-status-event",
  restartControlPlane: "agent-in-box:restart-control-plane",
  startControlPlane: "agent-in-box:start-control-plane",
  stopControlPlane: "agent-in-box:stop-control-plane",
  vmStatus: "agent-in-box:vm-status",
  vmInstallQemu: "agent-in-box:vm-install-qemu",
  vmSetQemuPath: "agent-in-box:vm-set-qemu-path",
  vmRestartSupervisor: "agent-in-box:vm-restart-supervisor",
  quit: "agent-in-box:quit",
  openLogs: "agent-in-box:open-logs",
  chooseDirectory: "agent-in-box:choose-directory",
  getPreferences: "agent-in-box:get-preferences",
  setPreferences: "agent-in-box:set-preferences",
  updatesStatus: "agent-in-box:updates-status",
  updatesCheck: "agent-in-box:updates-check",
  updatesDownload: "agent-in-box:updates-download",
  updatesInstall: "agent-in-box:updates-install",
  updatesRollback: "agent-in-box:updates-rollback",
  showNotification: "agent-in-box:show-notification",
  notificationClickEvent: "agent-in-box:notification-click",
  navigateEvent: "agent-in-box:navigate",
  credentialsStatus: "agent-in-box:credentials-status",
  credentialsSave: "agent-in-box:credentials-save",
  credentialsRemove: "agent-in-box:credentials-remove",
  rendererLog: "agent-in-box:renderer-log",
} as const;

const bridge: DesktopBridge = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
  },
  app: {
    status: () => ipcRenderer.invoke(IPC_CHANNELS.appStatus) as Promise<DesktopAppStatus>,
    onStatus: (listener) => {
      const handler = (_event: unknown, status: DesktopAppStatus): void => listener(status);
      ipcRenderer.on(IPC_CHANNELS.appStatusEvent, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.appStatusEvent, handler);
      };
    },
    restartControlPlane: () =>
      ipcRenderer.invoke(IPC_CHANNELS.restartControlPlane) as Promise<DesktopAppStatus>,
    startControlPlane: () =>
      ipcRenderer.invoke(IPC_CHANNELS.startControlPlane) as Promise<DesktopAppStatus>,
    stopControlPlane: () =>
      ipcRenderer.invoke(IPC_CHANNELS.stopControlPlane) as Promise<DesktopAppStatus>,
    onNavigate: (listener) => {
      const handler = (_event: unknown, view: string): void => listener(view);
      ipcRenderer.on(IPC_CHANNELS.navigateEvent, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.navigateEvent, handler);
      };
    },
    quit: () => ipcRenderer.invoke(IPC_CHANNELS.quit) as Promise<void>,
    openLogs: () => ipcRenderer.invoke(IPC_CHANNELS.openLogs) as Promise<void>,
  },
  vm: {
    status: () => ipcRenderer.invoke(IPC_CHANNELS.vmStatus) as Promise<VmRuntimeStatus>,
    installQemu: () => ipcRenderer.invoke(IPC_CHANNELS.vmInstallQemu) as Promise<VmRuntimeStatus>,
    setQemuPath: (value: string | null) =>
      ipcRenderer.invoke(IPC_CHANNELS.vmSetQemuPath, value) as Promise<VmRuntimeStatus>,
    restartSupervisor: () =>
      ipcRenderer.invoke(IPC_CHANNELS.vmRestartSupervisor) as Promise<VmRuntimeStatus>,
  },
  dialog: {
    chooseDirectory: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.chooseDirectory, input) as Promise<string | null>,
  },
  config: {
    getPreferences: () =>
      ipcRenderer.invoke(IPC_CHANNELS.getPreferences) as Promise<DesktopPreferences>,
    setPreferences: (patch: DesktopPreferencesPatch) =>
      ipcRenderer.invoke(IPC_CHANNELS.setPreferences, patch) as Promise<DesktopPreferences>,
  },
  updates: {
    status: () => ipcRenderer.invoke(IPC_CHANNELS.updatesStatus) as Promise<DesktopUpdateStatus>,
    check: () => ipcRenderer.invoke(IPC_CHANNELS.updatesCheck) as Promise<DesktopUpdateStatus>,
    download: () =>
      ipcRenderer.invoke(IPC_CHANNELS.updatesDownload) as Promise<DesktopUpdateStatus>,
    install: () => ipcRenderer.invoke(IPC_CHANNELS.updatesInstall) as Promise<void>,
    rollback: () => ipcRenderer.invoke(IPC_CHANNELS.updatesRollback) as Promise<void>,
  },
  notifications: {
    show: (request: DesktopNotificationRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.showNotification, request) as Promise<boolean>,
    onClick: (listener) => {
      const handler = (_event: unknown, notificationId: string): void => listener(notificationId);
      ipcRenderer.on(IPC_CHANNELS.notificationClickEvent, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.notificationClickEvent, handler);
      };
    },
  },
  credentials: {
    status: () =>
      ipcRenderer.invoke(IPC_CHANNELS.credentialsStatus) as Promise<DesktopCredentialStatus>,
    save: (request: CredentialSaveRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.credentialsSave, request) as Promise<DesktopCredentialStatus>,
    remove: (kind: "model" | "bot", providerId: string) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.credentialsRemove,
        kind,
        providerId,
      ) as Promise<DesktopCredentialStatus>,
  },
  log: (level, message, data) => {
    ipcRenderer.send(IPC_CHANNELS.rendererLog, level, message, data);
  },
};

contextBridge.exposeInMainWorld("agentInBox", bridge);
