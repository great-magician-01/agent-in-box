import { contextBridge, ipcRenderer } from "electron";
import type {
  CloseBehavior,
  CredentialSaveRequest,
  DesktopAppStatus,
  DesktopBridge,
  DesktopCredentialStatus,
} from "@agent-in-box/protocol";

// Sandboxed preload scripts only get a limited require polyfill, so channel
// names must be inlined instead of imported from another local module.
// Keep these values identical to ipc-channels.ts.
const IPC_CHANNELS = {
  appStatus: "agent-in-box:app-status",
  appStatusEvent: "agent-in-box:app-status-event",
  restartControlPlane: "agent-in-box:restart-control-plane",
  quit: "agent-in-box:quit",
  openLogs: "agent-in-box:open-logs",
  chooseDirectory: "agent-in-box:choose-directory",
  getCloseBehavior: "agent-in-box:get-close-behavior",
  setCloseBehavior: "agent-in-box:set-close-behavior",
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
    quit: () => ipcRenderer.invoke(IPC_CHANNELS.quit) as Promise<void>,
    openLogs: () => ipcRenderer.invoke(IPC_CHANNELS.openLogs) as Promise<void>,
  },
  dialog: {
    chooseDirectory: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.chooseDirectory, input) as Promise<string | null>,
  },
  config: {
    getCloseBehavior: () =>
      ipcRenderer.invoke(IPC_CHANNELS.getCloseBehavior) as Promise<CloseBehavior>,
    setCloseBehavior: (value) =>
      ipcRenderer.invoke(IPC_CHANNELS.setCloseBehavior, value) as Promise<CloseBehavior>,
  },
  credentials: {
    status: () =>
      ipcRenderer.invoke(IPC_CHANNELS.credentialsStatus) as Promise<DesktopCredentialStatus>,
    save: (request: CredentialSaveRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.credentialsSave, request) as Promise<DesktopCredentialStatus>,
    remove: (providerId: string) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.credentialsRemove,
        providerId,
      ) as Promise<DesktopCredentialStatus>,
  },
  log: (level, message, data) => {
    ipcRenderer.send(IPC_CHANNELS.rendererLog, level, message, data);
  },
};

contextBridge.exposeInMainWorld("agentInBox", bridge);
