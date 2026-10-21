import { guiArtifactCacheRoot, guiDaemonUserRoot } from "./gui-daemon-target.ts";
import { registerProjectDirectoryIpc } from "./project-directory-ipc.ts";
import { registerProjectWindowIpc } from "./project-window-ipc.ts";
import {
  createProjectWindowRegistry,
  menuNewWindow,
  projectWindowArgument,
  type ProjectWindowRegistryEntry,
} from "./project-windows.ts";
import { darwinAppMenuTemplate } from "./darwin-app-menu.ts";
import { ensureApplicationsFolder } from "./darwin-applications-folder.ts";
import { APP_COMMAND_CHANNEL, type AppNavigationCommand } from "../api/app-command-contract.ts";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell } from "electron";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { readDaemonRegistry } from "@harness-anything/kernel";
import { registerHarnessIpcHandlers } from "./ipc-handlers.ts";
import { createLoginWebviewSecurity } from "./login-webview-security.ts";
import { registerOidcAuthIpc } from "./oidc-auth-ipc.ts";
import { registerAccessAdminIpc } from "./access-admin-ipc.ts";
import { registerCenterSettingsIpc } from "./center-settings-ipc.ts";
import { EDGE_JOIN_LINK_CHANNEL } from "../api/edge-join-entry-contract.ts";
import { edgeJoinLinkFromArgv, registerEdgeJoinEntryIpc } from "./edge-join-entry-ipc.ts";
import { registerArtifactOpenIpc } from "./artifact-open-ipc.ts";
import { registerLocalDocIpc } from "./local-doc-ipc.ts";
import {
  bootstrapLocalRepository,
  createLocalGuiServiceBridge,
  requestDaemonAdminRpc,
  requestRepoScopedRpc,
} from "./local-composition-root.ts";
import { registerConnectionAdminIpc } from "./connection-admin-ipc.ts";
import { addLocalMainControls } from "./local-main-controls.ts";
import { resolveLocalDaemonTarget, resolveLocalDaemonTargetFromRepos } from "@harness-anything/daemon/client";
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
import {
  appIconPath,
  assertDevRendererUrl,
  createGuiContentSecurityPolicy,
  createPackagedRendererUrl,
  guiPlatformWindowOptions,
  isNavigableAppDocumentUrl,
  packagedRendererIndexPath,
  resolveGuiPackageRoot,
  windowBackgroundColor,
} from "./window-config.ts";
import { registerFirstRunIpcHandlers } from "./first-run-ipc.ts";
import { DESKTOP_FIRST_RUN_UPDATED_CHANNEL, type DesktopSetupFailure } from "../api/first-run-contract.ts";
import { desktopRuntimePaths, desktopFirstRunReport, runDesktopSetup } from "./desktop-first-run.ts";
import { registerUpdaterIpc } from "./update-service.ts";
// electron-updater is CommonJS: a named import breaks direct source launches under Node ESM
// type stripping ("Named export 'autoUpdater' not found"); default-import and destructure.
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

process.on("uncaughtException", (err) => console.error("[FATAL] uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("[FATAL] unhandledRejection:", err));

// The GUI is the person's local viewer, never a dispatched execution. When an automated
// entry (capture.mjs, e2e probe, gui-e2e lanes) launches the app from inside a task
// dispatch, the ambient worker credential would otherwise ride into the daemon client,
// attach to every request and be rejected as outside the dispatch scope
// (execution_credential_rejected), leaving the window stuck on the daemon startup gate.
// Drop it before the first client can read it; terminal sessions spawned from the GUI
// inherit the cleaned environment as well.
delete process.env.HARNESS_EXECUTION_CREDENTIAL;

// Automated Electron runs render normally but never claim the user's desktop.
const backgroundTest = app.commandLine.hasSwitch("headless");
if (backgroundTest && process.platform === "darwin") app.setActivationPolicy("accessory");

// harness-edge:// 协议激活(task_0499bcc75d0f):点击邀请链接唤起本 app,把链接交给加入向导。
// 冷启动时窗口可能尚未加载完,先暂存,任一窗口 did-finish-load 后送达;注册在 whenReady 之前,
// macOS 冷启动的 open-url 才不会丢。打包态才注册协议,dev 运行不接管系统的协议绑定。
let pendingEdgeJoinLink: string | null = null;
function deliverEdgeJoinLink(link: string): void {
  const loaded = BrowserWindow.getAllWindows().filter(
    (window) => !window.isDestroyed() && !window.webContents.isLoading(),
  );
  if (loaded.length === 0) {
    pendingEdgeJoinLink = link;
    return;
  }
  for (const window of loaded) window.webContents.send(EDGE_JOIN_LINK_CHANNEL, { link });
}

app.on("web-contents-created", (_event, contents) => {
  // A top-level BrowserWindow's webContents reports type "window"; webviews/background pages must not receive it.
  if (contents.getType() !== "window") return;
  contents.once("did-finish-load", () => {
    if (pendingEdgeJoinLink === null || contents.isDestroyed()) return;
    contents.send(EDGE_JOIN_LINK_CHANNEL, { link: pendingEdgeJoinLink });
    pendingEdgeJoinLink = null;
  });
});
app.on("open-url", (event, url) => {
  const link = edgeJoinLinkFromArgv([url]);
  if (link === null) return;
  event.preventDefault();
  deliverEdgeJoinLink(link);
});
// Windows/Linux 把协议激活作为「第二个实例」的命令行参数送达(进程已存在时不再开新窗);
// 锁按 user-data-dir 隔离,测试/e2e 的独立 profile 不会与用户正在用的实例互抢。
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) app.quit();
else
  app.on("second-instance", (_event, argv) => {
    const link = edgeJoinLinkFromArgv(argv);
    if (link !== null) deliverEdgeJoinLink(link);
  });

/** Per-sign-in login webview boundary; created once so its certificate-error handler is, too. */
const loginWebviewSecurity = createLoginWebviewSecurity();

export function createMainWindow(initialRepoId?: string): BrowserWindow {
  const preloadPath = path.join(resolveGuiPackageRoot(), "dist-electron/electron-preload.cjs");
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  const packagedRendererUrl = createPackagedRendererUrl();
  const mainWindow = new BrowserWindow({
    title: "Harness Anything",
    // 只作用于 Windows/Linux 的窗口与任务栏图标;macOS Dock 走上面的 app.dock.setIcon。
    icon: appIconPath(),
    // macOS 隐藏系统标题栏,红绿灯嵌进应用自己的顶行(窗口拖拽区见 renderer 侧
    // styles.css 的 titlebar 规则);其余平台展开为空,参数不变。
    ...guiPlatformWindowOptions(),
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    focusable: !backgroundTest,
    // 窗口本体先于渲染层文档存在:未预设底色时冷启动首帧与 resize 露出系统白底。
    // 按主进程可感知的主题信号(原生主题;应用内选择存 renderer localStorage,首帧前
    // 不可见)预铺应用底色(styles.css --color-bg 的预换算 hex)。
    backgroundColor: windowBackgroundColor(nativeTheme.shouldUseDarkColors),
    webPreferences: {
      backgroundThrottling: !backgroundTest,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: true,
      preload: preloadPath,
      // 「在新窗口打开」的初始项目走 additionalArguments(不进 URL:打包态 file:// 文档
      // 的 query 会被 isNavigableAppDocumentUrl 拒绝),preload 从 argv 读出后作 App 的
      // 选仓种子;普通启动没有该参数,单窗口行为不变。
      ...(initialRepoId === undefined ? {} : { additionalArguments: [projectWindowArgument(initialRepoId)] }),
    },
  });

  mainWindow.once("ready-to-show", () => {
    if (!backgroundTest) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  // 原生主题翻转时窗口底色跟随创建时的同一 token。窗口关闭即注销;"updated" 可能
  // 在销毁与注销之间送达,此时跳过,避免对已销毁窗口调用 setBackgroundColor。
  const syncWindowBackground = () => {
    if (!mainWindow.isDestroyed())
      mainWindow.setBackgroundColor(windowBackgroundColor(nativeTheme.shouldUseDarkColors));
  };
  nativeTheme.on("updated", syncWindowBackground);
  mainWindow.once("closed", () => nativeTheme.off("updated", syncWindowBackground));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: evaluateWindowOpenRequest().action }));
  // 鼠标侧键(Windows/Linux):OS 把侧键转成 app-command 而不是 DOM mousedown 3/4,
  // 这里把它转发给 renderer 的统一导航历史;macOS 侧键走 DOM,不会重复触发。
  mainWindow.on("app-command", (_event, command) => {
    const navigation: AppNavigationCommand | null =
      command === "browser-backward" ? "back" : command === "browser-forward" ? "forward" : null;
    if (navigation) mainWindow.webContents.send(APP_COMMAND_CHANNEL, navigation);
  });
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
    // A sign-in over the daemon's self-signed listener holds an opaque one-shot token naming a
    // main-generated partition; the token itself is never a partition and authorizes only the
    // exact authorization URL this sign-in began with.
    const loginAttachment = loginWebviewSecurity.consumeWebviewAttachment(params);
    if (loginAttachment) {
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
      webPreferences.partition = loginAttachment.partition;
      params.partition = loginAttachment.partition;
      delete params.preload;
      return;
    }
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
    // Binds the guest into its sign-in's grant (certificate decisions, origin guards); guests of
    // any other session fall through unchanged.
    if (loginWebviewSecurity.attachGuest(guest)) return;
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
  // A losing second instance still reaches whenReady; it must not build windows or services.
  if (!singleInstanceLock) return;
  await app.whenReady();
  const moved = await ensureApplicationsFolder({ app, dialog });
  if (moved) return;
  // macOS 的协议绑定来自打包的 Info.plist;Windows/Linux 由运行时写注册表/桌面项。
  if (app.isPackaged && process.platform !== "darwin") app.setAsDefaultProtocolClient("harness-edge");
  if (process.platform === "darwin") {
    // npm 通路跑的是通用 Electron bundle,Dock 瓦片默认是它的 electron.icns;
    // 运行期只有 app.dock.setIcon 换得动(task_e07b30fd 阶段一三探针实测)。
    app.dock?.setIcon(appIconPath());
  }
  installContentSecurityPolicy();
  loginWebviewSecurity.installCertificateErrorHandler(app);
  const trustedWebContentsIds = new Set<number>();
  // 项目窗口注册表(task_ca1ee6b9e8f83c89cb376e5f07):窗口↔项目记账。开窗两条路
  // (CEO 2026-10-17 裁定):切换器「在新窗口打开」已开即聚焦(openProjectWindow);
  // 菜单「新建窗口 ⌘⇧N」总是新建、以当前项目作种子(newWindow)。headless 运行不碰
  // 窗口可见性(后台验收要求全部窗口保持隐藏)。
  const projectWindows = createProjectWindowRegistry({
    createProjectWindow: (repoId) => toProjectWindowEntry(createTrustedMainWindow(trustedWebContentsIds, repoId)),
    focusWindows: !backgroundTest,
  });
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        // 「文件 → 新建窗口 ⌘⇧N」总是新建,不去重(CEO 2026-10-17 裁定);以聚焦窗口
        // 的项目作初始项目,焦点不在任何窗口或未选项目时开默认窗口。
        darwinAppMenuTemplate(() =>
          menuNewWindow(projectWindows, BrowserWindow.getFocusedWindow()?.webContents.id ?? null),
        ),
      ),
    );
  }
  const rootDir = resolveGuiProjectRoot(),
    bridge = createLocalGuiServiceBridge(rootDir),
    controlled = addLocalMainControls({
      bridge,
      target: async (repoId) => resolveLocalDaemonTarget({ rootDir, ...(repoId ? { repoIdOverride: repoId } : {}) }),
    }),
    trustPolicy: IpcWebContentsTrustPolicy = {
      isTrustedWebContentsId: (id) => trustedWebContentsIds.has(id),
      rendererUrl: {
        packagedRendererUrl: createPackagedRendererUrl(),
        allowDevRenderer: Boolean(process.env.ELECTRON_RENDERER_URL),
      },
    };
  registerHarnessIpcHandlers(ipcMain, controlled, trustPolicy);
  registerProjectDirectoryIpc(
    ipcMain,
    {
      registeredRoot: (repoId) => {
        const repo = readDaemonRegistry({ userRoot: guiDaemonUserRoot() }).repos.find((row) => row.repoId === repoId);
        return repo?.mode === "remote-proxy" ? null : (repo?.canonicalRoot ?? null);
      },
      openPath: (root) => shell.openPath(root),
    },
    trustPolicy,
  );
  registerOidcAuthIpc(ipcMain, trustPolicy, {
    daemonRequest: (params) => requestDaemonAdminRpc("daemon.rbac.manage", params),
    openExternal: (url) => shell.openExternal(url),
    // A listener-backed sign-in loads in its own non-persistent partition whose certificate trust
    // is decided per request (full origin, guest identity, fingerprint) and dies with the sign-in;
    // the default session and the in-app browser partition are never relaxed.
    openLoginWebview: loginWebviewSecurity.openLoginWebview,
  });
  registerAccessAdminIpc(ipcMain, trustPolicy, {
    daemonRequest: (params) => requestDaemonAdminRpc("daemon.rbac.manage", params),
    operationId: randomUUID,
  });
  registerCenterSettingsIpc(ipcMain, trustPolicy, {
    daemonRequest: (params) => requestDaemonAdminRpc("daemon.rbac.manage", params),
    dialog: {
      selectFile: async (kind) => {
        const selected = await dialog.showOpenDialog({
          title:
            kind === "certificate" ? "Choose the login service certificate" : "Choose the login service private key",
          properties: ["openFile"],
          filters:
            kind === "certificate"
              ? [{ name: "Certificates", extensions: ["pem", "crt", "cer"] }]
              : [{ name: "Private keys", extensions: ["key", "pem"] }],
        });
        return selected.canceled ? null : (selected.filePaths[0] ?? null);
      },
    },
  });
  // 边缘节点加入向导(task_0499bcc75d0f):只调用 daemon 既有 edge join,主进程收窄见
  // main/edge-join-entry-ipc.ts;「在浏览器打开」只开 daemon 返回的登录页。
  registerEdgeJoinEntryIpc(ipcMain, trustPolicy, {
    daemonRequest: (params) => requestDaemonAdminRpc("daemon.rbac.manage", params),
    openExternal: (url) => shell.openExternal(url),
  });
  // 「在默认浏览器打开」(task_7e713fee;W3 扩 remote-proxy 物化副本):主进程收窄见 artifact-open-ipc.ts。
  registerArtifactOpenIpc(
    ipcMain,
    {
      canonicalRootOf: (repoId) => {
        const target = resolveLocalDaemonTargetFromRepos(
          { rootDir, repoIdOverride: repoId },
          readDaemonRegistry({ userRoot: guiDaemonUserRoot() }).repos,
        );
        if (target.repoId !== repoId) throw new Error(`Repository ${repoId} is not registered and enabled.`);
        return target.canonicalRoot;
      },
      repoModeOf: (repoId) =>
        readDaemonRegistry({ userRoot: guiDaemonUserRoot() }).repos.find((repo) => repo.repoId === repoId)?.mode ??
        null,
      readDocument: async (repoId, taskId, artifactPath) => {
        const result = await requestRepoScopedRpc(rootDir, repoId, "repo.tasks.document.read", {
          repo: { repoId },
          payload: { taskId, path: artifactPath },
        });
        const record = result as {
          readonly ok?: boolean;
          readonly body?: unknown;
          readonly worktreeBody?: unknown;
          readonly uncommitted?: unknown;
          readonly bytes?: unknown;
          readonly contentKind?: unknown;
          readonly size?: unknown;
          readonly repositoryPath?: unknown;
          readonly error?: { readonly hint?: unknown };
        };
        if (record.ok !== true || typeof record.body !== "string")
          throw new Error(
            typeof record.error?.hint === "string" ? record.error.hint : "Remote artifact body read failed.",
          );
        return {
          body: record.body,
          worktreeBody: typeof record.worktreeBody === "string" ? record.worktreeBody : null,
          uncommitted: record.uncommitted === true,
          // raw 产物的 canonical 字节;文本产物为 null,物化仍走正文。
          bytes: typeof record.bytes === "string" ? record.bytes : null,
          contentKind: record.contentKind === "binary" ? ("binary" as const) : ("text" as const),
          size: typeof record.size === "number" ? record.size : null,
          repositoryPath: typeof record.repositoryPath === "string" ? record.repositoryPath : null,
        };
      },
      artifactCacheRoot: () => guiArtifactCacheRoot(),
      openPath: (absolutePath) => shell.openPath(absolutePath),
    },
    trustPolicy,
  );
  // Settings → 仓库与连接(PLT-EdgeGUI-W3):连接/仓库 admin 全部经本机 daemon RPC,GUI 零远程 transport。
  registerConnectionAdminIpc(ipcMain, { request: requestDaemonAdminRpc }, trustPolicy);
  // 首启安装失败不再挡住窗口(评审 2026-10-17):每一步的失败记成 setupFailures,由引导屏
  // 以「哪一步/为什么/怎么办」显示;窗口与 IPC 永远先于安装步骤存在。
  let desktopSetupFailures: readonly DesktopSetupFailure[] = [];
  const desktopStatusReport = async (): Promise<unknown> => ({
    ...(await desktopFirstRunReport({ runtime: desktopRuntimePaths(process.resourcesPath, app.getAppPath()) })),
    setupFailures: desktopSetupFailures,
  });
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
      desktopStatus: () => desktopStatusReport(),
      desktopSetup: async () => {
        desktopSetupFailures = await prepareDesktopFirstRun();
        return desktopStatusReport();
      },
    },
    trustPolicy,
  );
  // GUI 内读本机文档(task_89d324b5):节点本地只读查询,主进程收窄见 local-doc-ipc.ts。
  registerLocalDocIpc(ipcMain, { homeDir: () => homedir() }, trustPolicy);
  registerProjectWindowIpc(ipcMain, projectWindows, trustPolicy);
  projectWindows.newWindow(null);
  // Windows/Linux 协议激活在冷启动参数里;窗口已建,直接送达(macOS 冷启动走 open-url 暂存路径)。
  const argvLink = edgeJoinLinkFromArgv(process.argv);
  if (argvLink !== null) deliverEdgeJoinLink(argvLink);
  const updaterWindow = BrowserWindow.getAllWindows()[0];
  if (updaterWindow) registerUpdaterIpc(ipcMain, updaterWindow, trustPolicy, autoUpdater, app.getVersion());
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) projectWindows.newWindow(null);
  });
  // 窗口与 IPC 就绪后才跑首启安装;失败只进引导屏,任何一步出错都不会让 App 无窗口退出。
  void prepareDesktopFirstRun().then((failures) => {
    desktopSetupFailures = failures;
  });
}

function toProjectWindowEntry(mainWindow: BrowserWindow): ProjectWindowRegistryEntry {
  return {
    webContentsId: mainWindow.webContents.id,
    focus() {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    },
    onClosed: (listener) => mainWindow.once("closed", listener),
  };
}

function createTrustedMainWindow(trustedWebContentsIds: Set<number>, initialRepoId: string | null): BrowserWindow {
  const mainWindow = createMainWindow(initialRepoId === null ? undefined : initialRepoId);
  // Capture the id now: by the time "closed" fires the native window is
  // destroyed and reading mainWindow.webContents throws "Object has been destroyed".
  const webContentsId = mainWindow.webContents.id;
  trustedWebContentsIds.add(webContentsId);
  mainWindow.once("closed", () => {
    trustedWebContentsIds.delete(webContentsId);
  });
  return mainWindow;
}

export function resolveGuiProjectRoot(): string {
  return path.resolve(process.env.HARNESS_GUI_ROOT ?? process.cwd());
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

if (app.isPackaged || process.argv.some((arg) => /electron-main\.(?:js|ts)$/u.test(arg))) {
  startGuiApp().catch((err) => {
    console.error("[FATAL] startGuiApp failed:", err);
  });
}

/** Install the user-owned CLI shim, PATH entry, and daemon service, then tell open windows to
 *  refresh their guide screen. Per-step failures are returned, never thrown. */
async function prepareDesktopFirstRun(): Promise<readonly DesktopSetupFailure[]> {
  const runtime = desktopRuntimePaths(process.resourcesPath, app.getAppPath());
  if (!existsSync(runtime.node) || !existsSync(runtime.cli) || !existsSync(runtime.daemon)) return [];
  const failures = await runDesktopSetup({ runtime });
  for (const browserWindow of BrowserWindow.getAllWindows())
    if (!browserWindow.isDestroyed()) browserWindow.webContents.send(DESKTOP_FIRST_RUN_UPDATED_CHANNEL, null);
  return failures;
}
