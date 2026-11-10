import { app, BrowserWindow, shell } from "electron";
import path from "node:path";

const DEV_URL = process.env.AGENT_IN_BOX_WEB_URL ?? "http://127.0.0.1:5173";

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#f2f1eb",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once("ready-to-show", () => window.show());

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.AGENT_IN_BOX_WEB_URL) {
    void window.loadURL(process.env.AGENT_IN_BOX_WEB_URL);
  } else if (app.isPackaged) {
    void window.loadFile(path.join(__dirname, "..", "..", "web", "dist", "index.html"));
  } else {
    void window.loadURL(DEV_URL);
  }

  return window;
}

void app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
