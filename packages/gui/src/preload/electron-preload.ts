import { contextBridge, ipcRenderer } from "electron";
import {
  HARNESS_PRELOAD_API,
  assertPreloadPayload,
  exposedPreloadApiCapabilities,
  preloadAllowlist,
  type PreloadApiMethod
} from "./allowlist.ts";

const exposedApi = Object.fromEntries(preloadAllowlist.map((method) => [
  method,
  (payload: unknown = null) => {
    assertPreloadPayload(method, payload);
    return ipcRenderer.invoke(`harness:${method}`, payload);
  }
])) as Record<PreloadApiMethod, (payload?: unknown) => Promise<unknown>>;

const exposedHarnessApi = {
  ...exposedApi,
  capabilities: exposedPreloadApiCapabilities
};

contextBridge.exposeInMainWorld(HARNESS_PRELOAD_API, exposedHarnessApi);
