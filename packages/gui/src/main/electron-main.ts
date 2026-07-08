import { app, BrowserWindow, ipcMain, session } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { HarnessLayoutOverrides } from "../../../kernel/src/index.ts";
import { registerHarnessIpcHandlers } from "./ipc-handlers.ts";
import { createLocalGuiServiceBridge } from "./local-composition-root.ts";
import { evaluateNavigationRequest, evaluatePermissionRequest, evaluateWindowOpenRequest } from "./security-policy.ts";
import { assertDevRendererUrl, createGuiContentSecurityPolicy } from "./window-config.ts";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export function createMainWindow(): BrowserWindow {
  const preloadPath = path.join(guiPackageRoot(), "dist-electron/electron-preload.cjs");
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  const allowDevRenderer = Boolean(rendererUrl);
  const packagedRendererUrl = createLocalPackagedRendererUrl();
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
    if (evaluateNavigationRequest(url, { packagedRendererUrl, allowDevRenderer }).action === "deny") {
      event.preventDefault();
    }
  });
  if (rendererUrl) {
    assertDevRendererUrl(rendererUrl);
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(packagedRendererIndexPath());
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
  registerHarnessIpcHandlers(ipcMain, createLocalGuiServiceBridge(resolveGuiProjectRoot(), resolveGuiLayoutOverrides()), {
    isTrustedWebContentsId: (id) => trustedWebContentsIds.has(id),
    rendererUrl: {
      packagedRendererUrl: createLocalPackagedRendererUrl(),
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
  // Capture the id now: by the time "closed" fires the native window is
  // destroyed and reading mainWindow.webContents throws "Object has been destroyed".
  const webContentsId = mainWindow.webContents.id;
  trustedWebContentsIds.add(webContentsId);
  mainWindow.once("closed", () => trustedWebContentsIds.delete(webContentsId));
  return mainWindow;
}

export function resolveGuiProjectRoot(): string {
  return path.resolve(process.env.HARNESS_GUI_ROOT ?? process.cwd());
}

export function resolveGuiLayoutOverrides(): HarnessLayoutOverrides | undefined {
  const authoredRoot = process.env.HARNESS_AUTHORED_ROOT;
  return authoredRoot && authoredRoot.length > 0 ? { authoredRoot } : undefined;
}

function guiPackageRoot(): string {
  return path.resolve(dirname, "../..");
}

function packagedRendererIndexPath(): string {
  return path.join(guiPackageRoot(), "dist/index.html");
}

function createLocalPackagedRendererUrl(): string {
  return pathToFileURL(packagedRendererIndexPath()).href;
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

if (app.isPackaged || process.argv.some((arg) => /electron-main\.(?:js|ts)$/u.test(arg))) {
  void startGuiApp();
}
