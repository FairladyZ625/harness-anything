import { decodeDaemonLogListInput } from "../../../application/src/index.ts";
import type { ApiRouteContract } from "./api-contract-registry.ts";

type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;
type PayloadValidation = { readonly ok: true; readonly payload: unknown } | { readonly ok: false; readonly failure: JsonObject };
const domainStatuses = new Set(["planned", "active", "blocked", "in_review", "done", "cancelled"]);
const DEFAULT_DAEMON_RESTART_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_DAEMON_RESTART_REASON = "GUI Settings System restart request";

export function validateGuiRoutePayload(route: ApiRouteContract, payload: unknown): PayloadValidation {
  // Renderer multi-repo routing may attach `repoId` to any bridge payload.
  // It is consumed by main (jsonRpcParamsForGuiRoute) and must not fail schema checks.
  payload = stripRepoRoutingField(payload);
  switch (route.inputSchemaId) {
    case "daemon-log-list-input/v1":
      try {
        return { ok: true, payload: decodeDaemonLogListInput(payload) };
      } catch (error) {
        return invalidPayload(error instanceof Error ? error.message : "daemon log filters are invalid.");
      }
    case "daemon.control-request/v1":
      return validateDaemonControlRequestPayload(payload);
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
    case "application.agent-runtime-control-payload/v1":
      return validateAgentRuntimePayload(route, payload);
    case "application.agent-holder-projection-query/v1":
      if (payload === undefined || payload === null) return { ok: true, payload: {} };
      if (!isServicePayloadRecord(payload) || Object.keys(payload).some((key) => key !== "taskId")) {
        return invalidPayload("agent holder query accepts only taskId.");
      }
      return payload.taskId === undefined ? { ok: true, payload } : validateTaskIdPayload(payload);
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
    case "terminal.terminate-session-payload/v1":
      return validateTerminalTerminatePayload(payload);
    default:
      return { ok: true, payload };
  }
}

function validateAgentRuntimePayload(route: ApiRouteContract, payload: unknown): PayloadValidation {
  if (route.serviceMethod === "status" && (payload === undefined || payload === null)) return { ok: true, payload };
  if (!isServicePayloadRecord(payload)) return invalidPayload("agent runtime payload must be an object.");
  const allowed = new Set(route.serviceMethod === "spawn"
    ? ["kindId", "prompt", "cwd", "authenticationProfileKind", "resumeProviderSessionId", "taskId", "executionId"]
    : route.serviceMethod === "events" ? ["runtimeSessionId", "cursor"] : ["runtimeSessionId"]);
  if (Object.keys(payload).some((key) => !allowed.has(key))) return invalidPayload("agent runtime payload contains an undeclared field.");
  if (route.serviceMethod === "spawn") {
    if ((payload.kindId !== "claude-code" && payload.kindId !== "codex") || !nonBlankString(payload.prompt) ||
        !nonBlankString(payload.cwd) || !nonBlankString(payload.authenticationProfileKind)) {
      return invalidPayload("kindId, prompt, cwd, and authenticationProfileKind are required.");
    }
    return { ok: true, payload };
  }
  if (!nonBlankString(payload.runtimeSessionId)) return invalidPayload("runtimeSessionId is required.");
  if (payload.cursor !== undefined && (!Number.isInteger(payload.cursor) || Number(payload.cursor) < 0)) {
    return invalidPayload("cursor must be a non-negative integer.");
  }
  return { ok: true, payload };
}

function validateDaemonControlRequestPayload(payload: unknown): PayloadValidation {
  // Empty / null payload is allowed — bridge fills reason + drainTimeoutMs defaults.
  if (payload === undefined || payload === null) {
    return {
      ok: true,
      payload: {
        reason: DEFAULT_DAEMON_RESTART_REASON,
        drainTimeoutMs: DEFAULT_DAEMON_RESTART_DRAIN_TIMEOUT_MS
      }
    };
  }
  if (!isServicePayloadRecord(payload)) {
    return invalidPayload("daemon control request payload must be an object.");
  }
  const reason =
    typeof payload.reason === "string" && payload.reason.trim().length > 0
      ? payload.reason
      : DEFAULT_DAEMON_RESTART_REASON;
  const drainTimeoutMs =
    Number.isSafeInteger(payload.drainTimeoutMs)
      ? Number(payload.drainTimeoutMs)
      : DEFAULT_DAEMON_RESTART_DRAIN_TIMEOUT_MS;
  if (drainTimeoutMs < 100 || drainTimeoutMs > 120_000) {
    return invalidPayload("drainTimeoutMs must be an integer from 100 through 120000.");
  }
  return {
    ok: true,
    payload: {
      reason,
      drainTimeoutMs
    }
  };
}

function validateTerminalCreatePayload(payload: unknown): PayloadValidation {
  if (!isServicePayloadRecord(payload)) return invalidPayload("terminal create payload is required.");
  for (const field of ["name", "cwd", "shell", "projectId", "taskId"] as const) {
    if (payload[field] !== undefined && typeof payload[field] !== "string") {
      return invalidPayload(`${field} must be a string.`);
    }
  }
  if (payload.backend !== undefined && payload.backend !== "direct-pty" && payload.backend !== "tmux") {
    return invalidPayload("Local terminal creation supports tmux or direct-pty backends.");
  }
  return { ok: true, payload };
}

function validateTerminalSessionIdPayload(payload: unknown): PayloadValidation {
  if (!isServicePayloadRecord(payload) || !nonBlankString(payload.sessionId)) {
    return invalidPayload("sessionId is required.");
  }
  return { ok: true, payload };
}

function validateTerminalTerminatePayload(payload: unknown): PayloadValidation {
  const session = validateTerminalSessionIdPayload(payload);
  if (!session.ok) return session;
  if (!isServicePayloadRecord(payload) || payload.confirmation !== "terminate-terminal-session") {
    return invalidPayload("terminal termination requires confirmation=terminate-terminal-session.");
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



/** Drop renderer-only `repoId` so service payload schemas stay unchanged. */
export function stripRepoRoutingField(payload: unknown): unknown {
  if (!isServicePayloadRecord(payload) || !("repoId" in payload)) return payload;
  const { repoId: _repoId, ...rest } = payload;
  return Object.keys(rest).length > 0 ? rest : null;
}

export function isServicePayloadRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
