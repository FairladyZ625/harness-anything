import type { PreloadApiMethod } from "../preload/allowlist.ts";
import { apiRouteContracts, deferredGuiBridgeContracts, type ApiRouteContract } from "./api-contract-registry.ts";

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
type LocalControllerGuiMethod =
  | "getTasks"
  | "getTaskDetail"
  | "getTaskDocument"
  | "setTaskStatus"
  | "reviewTask"
  | "appendTaskProgress"
  | "rebuildGovernance";

interface GuiBridgeServiceProxy {
  readonly getTasks: () => Promise<unknown> | unknown;
  readonly getTaskDetail: (payload: unknown) => Promise<unknown> | unknown;
  readonly getTaskDocument: (payload: unknown) => Promise<unknown> | unknown;
  readonly setTaskStatus: (payload: unknown) => Promise<unknown> | unknown;
  readonly reviewTask: (payload: unknown) => Promise<unknown> | unknown;
  readonly appendTaskProgress: (payload: unknown) => Promise<unknown> | unknown;
  readonly rebuildGovernance: () => Promise<unknown> | unknown;
}

interface GuiBridgeHandlerContext {
  readonly service: GuiBridgeServiceProxy;
  readonly payload: unknown;
}

interface GuiBridgeHandlerImplementation {
  readonly serviceMethod: LocalControllerGuiMethod;
  readonly invoke: (context: GuiBridgeHandlerContext) => Promise<unknown> | unknown;
}

export const guiBridgeHandlerImplementations = {
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
const routeByGuiMethod = new Map<PreloadApiMethod, ApiRouteContract>(
  apiRouteContracts.flatMap((route) => "guiBridgeMethod" in route && route.guiBridgeMethod ? [[route.guiBridgeMethod as PreloadApiMethod, route]] : [])
);
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
    getTasks: () => invokeDaemonGuiRoute(request, "getTasks", undefined),
    getTaskDetail: (payload) => invokeDaemonGuiRoute(request, "getTaskDetail", payload),
    getTaskDocument: (payload) => invokeDaemonGuiRoute(request, "getTaskDocument", payload),
    setTaskStatus: (payload) => invokeDaemonGuiRoute(request, "setTaskStatus", payload),
    reviewTask: (payload) => invokeDaemonGuiRoute(request, "reviewTask", payload),
    appendTaskProgress: (payload) => invokeDaemonGuiRoute(request, "appendTaskProgress", payload),
    rebuildGovernance: () => invokeDaemonGuiRoute(request, "rebuildGovernance", undefined)
  };
}

async function invokeDaemonGuiRoute(
  request: GuiDaemonRequester,
  method: PreloadApiMethod,
  payload: unknown
): Promise<unknown> {
  const route = routeByGuiMethod.get(method);
  if (!route) {
    return {
      ok: false,
      error: {
        code: "method_not_allowed",
        hint: `Unsupported GUI service method: ${method}`
      }
    };
  }
  const validation = validateGuiRoutePayload(route, payload);
  if (!validation.ok) return validation.failure;
  const receipt = await request(route, validation.payload);
  return unwrapDaemonReceipt(receipt);
}

type PayloadValidation = { readonly ok: true; readonly payload: unknown } | { readonly ok: false; readonly failure: JsonObject };
const domainStatuses = new Set(["planned", "active", "blocked", "in_review", "done", "cancelled"]);

export function validateGuiRoutePayload(route: ApiRouteContract, payload: unknown): PayloadValidation {
  switch (route.inputSchemaId) {
    case "gui.empty/v1":
      return payload === undefined || payload === null || isServicePayloadRecord(payload)
        ? { ok: true, payload }
        : invalidPayload("empty payload is required.");
    case "application.task-id-payload/v1":
      return validateTaskIdPayload(payload);
    case "application.task-document-payload/v1":
      return validateTaskDocumentPayload(payload);
    case "application.set-task-status-payload/v1":
      return validateSetStatusPayload(payload);
    case "application.append-task-progress-payload/v1":
      return validateAppendProgressPayload(payload);
    default:
      return { ok: true, payload };
  }
}

function validateTaskIdPayload(payload: unknown): PayloadValidation {
  if (!isServicePayloadRecord(payload) || typeof payload.taskId !== "string") return invalidPayload("taskId is required.");
  if (!isValidTaskId(payload.taskId)) return invalidPayload("taskId is invalid.");
  return { ok: true, payload };
}

function validateTaskDocumentPayload(payload: unknown): PayloadValidation {
  const taskPayload = validateTaskIdPayload(payload);
  if (!taskPayload.ok) return taskPayload;
  if (!isServicePayloadRecord(payload) || typeof payload.path !== "string") return invalidPayload("path is required.");
  return { ok: true, payload };
}

function validateSetStatusPayload(payload: unknown): PayloadValidation {
  const taskPayload = validateTaskIdPayload(payload);
  if (!taskPayload.ok) return taskPayload;
  if (!isServicePayloadRecord(payload) || typeof payload.status !== "string" || !domainStatuses.has(payload.status)) {
    return invalidPayload("valid status is required.");
  }
  return { ok: true, payload };
}

function validateAppendProgressPayload(payload: unknown): PayloadValidation {
  const taskPayload = validateTaskIdPayload(payload);
  if (!taskPayload.ok) return taskPayload;
  if (!isServicePayloadRecord(payload) || typeof payload.text !== "string" || payload.text.length === 0) return invalidPayload("text is required.");
  return { ok: true, payload };
}

function invalidPayload(hint: string): PayloadValidation {
  return {
    ok: false,
    failure: {
      ok: false,
      error: {
        code: "invalid_payload",
        hint
      }
    }
  };
}

function isValidTaskId(taskId: string): boolean {
  return taskId.length > 0 && !taskId.includes("/") && !taskId.includes("..");
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

function isServicePayloadRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
