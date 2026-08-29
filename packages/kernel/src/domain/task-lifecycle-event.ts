import { isNativeCommitSha, validateExecutionV1, validateLeaseHolder, validateLeaseV1 } from "./execution.ts";
import type { ExecutionV1, LeaseHolder, LeaseV1 } from "./execution.ts";
import { validateReviewConsentV1, validateReviewV1 } from "./review.ts";
import type { ReviewConsentV1, ReviewV1 } from "./review.ts";
import { validateActorAxes, validateTaskV1 } from "./task.ts";
import type { ActorAxes, ContractValidationIssue, TaskV1 } from "./task.ts";
import { validateTaskGraph } from "./task-graph.ts";
import type { TaskEdgeTaken } from "./task-graph.ts";
import {
  validateCodeDocRepointV1,
  validateCodeDocWitnessV1,
  type CodeDocRepointV1,
  type CodeDocWitnessV1,
} from "./code-doc-witness.ts";
import { validateCompletionGateWitnessV1, type CompletionGateWitnessV1 } from "./completion-gate-witness.ts";
import {
  hasOnlyFields,
  hasRequiredFields,
  isNonEmptyString,
  isRecord,
  sameActorIdentity,
  sameWriteSource,
  serializeEventEnvelope,
  validateWriteSource,
} from "./write-chain.contract.ts";
import type { EventEnvelope } from "./write-chain.contract.ts";
import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import { isValidDocEventChange, type DocEventChange } from "./doc-sync.contract.ts";
import { timestamp } from "./timestamp.ts";
export const taskEventTypes = [
  "task_created",
  "execution_started",
  "lease_renewed",
  "execution_submitted",
  "execution_executor_declared",
  "review_recorded",
  "review_consent_recorded",
  "code_doc_reconciled",
  "code_doc_repointed",
  "completion_gate_verified",
  "task_completed",
  "lease_released",
  "task_transitioned",
  "task_amended",
  "task_archived",
  "task_superseded",
  "task_deleted",
  "task_reopened",
  "task_contract_migrated",
  "task_relation_added",
] as const;
export type TaskEventType = (typeof taskEventTypes)[number];
// Lifecycle claims are machine-rendered documents. The one exception mirrors the
// bootstrap claim contract: `task_plan.md` is owned by doc-sync (`markdown-body-replaceable/v1`),
// so a lifecycle retitle of an already-published plan must keep the prose policy — otherwise the
// next prose sync of that plan would be rejected as `semantic_policy_changed`.
export interface LifecycleDocumentClaim {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: "text/markdown" | "application/json";
  readonly policyId: "typed-machine-writer/v1" | "markdown-body-replaceable/v1";
}
export type TaskCarriedDocumentChange = DocEventChange;
type TaskEventEnvelope<T extends TaskEventType, P> = EventEnvelope<
  "task-event/v1",
  T,
  ActorAxes,
  P & {
    readonly documentClaims: readonly LifecycleDocumentClaim[];
    readonly carriedDocumentClaims?: readonly TaskCarriedDocumentChange[];
  }
> & { readonly taskId: string };
export type TaskCreatedEvent = EventEnvelope<
  "task-event/v1",
  "task_created",
  ActorAxes,
  {
    readonly task: TaskV1;
    readonly documentClaims?: readonly LifecycleDocumentClaim[];
    readonly carriedDocumentClaims?: readonly TaskCarriedDocumentChange[];
  }
> & { readonly taskId: string };
export type LeaseChangeReason = "initial_claim" | "same_principal_reconnect" | "ttl_expired_takeover";
export type ExecutionStartedEvent = TaskEventEnvelope<
  "execution_started",
  {
    readonly task: TaskV1;
    readonly execution: ExecutionV1;
    readonly lease: LeaseV1;
    readonly previousHolder: LeaseHolder | null;
    readonly leaseExpiresAt: string;
    readonly reason: LeaseChangeReason;
  }
>;
export type LeaseRenewedEvent = TaskEventEnvelope<
  "lease_renewed",
  {
    readonly task: TaskV1;
    readonly execution: ExecutionV1;
    readonly lease: LeaseV1;
    readonly previousHolder: LeaseHolder;
    readonly leaseExpiresAt: string;
    readonly reason: "same_principal_reconnect";
  }
>;
export type ExecutionSubmittedEvent = TaskEventEnvelope<
  "execution_submitted",
  {
    readonly task: TaskV1;
    readonly execution: ExecutionV1;
    readonly edge: TaskEdgeTaken;
  }
>;
export type ExecutionExecutorDeclaredEvent = TaskEventEnvelope<
  "execution_executor_declared",
  {
    readonly task: TaskV1;
    readonly execution: ExecutionV1;
    readonly previousActor: ActorAxes;
    readonly reason: string;
  }
>;
export type ReviewRecordedEvent = TaskEventEnvelope<
  "review_recorded",
  {
    readonly task: TaskV1;
    readonly execution: ExecutionV1;
    readonly review: ReviewV1;
    readonly edge?: TaskEdgeTaken;
  }
>;
export type ReviewConsentRecordedEvent = TaskEventEnvelope<
  "review_consent_recorded",
  {
    readonly task: TaskV1;
    readonly execution: ExecutionV1;
    readonly review: ReviewV1;
    readonly consent: ReviewConsentV1;
  }
>;
export type CodeDocReconciledEvent = TaskEventEnvelope<
  "code_doc_reconciled",
  {
    readonly task: TaskV1;
    readonly execution: ExecutionV1;
    readonly witness: CodeDocWitnessV1;
  }
>;
export type CodeDocRepointedEvent = TaskEventEnvelope<
  "code_doc_repointed",
  {
    readonly task: TaskV1;
    readonly execution: ExecutionV1;
    readonly record: CodeDocRepointV1;
  }
>;
export type CompletionGateVerifiedEvent = TaskEventEnvelope<
  "completion_gate_verified",
  {
    readonly task: TaskV1;
    readonly execution: ExecutionV1;
    readonly witness: CompletionGateWitnessV1;
  }
>;
export type TaskCompletedEvent = TaskEventEnvelope<
  "task_completed",
  { readonly task: TaskV1; readonly execution: ExecutionV1 }
>;
export interface TaskMutationV1 {
  readonly command:
    | "release"
    | "transition"
    | "amend"
    | "archive"
    | "supersede"
    | "delete"
    | "reopen"
    | "contract-migrate"
    | "relate";
  readonly reason: string;
  readonly fields: readonly string[];
}
export type LeaseReleasedEvent = TaskEventEnvelope<
  "lease_released",
  {
    readonly task: TaskV1;
    readonly execution: ExecutionV1;
    readonly releasedLease: LeaseV1;
    readonly mutation: TaskMutationV1;
  }
>;
export type TaskMutationEventType = Exclude<
  TaskEventType,
  | "task_created"
  | "execution_started"
  | "lease_renewed"
  | "execution_submitted"
  | "execution_executor_declared"
  | "review_recorded"
  | "review_consent_recorded"
  | "code_doc_reconciled"
  | "code_doc_repointed"
  | "completion_gate_verified"
  | "task_completed"
  | "lease_released"
>;
export type TaskMutationEvent = TaskEventEnvelope<
  TaskMutationEventType,
  { readonly task: TaskV1; readonly mutation: TaskMutationV1 }
>;
export type TaskEventV1 =
  | TaskCreatedEvent
  | ExecutionStartedEvent
  | LeaseRenewedEvent
  | ExecutionSubmittedEvent
  | ExecutionExecutorDeclaredEvent
  | ReviewRecordedEvent
  | ReviewConsentRecordedEvent
  | CodeDocReconciledEvent
  | CodeDocRepointedEvent
  | CompletionGateVerifiedEvent
  | TaskCompletedEvent
  | LeaseReleasedEvent
  | TaskMutationEvent;
export type TaskLifecycleErrorCode =
  | "invalid_schema"
  | "orphan_task"
  | "invalid_transition"
  | "invalid_proof"
  | "invalid_graph"
  | "manual_intervention_required"
  | "frozen_write_plan";
export class TaskLifecycleContractError extends Error {
  readonly code: TaskLifecycleErrorCode;
  readonly issues: readonly ContractValidationIssue[];
  constructor(code: TaskLifecycleErrorCode, issues: readonly ContractValidationIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "TaskLifecycleContractError";
    this.code = code;
    this.issues = issues;
  }
}
export const TASK_EVENT_V1_SCHEMA = Object.freeze({
  id: "task-event/v1",
  required: Object.freeze([
    "schema",
    "eventId",
    "workspaceRevision",
    "opId",
    "taskId",
    "type",
    "actor",
    "source",
    "occurredAt",
    "payload",
  ]),
  types: taskEventTypes,
});
export function validateTaskEvent(value: unknown): readonly ContractValidationIssue[] {
  return validateTaskEventFields(value, true);
}
export function validateCurrentTaskEvent(value: unknown): readonly ContractValidationIssue[] {
  return validateTaskEventFields(value, false);
}
function validateTaskEventFields(value: unknown, allowUnknownFields: boolean): readonly ContractValidationIssue[] {
  if (
    !isRecord(value) ||
    !(allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, TASK_EVENT_V1_SCHEMA.required)
  )
    return [invalidEventPayloadIssue("task-event/v1 fields are incomplete or unknown")];
  const issues: ContractValidationIssue[] = [];
  if (value.schema !== "task-event/v1")
    issues.push({
      code: "invalid_schema",
      message: "event must use task-event/v1",
    });
  if (
    !isNonEmptyString(value.eventId) ||
    !isNonEmptyString(value.opId) ||
    !isNonEmptyString(value.taskId) ||
    !timestamp(value.occurredAt) ||
    !Number.isInteger(value.workspaceRevision) ||
    (value.workspaceRevision as number) < 1 ||
    !taskEventTypes.includes(value.type as TaskEventType)
  )
    issues.push(invalidEventPayloadIssue("event identity, revision, or type is invalid"));
  issues.push(...validateActorAxes(value.actor, allowUnknownFields));
  if (validateWriteSource(value.source, allowUnknownFields).length)
    issues.push(invalidEventPayloadIssue("event source is invalid"));
  if (!isRecord(value.payload)) return [...issues, invalidEventPayloadIssue("event payload must be an object")];
  const payload = value.payload,
    carried = payload.carriedDocumentClaims,
    payloadWithoutCarried = isRecord(payload)
      ? Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "carriedDocumentClaims"))
      : payload,
    fields = lifecyclePayloadFields(
      String(value.type),
      Object.hasOwn(payloadWithoutCarried as Record<string, unknown>, "edge"),
    ),
    claims = payload.documentClaims;
  const claimlessFields =
    value.type === "task_created"
      ? ["task"]
      : lifecyclePayloadFields(String(value.type), Object.hasOwn(payload, "edge")).filter(
          (field) => field !== "documentClaims",
        );
  const payloadFields = allowUnknownFields ? hasRequiredFields : hasOnlyFields;
  const validPayloadFields =
    (value.type === "task_created" || value.type === "lease_renewed") && claims === undefined
      ? payloadFields(payloadWithoutCarried as Record<string, unknown>, claimlessFields)
      : payloadFields(payloadWithoutCarried as Record<string, unknown>, fields);
  if (
    !validPayloadFields ||
    (claims !== undefined &&
      (!Array.isArray(claims) || claims.some((claim) => !validLifecycleClaim(claim, allowUnknownFields)))) ||
    (carried !== undefined &&
      (!Array.isArray(carried) ||
        carried.length === 0 ||
        carried.some((change) => !isValidDocEventChange(change, allowUnknownFields))))
  )
    return [...issues, invalidEventPayloadIssue(`${String(value.type)} payload fields or document claims are invalid`)];
  issues.push(...validateTaskV1(payload.task, allowUnknownFields));
  if (
    [
      "execution_started",
      "lease_renewed",
      "execution_submitted",
      "execution_executor_declared",
      "review_recorded",
      "review_consent_recorded",
      "code_doc_reconciled",
      "code_doc_repointed",
      "completion_gate_verified",
      "task_completed",
      "lease_released",
    ].includes(String(value.type))
  )
    issues.push(...validateExecutionV1(payload.execution, allowUnknownFields));
  if (value.type === "execution_started" || value.type === "lease_renewed") {
    issues.push(...validateLeaseV1(payload.lease, allowUnknownFields));
    if (payload.previousHolder !== null)
      issues.push(...validateLeaseHolder(payload.previousHolder, allowUnknownFields));
    if (
      !timestamp(payload.leaseExpiresAt) ||
      !["initial_claim", "same_principal_reconnect", "ttl_expired_takeover"].includes(String(payload.reason)) ||
      (value.type === "lease_renewed" &&
        (payload.previousHolder === null || payload.reason !== "same_principal_reconnect"))
    )
      issues.push(invalidEventPayloadIssue("lease event history is invalid"));
  }
  if (value.type === "execution_executor_declared") {
    issues.push(...validateActorAxes(payload.previousActor, allowUnknownFields));
    if (
      !isNonEmptyString(payload.reason) ||
      (isRecord(payload.previousActor) && payload.previousActor.executor !== null) ||
      (isRecord(payload.execution) && !sameActorIdentity(payload.execution.actor, value.actor))
    )
      issues.push(
        invalidEventPayloadIssue(
          "executor declaration must preserve the previous bare actor, bind the declaring actor, and state a reason",
        ),
      );
  }
  if (value.type === "review_recorded") issues.push(...validateReviewV1(payload.review, allowUnknownFields));
  if (value.type === "review_consent_recorded")
    issues.push(
      ...validateReviewV1(payload.review, allowUnknownFields),
      ...validateReviewConsentV1(payload.consent, allowUnknownFields),
    );
  if (value.type === "code_doc_reconciled")
    issues.push(...validateCodeDocWitnessV1(payload.witness, allowUnknownFields));
  if (value.type === "code_doc_repointed") issues.push(...validateCodeDocRepointV1(payload.record, allowUnknownFields));
  if (
    value.type === "code_doc_repointed" &&
    isRecord(payload.record) &&
    isRecord(payload.execution) &&
    (payload.record.taskId !== value.taskId ||
      payload.record.executionId !== (payload.execution as { readonly executionId?: unknown }).executionId ||
      !sameActorIdentity(payload.record.actor, value.actor) ||
      !sameWriteSource(payload.record.source, value.source) ||
      payload.record.repointedAt !== value.occurredAt)
  )
    issues.push(invalidEventPayloadIssue("code-doc repoint record must be pinned to its canonical event envelope"));
  if (value.type === "completion_gate_verified") {
    issues.push(...validateCompletionGateWitnessV1(payload.witness, allowUnknownFields));
    if (
      isRecord(payload.witness) &&
      (payload.witness.receiptId !== value.opId ||
        payload.witness.taskId !== value.taskId ||
        !sameActorIdentity(payload.witness.actor, value.actor) ||
        !sameWriteSource(payload.witness.source, value.source))
    )
      issues.push(invalidEventPayloadIssue("completion gate witness must be pinned to its canonical event receipt"));
  }
  if ("edge" in payload) issues.push(...validateEdge(payload.edge, allowUnknownFields));
  if (value.type === "lease_released") {
    issues.push(...validateLeaseV1(payload.releasedLease, allowUnknownFields));
    if (
      !validMutation(payload.mutation, allowUnknownFields) ||
      (isRecord(payload.releasedLease) && payload.releasedLease.taskId !== value.taskId)
    )
      issues.push(invalidEventPayloadIssue("lease release mutation is invalid"));
  }
  if (
    String(value.type).startsWith("task_") &&
    !["task_created", "task_completed"].includes(String(value.type)) &&
    !validMutation(payload.mutation, allowUnknownFields)
  )
    issues.push(invalidEventPayloadIssue("task mutation audit fields are invalid"));
  if (isRecord(payload.task) && "graph" in payload.task)
    issues.push(...validateTaskGraph(payload.task.graph, allowUnknownFields));
  if (isRecord(payload.task) && payload.task.taskId !== value.taskId)
    issues.push(invalidEventPayloadIssue("payload Task identity must match the envelope"));
  return issues;
}
function lifecyclePayloadFields(type: string, edge: boolean): readonly string[] {
  const common = ["task", "execution", "documentClaims"];
  if (type === "task_created") return ["task", "documentClaims"];
  if (type === "execution_started" || type === "lease_renewed")
    return [...common, "lease", "previousHolder", "leaseExpiresAt", "reason"];
  if (type === "execution_submitted") return [...common, "edge"];
  if (type === "execution_executor_declared") return [...common, "previousActor", "reason"];
  if (type === "review_recorded") return [...common, "review", ...(edge ? ["edge"] : [])];
  if (type === "review_consent_recorded") return [...common, "review", "consent"];
  if (type === "code_doc_reconciled" || type === "completion_gate_verified") return [...common, "witness"];
  if (type === "code_doc_repointed") return [...common, "record"];
  if (type === "lease_released") return [...common, "releasedLease", "mutation"];
  if (type.startsWith("task_") && !["task_created", "task_completed"].includes(type))
    return ["task", "mutation", "documentClaims"];
  return common;
}
function validMutation(value: unknown, allowUnknownFields: boolean): value is TaskMutationV1 {
  return (
    isRecord(value) &&
    (allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, ["command", "reason", "fields"]) &&
    [
      "release",
      "transition",
      "amend",
      "archive",
      "supersede",
      "delete",
      "reopen",
      "contract-migrate",
      "relate",
    ].includes(String(value.command)) &&
    isNonEmptyString(value.reason) &&
    Array.isArray(value.fields) &&
    value.fields.every((field) => isNonEmptyString(field) && !isImmutableTaskField(field))
  );
}
function isImmutableTaskField(value: string): boolean {
  return value.startsWith("owner") || value.startsWith("createdBy");
}
function validLifecycleClaim(value: unknown, allowUnknownFields: boolean): value is LifecycleDocumentClaim {
  if (
    !isRecord(value) ||
    !(allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, [
      "path",
      "sha256",
      "size",
      "mediaType",
      "policyId",
    ]) ||
    !/^[0-9a-f]{64}$/u.test(String(value.sha256)) ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 ||
    !["text/markdown", "application/json"].includes(String(value.mediaType))
  )
    return false;
  const path = String(value.path);
  let canonical: boolean;
  try {
    canonical = normalizeRelativeDocumentPath(path) === path;
  } catch {
    return false;
  }
  if (!canonical) return false;
  const planClaim = path.endsWith("/task_plan.md");
  return planClaim
    ? value.policyId === "markdown-body-replaceable/v1" && value.mediaType === "text/markdown"
    : value.policyId === "typed-machine-writer/v1";
}
function validateEdge(value: unknown, allowUnknownFields: boolean): readonly ContractValidationIssue[] {
  return !isRecord(value) ||
    !(allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, [
      "edgeId",
      "from",
      "to",
      "on",
      "actorRole",
      "reason",
      "commitSha",
      "iteration",
    ]) ||
    !isNonEmptyString(value.edgeId) ||
    !isNonEmptyString(value.reason) ||
    !["implementation", "review"].includes(String(value.from)) ||
    !["implementation", "review"].includes(String(value.to)) ||
    !["submitted", "changes_requested"].includes(String(value.on)) ||
    !["executor", "reviewer"].includes(String(value.actorRole)) ||
    !isNativeCommitSha(value.commitSha) ||
    !Number.isInteger(value.iteration) ||
    (value.iteration as number) < 0 ||
    (value.iteration as number) > 1
    ? [
        {
          code: "invalid_edge_evidence",
          message: "taken edge requires its audit fields",
        },
      ]
    : [];
}
function invalidEventPayloadIssue(message: string): ContractValidationIssue {
  return { code: "invalid_event_payload", message };
}
export function serializeTaskEvent(value: TaskEventV1): string {
  const issues = validateCurrentTaskEvent(value);
  if (issues.length) throw new TaskLifecycleContractError("invalid_schema", issues);
  return serializeEventEnvelope(value);
}
