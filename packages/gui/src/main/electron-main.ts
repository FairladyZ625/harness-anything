import { app, BrowserWindow, ipcMain, session } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGuiServiceBridge } from "../api/service-bridge.ts";
import { registerHarnessIpcHandlers } from "./ipc-handlers.ts";
import { evaluateNavigationRequest, evaluatePermissionRequest, evaluateWindowOpenRequest } from "./security-policy.ts";
import { assertDevRendererUrl, createGuiContentSecurityPolicy, createPackagedRendererUrl } from "./window-config.ts";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export function createMainWindow(): BrowserWindow {
  const preloadPath = path.join(dirname, "../preload/electron-preload.mjs");
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  const allowDevRenderer = Boolean(rendererUrl);
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
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: evaluateWindowOpenRequest().action }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (evaluateNavigationRequest(url, { packagedRendererUrl: createPackagedRendererUrl(), allowDevRenderer }).action === "deny") {
      event.preventDefault();
    }
  });
  if (rendererUrl) {
    assertDevRendererUrl(rendererUrl);
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(path.join(dirname, "../renderer/index.html"));
  }
  return mainWindow;
}

export function installContentSecurityPolicy(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(evaluatePermissionRequest().action === "allow");
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [createGuiContentSecurityPolicy({
          allowDevRenderer: Boolean(process.env.ELECTRON_RENDERER_URL)
        })]
      }
    });
  });
}

export async function startGuiApp(): Promise<void> {
  await app.whenReady();
  installContentSecurityPolicy();
  const trustedWebContentsIds = new Set<number>();
  registerHarnessIpcHandlers(ipcMain, createGuiServiceBridge(resolveGuiProjectRoot()), {
    isTrustedWebContentsId: (id) => trustedWebContentsIds.has(id),
    rendererUrl: {
      packagedRendererUrl: createPackagedRendererUrl(),
      allowDevRenderer: Boolean(process.env.ELECTRON_RENDERER_URL)
    }
  });
  createTrustedMainWindow(trustedWebContentsIds);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createTrustedMainWindow(trustedWebContentsIds);
  });
}

function createTrustedMainWindow(trustedWebContentsIds: Set<number>): BrowserWindow {
  const mainWindow = createMainWindow();
  trustedWebContentsIds.add(mainWindow.webContents.id);
  mainWindow.once("closed", () => trustedWebContentsIds.delete(mainWindow.webContents.id));
  return mainWindow;
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
