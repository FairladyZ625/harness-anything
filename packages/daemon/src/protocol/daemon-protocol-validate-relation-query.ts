import type { DispatchLifecycleSummary } from "@harness-anything/kernel";
import {
  queryPayloadValidation,
  type QueryPayloadValidationIssue,
} from "@harness-anything/kernel/internal/domain/query-payload-validation.ts";
import {
  dispatchAttemptPhaseWords,
  dispatchGroupPhaseWords,
  dispatchReservationStateWords,
  dispatchCapacityDispositionWords,
  dispatchDisplayStatusWords,
} from "./daemon-protocol-vocabulary.ts";
import {
  statusWord,
  stringArray,
  exactRecord,
  integer,
  nonEmpty,
  validationEntityId,
  validationError,
  warningArray,
  recordShapeError,
} from "./daemon-protocol-validate-entities.ts";
import { relationStateWords, decisionStateWords, taskStatusWords } from "./daemon-protocol-vocabulary.ts";
import { isJsonObject, isUtcTimestamp, unknownFieldViolation, type JsonObject } from "./json-rpc-types.ts";
import { DAEMON_WORKSPACE_SUMMARY_SCHEMA } from "./daemon-protocol-schema-ids.ts";
import type {
  ProviderUnreachableEvidence,
  TaskDispatchAttempt,
  TaskDispatchResume,
  TaskDispatchRow,
} from "./task-dispatch-contract.ts";
export function validateRelationNeighborhoodPayload(value: JsonObject): string[] {
  const allowed = ["entity", "hops", "status"],
    unknown = unknownFieldViolation(value, allowed);
  if (unknown) return [`repo.triadic.relationGraph.payload contains an ${unknown}`];
  if (typeof value.entity !== "string" || value.entity.length === 0 || !isJsonObject(value.hops))
    return ["repo.triadic.relationGraph.payload requires entity and hops"];
  const hops = value.hops,
    hopsUnknown = unknownFieldViolation(hops, ["direction", "relationTypes", "maxDepth", "maxNodes"]);
  if (hopsUnknown) return [`repo.triadic.relationGraph.payload.hops contains an ${hopsUnknown}`];
  if (!["outgoing", "incoming", "both"].includes(String(hops.direction)))
    return ["repo.triadic.relationGraph.payload.hops.direction is invalid"];
  if (!stringArray(hops.relationTypes) || hops.relationTypes.length === 0)
    return ["repo.triadic.relationGraph.payload.hops.relationTypes is invalid"];
  if (!Number.isInteger(hops.maxDepth) || Number(hops.maxDepth) < 1 || Number(hops.maxDepth) > 4_096)
    return ["repo.triadic.relationGraph.payload.hops.maxDepth is invalid"];
  if (!Number.isInteger(hops.maxNodes) || Number(hops.maxNodes) < 1 || Number(hops.maxNodes) > 10_000)
    return ["repo.triadic.relationGraph.payload.hops.maxNodes is invalid"];
  const statusError =
    value.status !== undefined && !statusWord(relationStateWords, value.status)
      ? "repo.triadic.relationGraph.payload.status is invalid"
      : null;
  return statusError ? [statusError] : [];
}

/** One indexed page of relations incident to `entity` (plus its sub-refs). No `hops`: the
 * depth budget belongs to the neighborhood selector and must not be implied by a page read. */
function validateRelationEntityPagePayload(value: JsonObject): string[] {
  const unknown = unknownFieldViolation(value, ["entity", "status", "limit", "cursor"]);
  if (unknown) return [`repo.triadic.relationGraph.payload contains an ${unknown}`];
  if (typeof value.entity !== "string" || value.entity.length === 0)
    return ["repo.triadic.relationGraph.payload.entity is invalid"];
  return validateDaemonQueryPayload("repo.triadic.relationGraph", {
    ...(value.status === undefined ? {} : { status: value.status }),
    ...(value.limit === undefined ? {} : { limit: value.limit }),
    ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
  });
}

// Workspace-summary read result validator lives with the other per-facet repo read validators
// so the offline-maintenance and thin-transport import closures keep their exact membership.
export function validateDaemonWorkspaceSummary(value: unknown): readonly string[] {
  const entityId = "workspace",
    shapeError = recordShapeError(entityId, value, DAEMON_WORKSPACE_SUMMARY_SCHEMA.required);
  if (shapeError) return [shapeError];
  if (!isJsonObject(value)) return [];
  for (const [field, actual, valid, expectation] of [
    ["schema", value.schema, value.schema === DAEMON_WORKSPACE_SUMMARY_SCHEMA.id, "must match the workspace schema"],
    ["ok", value.ok, value.ok === true, "must be true"],
    ["status", value.status, value.status === "ready" || value.status === "pending", "must be ready or pending"],
    ["watermark", value.watermark, integer(value.watermark), "must be an integer"],
    ["sourceRevision", value.sourceRevision, integer(value.sourceRevision), "must be an integer"],
    ["warnings", value.warnings, warningArray(value.warnings), "must contain valid warnings"],
  ] as const)
    if (!valid) return [validationError(entityId, field, actual, expectation)];
  const taskStatuses = [...taskStatusWords, "unknown"],
    tasks = value.tasks,
    decisions = value.decisions;
  const tasksShapeError = recordShapeError(entityId, tasks, ["total", "byStatus", "lastChangedAt"], undefined, "tasks");
  if (tasksShapeError) return [tasksShapeError];
  if (!isJsonObject(tasks)) return [];
  if (!integer(tasks.total) || Number(tasks.total) < 0)
    return [validationError(entityId, "tasks.total", tasks.total, "must be a non-negative integer")];
  if (tasks.lastChangedAt !== null && !isUtcTimestamp(tasks.lastChangedAt))
    return [validationError(entityId, "tasks.lastChangedAt", tasks.lastChangedAt, "must be a UTC timestamp or null")];
  const byStatus = tasks.byStatus;
  const statusShapeError = recordShapeError(entityId, byStatus, taskStatuses, undefined, "tasks.byStatus");
  if (statusShapeError) return [statusShapeError];
  if (!isJsonObject(byStatus)) return [];
  const invalidTaskStatus = taskStatuses.find((status) => !integer(byStatus[status]) || Number(byStatus[status]) < 0);
  if (invalidTaskStatus)
    return [
      validationError(
        entityId,
        `tasks.byStatus.${invalidTaskStatus}`,
        byStatus[invalidTaskStatus],
        "must be a non-negative integer",
      ),
    ];
  if (taskStatuses.reduce((sum, status) => sum + Number(byStatus[status]), 0) !== tasks.total)
    return [validationError(entityId, "tasks.total", tasks.total, "must equal the by-status sum")];
  const decisionsShapeError = recordShapeError(
    entityId,
    decisions,
    ["total", "inboxCount", "byState", "groups"],
    undefined,
    "decisions",
  );
  if (decisionsShapeError) return [decisionsShapeError];
  if (!isJsonObject(decisions)) return [];
  if (!integer(decisions.total) || Number(decisions.total) < 0)
    return [validationError(entityId, "decisions.total", decisions.total, "must be a non-negative integer")];
  if (!integer(decisions.inboxCount) || Number(decisions.inboxCount) < 0)
    return [validationError(entityId, "decisions.inboxCount", decisions.inboxCount, "must be a non-negative integer")];
  if (!Array.isArray(decisions.groups))
    return [validationError(entityId, "decisions.groups", decisions.groups, "must be an array")];
  const byDecisionState = decisions.byState;
  const stateShapeError = recordShapeError(
    entityId,
    byDecisionState,
    decisionStateWords,
    undefined,
    "decisions.byState",
  );
  if (stateShapeError) return [stateShapeError];
  if (!isJsonObject(byDecisionState)) return [];
  const invalidDecisionState = decisionStateWords.find(
    (state) => !integer(byDecisionState[state]) || Number(byDecisionState[state]) < 0,
  );
  if (invalidDecisionState)
    return [
      validationError(
        entityId,
        `decisions.byState.${invalidDecisionState}`,
        byDecisionState[invalidDecisionState],
        "must be a non-negative integer",
      ),
    ];
  if (decisionStateWords.reduce((sum, state) => sum + Number(byDecisionState[state]), 0) !== decisions.total)
    return [validationError(entityId, "decisions.total", decisions.total, "must equal the by-state sum")];
  const groupIds = ["proposed", "in_effect", "rejected", "deferred", "retired"],
    decisionIds: string[] = [],
    states: string[] = [];
  if (decisions.groups.length !== groupIds.length)
    return [
      validationError(entityId, "decisions.groups.length", decisions.groups.length, `must be ${groupIds.length}`),
    ];
  for (const [index, group] of decisions.groups.entries()) {
    if (
      !exactRecord(group, ["id", "states", "count", "decisionIds"]) ||
      group.id !== groupIds[index] ||
      !Array.isArray(group.states) ||
      group.states.some((state) => !statusWord(decisionStateWords, state)) ||
      new Set(group.states).size !== group.states.length ||
      !integer(group.count) ||
      Number(group.count) < 0 ||
      !stringArray(group.decisionIds) ||
      new Set(group.decisionIds).size !== group.decisionIds.length ||
      group.count !== group.decisionIds.length
    )
      return [
        validationError(
          validationEntityId(group, ["id"], `decision-group:${index}`),
          `decisions.groups[${index}]`,
          group,
          "must be a valid decision group",
        ),
      ];
    states.push(...group.states.map(String));
    decisionIds.push(...group.decisionIds.map(String));
  }
  if (
    states.length !== decisionStateWords.length ||
    !decisionStateWords.every((state) => states.includes(state)) ||
    new Set(decisionIds).size !== decisionIds.length ||
    decisions.total !== decisionIds.length ||
    decisions.inboxCount !== decisions.groups[0].count
  )
    return [
      validationError(entityId, "decisions.total", decisions.total, "must match unique grouped decisions and inbox"),
    ];
  return [];
}

const dispatchAttemptRequired = [
    "dispatchId",
    "runtimeSessionId",
    "attemptIndex",
    "provider",
    "classification",
    "reason",
    "fallbackState",
    "nextDispatchId",
  ] as const,
  dispatchAttemptOptional = ["resume", "faultClass", "resetAt", "nextAction", "lifecycle"] as const;

export function validTaskDispatchAttempt(value: unknown): value is TaskDispatchAttempt {
  return (
    isJsonObject(value) &&
    dispatchFields(value, dispatchAttemptRequired, dispatchAttemptOptional) &&
    validTaskDispatchAttemptValues(value)
  );
}

export function validTaskDispatchRow(value: unknown): value is TaskDispatchRow {
  return (
    isJsonObject(value) &&
    [
      value.dispatchId,
      value.taskId,
      value.executionId,
      value.runtimeSessionId,
      value.instanceId,
      value.attemptGroupId,
    ].every(dispatchText) &&
    validTaskDispatchAttemptValues(value) &&
    (value.taskTitle === undefined || dispatchText(value.taskTitle)) &&
    (value.squadRunId === undefined || dispatchText(value.squadRunId)) &&
    (value.squadChildTaskIds === undefined ||
      (Array.isArray(value.squadChildTaskIds) && value.squadChildTaskIds.every(dispatchText))) &&
    (value.role === undefined || dispatchText(value.role)) &&
    (value.lastObservedAt === undefined ||
      (dispatchText(value.lastObservedAt) && isUtcTimestamp(value.lastObservedAt))) &&
    (value.activityStatus === undefined ||
      ["thinking", "tool", "waiting", "silent", "stalled", "unknown"].includes(String(value.activityStatus))) &&
    (value.activityObservedAt === undefined ||
      (dispatchText(value.activityObservedAt) && isUtcTimestamp(value.activityObservedAt))) &&
    (value.activityIdleMinutes === undefined ||
      (Number.isSafeInteger(value.activityIdleMinutes) && Number(value.activityIdleMinutes) >= 0)) &&
    (value.providerUnreachable === undefined || validProviderUnreachable(value.providerUnreachable)) &&
    ["agentId", "agentName", "delegatedByAgentId", "delegatedByAgentName", "squadId", "parentRuntimeSessionId"].every(
      (field) => value[field] === undefined || dispatchText(value[field]),
    ) &&
    (value.ruling === undefined || validDispatchRuling(value.ruling)) &&
    dispatchNullableText(value.providerSessionId) &&
    dispatchNullableText(value.eventStreamRef) &&
    dispatchText(value.startedAt) &&
    dispatchNullableText(value.endedAt) &&
    [null, "succeeded", "failed", "unknown", "cancelled", "stopped"].includes(value.outcome as never) &&
    ["running", "succeeded", "failed", "unknown", "cancelled", "stopped", "blocked", "lost"].includes(
      String(value.status),
    ) &&
    [value.resultRef, value.dispatchPath, value.reportPath].every(
      (field) => field === undefined || dispatchNullableText(field),
    ) &&
    (value.advisories === undefined ||
      (Array.isArray(value.advisories) && value.advisories.every(validTaskDispatchAdvisory))) &&
    (value.decisionAction === undefined || validTaskDispatchDecisionAction(value.decisionAction)) &&
    (value.exitCode === undefined || value.exitCode === null || dispatchInteger(value.exitCode))
  );
}

function validTaskDispatchAdvisory(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    dispatchText(value.evaluatedAt) &&
    dispatchText(value.pointId) &&
    dispatchText(value.questionVersion) &&
    dispatchText(value.selected) &&
    isJsonObject(value.distribution) &&
    Object.values(value.distribution).every(
      (probability) =>
        typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1,
    ) &&
    Array.isArray(value.options) &&
    value.options.every((option) => isJsonObject(option) && dispatchText(option.id) && dispatchText(option.text)) &&
    isJsonObject(value.provider) &&
    dispatchText(value.provider.providerId) &&
    value.provider.vendor === "openrouter" &&
    dispatchText(value.provider.requestedModel) &&
    dispatchText(value.provider.resolvedModel) &&
    value.provider.modelVersion === null &&
    dispatchNullableText(value.provider.providerRoute) &&
    isJsonObject(value.usage) &&
    dispatchInteger(value.usage.inputTokens) &&
    dispatchInteger(value.usage.outputTokens) &&
    (value.usage.reportedCost === null ||
      (typeof value.usage.reportedCost === "number" && Number.isFinite(value.usage.reportedCost))) &&
    dispatchInteger(value.latencyMs)
  );
}

function validTaskDispatchAttemptValues(value: Record<string, unknown>): boolean {
  return (
    dispatchText(value.dispatchId) &&
    dispatchText(value.runtimeSessionId) &&
    dispatchInteger(value.attemptIndex) &&
    isJsonObject(value.provider) &&
    dispatchText(value.provider.instance) &&
    (value.provider.model === null || dispatchText(value.provider.model)) &&
    (value.classification === null ||
      [
        "provider_fault",
        "provider_quota",
        "worker_stop",
        "dispatch_stalled",
        "awaiting_ruling",
        "needs_attention",
        "gate_red",
        "completed_without_final_text",
      ].includes(String(value.classification))) &&
    (value.reason === null || dispatchText(value.reason)) &&
    (value.resume === undefined || validTaskDispatchResume(value.resume)) &&
    (value.faultClass === undefined || ["quota_exhausted", "rate_limited"].includes(String(value.faultClass))) &&
    (value.resetAt === undefined || (typeof value.resetAt === "string" && !Number.isNaN(Date.parse(value.resetAt)))) &&
    (value.nextAction === undefined || dispatchText(value.nextAction)) &&
    // Previous-version decode only, removed 2026-12-07. Never drives business state.
    [null, "scheduled", "dispatched", "exhausted"].includes(value.fallbackState as never) &&
    (value.lifecycle === undefined || validDispatchLifecycleSummary(value.lifecycle)) &&
    (value.nextDispatchId === null || dispatchText(value.nextDispatchId))
  );
}

function validTaskDispatchResume(value: unknown): value is TaskDispatchResume {
  return (
    isJsonObject(value) &&
    dispatchFields(value, ["dispatchId", "agentId"], []) &&
    dispatchText(value.dispatchId) &&
    (value.agentId === null || dispatchText(value.agentId))
  );
}
/** The read-side projection of a worker's ruling artifact: question text, options, and the path. */
function validDispatchRuling(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    dispatchText(value.question) &&
    dispatchText(value.path) &&
    Array.isArray(value.options) &&
    value.options.every((option) => typeof option === "string")
  );
}

/** The live provider-unreachable judgment: a named class plus the two timestamps and raw error. */
function validProviderUnreachable(value: unknown): value is ProviderUnreachableEvidence {
  return (
    isJsonObject(value) &&
    dispatchFields(value, ["state", "lastProgressAt", "lastErrorAt", "lastError"], []) &&
    value.state === "provider_unreachable" &&
    dispatchText(value.lastProgressAt) &&
    isUtcTimestamp(value.lastProgressAt) &&
    dispatchText(value.lastErrorAt) &&
    isUtcTimestamp(value.lastErrorAt) &&
    dispatchText(value.lastError)
  );
}

function dispatchFields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]) {
  return (
    required.every((field) => Object.hasOwn(value, field)) &&
    Object.keys(value).every((field) => required.includes(field) || optional.includes(field))
  );
}
function dispatchNullableText(value: unknown): boolean {
  return value === null || dispatchText(value);
}
function dispatchText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function dispatchInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}
const queryPayloadIssueMessages: Record<
  QueryPayloadValidationIssue,
  (method: "repo.tasks.list" | "repo.triadic.relationGraph" | "repo.artifacts.list") => string
> = {
  payload_not_object: () => "query payload must be an object",
  status_invalid: (method) => `${method}.payload.status is invalid`,
  changed_after_revision_invalid: (method) => `${method}.payload.changedAfterRevision is invalid`,
  time_window_invalid: (method) => `${method}.payload time window is invalid`,
  limit_invalid: (method) => `${method}.payload.limit is invalid`,
  cursor_invalid: (method) => `${method}.payload.cursor is invalid`,
};

// Absent facets keep the unparameterized full-result contract.
export function validateDaemonQueryPayload(
  method: "repo.tasks.list" | "repo.triadic.relationGraph" | "repo.artifacts.list",
  value: unknown,
): string[] {
  if (value === undefined) return [];
  if (!isJsonObject(value)) return ["query payload must be an object"];
  if (method === "repo.triadic.relationGraph" && value.hops !== undefined)
    return validateRelationNeighborhoodPayload(value);
  if (method === "repo.triadic.relationGraph" && value.entity !== undefined)
    return validateRelationEntityPagePayload(value);
  if (
    method === "repo.triadic.relationGraph" &&
    [value.facet, value.relationType, value.state, value.direction].some((field) => field !== undefined)
  )
    return validateRelationFacetPayload(value);
  if (method === "repo.triadic.relationGraph") {
    // The legacy page branch is the only relation shape that could not name its fields through a
    // facet selector. Keep it closed here so the preload can delegate wholesale: every relation
    // selector is then admitted by this one validator, never by a second hand-copied field list.
    const unknown = unknownFieldViolation(value, ["status", "updatedAfter", "updatedBefore", "limit", "cursor"]);
    if (unknown) return [`repo.triadic.relationGraph.payload contains an ${unknown}`];
  }
  return queryPayloadValidation(method === "repo.tasks.list" ? "task-list" : "relation-graph", value).map((issue) =>
    queryPayloadIssueMessages[issue](method),
  );
}

function validateRelationFacetPayload(value: JsonObject): string[] {
  const facet = value.facet,
    edgeFields = ["facet", "relationType", "state", "direction", "limit", "cursor"],
    allowed = facet === "edges" ? edgeFields : facet === "facts" ? ["facet", "limit", "cursor"] : ["facet"];
  if (!["edges", "facts", "coverageRows", "runtimeEdges"].includes(String(facet)))
    return ["repo.triadic.relationGraph.payload.facet is invalid"];
  const unknown = unknownFieldViolation(value, allowed);
  if (unknown) return [`repo.triadic.relationGraph.payload contains an ${unknown}`];
  const errors = validateDaemonQueryPayload("repo.triadic.relationGraph", {
    ...(value.limit === undefined ? {} : { limit: value.limit }),
    ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
  });
  if (facet !== "edges") return errors;
  if (value.relationType !== undefined && !nonEmpty(value.relationType))
    errors.push("repo.triadic.relationGraph.payload.relationType is invalid");
  if (value.state !== undefined && !statusWord(relationStateWords, value.state))
    errors.push("repo.triadic.relationGraph.payload.state is invalid");
  if (value.direction !== undefined && !["directed", "undirected"].includes(String(value.direction)))
    errors.push("repo.triadic.relationGraph.payload.direction is invalid");
  return errors;
}

/** The incident disposition row: the `claimed` fence carries only identity, a settled receipt adds
 * the executed option, its canonical outcome and the budget it was judged against. */
function validTaskDispatchDecisionAction(value: unknown): boolean {
  if (
    !isJsonObject(value) ||
    !dispatchText(value.pointId) ||
    !dispatchText(value.questionVersion) ||
    !dispatchText(value.decidedAt) ||
    !["claimed", "applied", "failed"].includes(String(value.status))
  )
    return false;
  if (value.status === "claimed")
    return Object.keys(value).every((field) => ["pointId", "questionVersion", "status", "decidedAt"].includes(field));
  return (
    dispatchText(value.selected) &&
    ["resume", "rerun", "needs_attention", "no_action"].includes(String(value.action)) &&
    (value.attention === null || value.attention === "question" || value.attention === "guard") &&
    [value.reason, value.successorDispatchId].every((field) => field === null || typeof field === "string") &&
    (value.budget === null ||
      (isJsonObject(value.budget) &&
        integer(value.budget.used) &&
        integer(value.budget.limit) &&
        Number(value.budget.used) >= 0 &&
        Number(value.budget.limit) >= 0 &&
        ["task", "repository", "daemon"].includes(String(value.budget.source))))
  );
}

/** Wire validation only: all judgments are produced by the kernel lifecycle read port. */
export function validDispatchLifecycleSummary(value: unknown): value is DispatchLifecycleSummary {
  if (!isJsonObject(value)) return false;
  const { policy } = value;
  return (
    ["ready", "pending"].includes(String(value.status)) &&
    [value.watermark, value.sourceRevision].every((n) => Number.isSafeInteger(n) && Number(n) >= 0) &&
    [value.dispatchId, value.nextDispatchId].every((id) => id === null || typeof id === "string") &&
    (value.groupPhase === null || (dispatchGroupPhaseWords as readonly unknown[]).includes(value.groupPhase)) &&
    (value.attemptPhase === null || (dispatchAttemptPhaseWords as readonly unknown[]).includes(value.attemptPhase)) &&
    [null, "succeeded", "failed", "cancelled", "stopped", "unknown"].includes(value.outcome as never) &&
    (dispatchDisplayStatusWords as readonly unknown[]).includes(value.displayStatus) &&
    (policy === null ||
      (isJsonObject(policy) &&
        [
          "attemptSettled",
          "groupSettled",
          "consentBlocked",
          "fallbackPending",
          "successorAdmissible",
          "canResolveRuling",
          "canRecover",
          "canSteer",
          "canAdoptProcess",
          "canHandoff",
          "canWrite",
          "canPublish",
          "ownsWorkspace",
        ].every((key) => typeof policy[key] === "boolean") &&
        (dispatchReservationStateWords as readonly unknown[]).includes(policy.capacity) &&
        (dispatchCapacityDispositionWords as readonly unknown[]).includes(policy.capacityDisposition) &&
        [null, "runtime_recovery_pending", "dispatch_owner_unverified", "runtime_capacity_exhausted"].includes(
          policy.blockerCode as never,
        )))
  );
}
