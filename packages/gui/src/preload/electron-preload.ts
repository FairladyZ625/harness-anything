import { contextBridge, ipcRenderer } from "electron";
import {
  HARNESS_AGENT_RUNTIME_CREDENTIALS_CHANNEL,
  HARNESS_PRELOAD_API,
  HARNESS_PROJECTION_CHANGED_CHANNEL,
  HARNESS_WATCH_PROJECTION_CHANGES_CHANNEL,
  assertAgentRuntimeCredentialsPayload,
  assertPreloadPayload,
  assertProjectionWatchPayload,
  exposedPreloadApiCapabilities,
  preloadAllowlist,
  type AgentRuntimeCredentialsPayload,
  type AgentRuntimeCredentialsResult,
  type PreloadApiMethod,
  type ProjectionWatchResult,
  type RendererProjectionNotification
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
  capabilities: exposedPreloadApiCapabilities,
  watchProjectionChanges: (repoId: string): Promise<ProjectionWatchResult> => {
    const payload = { repoId };
    assertProjectionWatchPayload(payload);
    return ipcRenderer.invoke(HARNESS_WATCH_PROJECTION_CHANGES_CHANNEL, payload) as Promise<ProjectionWatchResult>;
  },
  onProjectionChanged: (listener: (notification: RendererProjectionNotification) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, notification: RendererProjectionNotification) => listener(notification);
    ipcRenderer.on(HARNESS_PROJECTION_CHANGED_CHANNEL, handler);
    return () => ipcRenderer.removeListener(HARNESS_PROJECTION_CHANGED_CHANNEL, handler);
  },
  writeAgentRuntimeCredentials: (payload: AgentRuntimeCredentialsPayload): Promise<AgentRuntimeCredentialsResult> => {
    const validated = assertAgentRuntimeCredentialsPayload(payload);
    return ipcRenderer.invoke(HARNESS_AGENT_RUNTIME_CREDENTIALS_CHANNEL, validated) as Promise<AgentRuntimeCredentialsResult>;
  }
};

contextBridge.exposeInMainWorld(HARNESS_PRELOAD_API, exposedHarnessApi);
