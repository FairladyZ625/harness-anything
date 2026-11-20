import { EXTERNAL_URL_OPEN_CHANNEL, type ExternalUrlApi } from "../api/external-url-contract.ts";
import { PROJECT_DIRECTORY_CHANNEL, type ProjectDirectoryApi } from "../api/project-directory-contract.ts";
import {
  PROJECT_WINDOW_ACTIVE_CHANNEL,
  PROJECT_WINDOW_OPEN_CHANNEL,
  initialProjectFromArgv,
  type ProjectWindowApi,
} from "../api/project-window-contract.ts";
import { APP_COMMAND_CHANNEL, type AppCommandApi, type AppNavigationCommand } from "../api/app-command-contract.ts";
import { contextBridge, ipcRenderer } from "electron";
import { reportCollaborationResponse } from "../api/collaboration-response.ts";
import {
  UPDATE_CHECK_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_STATUS_CHANNEL,
  UPDATE_STATUS_EVENT,
  type UpdateApi,
} from "../api/update-contract.ts";
import {
  HARNESS_PRELOAD_API,
  RPC_CHANNEL,
  STREAM_OPEN_CHANNEL,
  STREAM_CLOSE_CHANNEL,
  streamFrameChannel,
  preloadApiCapabilities,
} from "./allowlist.ts";
import type { DaemonStreamMethod } from "@harness-anything/daemon/protocol";
import { accessAdminPreloadApi, fleetAdminFromAccess } from "./access-admin-preload.ts";
import { centerSettingsPreloadApi } from "./center-settings-preload.ts";
import { edgeJoinEntryPreloadApi } from "./edge-join-entry-preload.ts";
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
} from "@harness-anything/authorization/gui/oidc-auth-contract";
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
const electronInvokeErrorPrefix = /^Error invoking remote method '[^']+': Error: /u;

async function invoke<T>(channel: string, payload: unknown): Promise<T> {
  try {
    const reply = await ipcRenderer.invoke(channel, payload);
    if (reply?.ipcFailure) {
      const failure = reply.ipcFailure as { code: string; message: string };
      throw Object.assign(new Error(failure.message), { code: failure.code });
    }
    reportCollaborationResponse(reply);
    return reply as T;
  } catch (cause) {
    reportCollaborationResponse(cause);
    if (!(cause instanceof Error)) throw cause;
    const message = cause.message.replace(electronInvokeErrorPrefix, "");
    if (message === cause.message) throw cause;
    throw new Error(message);
  }
}

let nextSubscription = 0;
const accessApi = accessAdminPreloadApi(invoke);
const exposedHarnessApi = {
  request: (method: string, params: unknown) => invoke(RPC_CHANNEL, { method, params }),
  subscribe: (
    method: DaemonStreamMethod,
    params: unknown,
    receive: (value: unknown) => void,
    onError: (error: unknown) => void,
  ) => {
    if (typeof receive !== "function" || typeof onError !== "function")
      throw new Error("Stream handlers are required.");
    const subscriptionId = `renderer-${++nextSubscription}`,
      channel = streamFrameChannel(subscriptionId),
      listener = (_event: Electron.IpcRendererEvent, value: unknown) => receive(value);
    ipcRenderer.on(channel, listener);
    let closed = false;
    function stop() {
      if (closed) return;
      closed = true;
      ipcRenderer.removeListener(channel, listener);
      void invoke(STREAM_CLOSE_CHANNEL, { subscriptionId }).catch(reportCollaborationResponse);
    }
    void invoke(STREAM_OPEN_CHANNEL, { method, params, subscriptionId }).catch((error: unknown) => {
      if (!closed) {
        stop();
        onError(error);
      }
    });
    return stop;
  },
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
  externalUrl: {
    open: (url) => invoke(EXTERNAL_URL_OPEN_CHANNEL, url),
  } satisfies ExternalUrlApi,
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
    login: async (repoId, openBrowser, userCode, rootDir) => {
      const listener = (_event: Electron.IpcRendererEvent, page: EmbeddedLoginPage) => openBrowser(page);
      ipcRenderer.on(OIDC_LOGIN_URL_CHANNEL, listener);
      try {
        return await invoke(OIDC_LOGIN_CHANNEL, {
          ...(repoId ? { repoId } : {}),
          ...(rootDir ? { rootDir } : {}),
          ...(userCode ? { userCode } : {}),
        });
      } finally {
        ipcRenderer.removeListener(OIDC_LOGIN_URL_CHANNEL, listener);
      }
    },
    cancelLogin: () => invoke(OIDC_CANCEL_LOGIN_CHANNEL, null),
    logout: (repoId, rootDir) =>
      invoke(OIDC_LOGOUT_CHANNEL, { ...(repoId ? { repoId } : {}), ...(rootDir ? { rootDir } : {}) }),
    status: (repoId, rootDir) =>
      invoke(OIDC_STATUS_CHANNEL, { ...(repoId ? { repoId } : {}), ...(rootDir ? { rootDir } : {}) }),
    bindingStatus: (repoId, rootDir) =>
      invoke(OIDC_BINDING_STATUS_CHANNEL, { ...(repoId ? { repoId } : {}), ...(rootDir ? { rootDir } : {}) }),
    openConsole: (repoId, rootDir) =>
      invoke(OIDC_OPEN_CONSOLE_CHANNEL, { ...(repoId ? { repoId } : {}), ...(rootDir ? { rootDir } : {}) }),
    configure: (input, repoId, rootDir) =>
      invoke(OIDC_CONFIGURE_CHANNEL, { ...input, ...(repoId ? { repoId } : {}), ...(rootDir ? { rootDir } : {}) }),
    bootstrapStatus: (repoId, rootDir) =>
      invoke(OIDC_BOOTSTRAP_STATUS_CHANNEL, { ...(repoId ? { repoId } : {}), ...(rootDir ? { rootDir } : {}) }),
    bootstrapAdmin: (input, rootDir) =>
      invoke(OIDC_BOOTSTRAP_ADMIN_CHANNEL, { ...input, ...(rootDir ? { rootDir } : {}) }),
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
  access: accessApi,
  fleetAdmin: fleetAdminFromAccess(accessApi),
  centerSettings: centerSettingsPreloadApi(invoke),
  // 边缘节点加入向导(task_0499bcc75d0f):join/poll/progress 与协议激活推送,主进程收窄见
  // main/edge-join-entry-ipc.ts。
  edgeJoin: edgeJoinEntryPreloadApi(invoke, (channel, listener) => {
    const subscription = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, subscription);
    return () => ipcRenderer.removeListener(channel, subscription);
  }),
  capabilities: preloadApiCapabilities,
  updates: {
    check: () => invoke(UPDATE_CHECK_CHANNEL, null),
    install: () => invoke(UPDATE_INSTALL_CHANNEL, null),
    status: () => invoke(UPDATE_STATUS_CHANNEL, null),
    onStatus: (listener) => {
      const subscription = (_event: Electron.IpcRendererEvent, status: unknown) =>
        listener(status as Parameters<typeof listener>[0]);
      ipcRenderer.on(UPDATE_STATUS_EVENT, subscription);
      return () => ipcRenderer.removeListener(UPDATE_STATUS_EVENT, subscription);
    },
  } satisfies UpdateApi,
};

contextBridge.exposeInMainWorld(HARNESS_PRELOAD_API, exposedHarnessApi);
