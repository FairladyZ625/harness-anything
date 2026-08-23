import {
  EXECUTION_V1_SCHEMA,
  isNativeCommitSha,
  isNativeExecution,
  LEASE_V1_SCHEMA,
  validateSubmissionV1,
} from "./execution.ts";
import { digest } from "./digest.ts";
import type { ExecutionV1, LeaseHolder, LeaseV1, ProjectedExecution, SubmissionV1 } from "./execution.ts";
import { REVIEW_CONSENT_V1_SCHEMA, REVIEW_V1_SCHEMA, reviewDigest } from "./review.ts";
import type { ReviewConsentV1, ReviewV1, ReviewVerdict } from "./review.ts";
import type { CodeDocWitnessV1 } from "./code-doc-witness.ts";
import type { CompletionGateWitnessV1 } from "./completion-gate-witness.ts";
import type { CoverageRelation } from "./decision-coverage.ts";
import { TASK_V1_SCHEMA, taskClasses } from "./task.ts";
import type { ActorAxes, ContractValidationIssue, TaskClass, TaskV1 } from "./task.ts";
import { TASK_EDGE_TAKEN_SCHEMA, TASK_GRAPH_V1_SCHEMA, validateTaskGraph } from "./task-graph.ts";
import type { TaskEdgeTaken, TaskGraphV1 } from "./task-graph.ts";
import {
  isNonEmptyString,
  normalizeCommandEnvelope,
  validateNormalizedCommandEnvelope,
} from "./write-chain.contract.ts";
import type { NormalizedCommandEnvelope, WriteSource } from "./write-chain.contract.ts";
import { stableStringify } from "../integrity/stable-hash.ts";
import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import { TaskLifecycleContractError, validateTaskEvent } from "./task-lifecycle-event.ts";
import type {
  CodeDocReconciledEvent,
  ExecutionExecutorDeclaredEvent,
  ExecutionStartedEvent,
  ExecutionSubmittedEvent,
  LeaseChangeReason,
  ReviewConsentRecordedEvent,
  ReviewRecordedEvent,
  TaskCompletedEvent,
  TaskCreatedEvent,
  TaskEventType,
  TaskEventV1,
  TaskLifecycleErrorCode,
  TaskMutationEvent,
} from "./task-lifecycle-event.ts";
import { isIndependentFrom, isSameExecution, isSamePerson } from "./actor-domain-services.ts";
import { explainStatusTransition, reinstateTaskTargets } from "./lifecycle-status.ts";
import type { DomainStatus } from "./lifecycle-status.ts";
import { closeoutReadiness, currentSubmittedExecutions, gateResults } from "./closeout-readiness.ts";
import type {
  CompleteTaskProof,
  TaskLifecycleCommand,
  TaskLifecycleSnapshot,
} from "./task-lifecycle-contract-internal-types.ts";

// Snapshot primitives, event construction, and common validation helpers.
export function emptyTaskLifecycleSnapshot(revision = 0): TaskLifecycleSnapshot {
  return {
    revision,
    task: null,
    executions: [],
    reviews: [],
    consents: [],
    codeDocWitnesses: [],
    gateWitnesses: [],
    edgesTaken: [],
    lease: null,
  };
}
export function envelope<E extends TaskEventV1>(
  command: TaskLifecycleCommand,
  type: E["type"],
  payload: Omit<E["payload"], "documentClaims">,
): E {
  return {
    schema: "task-event/v1",
    eventId: command.eventId,
    workspaceRevision: command.workspaceRevision,
    opId: command.opId,
    taskId: command.taskId,
    type,
    actor: command.actor,
    source: command.source,
    occurredAt: command.occurredAt,
    payload: { ...payload, documentClaims: [] },
  } as unknown as E;
}
export function revisionIssues(
  snapshot: TaskLifecycleSnapshot,
  command: TaskLifecycleCommand,
): ContractValidationIssue[] {
  return command.expectedRevision === snapshot.revision && command.workspaceRevision > snapshot.revision
    ? []
    : [
        lifecycleContractIssue(
          "invalid_transition",
          "aggregate expected revision must match and workspace revision must advance",
        ),
      ];
}
export function replaceExecution(
  values: readonly ProjectedExecution[],
  replacement: ExecutionV1,
): readonly ProjectedExecution[] {
  return values.map((value) => (value.executionId === replacement.executionId ? replacement : value));
}
export function execution(snapshot: TaskLifecycleSnapshot, id: string): ExecutionV1 | undefined {
  return snapshot.executions.find(
    (value): value is ExecutionV1 =>
      isNativeExecution(value) && value.executionId === id && value.iteration === snapshot.task?.iteration,
  );
}
export function heldLeaseForExecutionActor(
  snapshot: TaskLifecycleSnapshot,
  executionId: string | undefined,
  actor: ActorAxes,
): LeaseV1 | undefined {
  const lease = snapshot.lease;
  return lease?.phase === "held" &&
    (executionId === undefined || lease.executionId === executionId) &&
    isSameExecution(lease.actor, actor)
    ? lease
    : undefined;
}
export function executionExecutorDeclarationCandidates(
  snapshot: TaskLifecycleSnapshot,
  taskId: string,
  actor: ActorAxes,
): readonly ExecutionV1[] {
  const task = snapshot.task;
  if (
    !task ||
    task.taskId !== taskId ||
    task.status !== "in_review" ||
    task.currentNode !== "review" ||
    snapshot.lease !== null ||
    actor.executor === null
  )
    return [];
  return currentSubmittedExecutions(snapshot).filter(
    (value) =>
      value.actor.executor === null &&
      isSamePerson(value.actor, actor) &&
      !snapshot.reviews.some((review) => review.executionId === value.executionId),
  );
}
export function takeEdge(
  task: TaskV1,
  trigger: TaskEdgeTaken["on"],
  reason: string,
  commitSha: string,
  iteration: number,
): TaskEdgeTaken {
  const edge = task.graph.edges.find((value) => value.on === trigger);
  if (!edge)
    throw new TaskLifecycleContractError("invalid_graph", [
      lifecycleContractIssue("invalid_graph_shape", `graph has no ${trigger} edge`),
    ]);
  return {
    edgeId: edge.id,
    from: edge.from,
    to: edge.to,
    on: edge.on,
    actorRole: edge.actorRole,
    reason,
    commitSha,
    iteration,
  };
}
export function canonicalGateReceipts(
  snapshot: TaskLifecycleSnapshot,
  current: ExecutionV1,
): CompleteTaskProof["gateReceipts"] {
  const passed = new Set(
    gateResults(snapshot, undefined, current.executionId, current.submission?.commitSha, current.iteration)
      .filter(({ status }) => status === "passed")
      .map(({ gateId }) => gateId),
  );
  return (snapshot.task?.completionGateIds ?? []).flatMap((gateId) => {
    if (!passed.has(gateId)) return [];
    const codeDoc =
      gateId === "code-doc-reconciliation"
        ? snapshot.codeDocWitnesses.find(
            (value) =>
              value.executionId === current.executionId &&
              value.commitSha === current.submission?.commitSha &&
              value.iteration === current.iteration,
          )
        : undefined;
    const gate =
      gateId !== "code-doc-reconciliation"
        ? snapshot.gateWitnesses.find(
            (value) =>
              value.gateId === gateId &&
              value.executionId === current.executionId &&
              value.commitSha === current.submission?.commitSha &&
              value.iteration === current.iteration &&
              value.result === "pass",
          )
        : undefined;
    const receiptRef = codeDoc ? `event:${codeDoc.witnessId}` : gate ? `event:${gate.receiptId}` : null;
    return receiptRef
      ? [
          {
            gateId,
            receiptRef,
            result: "pass" as const,
            executionId: current.executionId,
            commitSha: current.submission!.commitSha,
            iteration: current.iteration,
          },
        ]
      : [];
  });
}
export { reviewDigest } from "./review.ts";
export function canonicalDocumentPaths(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) return false;
  try {
    return value.every((path) => typeof path === "string" && normalizeRelativeDocumentPath(path) === path);
  } catch {
    return false;
  }
}
export function errorCode(issues: readonly ContractValidationIssue[]): TaskLifecycleErrorCode {
  return issues.some((value) => value.code === "manual_intervention_required")
    ? "manual_intervention_required"
    : issues.some(
          (value) => value.code.includes("graph") || value.code.includes("edge") || value.code.includes("atomicity"),
        )
      ? "invalid_graph"
      : issues.some((value) => value.code === "invalid_proof")
        ? "invalid_proof"
        : "invalid_transition";
}
export function lifecycleContractIssue(code: string, message: string): ContractValidationIssue {
  return { code, message };
}
