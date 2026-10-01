import { PROJECT_DIRECTORY_CHANNEL, type ProjectDirectoryApi } from "../api/project-directory-contract.ts";
import { contextBridge, ipcRenderer } from "electron";
import {
  HARNESS_PRELOAD_API,
  assertPreloadPayload,
  preloadApiCapabilities,
  preloadAllowlist,
  type PreloadApiMethod,
} from "./allowlist.ts";
import { agentRuntimePreloadApi } from "./agent-runtime-preload.ts";
import { daemonGuiActionMethods, daemonGuiStreamFacets } from "@harness-anything/daemon/protocol";
import { FIRST_RUN_BOOTSTRAP_CHANNEL, FIRST_RUN_CHOOSE_CHANNEL, type FirstRunApi } from "../api/first-run-contract.ts";
import { ARTIFACT_OPEN_EXTERNAL_CHANNEL, type ArtifactOpenApi } from "../api/artifact-open-contract.ts";
import { LOCAL_DOC_READ_CHANNEL, LOCAL_DOC_WRITE_CHANNEL, type LocalDocApi } from "../api/local-doc-contract.ts";
import {
  OIDC_LOGIN_CHANNEL,
  OIDC_LOGOUT_CHANNEL,
  OIDC_STATUS_CHANNEL,
  OIDC_BINDING_STATUS_CHANNEL,
  OIDC_OPEN_CONSOLE_CHANNEL,
  OIDC_CONFIGURE_CHANNEL,
  OIDC_BOOTSTRAP_STATUS_CHANNEL,
  OIDC_BOOTSTRAP_ADMIN_CHANNEL,
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
    chooseRepository: () => invoke(FIRST_RUN_CHOOSE_CHANNEL, null),
    bootstrap: (input) => invoke(FIRST_RUN_BOOTSTRAP_CHANNEL, input),
  } satisfies FirstRunApi,
  artifacts: {
    openExternal: (input) => invoke(ARTIFACT_OPEN_EXTERNAL_CHANNEL, input),
  } satisfies ArtifactOpenApi,
  // GUI 内读本机文档(task_89d324b5)与写回 SKILL.md(task_5dfe382f):主进程收窄见 main/local-doc-ipc.ts。
  localDoc: {
    read: (input) => invoke(LOCAL_DOC_READ_CHANNEL, input),
    write: (input) => invoke(LOCAL_DOC_WRITE_CHANNEL, input),
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
    login: () => invoke(OIDC_LOGIN_CHANNEL, null),
    logout: () => invoke(OIDC_LOGOUT_CHANNEL, null),
    status: () => invoke(OIDC_STATUS_CHANNEL, null),
    bindingStatus: () => invoke(OIDC_BINDING_STATUS_CHANNEL, null),
    openConsole: () => invoke(OIDC_OPEN_CONSOLE_CHANNEL, null),
    configure: (input) => invoke(OIDC_CONFIGURE_CHANNEL, input),
    bootstrapStatus: () => invoke(OIDC_BOOTSTRAP_STATUS_CHANNEL, null),
    bootstrapAdmin: (input) => invoke(OIDC_BOOTSTRAP_ADMIN_CHANNEL, input),
  } satisfies OidcAuthApi,
  projects: {
    openDirectory: (input) => invoke(PROJECT_DIRECTORY_CHANNEL, input),
  } satisfies ProjectDirectoryApi,
  capabilities: preloadApiCapabilities,
};

contextBridge.exposeInMainWorld(HARNESS_PRELOAD_API, exposedHarnessApi);
