import { PROJECT_DIRECTORY_CHANNEL, type ProjectDirectoryApi } from "../api/project-directory-contract.ts";
import {
  PROJECT_WINDOW_ACTIVE_CHANNEL,
  PROJECT_WINDOW_OPEN_CHANNEL,
  initialProjectFromArgv,
  type ProjectWindowApi,
} from "../api/project-window-contract.ts";
import { APP_COMMAND_CHANNEL, type AppCommandApi, type AppNavigationCommand } from "../api/app-command-contract.ts";
import { contextBridge, ipcRenderer } from "electron";
import {
  HARNESS_PRELOAD_API,
  assertPreloadPayload,
  preloadApiCapabilities,
  preloadAllowlist,
  type PreloadApiMethod,
} from "./allowlist.ts";
import { agentRuntimePreloadApi } from "./agent-runtime-preload.ts";
import { accessAdminPreloadApi } from "./access-admin-preload.ts";
import { daemonGuiActionMethods, daemonGuiStreamFacets } from "@harness-anything/daemon/protocol";
import {
  FIRST_RUN_BOOTSTRAP_CHANNEL,
  FIRST_RUN_CHOOSE_CHANNEL,
  DESKTOP_FIRST_RUN_STATUS_CHANNEL,
  DESKTOP_FIRST_RUN_SETUP_CHANNEL,
  DESKTOP_FIRST_RUN_UPDATED_CHANNEL,
  type FirstRunApi,
} from "../api/first-run-contract.ts";
import { ARTIFACT_OPEN_EXTERNAL_CHANNEL, type ArtifactOpenApi } from "../api/artifact-open-contract.ts";
import {
  LOCAL_DOC_READ_CHANNEL,
  LOCAL_DOC_WRITE_CHANNEL,
  LOCAL_DOC_PPTX_CHANNEL,
  LOCAL_DOC_EXTRACT_WORD_CHANNEL,
  type LocalDocApi,
} from "../api/local-doc-contract.ts";
import {
  OIDC_LOGIN_CHANNEL,
  OIDC_LOGIN_URL_CHANNEL,
  OIDC_CANCEL_LOGIN_CHANNEL,
  OIDC_LOGOUT_CHANNEL,
  OIDC_STATUS_CHANNEL,
  OIDC_BINDING_STATUS_CHANNEL,
  OIDC_OPEN_CONSOLE_CHANNEL,
  OIDC_CONFIGURE_CHANNEL,
  OIDC_BOOTSTRAP_STATUS_CHANNEL,
  OIDC_BOOTSTRAP_ADMIN_CHANNEL,
  type EmbeddedLoginPage,
  type OidcAuthApi,
} from "../api/oidc-auth-contract.ts";
import {
  CONNECTION_PROBE_CHANNEL,
  CONNECTION_REGISTER_CHANNEL,
  CONNECTION_STATUS_CHANNEL,
  CONNECTION_UNREGISTER_CHANNEL,
  CONNECTION_UPDATE_CHANNEL,
  REPO_REGISTER_CHANNEL,
  REPO_UNREGISTER_CHANNEL,
  REPO_UPDATE_CHANNEL,
  WORKSPACE_INSPECT_CHANNEL,
  type ConnectionAdminApi,
  type RepoAdminApi,
} from "../api/connection-admin-contract.ts";
const streamMethods: ReadonlySet<string> = new Set(daemonGuiStreamFacets.map(({ guiBridgeMethod }) => guiBridgeMethod));
const actionMethods: ReadonlySet<string> = new Set(
  daemonGuiActionMethods.map(({ guiBridgeMethod }) => guiBridgeMethod),
);
const electronInvokeErrorPrefix = /^Error invoking remote method '[^']+': Error: /u;

async function invoke<T>(channel: string, payload: unknown): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, payload)) as T;
  } catch (cause) {
    if (!(cause instanceof Error)) throw cause;
    const message = cause.message.replace(electronInvokeErrorPrefix, "");
    if (message === cause.message) throw cause;
    throw new Error(message);
  }
}

const exposedApi = Object.fromEntries(
  preloadAllowlist
    .filter((method) => !streamMethods.has(method) && !actionMethods.has(method))
    .map((method) => [
      method,
      (payload: unknown = null) => {
        assertPreloadPayload(method, payload);
        return invoke(`harness:${method}`, payload);
      },
    ]),
) as Record<PreloadApiMethod, (payload?: unknown) => Promise<unknown>>;
const exposedHarnessApi = {
  request: (method: string, payload: unknown = null) => {
    assertPreloadPayload(method, payload);
    return invoke(`harness:${method}`, payload);
  },
  ...exposedApi,
  ...agentRuntimePreloadApi(ipcRenderer),
  firstRun: {
    desktopStatus: () => invoke(DESKTOP_FIRST_RUN_STATUS_CHANNEL, null),
    desktopSetup: () => invoke(DESKTOP_FIRST_RUN_SETUP_CHANNEL, null),
    // 首启安装在主进程后台完成后推送;引导屏收到后重新拉取状态(含逐步失败)。
    onDesktopFirstRunUpdated: (listener) => {
      const subscription = () => listener();
      ipcRenderer.on(DESKTOP_FIRST_RUN_UPDATED_CHANNEL, subscription);
      return () => ipcRenderer.removeListener(DESKTOP_FIRST_RUN_UPDATED_CHANNEL, subscription);
    },
    chooseRepository: () => invoke(FIRST_RUN_CHOOSE_CHANNEL, null),
    bootstrap: (input) => invoke(FIRST_RUN_BOOTSTRAP_CHANNEL, input),
  } satisfies FirstRunApi,
  artifacts: {
    openExternal: (input) => invoke(ARTIFACT_OPEN_EXTERNAL_CHANNEL, input),
  } satisfies ArtifactOpenApi,
  // GUI 内读本机文档(task_89d324b5)与写回 SKILL.md(task_5dfe382f):主进程收窄见 main/local-doc-ipc.ts。
  localDoc: {
    extractWordText: (input) => invoke(LOCAL_DOC_EXTRACT_WORD_CHANNEL, input),
    read: (input) => invoke(LOCAL_DOC_READ_CHANNEL, input),
    write: (input) => invoke(LOCAL_DOC_WRITE_CHANNEL, input),
    pptx: (input) => invoke(LOCAL_DOC_PPTX_CHANNEL, input),
  } satisfies LocalDocApi,
  // Settings → 仓库与连接(PLT-EdgeGUI-W3):连接/仓库 admin,主进程收窄见 main/connection-admin-ipc.ts。
  connections: {
    status: () => invoke(CONNECTION_STATUS_CHANNEL, null),
    probe: (input) => invoke(CONNECTION_PROBE_CHANNEL, input),
    register: (input) => invoke(CONNECTION_REGISTER_CHANNEL, input),
    update: (input) => invoke(CONNECTION_UPDATE_CHANNEL, input),
    unregister: (input) => invoke(CONNECTION_UNREGISTER_CHANNEL, input),
  } satisfies ConnectionAdminApi,
  repoAdmin: {
    register: (input) => invoke(REPO_REGISTER_CHANNEL, input),
    update: (input) => invoke(REPO_UPDATE_CHANNEL, input),
    unregister: (input) => invoke(REPO_UNREGISTER_CHANNEL, input),
    inspectWorkspace: (input) => invoke(WORKSPACE_INSPECT_CHANNEL, input),
  } satisfies RepoAdminApi,
  auth: {
    login: async (repoId, openBrowser, userCode) => {
      const listener = (_event: Electron.IpcRendererEvent, page: EmbeddedLoginPage) => openBrowser(page);
      ipcRenderer.on(OIDC_LOGIN_URL_CHANNEL, listener);
      try {
        return await invoke(OIDC_LOGIN_CHANNEL, { ...(repoId ? { repoId } : {}), ...(userCode ? { userCode } : {}) });
      } finally {
        ipcRenderer.removeListener(OIDC_LOGIN_URL_CHANNEL, listener);
      }
    },
    cancelLogin: () => invoke(OIDC_CANCEL_LOGIN_CHANNEL, null),
    logout: (repoId) => invoke(OIDC_LOGOUT_CHANNEL, repoId ? { repoId } : null),
    status: (repoId) => invoke(OIDC_STATUS_CHANNEL, repoId ? { repoId } : null),
    bindingStatus: (repoId) => invoke(OIDC_BINDING_STATUS_CHANNEL, repoId ? { repoId } : null),
    openConsole: (repoId) => invoke(OIDC_OPEN_CONSOLE_CHANNEL, repoId ? { repoId } : null),
    configure: (input, repoId) => invoke(OIDC_CONFIGURE_CHANNEL, { ...input, ...(repoId ? { repoId } : {}) }),
    bootstrapStatus: (repoId) => invoke(OIDC_BOOTSTRAP_STATUS_CHANNEL, repoId ? { repoId } : null),
    bootstrapAdmin: (input) => invoke(OIDC_BOOTSTRAP_ADMIN_CHANNEL, input),
  } satisfies OidcAuthApi,
  projects: {
    openDirectory: (input) => invoke(PROJECT_DIRECTORY_CHANNEL, input),
  } satisfies ProjectDirectoryApi,
  // 一个项目一个窗口(task_ca1ee6b9e8f83c89cb376e5f07):主进程按窗口上报的当前项目
  // 聚焦/开窗;本窗口的初始项目来自 additionalArguments(见 project-window-contract)。
  windows: {
    openProject: (input) => invoke(PROJECT_WINDOW_OPEN_CHANNEL, input),
    setActiveProject: (input) => invoke(PROJECT_WINDOW_ACTIVE_CHANNEL, input),
    initialProjectId: initialProjectFromArgv(process.argv),
  } satisfies ProjectWindowApi,
  // 鼠标侧键后退/前进:主进程 app-command 的只读订阅(见 api/app-command-contract.ts)。
  appCommand: {
    onNavigationCommand: (listener: (command: AppNavigationCommand) => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, command: AppNavigationCommand) => listener(command);
      ipcRenderer.on(APP_COMMAND_CHANNEL, subscription);
      return () => ipcRenderer.removeListener(APP_COMMAND_CHANNEL, subscription);
    },
  } satisfies AppCommandApi,
  // 账号与访问控制页:策略组、授权与回执,见 preload/access-admin-preload.ts。
  access: accessAdminPreloadApi(invoke),
  capabilities: preloadApiCapabilities,
};

contextBridge.exposeInMainWorld(HARNESS_PRELOAD_API, exposedHarnessApi);
