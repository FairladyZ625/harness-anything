import { app, BrowserWindow, ipcMain, session } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGuiServiceBridge } from "../api/service-bridge.ts";
import { registerHarnessIpcHandlers } from "./ipc-handlers.ts";
import { assertDevRendererUrl, guiContentSecurityPolicy } from "./window-config.ts";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export function createMainWindow(): BrowserWindow {
  const preloadPath = path.join(dirname, "../preload/electron-preload.mjs");
  const mainWindow = new BrowserWindow({
    title: "Harness Anything",
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: preloadPath
    }
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    assertDevRendererUrl(rendererUrl);
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(path.join(dirname, "../renderer/index.html"));
  }
  return mainWindow;
}

export function installContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [guiContentSecurityPolicy]
      }
    });
  });
}

export async function startGuiApp(): Promise<void> {
  await app.whenReady();
  installContentSecurityPolicy();
  registerHarnessIpcHandlers(ipcMain, createGuiServiceBridge(resolveGuiProjectRoot()));
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}

export function resolveGuiProjectRoot(): string {
  return path.resolve(process.env.HARNESS_GUI_ROOT ?? process.cwd());
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

if (process.argv[1]?.endsWith("electron-main.js")) {
  void startGuiApp();
}
