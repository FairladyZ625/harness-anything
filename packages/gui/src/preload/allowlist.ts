import type { apiRouteContracts, deferredGuiBridgeContracts, terminalGuiBridgeContracts } from "../api/api-contract-registry.ts";

export const HARNESS_PRELOAD_API = "harness";

type ShippedPreloadApiMethod = Extract<(typeof apiRouteContracts)[number], { readonly guiBridgeMethod: string }>["guiBridgeMethod"];
type TerminalPreloadApiMethod = (typeof terminalGuiBridgeContracts)[number]["guiBridgeMethod"];
type DeferredPreloadApiMethod = (typeof deferredGuiBridgeContracts)[number]["guiBridgeMethod"];
type ActivePreloadApiMethod = ShippedPreloadApiMethod | TerminalPreloadApiMethod;
export type PreloadApiMethod = ActivePreloadApiMethod | DeferredPreloadApiMethod;
export type PreloadApiCapabilityStatus = "shipped" | "deferred";

export interface PreloadApiCapability {
  readonly method: PreloadApiMethod;
  readonly status: PreloadApiCapabilityStatus;
  readonly reason?: string;
}

export const allowedPreloadApi = Object.freeze({
  getCatalogSnapshot: "getCatalogSnapshot",
  getTasks: "getTasks",
  getTaskDetail: "getTaskDetail",
  getTaskDocument: "getTaskDocument",
  getPeripheralDocuments: "getPeripheralDocuments",
  getPeripheralDocument: "getPeripheralDocument",
  setTaskStatus: "setTaskStatus",
  reviewTask: "reviewTask",
  appendTaskProgress: "appendTaskProgress",
  rebuildGovernance: "rebuildGovernance",
  getTriadicProjection: "getTriadicProjection",
  getRelationGraph: "getRelationGraph",
  getDecisions: "getDecisions",
  getDecisionDetail: "getDecisionDetail",
  getFacts: "getFacts",
  getTaskFacts: "getTaskFacts",
  getExecutions: "getExecutions",
  getExecutionEvidencePage: "getExecutionEvidencePage",
  getTaskExecutions: "getTaskExecutions",
  getExecutionDetail: "getExecutionDetail",
  getReviewDetail: "getReviewDetail",
  proposeDecision: "proposeDecision",
  acceptDecision: "acceptDecision",
  rejectDecision: "rejectDecision",
  deferDecision: "deferDecision",
  archiveTask: "archiveTask",
  openShell: "openShell"
} as const satisfies { readonly [Method in ShippedPreloadApiMethod | DeferredPreloadApiMethod]: Method });

export const terminalPreloadApi = Object.freeze({
  terminalCreate: "terminalCreate",
  terminalWrite: "terminalWrite",
  terminalRead: "terminalRead",
  terminalResize: "terminalResize",
  terminalExit: "terminalExit"
} as const satisfies { readonly [Method in TerminalPreloadApiMethod]: Method });

export const preloadApiCapabilities = Object.freeze({
  getCatalogSnapshot: { method: "getCatalogSnapshot", status: "shipped" },
  getTasks: { method: "getTasks", status: "shipped" },
  getTaskDetail: { method: "getTaskDetail", status: "shipped" },
  getTaskDocument: { method: "getTaskDocument", status: "shipped" },
  getPeripheralDocuments: { method: "getPeripheralDocuments", status: "shipped" },
  getPeripheralDocument: { method: "getPeripheralDocument", status: "shipped" },
  setTaskStatus: { method: "setTaskStatus", status: "shipped" },
  reviewTask: { method: "reviewTask", status: "shipped" },
  appendTaskProgress: { method: "appendTaskProgress", status: "shipped" },
  rebuildGovernance: { method: "rebuildGovernance", status: "shipped" },
  getTriadicProjection: { method: "getTriadicProjection", status: "shipped" },
  getRelationGraph: { method: "getRelationGraph", status: "shipped" },
  getDecisions: { method: "getDecisions", status: "shipped" },
  getDecisionDetail: { method: "getDecisionDetail", status: "shipped" },
  getFacts: { method: "getFacts", status: "shipped" },
  getTaskFacts: { method: "getTaskFacts", status: "shipped" },
  getExecutions: { method: "getExecutions", status: "shipped" },
  getExecutionEvidencePage: { method: "getExecutionEvidencePage", status: "shipped" },
  getTaskExecutions: { method: "getTaskExecutions", status: "shipped" },
  getExecutionDetail: { method: "getExecutionDetail", status: "shipped" },
  getReviewDetail: { method: "getReviewDetail", status: "shipped" },
  proposeDecision: { method: "proposeDecision", status: "shipped" },
  acceptDecision: { method: "acceptDecision", status: "shipped" },
  rejectDecision: { method: "rejectDecision", status: "shipped" },
  deferDecision: { method: "deferDecision", status: "shipped" },
  archiveTask: {
    method: "archiveTask",
    status: "deferred",
    reason: "Archive is exposed in the preload allowlist as a disabled placeholder until the closeout/archive route contract is implemented."
  },
  openShell: {
    method: "openShell",
    status: "deferred",
    reason: "Legacy shell button remains a display-only GUI policy placeholder; terminal sessions use explicit terminal route contracts."
  }
} as const satisfies Record<ShippedPreloadApiMethod | DeferredPreloadApiMethod, PreloadApiCapability>);

export const terminalPreloadApiCapabilities = Object.freeze({
  terminalCreate: { method: "terminalCreate", status: "shipped" },
  terminalWrite: { method: "terminalWrite", status: "shipped" },
  terminalRead: { method: "terminalRead", status: "shipped" },
  terminalResize: { method: "terminalResize", status: "shipped" },
  terminalExit: { method: "terminalExit", status: "shipped" }
} as const satisfies Record<TerminalPreloadApiMethod, PreloadApiCapability>);

export const exposedPreloadApiCapabilities = Object.freeze({
  ...preloadApiCapabilities,
  ...terminalPreloadApiCapabilities
}) satisfies Record<PreloadApiMethod, PreloadApiCapability>;

export const preloadAllowlist = Object.freeze([
  ...Object.values(allowedPreloadApi),
  ...Object.values(terminalPreloadApi)
]) as ReadonlyArray<PreloadApiMethod>;

export const shippedPreloadMethods = Object.freeze(
  preloadAllowlist.filter((method): method is ActivePreloadApiMethod => exposedPreloadApiCapabilities[method].status === "shipped")
) as ReadonlyArray<ActivePreloadApiMethod>;

export const deferredPreloadMethods = Object.freeze(
  preloadAllowlist.filter((method): method is DeferredPreloadApiMethod => exposedPreloadApiCapabilities[method].status === "deferred")
) as ReadonlyArray<DeferredPreloadApiMethod>;

export function isAllowedPreloadApiMethod(method: string): method is PreloadApiMethod {
  return preloadAllowlist.includes(method as PreloadApiMethod);
}

export function getPreloadApiCapability(method: PreloadApiMethod): PreloadApiCapability {
  return exposedPreloadApiCapabilities[method];
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
