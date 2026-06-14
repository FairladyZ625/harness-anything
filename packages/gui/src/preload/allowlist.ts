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
export type PreloadApiCapabilityStatus = "shipped" | "deferred";

export interface PreloadApiCapability {
  readonly method: PreloadApiMethod;
  readonly status: PreloadApiCapabilityStatus;
  readonly reason?: string;
}

export const preloadApiCapabilities = {
  getTasks: { method: "getTasks", status: "shipped" },
  getTaskDetail: { method: "getTaskDetail", status: "shipped" },
  getTaskDocument: { method: "getTaskDocument", status: "shipped" },
  setTaskStatus: { method: "setTaskStatus", status: "shipped" },
  reviewTask: { method: "reviewTask", status: "shipped" },
  archiveTask: {
    method: "archiveTask",
    status: "deferred",
    reason: "Archive is a disabled placeholder until closeout/archive route ownership is implemented."
  },
  appendTaskProgress: { method: "appendTaskProgress", status: "shipped" },
  rebuildGovernance: { method: "rebuildGovernance", status: "shipped" },
  openShell: {
    method: "openShell",
    status: "deferred",
    reason: "Legacy openShell is display-only; shipped terminal lifecycle uses terminal session APIs."
  }
} as const satisfies Record<PreloadApiMethod, PreloadApiCapability>;

export const preloadAllowlist = Object.freeze(Object.keys(allowedPreloadApi) as ReadonlyArray<PreloadApiMethod>);
export const shippedPreloadMethods = Object.freeze(preloadAllowlist.filter((method) => preloadApiCapabilities[method].status === "shipped"));
export const deferredPreloadMethods = Object.freeze(preloadAllowlist.filter((method) => preloadApiCapabilities[method].status === "deferred"));

export function isAllowedPreloadApiMethod(method: string): method is PreloadApiMethod {
  return preloadAllowlist.includes(method as PreloadApiMethod);
}

export function getPreloadApiCapability(method: PreloadApiMethod): PreloadApiCapability {
  return preloadApiCapabilities[method];
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
