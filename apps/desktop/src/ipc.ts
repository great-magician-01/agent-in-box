import path from "node:path";
import { pathToFileURL } from "node:url";
import { dialog, ipcMain, type BrowserWindow } from "electron";
import type {
  CredentialSaveRequest,
  DesktopAppStatus,
  DesktopCredentialStatus,
  DesktopNotificationRequest,
  DesktopPreferences,
  DesktopPreferencesPatch,
  DesktopUpdateStatus,
} from "@agent-in-box/protocol";
import type { ControlPlaneSupervisor } from "./control-plane-supervisor";
import type { CredentialStore } from "./credential-store";
import type { JsonLineLogger } from "./logger";
import type { DesktopPaths } from "./app-config";
import { IPC_CHANNELS } from "./ipc-channels";

export interface DesktopUpdateActions {
  status(): DesktopUpdateStatus;
  check(): Promise<DesktopUpdateStatus>;
  download(): Promise<DesktopUpdateStatus>;
  install(): Promise<void>;
  rollback(): Promise<void>;
}

export interface DesktopIpcDependencies {
  supervisor: ControlPlaneSupervisor;
  credentialStore: CredentialStore;
  logger: JsonLineLogger;
  paths: DesktopPaths;
  getMainWindow(): BrowserWindow | null;
  getPreferences(): DesktopPreferences;
  setPreferences(patch: DesktopPreferencesPatch): DesktopPreferences;
  updates: DesktopUpdateActions;
  showNotification(request: DesktopNotificationRequest): boolean;
  quit(): void;
  openLogs(): Promise<void>;
  appVersion: string;
  platform: NodeJS.Platform;
  arch: string;
}

function isTrustedFileUrl(url: string): boolean {
  const staticDirectory = pathToFileURL(path.join(__dirname, "..", "static")).href;
  return url.startsWith(staticDirectory);
}

function assertTrustedSender(event: { senderFrame?: { url?: string } | null }): void {
  const url = event.senderFrame?.url ?? "";
  if (
    isTrustedFileUrl(url) ||
    url.startsWith("http://127.0.0.1:") ||
    url.startsWith("http://localhost:")
  ) {
    return;
  }
  throw new Error("拒绝来自非本地页面的调用");
}

export interface DesktopIpcHandle {
  broadcast(): void;
  dispose(): void;
}

export function registerDesktopIpc(dependencies: DesktopIpcDependencies): DesktopIpcHandle {
  const status = (): DesktopAppStatus => {
    const preferences = dependencies.getPreferences();
    return {
      controlPlane: dependencies.supervisor.getStatus(),
      closeBehavior: preferences.closeBehavior,
      preferences,
      update: dependencies.updates.status(),
      configDirectory: dependencies.paths.configDirectory,
      logDirectory: dependencies.paths.logDirectory,
      version: dependencies.appVersion,
      platform: dependencies.platform,
      arch: dependencies.arch,
    };
  };

  ipcMain.handle(IPC_CHANNELS.appStatus, (event) => {
    assertTrustedSender(event);
    return status();
  });

  ipcMain.handle(IPC_CHANNELS.restartControlPlane, async (event) => {
    assertTrustedSender(event);
    dependencies.logger.info("渲染进程请求重启本地控制平面");
    await dependencies.supervisor.restart();
    return status();
  });

  ipcMain.handle(IPC_CHANNELS.startControlPlane, async (event) => {
    assertTrustedSender(event);
    dependencies.logger.info("渲染进程请求启动本地控制平面");
    await dependencies.supervisor.start();
    return status();
  });

  ipcMain.handle(IPC_CHANNELS.stopControlPlane, async (event) => {
    assertTrustedSender(event);
    dependencies.logger.info("渲染进程请求停止本地控制平面");
    await dependencies.supervisor.stop();
    return status();
  });

  ipcMain.handle(IPC_CHANNELS.quit, (event) => {
    assertTrustedSender(event);
    dependencies.quit();
  });

  ipcMain.handle(IPC_CHANNELS.openLogs, async (event) => {
    assertTrustedSender(event);
    await dependencies.openLogs();
  });

  ipcMain.handle(
    IPC_CHANNELS.chooseDirectory,
    async (event, input?: { title?: string; defaultPath?: string }) => {
      assertTrustedSender(event);
      const title =
        typeof input?.title === "string" && input.title.length < 120
          ? input.title
          : "选择 Agent-in-Box 数据目录";
      const defaultPath =
        typeof input?.defaultPath === "string" && input.defaultPath.length < 260
          ? input.defaultPath
          : undefined;
      const window = dependencies.getMainWindow();
      const options = {
        title,
        ...(defaultPath ? { defaultPath } : {}),
        properties: ["openDirectory", "createDirectory"] as Array<
          "openDirectory" | "createDirectory"
        >,
      };
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );

  ipcMain.handle(IPC_CHANNELS.getPreferences, (event) => {
    assertTrustedSender(event);
    return dependencies.getPreferences();
  });

  ipcMain.handle(IPC_CHANNELS.setPreferences, (event, patch: DesktopPreferencesPatch) => {
    assertTrustedSender(event);
    return dependencies.setPreferences(patch);
  });

  ipcMain.handle(IPC_CHANNELS.updatesStatus, (event) => {
    assertTrustedSender(event);
    return dependencies.updates.status();
  });

  ipcMain.handle(IPC_CHANNELS.updatesCheck, async (event) => {
    assertTrustedSender(event);
    return dependencies.updates.check();
  });

  ipcMain.handle(IPC_CHANNELS.updatesDownload, async (event) => {
    assertTrustedSender(event);
    return dependencies.updates.download();
  });

  ipcMain.handle(IPC_CHANNELS.updatesInstall, async (event) => {
    assertTrustedSender(event);
    await dependencies.updates.install();
  });

  ipcMain.handle(IPC_CHANNELS.updatesRollback, async (event) => {
    assertTrustedSender(event);
    await dependencies.updates.rollback();
  });

  ipcMain.handle(
    IPC_CHANNELS.showNotification,
    (event, request: DesktopNotificationRequest): boolean => {
      assertTrustedSender(event);
      if (
        typeof request?.notificationId !== "string" ||
        typeof request.title !== "string" ||
        typeof request.body !== "string"
      ) {
        throw new Error("无效的通知请求");
      }
      return dependencies.showNotification(request);
    },
  );

  ipcMain.handle(IPC_CHANNELS.credentialsStatus, (event): DesktopCredentialStatus => {
    assertTrustedSender(event);
    return dependencies.credentialStore.status();
  });

  ipcMain.handle(
    IPC_CHANNELS.credentialsSave,
    (event, request: CredentialSaveRequest): DesktopCredentialStatus => {
      assertTrustedSender(event);
      return dependencies.credentialStore.save(request);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.credentialsRemove,
    (event, providerId: string): DesktopCredentialStatus => {
      assertTrustedSender(event);
      return dependencies.credentialStore.remove(providerId);
    },
  );

  ipcMain.on(IPC_CHANNELS.rendererLog, (event, level: unknown, message: unknown, data: unknown) => {
    try {
      assertTrustedSender(event);
    } catch {
      return;
    }
    if (level !== "info" && level !== "warn" && level !== "error") {
      return;
    }
    if (typeof message !== "string" || message.length > 2000) {
      return;
    }
    const log = dependencies.logger.child("renderer");
    log[level](message, data);
  });

  const broadcast = (): void => {
    const window = dependencies.getMainWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.appStatusEvent, status());
    }
  };

  const unsubscribe = dependencies.supervisor.onStatus(() => broadcast());

  return {
    broadcast,
    dispose: () => {
      unsubscribe();
      for (const channel of [
        IPC_CHANNELS.appStatus,
        IPC_CHANNELS.restartControlPlane,
        IPC_CHANNELS.startControlPlane,
        IPC_CHANNELS.stopControlPlane,
        IPC_CHANNELS.quit,
        IPC_CHANNELS.openLogs,
        IPC_CHANNELS.chooseDirectory,
        IPC_CHANNELS.getPreferences,
        IPC_CHANNELS.setPreferences,
        IPC_CHANNELS.updatesStatus,
        IPC_CHANNELS.updatesCheck,
        IPC_CHANNELS.updatesDownload,
        IPC_CHANNELS.updatesInstall,
        IPC_CHANNELS.updatesRollback,
        IPC_CHANNELS.showNotification,
        IPC_CHANNELS.credentialsStatus,
        IPC_CHANNELS.credentialsSave,
        IPC_CHANNELS.credentialsRemove,
      ]) {
        ipcMain.removeHandler(channel);
      }
      ipcMain.removeAllListeners(IPC_CHANNELS.rendererLog);
    },
  };
}
