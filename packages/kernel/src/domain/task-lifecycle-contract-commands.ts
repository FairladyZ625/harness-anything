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
  NormalizedTaskLifecycleCommand,
  TaskLifecycleCommand,
  TaskLifecycleCommandIntent,
} from "./task-lifecycle-contract-internal-types.ts";

// Command envelope normalization and validation.
export function normalizeTaskLifecycleCommand<C extends TaskLifecycleCommandIntent>(
  binding: {
    readonly workspaceId: string;
    readonly actor: ActorAxes;
    readonly source: WriteSource;
    readonly expectedRevision: number;
  },
  command: C,
): NormalizedTaskLifecycleCommand<C> {
  return Object.freeze({
    ...command,
    ...normalizeCommandEnvelope({
      ...binding,
      command: command as unknown as Readonly<Record<string, unknown>>,
    }),
  }) as unknown as NormalizedTaskLifecycleCommand<C>;
}
function intent(command: TaskLifecycleCommand): TaskLifecycleCommandIntent {
  const {
    schema: _schema,
    workspaceId: _workspaceId,
    actor: _actor,
    source: _source,
    expectedRevision: _expectedRevision,
    opId: _opId,
    commandDigest: _commandDigest,
    eventId: _eventId,
    workspaceRevision: _workspaceRevision,
    occurredAt: _occurredAt,
    transport: _transport,
    ...value
  } = command as TaskLifecycleCommand & { readonly transport?: unknown };
  return value as TaskLifecycleCommandIntent;
}
export function validateTaskLifecycleCommandEnvelope(
  command: TaskLifecycleCommand,
): readonly ContractValidationIssue[] {
  return validateNormalizedCommandEnvelope(command, {
    workspaceId: command.workspaceId,
    actor: command.actor,
    source: command.source,
    expectedRevision: command.expectedRevision,
    command: intent(command) as unknown as Readonly<Record<string, unknown>>,
  }).map((message) => ({ code: "invalid_schema", message }));
}
