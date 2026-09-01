import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { HarnessLayoutOverrides } from "../../../kernel/src/index.ts";
import { registerHarnessIpcHandlers } from "./ipc-handlers.ts";
import { registerArtifactOpenIpc } from "./artifact-open-ipc.ts";
import { registerLocalDocIpc } from "./local-doc-ipc.ts";
import { bootstrapLocalRepository, createLocalGuiServiceBridge } from "./local-composition-root.ts";
import { addLocalMainControls } from "./local-main-controls.ts";
import { resolveLocalDaemonTarget } from "../../../daemon/src/client/local-daemon-target.ts";
import { daemonBuildStamp } from "../../../daemon/src/build-identity.ts";
import {
  evaluateHtmlArtifactAttachment,
  evaluateHtmlArtifactRequest,
  evaluateInAppBrowserAttachment,
  evaluateInAppBrowserUrl,
  evaluatePermissionRequest,
  evaluateWindowOpenRequest,
  HTML_ARTIFACT_PARTITION,
  IN_APP_BROWSER_PARTITION,
  type IpcWebContentsTrustPolicy,
} from "./security-policy.ts";
import { assertDevRendererUrl, createGuiContentSecurityPolicy, isNavigableAppDocumentUrl } from "./window-config.ts";
import { registerFirstRunIpcHandlers } from "./first-run-ipc.ts";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export function createMainWindow(): BrowserWindow {
  const preloadPath = path.join(guiPackageRoot(), "dist-electron/electron-preload.cjs");
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
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
  // 单文档应用:窗口只可停在入口文档上。dev 态同源任意路径(Markdown 外链的绝对
  // 路径会解析到 dev origin 之下)同样拒绝 —— 那会把窗口带离应用,落在 dev server
  // 的 404 白屏上(task_89d324b5 详情面外链白屏的壳侧成因;渲染层拦截是根修)。
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isNavigableAppDocumentUrl(url, { packagedRendererUrl, devRendererUrl: rendererUrl })) {
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
  const browserSession = session.fromPartition(IN_APP_BROWSER_PARTITION);
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  browserSession.on("will-download", (event) => event.preventDefault());
}

function installHtmlArtifactWebviewPolicy(mainWindow: BrowserWindow): void {
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (params.partition === IN_APP_BROWSER_PARTITION) {
      if (evaluateInAppBrowserAttachment(params).action === "deny") {
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
      webPreferences.javascript = true;
      webPreferences.plugins = false;
      webPreferences.devTools = false;
      webPreferences.navigateOnDragDrop = false;
      webPreferences.webviewTag = false;
      webPreferences.partition = IN_APP_BROWSER_PARTITION;
      delete params.preload;
      return;
    }
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
    if (guest.session === session.fromPartition(IN_APP_BROWSER_PARTITION)) {
      guest.setWindowOpenHandler(() => ({ action: "deny" }));
      guest.on("will-navigate", (event, url) => {
        if (evaluateInAppBrowserUrl(url).action === "deny") event.preventDefault();
      });
      return;
    }
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
    bridge = createLocalGuiServiceBridge(rootDir, resolveGuiLayoutOverrides()),
    controlled = addLocalMainControls({
      bridge,
      target: async (repoId) => resolveLocalDaemonTarget({ rootDir, ...(repoId ? { repoIdOverride: repoId } : {}) }),
      clientBuildCommit: daemonBuildStamp().commit,
    }),
    trustPolicy: IpcWebContentsTrustPolicy = {
      isTrustedWebContentsId: (id) => trustedWebContentsIds.has(id),
      rendererUrl: {
        packagedRendererUrl: createLocalPackagedRendererUrl(),
        allowDevRenderer: Boolean(process.env.ELECTRON_RENDERER_URL),
      },
    };
  registerHarnessIpcHandlers(ipcMain, controlled, trustPolicy);
  // 「在默认浏览器打开」(task_7e713fee):唯一新增通道,主进程收窄见 artifact-open-ipc.ts。
  registerArtifactOpenIpc(
    ipcMain,
    {
      canonicalRootOf: (repoId) => {
        const target = resolveLocalDaemonTarget({ rootDir, repoIdOverride: repoId });
        if (target.repoId !== repoId) throw new Error(`Repository ${repoId} is not registered and enabled.`);
        return target.canonicalRoot;
      },
      openPath: (absolutePath) => shell.openPath(absolutePath),
    },
    trustPolicy,
  );
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
      bootstrap: (input) => bootstrapLocalRepository(input),
    },
    trustPolicy,
  );
  // GUI 内读本机文档(task_89d324b5):节点本地只读查询,主进程收窄见 local-doc-ipc.ts。
  registerLocalDocIpc(ipcMain, { homeDir: () => homedir() }, trustPolicy);
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
