import { EXECUTION_V1_SCHEMA, isNativeCommitSha, LEASE_V1_SCHEMA, validateExecutionV1, validateLeaseHolder, validateLeaseV1 } from "./execution.ts";
import type { ExecutionV1, LeaseHolder, LeaseV1 } from "./execution.ts";
import { REVIEW_V1_SCHEMA, validateReviewV1 } from "./review.ts";
import type { ReviewV1 } from "./review.ts";
import { TASK_V1_SCHEMA, validateActorAxes, validateTaskV1 } from "./task.ts";
import type { ActorAxes, ContractValidationIssue, TaskV1 } from "./task.ts";
import { TASK_EDGE_TAKEN_SCHEMA, TASK_GRAPH_V1_SCHEMA, validateTaskGraph } from "./task-graph.ts";
import type { TaskEdgeTaken } from "./task-graph.ts";
import { hasOnlyFields, isNonEmptyString, isRecord, serializeEventEnvelope, validateWriteSource } from "./write-chain.contract.ts";
import type { EventEnvelope } from "./write-chain.contract.ts";

export const taskEventTypes = ["task_created", "execution_started", "lease_renewed", "execution_submitted", "review_recorded", "task_completed"] as const;
export type TaskEventType = (typeof taskEventTypes)[number];
type TaskEventEnvelope<T extends TaskEventType, P> = EventEnvelope<"task-event/v1", T, ActorAxes, P> & { readonly taskId: string };
export type TaskCreatedEvent = TaskEventEnvelope<"task_created", { readonly task: TaskV1 }>;
export type LeaseChangeReason = "initial_claim" | "same_principal_reconnect" | "ttl_expired_takeover";
export type ExecutionStartedEvent = TaskEventEnvelope<"execution_started", { readonly task: TaskV1; readonly execution: ExecutionV1; readonly lease: LeaseV1; readonly previousHolder: LeaseHolder | null; readonly leaseExpiresAt: string; readonly reason: LeaseChangeReason }>;
export type LeaseRenewedEvent = TaskEventEnvelope<"lease_renewed", { readonly task: TaskV1; readonly execution: ExecutionV1; readonly lease: LeaseV1; readonly previousHolder: LeaseHolder; readonly leaseExpiresAt: string; readonly reason: "same_principal_reconnect" }>;
export type ExecutionSubmittedEvent = TaskEventEnvelope<"execution_submitted", { readonly task: TaskV1; readonly execution: ExecutionV1; readonly edge: TaskEdgeTaken }>;
export type ReviewRecordedEvent = TaskEventEnvelope<"review_recorded", { readonly task: TaskV1; readonly execution: ExecutionV1; readonly review: ReviewV1; readonly edge?: TaskEdgeTaken }>;
export type TaskCompletedEvent = TaskEventEnvelope<"task_completed", { readonly task: TaskV1; readonly execution: ExecutionV1 }>;
export type TaskEventV1 = TaskCreatedEvent | ExecutionStartedEvent | LeaseRenewedEvent | ExecutionSubmittedEvent | ReviewRecordedEvent | TaskCompletedEvent;
export type TaskLifecycleErrorCode = "invalid_schema" | "invalid_transition" | "invalid_proof" | "invalid_graph" | "manual_intervention_required" | "frozen_write_plan";
export class TaskLifecycleContractError extends Error {
  readonly code: TaskLifecycleErrorCode; readonly issues: readonly ContractValidationIssue[];
  constructor(code: TaskLifecycleErrorCode, issues: readonly ContractValidationIssue[]) { super(issues.map((issue) => issue.message).join("; ")); this.name = "TaskLifecycleContractError"; this.code = code; this.issues = issues; }
}

export const TASK_EVENT_V1_SCHEMA = Object.freeze({ id: "task-event/v1", required: Object.freeze(["schema", "eventId", "workspaceRevision", "opId", "taskId", "type", "actor", "source", "occurredAt", "payload"]), types: taskEventTypes });
export const TASK_LIFECYCLE_SCHEMA = Object.freeze({ id: "task-lifecycle/v1", task: TASK_V1_SCHEMA, execution: EXECUTION_V1_SCHEMA, lease: LEASE_V1_SCHEMA,
  review: REVIEW_V1_SCHEMA, graph: TASK_GRAPH_V1_SCHEMA, edgeTaken: TASK_EDGE_TAKEN_SCHEMA, event: TASK_EVENT_V1_SCHEMA });

export function validateTaskEvent(value: unknown): readonly ContractValidationIssue[] {
  if (!isRecord(value) || !hasOnlyFields(value, TASK_EVENT_V1_SCHEMA.required)) return [{ code: "invalid_event", message: "task-event/v1 fields are incomplete or unknown" }];
  const issues: ContractValidationIssue[] = [];
  if (value.schema !== "task-event/v1") issues.push({ code: "invalid_schema", message: "event must use task-event/v1" });
  if (!isNonEmptyString(value.eventId) || !isNonEmptyString(value.opId) || !isNonEmptyString(value.taskId) || !isNonEmptyString(value.occurredAt)
    || typeof value.workspaceRevision !== "number" || !Number.isInteger(value.workspaceRevision) || value.workspaceRevision < 1
    || !(taskEventTypes as readonly unknown[]).includes(value.type)) issues.push({ code: "invalid_event", message: "event identity, revision, or type is invalid" });
  issues.push(...validateActorAxes(value.actor));
  if (validateWriteSource(value.source).length > 0) issues.push({ code: "invalid_event", message: "event source is invalid" });
  if (!isRecord(value.payload)) issues.push({ code: "invalid_event_payload", message: "event payload must be an object" });
  else if (value.type === "task_created") {
    if (!hasOnlyFields(value.payload, ["task"])) issues.push({ code: "invalid_event_payload", message: "task_created payload must contain only task" });
    else issues.push(...validateTaskV1(value.payload.task));
  } else {
    const fields = value.type === "review_recorded" && Object.hasOwn(value.payload, "edge") ? ["task", "execution", "review", "edge"]
      : value.type === "review_recorded" ? ["task", "execution", "review"] : value.type === "execution_submitted" ? ["task", "execution", "edge"]
      : value.type === "execution_started" || value.type === "lease_renewed" ? ["task", "execution", "lease", "previousHolder", "leaseExpiresAt", "reason"] : ["task", "execution"];
    if (!hasOnlyFields(value.payload, fields)) issues.push({ code: "invalid_event_payload", message: `${String(value.type)} payload fields are incomplete or unknown` });
    else {
      issues.push(...validateTaskV1(value.payload.task), ...validateExecutionV1(value.payload.execution));
      if (value.type === "execution_started" || value.type === "lease_renewed") {
        issues.push(...validateLeaseV1(value.payload.lease)); if (value.payload.previousHolder !== null) issues.push(...validateLeaseHolder(value.payload.previousHolder));
        if (!isNonEmptyString(value.payload.leaseExpiresAt) || !["initial_claim", "same_principal_reconnect", "ttl_expired_takeover"].includes(String(value.payload.reason))) issues.push({ code: "invalid_event_payload", message: `${value.type} requires lease expiry and history reason` });
        if (value.type === "lease_renewed" && (value.payload.previousHolder === null || value.payload.reason !== "same_principal_reconnect")) issues.push({ code: "invalid_event_payload", message: "lease_renewed requires its previous holder and reconnect reason" });
      }
      if (value.type === "review_recorded") issues.push(...validateReviewV1(value.payload.review));
      if ("edge" in value.payload) issues.push(...validateTakenEdge(value.payload.edge));
    }
  }
  if (isRecord(value.payload) && "task" in value.payload && isRecord(value.payload.task) && "graph" in value.payload.task) issues.push(...validateTaskGraph(value.payload.task.graph));
  if (isRecord(value.payload) && "task" in value.payload && isRecord(value.payload.task) && "taskId" in value.payload.task && value.payload.task.taskId !== value.taskId) issues.push({ code: "invalid_event_payload", message: "payload Task identity must match the envelope" });
  return issues;
}

function validateTakenEdge(value: unknown): readonly ContractValidationIssue[] {
  const fields = ["edgeId", "from", "to", "on", "actorRole", "reason", "commitSha", "iteration"];
  if (!isRecord(value) || !hasOnlyFields(value, fields) || !isNonEmptyString(value.edgeId) || !isNonEmptyString(value.reason)
    || !["implementation", "anti_entropy", "review"].includes(String(value.from)) || !["implementation", "anti_entropy", "review"].includes(String(value.to))
    || !["submitted", "approved", "changes_requested"].includes(String(value.on)) || !["executor", "anti_entropy"].includes(String(value.actorRole))
    || !isNativeCommitSha(value.commitSha) || !Number.isInteger(value.iteration) || typeof value.iteration !== "number" || value.iteration < 0 || value.iteration > 1) return [{ code: "invalid_edge_evidence", message: "taken edge requires its seven audit fields" }];
  return [];
}

export function serializeTaskEvent(value: TaskEventV1): string {
  const issues = validateTaskEvent(value); if (issues.length > 0) throw new TaskLifecycleContractError("invalid_schema", issues); return serializeEventEnvelope(value);
}
