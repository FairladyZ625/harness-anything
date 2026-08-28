import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { HarnessLayoutOverrides } from "../../../kernel/src/index.ts";
import { registerHarnessIpcHandlers } from "./ipc-handlers.ts";
import { bootstrapLocalRepository, createLocalGuiServiceBridge } from "./local-composition-root.ts";
import { addLocalMainControls } from "./local-main-controls.ts";
import { resolveLocalDaemonTarget } from "../../../daemon/src/client/local-daemon-target.ts";
import { daemonBuildStamp } from "../../../daemon/src/build-identity.ts";
import {
  evaluateHtmlArtifactAttachment,
  evaluateHtmlArtifactRequest,
  evaluateNavigationRequest,
  evaluatePermissionRequest,
  evaluateWindowOpenRequest,
  HTML_ARTIFACT_PARTITION,
  type IpcWebContentsTrustPolicy,
} from "./security-policy.ts";
import { assertDevRendererUrl, createGuiContentSecurityPolicy } from "./window-config.ts";
import { registerFirstRunIpcHandlers } from "./first-run-ipc.ts";

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
      webviewTag: true,
      preload: preloadPath,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: evaluateWindowOpenRequest().action }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (evaluateNavigationRequest(url, { packagedRendererUrl, allowDevRenderer }).action === "deny") {
      event.preventDefault();
    }
  });
  installHtmlArtifactWebviewPolicy(mainWindow);
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
        "Content-Security-Policy": [
          createGuiContentSecurityPolicy({
            allowDevRenderer: Boolean(process.env.ELECTRON_RENDERER_URL),
          }),
        ],
      },
    });
  });
  const artifactSession = session.fromPartition(HTML_ARTIFACT_PARTITION);
  artifactSession.setPermissionCheckHandler(() => false);
  artifactSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  artifactSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: evaluateHtmlArtifactRequest(details.url).action === "deny" });
  });
  artifactSession.on("will-download", (event) => event.preventDefault());
}

function installHtmlArtifactWebviewPolicy(mainWindow: BrowserWindow): void {
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (evaluateHtmlArtifactAttachment(params).action === "deny") {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.javascript = false;
    webPreferences.plugins = false;
    webPreferences.devTools = false;
    webPreferences.navigateOnDragDrop = false;
    webPreferences.webviewTag = false;
    webPreferences.partition = HTML_ARTIFACT_PARTITION;
    delete params.preload;
  });
  mainWindow.webContents.on("did-attach-webview", (_event, guest) => {
    guest.setWindowOpenHandler(() => ({ action: "deny" }));
    guest.on("will-navigate", (event) => event.preventDefault());
    guest.on("will-frame-navigate", (event) => event.preventDefault());
    guest.on("will-redirect", (event) => event.preventDefault());
  });
}

export async function startGuiApp(): Promise<void> {
  await app.whenReady();
  installContentSecurityPolicy();
  const trustedWebContentsIds = new Set<number>();
  const rootDir = resolveGuiProjectRoot(),
    packaged = app.isPackaged ? { resourcesPath: process.resourcesPath } : undefined,
    bridge = createLocalGuiServiceBridge(rootDir, resolveGuiLayoutOverrides(), packaged ? { packaged } : {}),
    controlled = addLocalMainControls({
      bridge,
      target: async (repoId) => resolveLocalDaemonTarget({ rootDir, ...(repoId ? { repoIdOverride: repoId } : {}) }),
      clientBuildCommit: daemonBuildStamp().commit,
      ...(packaged ? { packaged } : {}),
    }),
    trustPolicy: IpcWebContentsTrustPolicy = {
      isTrustedWebContentsId: (id) => trustedWebContentsIds.has(id),
      rendererUrl: {
        packagedRendererUrl: createLocalPackagedRendererUrl(),
        allowDevRenderer: Boolean(process.env.ELECTRON_RENDERER_URL),
      },
    };
  registerHarnessIpcHandlers(ipcMain, controlled, trustPolicy);
  registerFirstRunIpcHandlers(
    ipcMain,
    {
      chooseRepository: async () => {
        const selected = await dialog.showOpenDialog({
          title: "Choose a git repository",
          properties: ["openDirectory", "createDirectory"],
        });
        return selected.canceled ? null : (selected.filePaths[0] ?? null);
      },
      bootstrap: (input) => bootstrapLocalRepository(input, packaged),
    },
    trustPolicy,
  );
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
