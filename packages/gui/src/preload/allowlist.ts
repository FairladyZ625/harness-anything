export const HARNESS_PRELOAD_API = "harness";

export const allowedPreloadApi = {
  getTasks: "getTasks",
  getTaskDetail: "getTaskDetail",
  getTaskDocument: "getTaskDocument",
  setTaskStatus: "setTaskStatus",
  reviewTask: "reviewTask",
  archiveTask: "archiveTask",
  appendTaskProgress: "appendTaskProgress",
  rebuildGovernance: "rebuildGovernance",
  openShell: "openShell"
} as const;

export type PreloadApiMethod = keyof typeof allowedPreloadApi;

export const preloadAllowlist = Object.freeze(Object.keys(allowedPreloadApi) as ReadonlyArray<PreloadApiMethod>);

export function isAllowedPreloadApiMethod(method: string): method is PreloadApiMethod {
  return preloadAllowlist.includes(method as PreloadApiMethod);
}

export function assertPreloadPayload(method: string, payload: unknown): true {
  if (!isAllowedPreloadApiMethod(method)) {
    throw new Error(`Preload method is not allowed: ${method}`);
  }
  if (payload !== null && (typeof payload !== "object" || Array.isArray(payload))) {
    throw new Error("Preload payload must be an object or null.");
  }
  return true;
}
