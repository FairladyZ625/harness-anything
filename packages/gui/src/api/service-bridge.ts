import {
  decodeDaemonLogListInput,
  projectDaemonStatusForRenderer,
  type DaemonStatusResultV2
} from "../../../application/src/index.ts";
import type { PreloadApiMethod } from "../preload/allowlist.ts";
import { apiRouteContracts, deferredGuiBridgeContracts, terminalGuiBridgeContracts, type ApiRouteContract } from "./api-contract-registry.ts";
import { terminalBridgeHandlerImplementations } from "./terminal-bridge-handlers.ts";

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
type TerminalGuiServiceMethod = (typeof terminalGuiBridgeContracts)[number]["serviceMethod"];

interface GuiBridgeServiceProxy {
  readonly getStatus: () => Promise<unknown> | unknown;
  readonly list: (payload: unknown) => Promise<unknown> | unknown;
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
  readonly serviceMethod: LocalControllerGuiMethod | DaemonStatusGuiServiceMethod | DaemonLogGuiServiceMethod | TerminalGuiServiceMethod;
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
  const validation = validateGuiRoutePayload(route, payload);
  if (!validation.ok) return validation.failure;
  const receipt = await request(route, validation.payload);
  return unwrapDaemonReceipt(receipt);
}

type PayloadValidation = { readonly ok: true; readonly payload: unknown } | { readonly ok: false; readonly failure: JsonObject };
const domainStatuses = new Set(["planned", "active", "blocked", "in_review", "done", "cancelled"]);

export function validateGuiRoutePayload(route: ApiRouteContract, payload: unknown): PayloadValidation {
  switch (route.inputSchemaId) {
    case "daemon-log-list-input/v1":
      try {
        return { ok: true, payload: decodeDaemonLogListInput(payload) };
      } catch (error) {
        return invalidPayload(error instanceof Error ? error.message : "daemon log filters are invalid.");
      }
    case "gui.empty/v1":
      return payload === undefined || payload === null || isServicePayloadRecord(payload)
        ? { ok: true, payload }
        : invalidPayload("empty payload is required.");
    case "application.task-id-payload/v1":
      return validateTaskIdPayload(payload);
    case "application.decision-id-payload/v1":
      return validateDecisionIdPayload(payload);
    case "application.decision-propose-payload/v1":
      return validateDecisionProposePayload(payload);
    case "application.decision-transition-payload/v1":
      return validateDecisionTransitionPayload(payload);
    case "application.execution-id-payload/v1":
      return validateEntityIdPayload(payload, "executionId");
    case "application.execution-evidence-page-payload/v1":
      return validateExecutionEvidencePagePayload(payload);
    case "application.review-id-payload/v1":
      return validateEntityIdPayload(payload, "reviewId");
    case "application.task-document-payload/v1":
      return validateTaskDocumentPayload(payload);
    case "application.peripheral-document-payload/v1":
      return validateDocumentPathPayload(payload);
    case "application.set-task-status-payload/v1":
      return validateSetStatusPayload(payload);
    case "application.append-task-progress-payload/v1":
      return validateAppendProgressPayload(payload);
    case "terminal.create-session-payload/v1":
      return validateTerminalCreatePayload(payload);
    case "terminal.write-session-payload/v1":
      return validateTerminalWritePayload(payload);
    case "terminal.output-read-payload/v1":
      return validateTerminalReadPayload(payload);
    case "terminal.resize-session-payload/v1":
      return validateTerminalResizePayload(payload);
    case "terminal.session-id-payload/v1":
      return validateTerminalSessionIdPayload(payload);
    default:
      return { ok: true, payload };
  }
}

function validateTerminalCreatePayload(payload: unknown): PayloadValidation {
  if (!isServicePayloadRecord(payload)) return invalidPayload("terminal create payload is required.");
  for (const field of ["name", "cwd", "shell", "projectId", "taskId"] as const) {
    if (payload[field] !== undefined && typeof payload[field] !== "string") {
      return invalidPayload(`${field} must be a string.`);
    }
  }
  if (payload.backend !== undefined && payload.backend !== "direct-pty") {
    return invalidPayload("P0 terminal creation supports the direct-pty backend only.");
  }
  return { ok: true, payload };
}

function validateTerminalSessionIdPayload(payload: unknown): PayloadValidation {
  if (!isServicePayloadRecord(payload) || !nonBlankString(payload.sessionId)) {
    return invalidPayload("sessionId is required.");
  }
  return { ok: true, payload };
}

function validateTerminalWritePayload(payload: unknown): PayloadValidation {
  const session = validateTerminalSessionIdPayload(payload);
  if (!session.ok) return session;
  if (!isServicePayloadRecord(payload) || typeof payload.data !== "string" || new TextEncoder().encode(payload.data).byteLength > 65_536) {
    return invalidPayload("terminal data must be a string no larger than 64 KiB.");
  }
  return { ok: true, payload };
}

function validateTerminalReadPayload(payload: unknown): PayloadValidation {
  const session = validateTerminalSessionIdPayload(payload);
  if (!session.ok) return session;
  if (!isServicePayloadRecord(payload)) return invalidPayload("terminal read payload is required.");
  if (payload.cursor !== undefined && (!Number.isInteger(payload.cursor) || Number(payload.cursor) < 0)) {
    return invalidPayload("cursor must be a non-negative integer.");
  }
  if (payload.timeoutMs !== undefined && (!Number.isInteger(payload.timeoutMs) || Number(payload.timeoutMs) < 0 || Number(payload.timeoutMs) > 1_000)) {
    return invalidPayload("timeoutMs must be an integer between 0 and 1000.");
  }
  return { ok: true, payload };
}

function validateTerminalResizePayload(payload: unknown): PayloadValidation {
  const session = validateTerminalSessionIdPayload(payload);
  if (!session.ok) return session;
  if (
    !isServicePayloadRecord(payload) || !Number.isInteger(payload.columns) || Number(payload.columns) <= 0 ||
    !Number.isInteger(payload.rows) || Number(payload.rows) <= 0
  ) return invalidPayload("terminal rows and columns must be positive integers.");
  return { ok: true, payload };
}

function validateTaskIdPayload(payload: unknown): PayloadValidation {
  if (!isServicePayloadRecord(payload) || typeof payload.taskId !== "string") return invalidPayload("taskId is required.");
  if (!isValidTaskId(payload.taskId)) return invalidPayload("taskId is invalid.");
  return { ok: true, payload };
}

function validateDecisionIdPayload(payload: unknown): PayloadValidation {
  if (!isServicePayloadRecord(payload) || typeof payload.decisionId !== "string") return invalidPayload("decisionId is required.");
  if (!isValidEntityId(payload.decisionId)) return invalidPayload("decisionId is invalid.");
  return { ok: true, payload };
}

function validateDecisionTransitionPayload(payload: unknown): PayloadValidation {
  const decision = validateDecisionIdPayload(payload);
  if (!decision.ok) return decision;
  if (!isServicePayloadRecord(payload)) return invalidPayload("decision transition payload is required.");
  if (!optionalDecisionString(payload.decidedAt) || !optionalDecisionString(payload.judgmentOnlyRationale) || !optionalDecisionString(payload.body)) {
    return invalidPayload("optional decision transition fields must be strings.");
  }
  if (payload.standingPolicy !== undefined && typeof payload.standingPolicy !== "boolean") {
    return invalidPayload("standingPolicy must be boolean.");
  }
  return { ok: true, payload };
}

function validateDecisionProposePayload(payload: unknown): PayloadValidation {
  if (!isServicePayloadRecord(payload)) return invalidPayload("decision propose payload is required.");
  if (
    !nonBlankString(payload.title) || !nonBlankString(payload.question) ||
    !Array.isArray(payload.chosen) || payload.chosen.length === 0 ||
    !Array.isArray(payload.rejected) || payload.rejected.length === 0 ||
    !isTier(payload.riskTier) || !isTier(payload.urgency)
  ) return invalidPayload("title, question, chosen, rejected, riskTier, and urgency are required.");
  if (!payload.chosen.every(validChoice) || !payload.rejected.every(validRejected)) {
    return invalidPayload("chosen and rejected entries require text; rejected entries also require why_not.");
  }
  if (payload.decisionId !== undefined && (typeof payload.decisionId !== "string" || !isValidEntityId(payload.decisionId))) {
    return invalidPayload("decisionId is invalid.");
  }
  if (!optionalDecisionString(payload.body) || !optionalStringList(payload.modules) || !optionalStringList(payload.productLines)) {
    return invalidPayload("optional decision body, modules, and productLines are invalid.");
  }
  if (payload.claims !== undefined && (!Array.isArray(payload.claims) || !payload.claims.every(validClaim))) {
    return invalidPayload("claims must contain valid decision claim entries.");
  }
  if (payload.evidenceRelations !== undefined && (
    !Array.isArray(payload.evidenceRelations) || !payload.evidenceRelations.every(validEvidenceRelation)
  )) return invalidPayload("evidenceRelations must contain anchor, type, target, and rationale strings.");
  return { ok: true, payload };
}

function validChoice(value: unknown): boolean {
  return isServicePayloadRecord(value) && nonBlankString(value.text) &&
    (value.id === undefined || nonBlankString(value.id)) &&
    (value.load_bearing === undefined || typeof value.load_bearing === "boolean");
}

function validRejected(value: unknown): boolean {
  return validChoice(value) && isServicePayloadRecord(value) && nonBlankString(value.why_not);
}

function validClaim(value: unknown): boolean {
  return validChoice(value) && isServicePayloadRecord(value) && (
    value.fulfillment === undefined ||
    value.fulfillment === "evidenced" ||
    value.fulfillment === "delivered" ||
    value.fulfillment === "standing-policy"
  );
}

function validEvidenceRelation(value: unknown): boolean {
  return isServicePayloadRecord(value) && nonBlankString(value.anchor) && nonBlankString(value.type) &&
    nonBlankString(value.target) && nonBlankString(value.rationale);
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalDecisionString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalStringList(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(nonBlankString));
}

function isTier(value: unknown): boolean {
  return value === "low" || value === "medium" || value === "high";
}

function validateEntityIdPayload(payload: unknown, field: "executionId" | "reviewId"): PayloadValidation {
  if (!isServicePayloadRecord(payload) || typeof payload[field] !== "string") return invalidPayload(`${field} is required.`);
  if (!isValidEntityId(payload[field])) return invalidPayload(`${field} is invalid.`);
  return { ok: true, payload };
}

function validateExecutionEvidencePagePayload(payload: unknown): PayloadValidation {
  if (!isServicePayloadRecord(payload) || !Number.isInteger(payload.limit) || Number(payload.limit) < 1 || Number(payload.limit) > 100) {
    return invalidPayload("limit must be an integer between 1 and 100.");
  }
  if (payload.cursor === undefined) return { ok: true, payload };
  if (!isServicePayloadRecord(payload.cursor) ||
      typeof payload.cursor.generation !== "string" || payload.cursor.generation.length === 0 ||
      typeof payload.cursor.latestAt !== "string" || !Number.isFinite(Date.parse(payload.cursor.latestAt)) ||
      typeof payload.cursor.executionId !== "string" || !isValidEntityId(payload.cursor.executionId)) {
    return invalidPayload("cursor must contain a valid generation, latestAt, and executionId.");
  }
  return { ok: true, payload };
}

function validateTaskDocumentPayload(payload: unknown): PayloadValidation {
  const taskPayload = validateTaskIdPayload(payload);
  if (!taskPayload.ok) return taskPayload;
  if (!isServicePayloadRecord(payload) || typeof payload.path !== "string") return invalidPayload("path is required.");
  return { ok: true, payload };
}

function validateDocumentPathPayload(payload: unknown): PayloadValidation {
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
  return isValidEntityId(taskId);
}

function isValidEntityId(value: string): boolean {
  return value.length > 0 && !value.includes("/") && !value.includes("..");
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
