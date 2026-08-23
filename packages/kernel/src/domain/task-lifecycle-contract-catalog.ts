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
import { TASK_LIFECYCLE_TRANSITIONS } from "./task-lifecycle-transitions.ts";

// CLI-facing catalog, projection fields, and contract descriptor.
export const TASK_LIFECYCLE_COMMAND_CATALOG = Object.freeze(
  TASK_LIFECYCLE_TRANSITIONS.map((value) =>
    Object.freeze({
      id: value.id,
      commandType: value.commandType,
      from: value.from,
      proof: value.proof,
      eventType: value.eventType,
    }),
  ),
);
export type TaskLifecycleCliCatalogEntry = (typeof TASK_LIFECYCLE_COMMAND_CATALOG)[number];
export const TASK_LIFECYCLE_PROJECTION_FIELDS = Object.freeze({
  task: TASK_V1_SCHEMA.required,
  execution: EXECUTION_V1_SCHEMA.required,
  review: REVIEW_V1_SCHEMA.required,
  consent: REVIEW_CONSENT_V1_SCHEMA.required,
  edgeTaken: TASK_EDGE_TAKEN_SCHEMA.required,
});
const taskLifecycleContract = Object.freeze({
  id: "task-lifecycle",
  phases: Object.freeze(["P4"]),
  commands: Object.freeze(TASK_LIFECYCLE_COMMAND_CATALOG.map((entry) => Object.freeze({ id: entry.id, phase: "P4" }))),
  gates: Object.freeze([]),
  guards: Object.freeze([]),
  schemas: Object.freeze([
    Object.freeze({
      id: "task-event/v1",
      schema: "packages/kernel/src/domain/task-lifecycle.contract.ts#TASK_EVENT_V1_SCHEMA",
      parser: "packages/kernel/src/domain/task-lifecycle.contract.ts#validateTaskEvent",
      writer: "packages/kernel/src/domain/task-lifecycle.contract.ts#serializeTaskEvent",
      error: "packages/kernel/src/domain/task-lifecycle.contract.ts#TaskLifecycleContractError",
      negativeFixtures: Object.freeze(["tools/gates/test/fixtures/task-event-legacy-shape.json"]),
    }),
  ]),
});
export default taskLifecycleContract;
