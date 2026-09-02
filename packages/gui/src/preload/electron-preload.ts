import { contextBridge, ipcRenderer } from "electron";
import {
  HARNESS_PRELOAD_API,
  assertPreloadPayload,
  preloadApiCapabilities,
  preloadAllowlist,
  type PreloadApiMethod,
} from "./allowlist.ts";
import { agentRuntimePreloadApi } from "./agent-runtime-preload.ts";
import { daemonGuiStreamFacets } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { FIRST_RUN_BOOTSTRAP_CHANNEL, FIRST_RUN_CHOOSE_CHANNEL, type FirstRunApi } from "../api/first-run-contract.ts";
import { ARTIFACT_OPEN_EXTERNAL_CHANNEL, type ArtifactOpenApi } from "../api/artifact-open-contract.ts";
import { LOCAL_DOC_READ_CHANNEL, type LocalDocApi } from "../api/local-doc-contract.ts";
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
const exposedApi = Object.fromEntries(
  preloadAllowlist
    .filter((method) => !streamMethods.has(method))
    .map((method) => [
      method,
      (payload: unknown = null) => {
        assertPreloadPayload(method, payload);
        return ipcRenderer.invoke(`harness:${method}`, payload);
      },
    ]),
) as Record<PreloadApiMethod, (payload?: unknown) => Promise<unknown>>;
const exposedHarnessApi = {
  ...exposedApi,
  ...agentRuntimePreloadApi(ipcRenderer),
  firstRun: {
    chooseRepository: () => ipcRenderer.invoke(FIRST_RUN_CHOOSE_CHANNEL, null),
    bootstrap: (input) => ipcRenderer.invoke(FIRST_RUN_BOOTSTRAP_CHANNEL, input),
  } satisfies FirstRunApi,
  artifacts: {
    openExternal: (input) => ipcRenderer.invoke(ARTIFACT_OPEN_EXTERNAL_CHANNEL, input),
  } satisfies ArtifactOpenApi,
  // GUI 内读本机文档(task_89d324b5):只读通道,主进程收窄见 main/local-doc-ipc.ts。
  localDoc: {
    read: (input) => ipcRenderer.invoke(LOCAL_DOC_READ_CHANNEL, input),
  } satisfies LocalDocApi,
  // Settings → 仓库与连接(PLT-EdgeGUI-W3):连接/仓库 admin,主进程收窄见 main/connection-admin-ipc.ts。
  connections: {
    status: () => ipcRenderer.invoke(CONNECTION_STATUS_CHANNEL, null),
    probe: (input) => ipcRenderer.invoke(CONNECTION_PROBE_CHANNEL, input),
    register: (input) => ipcRenderer.invoke(CONNECTION_REGISTER_CHANNEL, input),
    update: (input) => ipcRenderer.invoke(CONNECTION_UPDATE_CHANNEL, input),
    unregister: (input) => ipcRenderer.invoke(CONNECTION_UNREGISTER_CHANNEL, input),
  } satisfies ConnectionAdminApi,
  repoAdmin: {
    register: (input) => ipcRenderer.invoke(REPO_REGISTER_CHANNEL, input),
    update: (input) => ipcRenderer.invoke(REPO_UPDATE_CHANNEL, input),
    unregister: (input) => ipcRenderer.invoke(REPO_UNREGISTER_CHANNEL, input),
    inspectWorkspace: (input) => ipcRenderer.invoke(WORKSPACE_INSPECT_CHANNEL, input),
  } satisfies RepoAdminApi,
  capabilities: preloadApiCapabilities,
};

contextBridge.exposeInMainWorld(HARNESS_PRELOAD_API, exposedHarnessApi);
