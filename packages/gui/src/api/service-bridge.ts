import {
  projectDaemonStatusForRenderer,
  type DaemonStatusResultV2
} from "../../../application/src/index.ts";
import type { PreloadApiMethod } from "../preload/allowlist.ts";
import { apiRouteContracts, deferredGuiBridgeContracts, terminalGuiBridgeContracts, type ApiRouteContract } from "./api-contract-registry.ts";
import { terminalBridgeHandlerImplementations } from "./terminal-bridge-handlers.ts";
import { isServicePayloadRecord, validateGuiRoutePayload } from "./gui-route-payload.ts";
export { validateGuiRoutePayload } from "./gui-route-payload.ts";

// Contract anchor: document path normalization remains owned by the daemon-side
// LocalControllerService via kernel normalizeRelativeDocumentPath. GUI main must
// not import that kernel barrel because it would reintroduce the sqlite ABI path.
export interface GuiServiceBridge {
  readonly invoke: (method: string, payload: unknown) => Promise<unknown>;
}

type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;
type ShippedGuiBridgeRoute = Extract<(typeof apiRouteContracts)[number], { readonly guiBridgeMethod: PreloadApiMethod }>;
type ShippedGuiBridgeMethod = ShippedGuiBridgeRoute["guiBridgeMethod"];
export type TerminalGuiBridgeMethod = (typeof terminalGuiBridgeContracts)[number]["guiBridgeMethod"];
type LocalControllerGuiMethod =
  | "getCatalogSnapshot" | "getTasks" | "getTaskDetail" | "getTaskDocument"
  | "getPeripheralDocuments" | "getPeripheralDocument" | "getRelationGraph"
  | "getTriadicProjection" | "getDecisions" | "getDecisionDetail" | "proposeDecision"
  | "acceptDecision" | "rejectDecision" | "deferDecision" | "getTaskFacts" | "getFacts"
  | "getTaskExecutions" | "getExecutions" | "getExecutionEvidencePage" | "getExecutionDetail"
  | "getReviewDetail" | "setTaskStatus" | "reviewTask" | "appendTaskProgress" | "rebuildGovernance";
type DaemonStatusGuiServiceMethod = "getStatus";
type DaemonLogGuiServiceMethod = "list";
type DaemonControlGuiServiceMethod = "requestControl";
type TerminalGuiServiceMethod = (typeof terminalGuiBridgeContracts)[number]["serviceMethod"];

interface GuiBridgeServiceProxy {
  readonly getStatus: () => Promise<unknown> | unknown;
  readonly list: (payload: unknown) => Promise<unknown> | unknown;
  readonly requestControl: (payload: unknown) => Promise<unknown> | unknown;
  readonly getCatalogSnapshot: () => Promise<unknown> | unknown;
  readonly getTasks: () => Promise<unknown> | unknown;
  readonly getTaskDetail: (payload: unknown) => Promise<unknown> | unknown;
  readonly getTaskDocument: (payload: unknown) => Promise<unknown> | unknown;
  readonly getPeripheralDocuments: () => Promise<unknown> | unknown;
  readonly getPeripheralDocument: (payload: unknown) => Promise<unknown> | unknown;
  readonly getRelationGraph: () => Promise<unknown> | unknown;
  readonly getTriadicProjection: () => Promise<unknown> | unknown;
  readonly getDecisions: () => Promise<unknown> | unknown;
  readonly getDecisionDetail: (payload: unknown) => Promise<unknown> | unknown;
  readonly proposeDecision: (payload: unknown) => Promise<unknown> | unknown;
  readonly acceptDecision: (payload: unknown) => Promise<unknown> | unknown;
  readonly rejectDecision: (payload: unknown) => Promise<unknown> | unknown;
  readonly deferDecision: (payload: unknown) => Promise<unknown> | unknown;
  readonly getTaskFacts: (payload: unknown) => Promise<unknown> | unknown;
  readonly getFacts: () => Promise<unknown> | unknown;
  readonly getTaskExecutions: (payload: unknown) => Promise<unknown> | unknown;
  readonly getExecutions: () => Promise<unknown> | unknown;
  readonly getExecutionEvidencePage: (payload: unknown) => Promise<unknown> | unknown;
  readonly getExecutionDetail: (payload: unknown) => Promise<unknown> | unknown;
  readonly getReviewDetail: (payload: unknown) => Promise<unknown> | unknown;
  readonly setTaskStatus: (payload: unknown) => Promise<unknown> | unknown;
  readonly reviewTask: (payload: unknown) => Promise<unknown> | unknown;
  readonly appendTaskProgress: (payload: unknown) => Promise<unknown> | unknown;
  readonly rebuildGovernance: () => Promise<unknown> | unknown;
  readonly terminalCreate: (payload: unknown) => Promise<unknown> | unknown;
  readonly terminalWrite: (payload: unknown) => Promise<unknown> | unknown;
  readonly terminalRead: (payload: unknown) => Promise<unknown> | unknown;
  readonly terminalResize: (payload: unknown) => Promise<unknown> | unknown;
  readonly terminalExit: (payload: unknown) => Promise<unknown> | unknown;
}

export interface GuiBridgeHandlerContext {
  readonly service: GuiBridgeServiceProxy;
  readonly payload: unknown;
}

export interface GuiBridgeHandlerImplementation {
  readonly serviceMethod:
    | LocalControllerGuiMethod
    | DaemonStatusGuiServiceMethod
    | DaemonLogGuiServiceMethod
    | DaemonControlGuiServiceMethod
    | TerminalGuiServiceMethod;
  readonly invoke: (context: GuiBridgeHandlerContext) => Promise<unknown> | unknown;
}

export const guiBridgeHandlerImplementations = {
  getDaemonLogs: {
    serviceMethod: "list",
    invoke: ({ service, payload }) => service.list(payload)
  },
  getDaemonStatus: {
    serviceMethod: "getStatus",
    invoke: ({ service }) => service.getStatus()
  },
  restartDaemon: {
    serviceMethod: "requestControl",
    invoke: ({ service, payload }) => service.requestControl(payload)
  },
  getCatalogSnapshot: {
    serviceMethod: "getCatalogSnapshot",
    invoke: ({ service }) => service.getCatalogSnapshot()
  },
  getTasks: {
    serviceMethod: "getTasks",
    invoke: ({ service }) => service.getTasks()
  },
  getTaskDetail: {
    serviceMethod: "getTaskDetail",
    invoke: ({ service, payload }) => service.getTaskDetail(payload)
  },
  getTaskDocument: {
    serviceMethod: "getTaskDocument",
    invoke: ({ service, payload }) => service.getTaskDocument(payload)
  },
  getPeripheralDocuments: {
    serviceMethod: "getPeripheralDocuments",
    invoke: ({ service }) => service.getPeripheralDocuments()
  },
  getPeripheralDocument: {
    serviceMethod: "getPeripheralDocument",
    invoke: ({ service, payload }) => service.getPeripheralDocument(payload)
  },
  getRelationGraph: {
    serviceMethod: "getRelationGraph",
    invoke: ({ service }) => service.getRelationGraph()
  },
  getTriadicProjection: {
    serviceMethod: "getTriadicProjection",
    invoke: ({ service }) => service.getTriadicProjection()
  },
  getDecisions: {
    serviceMethod: "getDecisions",
    invoke: ({ service }) => service.getDecisions()
  },
  getDecisionDetail: {
    serviceMethod: "getDecisionDetail",
    invoke: ({ service, payload }) => service.getDecisionDetail(payload)
  },
  proposeDecision: {
    serviceMethod: "proposeDecision",
    invoke: ({ service, payload }) => service.proposeDecision(payload)
  },
  acceptDecision: {
    serviceMethod: "acceptDecision",
    invoke: ({ service, payload }) => service.acceptDecision(payload)
  },
  rejectDecision: {
    serviceMethod: "rejectDecision",
    invoke: ({ service, payload }) => service.rejectDecision(payload)
  },
  deferDecision: {
    serviceMethod: "deferDecision",
    invoke: ({ service, payload }) => service.deferDecision(payload)
  },
  getTaskFacts: {
    serviceMethod: "getTaskFacts",
    invoke: ({ service, payload }) => service.getTaskFacts(payload)
  },
  getFacts: {
    serviceMethod: "getFacts",
    invoke: ({ service }) => service.getFacts()
  },
  getTaskExecutions: {
    serviceMethod: "getTaskExecutions",
    invoke: ({ service, payload }) => service.getTaskExecutions(payload)
  },
  getExecutions: {
    serviceMethod: "getExecutions",
    invoke: ({ service }) => service.getExecutions()
  },
  getExecutionEvidencePage: {
    serviceMethod: "getExecutionEvidencePage",
    invoke: ({ service, payload }) => service.getExecutionEvidencePage(payload)
  },
  getExecutionDetail: {
    serviceMethod: "getExecutionDetail",
    invoke: ({ service, payload }) => service.getExecutionDetail(payload)
  },
  getReviewDetail: {
    serviceMethod: "getReviewDetail",
    invoke: ({ service, payload }) => service.getReviewDetail(payload)
  },
  setTaskStatus: {
    serviceMethod: "setTaskStatus",
    invoke: ({ service, payload }) => service.setTaskStatus(payload)
  },
  reviewTask: {
    serviceMethod: "reviewTask",
    invoke: ({ service, payload }) => service.reviewTask(payload)
  },
  appendTaskProgress: {
    serviceMethod: "appendTaskProgress",
    invoke: ({ service, payload }) => service.appendTaskProgress(payload)
  },
  rebuildGovernance: {
    serviceMethod: "rebuildGovernance",
    invoke: ({ service }) => service.rebuildGovernance()
  }
} as const satisfies Record<ShippedGuiBridgeMethod, GuiBridgeHandlerImplementation>;

export type GuiDaemonRequester = (route: ApiRouteContract, payload: unknown) => Promise<JsonObject>;

export function getShippedGuiBridgeMethods(): ReadonlyArray<ShippedGuiBridgeMethod> {
  return apiRouteContracts.flatMap((route) => "guiBridgeMethod" in route && route.guiBridgeMethod ? [route.guiBridgeMethod] : []) as ReadonlyArray<ShippedGuiBridgeMethod>;
}

const shippedGuiBridgeMethods = new Set<PreloadApiMethod>(getShippedGuiBridgeMethods());
const terminalGuiBridgeMethods = new Set<PreloadApiMethod>(terminalGuiBridgeContracts.map((entry) => entry.guiBridgeMethod));
const routeByGuiMethod = new Map<PreloadApiMethod, ApiRouteContract>(
  apiRouteContracts.flatMap((route) => "guiBridgeMethod" in route && route.guiBridgeMethod ? [[route.guiBridgeMethod as PreloadApiMethod, route]] : [])
);
const routeById = new Map(apiRouteContracts.map((route) => [route.id, route]));
const terminalRouteByGuiMethod = new Map<PreloadApiMethod, ApiRouteContract>(terminalGuiBridgeContracts.map((entry) => {
  const route = routeById.get(entry.routeId);
  if (!route) throw new Error(`Terminal GUI bridge route is not registered: ${entry.routeId}`);
  return [entry.guiBridgeMethod, route];
}));
const deferredGuiBridgeReasons = new Map<PreloadApiMethod, string>(
  deferredGuiBridgeContracts.map((entry) => [entry.guiBridgeMethod, entry.reason])
);

export function createGuiServiceBridgeForDaemon(request: GuiDaemonRequester): GuiServiceBridge {
  const service = createDaemonServiceProxy(request);
  return {
    invoke: async (method, payload) => dispatchGuiServiceMethod(service, method, payload)
  };
}

export async function dispatchGuiServiceMethod(
  service: GuiBridgeServiceProxy,
  method: string,
  payload: unknown
): Promise<unknown> {
  if (shippedGuiBridgeMethods.has(method as PreloadApiMethod)) {
    const handler = guiBridgeHandlerImplementations[method as ShippedGuiBridgeMethod];
    return handler.invoke({ service, payload });
  }
  if (terminalGuiBridgeMethods.has(method as PreloadApiMethod)) {
    const handler = terminalBridgeHandlerImplementations[method as TerminalGuiBridgeMethod];
    return handler.invoke({ service, payload });
  }
  const deferredReason = deferredGuiBridgeReasons.get(method as PreloadApiMethod);
  if (deferredReason) {
    return {
      ok: false,
      error: {
        code: "method_deferred",
        hint: deferredReason
      }
    };
  }
  return {
    ok: false,
    error: {
      code: "method_not_allowed",
      hint: `Unsupported GUI service method: ${method}`
    }
  };
}

function createDaemonServiceProxy(request: GuiDaemonRequester): GuiBridgeServiceProxy {
  return {
    list: (payload) => invokeDaemonGuiRoute(request, "getDaemonLogs", payload),
    getStatus: async () => projectDaemonStatusResult(await invokeDaemonGuiRoute(request, "getDaemonStatus", undefined)),
    requestControl: (payload) => invokeDaemonGuiRoute(request, "restartDaemon", payload),
    getCatalogSnapshot: () => invokeDaemonGuiRoute(request, "getCatalogSnapshot", undefined),
    getTasks: () => invokeDaemonGuiRoute(request, "getTasks", undefined),
    getTaskDetail: (payload) => invokeDaemonGuiRoute(request, "getTaskDetail", payload),
    getTaskDocument: (payload) => invokeDaemonGuiRoute(request, "getTaskDocument", payload),
    getPeripheralDocuments: () => invokeDaemonGuiRoute(request, "getPeripheralDocuments", undefined),
    getPeripheralDocument: (payload) => invokeDaemonGuiRoute(request, "getPeripheralDocument", payload),
    getRelationGraph: () => invokeDaemonGuiRoute(request, "getRelationGraph", undefined),
    getTriadicProjection: () => invokeDaemonGuiRoute(request, "getTriadicProjection", undefined),
    getDecisions: () => invokeDaemonGuiRoute(request, "getDecisions", undefined),
    getDecisionDetail: (payload) => invokeDaemonGuiRoute(request, "getDecisionDetail", payload),
    proposeDecision: (payload) => invokeDaemonGuiRoute(request, "proposeDecision", payload),
    acceptDecision: (payload) => invokeDaemonGuiRoute(request, "acceptDecision", payload),
    rejectDecision: (payload) => invokeDaemonGuiRoute(request, "rejectDecision", payload),
    deferDecision: (payload) => invokeDaemonGuiRoute(request, "deferDecision", payload),
    getTaskFacts: (payload) => invokeDaemonGuiRoute(request, "getTaskFacts", payload),
    getFacts: () => invokeDaemonGuiRoute(request, "getFacts", undefined),
    getTaskExecutions: (payload) => invokeDaemonGuiRoute(request, "getTaskExecutions", payload),
    getExecutions: () => invokeDaemonGuiRoute(request, "getExecutions", undefined),
    getExecutionEvidencePage: (payload) => invokeDaemonGuiRoute(request, "getExecutionEvidencePage", payload),
    getExecutionDetail: (payload) => invokeDaemonGuiRoute(request, "getExecutionDetail", payload),
    getReviewDetail: (payload) => invokeDaemonGuiRoute(request, "getReviewDetail", payload),
    setTaskStatus: (payload) => invokeDaemonGuiRoute(request, "setTaskStatus", payload),
    reviewTask: (payload) => invokeDaemonGuiRoute(request, "reviewTask", payload),
    appendTaskProgress: (payload) => invokeDaemonGuiRoute(request, "appendTaskProgress", payload),
    rebuildGovernance: () => invokeDaemonGuiRoute(request, "rebuildGovernance", undefined),
    terminalCreate: (payload) => invokeDaemonGuiRoute(request, "terminalCreate", payload),
    terminalWrite: (payload) => invokeDaemonGuiRoute(request, "terminalWrite", payload),
    terminalRead: (payload) => invokeDaemonGuiRoute(request, "terminalRead", payload),
    terminalResize: (payload) => invokeDaemonGuiRoute(request, "terminalResize", payload),
    terminalExit: (payload) => invokeDaemonGuiRoute(request, "terminalExit", payload)
  };
}

export function projectDaemonStatusResult(raw: unknown): unknown {
  if (isServicePayloadRecord(raw) && raw.schema === "daemon-status/v2") {
    return projectDaemonStatusForRenderer(raw as unknown as DaemonStatusResultV2);
  }
  return raw;
}

async function invokeDaemonGuiRoute(
  request: GuiDaemonRequester,
  method: PreloadApiMethod,
  payload: unknown
): Promise<unknown> {
  const route = routeByGuiMethod.get(method) ?? terminalRouteByGuiMethod.get(method);
  if (!route) {
    return {
      ok: false,
      error: {
        code: "method_not_allowed",
        hint: `Unsupported GUI service method: ${method}`
      }
    };
  }
  // Validate the service-facing shape (repoId stripped so schemas stay stable).
  // Re-attach renderer repoId onto the *validated* payload so defaults filled by
  // validators (e.g. daemon restart reason/drainTimeout) still reach the daemon
  // while multi-repo routing keeps working via jsonRpcParamsForGuiRoute.
  const validation = validateGuiRoutePayload(route, payload);
  if (!validation.ok) return validation.failure;
  const receipt = await request(route, reattachRepoRoutingField(payload, validation.payload));
  return unwrapDaemonReceipt(receipt);
}


function reattachRepoRoutingField(original: unknown, validated: unknown): unknown {
  if (!isServicePayloadRecord(original) || typeof original.repoId !== "string" || original.repoId.length === 0) {
    return validated;
  }
  if (validated === undefined || validated === null) {
    return { repoId: original.repoId };
  }
  if (!isServicePayloadRecord(validated)) return validated;
  return { ...validated, repoId: original.repoId };
}

function unwrapDaemonReceipt(receipt: JsonObject): unknown {
  const details = isServicePayloadRecord(receipt.details) ? receipt.details : undefined;
  const data = isServicePayloadRecord(details?.data) ? details.data : undefined;
  if (data) return data;
  if (receipt.ok === false) {
    const error = isServicePayloadRecord(receipt.error) ? receipt.error : {};
    return {
      ok: false,
      error: {
        code: typeof error.code === "string" ? error.code : "daemon_error",
        hint: typeof error.hint === "string" ? error.hint : "Daemon request failed."
      }
    };
  }
  return { ok: true };
}

