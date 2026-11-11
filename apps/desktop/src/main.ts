import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  safeStorage,
  session,
  shell,
  Tray,
  type WebContents,
} from "electron";
import type { CloseBehavior } from "@agent-in-box/protocol";
import { getCloseBehavior, resolveDesktopPaths, setCloseBehavior } from "./app-config";
import { ControlPlaneSupervisor } from "./control-plane-supervisor";
import { CredentialBridge } from "./credential-bridge";
import { CredentialStore } from "./credential-store";
import { registerDesktopIpc } from "./ipc";
import { JsonLineLogger } from "./logger";
import { shouldHideWindowOnClose, shouldQuitWhenAllWindowsClosed } from "./window-behavior";

const PORT = (() => {
  const raw = process.env.CONTROL_PLANE_PORT?.trim();
  if (!raw) {
    return 3000;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid CONTROL_PLANE_PORT: ${raw}`);
  }
  return parsed;
})();

const paths = resolveDesktopPaths();
app.setName("Agent-in-Box");
app.setPath("userData", paths.electronDataDirectory);

const logger = new JsonLineLogger({
  directory: paths.logDirectory,
  scope: "main",
  mirrorToConsole: !app.isPackaged,
});

const credentialStore = new CredentialStore({
  filePath: paths.credentialsPath,
  safeStorage,
  logger: logger.child("credentials"),
});

const credentialBridge = new CredentialBridge({
  descriptorPath: path.join(paths.configDirectory, "credential-bridge.json"),
  credentialStore,
  logger: logger.child("credential-bridge"),
});

function controlPlaneEntry(): {
  entryPath: string;
  workingDirectory: string;
  webRoot: string | null;
} {
  if (app.isPackaged) {
    const bundle = path.join(process.resourcesPath, "control-plane");
    return {
      entryPath: path.join(bundle, "dist", "main.js"),
      workingDirectory: bundle,
      webRoot: path.join(process.resourcesPath, "web"),
    };
  }

  const serviceRoot = path.resolve(__dirname, "..", "..", "..", "services", "control-plane");
  const webRoot = process.env.AGENT_IN_BOX_WEB_ROOT?.trim() || null;
  return {
    entryPath: path.join(serviceRoot, "dist", "main.js"),
    workingDirectory: serviceRoot,
    webRoot,
  };
}

const controlPlaneLocation = controlPlaneEntry();

const supervisor = new ControlPlaneSupervisor({
  entryPath: controlPlaneLocation.entryPath,
  workingDirectory: controlPlaneLocation.workingDirectory,
  port: PORT,
  nodeCommand: app.isPackaged ? process.execPath : (process.env.AGENT_IN_BOX_NODE ?? "node"),
  runAsNode: app.isPackaged,
  env: {
    AGENT_IN_BOX_CONFIG_DIR: paths.configDirectory,
    ...(controlPlaneLocation.webRoot
      ? { AGENT_IN_BOX_WEB_ROOT: controlPlaneLocation.webRoot }
      : {}),
    ...(app.isPackaged
      ? {
          NODE_PATH: [
            path.join(process.resourcesPath, "control-plane", "runtime_modules"),
            process.env.NODE_PATH,
          ]
            .filter(Boolean)
            .join(path.delimiter),
        }
      : {}),
    NODE_ENV: app.isPackaged ? "production" : "development",
  },
  logger: logger.child("supervisor"),
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let shutdownStarted = false;
let mainFrameFailed = false;
let disposeIpc: (() => void) | null = null;

function currentCloseBehavior(): CloseBehavior {
  try {
    return getCloseBehavior(paths.configPath);
  } catch (error) {
    logger.warn("读取关闭窗口设置失败，使用后台运行默认值", { error: String(error) });
    return "keep_running";
  }
}

function mainPageUrl(): string {
  if (controlPlaneLocation.webRoot || app.isPackaged) {
    return `http://127.0.0.1:${PORT}/`;
  }
  return process.env.AGENT_IN_BOX_WEB_URL ?? "http://127.0.0.1:5173";
}

function errorPagePath(): string {
  return path.join(__dirname, "..", "static", "control-plane-error.html");
}

function openExternalIfSafe(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      void shell.openExternal(url);
    }
  } catch {
    // Ignore malformed URLs.
  }
}

function isSameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function isTrustedFileUrl(url: string): boolean {
  const staticDirectory = pathToFileURL(path.join(__dirname, "..", "static")).href;
  return url.startsWith(staticDirectory);
}

function hardenWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    const current = contents.getURL();
    if (isTrustedFileUrl(url) || isSameOrigin(url, current)) {
      return;
    }
    event.preventDefault();
    openExternalIfSafe(url);
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#f2f1eb",
    show: false,
    title: "Agent-in-Box",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  window.once("ready-to-show", () => window.show());

  window.webContents.on("did-finish-load", () => {
    if (window.webContents.getURL().startsWith("http://127.0.0.1:")) {
      mainFrameFailed = false;
    }
  });
  window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || url.startsWith("file://")) {
      return;
    }
    mainFrameFailed = true;
    logger.warn("主页面加载失败，显示诊断页", { code, description, url });
    void window.loadFile(errorPagePath());
  });

  window.on("close", (event) => {
    if (
      shouldHideWindowOnClose({
        isQuitting,
        closeBehavior: currentCloseBehavior(),
        hasTray: tray !== null,
      })
    ) {
      event.preventDefault();
      window.hide();
      logger.info("窗口已关闭，本地服务继续在后台运行");
    }
  });

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  void window.loadURL(mainPageUrl());

  return window;
}

function trayIcon(): Electron.NativeImage {
  return nativeImage
    .createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAWUlEQVR42mNgQAMnK63+0xIz4AO0thyvI+hlOVZH0NtyFEcMlOVwR4w6YNQBxCiSUJAhC486YNQBow4YdcCoA0YdMHwcMNoeGHXAsO0bDJ6u2aDonA5U9xwAKKKmoZAwm9AAAAAASUVORK5CYII=",
    )
    .resize({ width: 16, height: 16 });
}

function updateTrayMenu(): void {
  if (!tray) {
    return;
  }
  const status = supervisor.getStatus();
  const label =
    status.state === "running"
      ? "本地服务：运行中"
      : status.state === "external"
        ? "本地服务：外部进程"
        : status.state === "starting"
          ? "本地服务：启动中"
          : status.state === "stopping"
            ? "本地服务：停止中"
            : status.state === "failed"
              ? "本地服务：异常"
              : "本地服务：已停止";
  tray.setToolTip(`Agent-in-Box · ${label}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "打开 Agent-in-Box",
        click: () => showMainWindow(),
      },
      { label, enabled: false },
      {
        label: "重新启动本地服务",
        click: () => {
          void supervisor.restart().catch((error: unknown) => {
            logger.error("手动重启本地服务失败", { error: String(error) });
          });
        },
      },
      { type: "separator" },
      {
        label: "退出 Agent-in-Box",
        click: () => requestQuit(),
      },
    ]),
  );
}

function createTray(): void {
  try {
    tray = new Tray(trayIcon());
    tray.on("double-click", () => showMainWindow());
    tray.on("click", () => showMainWindow());
    updateTrayMenu();
  } catch (error) {
    logger.warn("系统托盘不可用", { error: String(error) });
  }
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function requestQuit(): void {
  isQuitting = true;
  app.quit();
}

function installApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "文件",
      submenu: [
        {
          label: "打开日志目录",
          click: () => {
            void shell.openPath(paths.logDirectory);
          },
        },
        { type: "separator" },
        { label: "退出", accelerator: "CmdOrCtrl+Q", click: () => requestQuit() },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" as const }]),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function reportFatal(message: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  logger.error(message, { error: detail });
  if (app.isReady()) {
    dialog.showErrorBox("Agent-in-Box 遇到错误", `${message}\n\n日志：${paths.logDirectory}`);
  }
}

function installCrashDiagnostics(): void {
  process.on("uncaughtException", (error) => {
    reportFatal("主进程未捕获异常", error);
  });
  process.on("unhandledRejection", (reason) => {
    reportFatal("主进程未处理的 Promise 拒绝", reason);
  });
  app.on("render-process-gone", (_event, contents, details) => {
    logger.error("渲染进程异常退出", {
      reason: details.reason,
      exitCode: details.exitCode,
      url: contents.getURL(),
    });
    if (details.reason !== "clean-exit" && app.isReady()) {
      dialog.showErrorBox(
        "界面进程异常退出",
        `原因：${details.reason}\n日志：${paths.logDirectory}\n\n应用将尝试重新加载界面。`,
      );
      if (!contents.isDestroyed()) {
        contents.reload();
      }
    }
  });
  app.on("child-process-gone", (_event, details) => {
    logger.error("子进程异常退出", {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
}

async function bootstrap(): Promise<void> {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  installCrashDiagnostics();

  app.on("second-instance", () => showMainWindow());

  app.on("before-quit", (event) => {
    isQuitting = true;
    if (shutdownStarted) {
      return;
    }
    event.preventDefault();
    shutdownStarted = true;
    logger.info("正在停止本地控制平面并退出");
    void supervisor.stop().finally(() => {
      credentialBridge.stop();
      disposeIpc?.();
      app.quit();
    });
  });

  app.on("window-all-closed", () => {
    if (
      shouldQuitWhenAllWindowsClosed({
        platform: process.platform,
        closeBehavior: currentCloseBehavior(),
        hasTray: tray !== null,
      })
    ) {
      app.quit();
    }
  });

  await app.whenReady();

  app.setAppUserModelId("com.agentinbox.desktop");

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  app.on("web-contents-created", (_event, contents) => {
    hardenWebContents(contents);
  });

  disposeIpc = registerDesktopIpc({
    supervisor,
    credentialStore,
    logger,
    paths,
    getMainWindow: () => mainWindow,
    getCloseBehavior: () => currentCloseBehavior(),
    setCloseBehavior: (value) => {
      setCloseBehavior(paths.configPath, value);
    },
    quit: requestQuit,
    openLogs: async () => {
      const error = await shell.openPath(paths.logDirectory);
      if (error) {
        throw new Error(`无法打开日志目录：${error}`);
      }
    },
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  });

  supervisor.onStatus((status) => {
    updateTrayMenu();
    if (status.state === "running" && mainFrameFailed && mainWindow && !mainWindow.isDestroyed()) {
      logger.info("本地服务已恢复，重新加载主页面");
      void mainWindow.loadURL(mainPageUrl());
    }
  });

  try {
    await credentialBridge.start();
    process.env.AGENT_IN_BOX_CREDENTIAL_BRIDGE_DESCRIPTOR = path.join(
      paths.configDirectory,
      "credential-bridge.json",
    );
  } catch (error) {
    logger.error("模型凭据桥启动失败；模型调用将明确失败", { error: String(error) });
  }

  try {
    await supervisor.start();
  } catch (error) {
    logger.error("本地控制平面启动失败，界面将显示诊断页", { error: String(error) });
  }

  installApplicationMenu();
  mainWindow = createWindow();
  createTray();

  const smokeExitMs = Number(process.env.AGENT_IN_BOX_SMOKE_EXIT_MS ?? "");
  if (Number.isFinite(smokeExitMs) && smokeExitMs > 0) {
    setTimeout(() => {
      void (async () => {
        const status = supervisor.getStatus();
        let renderer: Record<string, unknown> | null = null;
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            renderer = (await mainWindow.webContents.executeJavaScript(
              `(async () => ({
                bridge: typeof window.agentInBox,
                requireType: typeof require,
                processType: typeof process,
                url: window.location.href,
                ipcState: window.agentInBox
                  ? await window.agentInBox.app.status()
                      .then((status) => status.controlPlane.state)
                      .catch((error) => "error:" + String(error))
                  : null,
                text: document.body.innerText.slice(0, 600)
              }))()`,
            )) as Record<string, unknown>;
          }
        } catch (error) {
          renderer = { error: String(error) };
        }
        const report = {
          ok: status.state === "running" || status.state === "external",
          controlPlane: status,
          renderer,
          closeBehavior: currentCloseBehavior(),
          configDirectory: paths.configDirectory,
          logDirectory: paths.logDirectory,
          version: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
        };
        const reportPath = process.env.AGENT_IN_BOX_SMOKE_REPORT;
        if (reportPath) {
          try {
            fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
          } catch (error) {
            logger.error("无法写入桌面 Smoke Test 报告", { error: String(error) });
          }
        }
        logger.info("Smoke Test 完成，准备退出", { ok: report.ok, state: status.state });
        requestQuit();
      })();
    }, smokeExitMs);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    } else {
      showMainWindow();
    }
  });
}

void bootstrap().catch((error: unknown) => {
  reportFatal("桌面应用启动失败", error);
  app.quit();
});
