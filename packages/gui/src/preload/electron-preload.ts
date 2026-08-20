import { contextBridge, ipcRenderer } from "electron";
import {
  HARNESS_PRELOAD_API,
  assertPreloadPayload,
  preloadApiCapabilities,
  preloadAllowlist,
  type PreloadApiMethod
} from "./allowlist.ts";
import { agentRuntimePreloadApi } from "./agent-runtime-preload.ts";
import { daemonGuiStreamFacets } from "@harness-anything/daemon/protocol/daemon-protocol.contract";
const streamMethods: ReadonlySet<string> = new Set(daemonGuiStreamFacets.map(({ guiBridgeMethod }) => guiBridgeMethod));
const exposedApi = Object.fromEntries(preloadAllowlist.filter((method) => !streamMethods.has(method)).map((method) => [
  method,
  (payload: unknown = null) => {
    assertPreloadPayload(method, payload);
    return ipcRenderer.invoke(`harness:${method}`, payload);
  }
])) as Record<PreloadApiMethod, (payload?: unknown) => Promise<unknown>>;
const exposedHarnessApi = {
  ...exposedApi,
  ...agentRuntimePreloadApi(ipcRenderer),
  capabilities: preloadApiCapabilities
};

contextBridge.exposeInMainWorld(HARNESS_PRELOAD_API, exposedHarnessApi);
