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
  capabilities: preloadApiCapabilities,
};

contextBridge.exposeInMainWorld(HARNESS_PRELOAD_API, exposedHarnessApi);
