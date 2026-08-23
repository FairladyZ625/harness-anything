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

// Shared public contract shapes and internal transition protocol.
export interface TaskLifecycleSnapshot {
  readonly revision: number;
  readonly task: TaskV1 | null;
  readonly executions: readonly ProjectedExecution[];
  readonly reviews: readonly ReviewV1[];
  readonly consents: readonly ReviewConsentV1[];
  readonly codeDocWitnesses: readonly CodeDocWitnessV1[];
  readonly gateWitnesses: readonly CompletionGateWitnessV1[];
  readonly edgesTaken: readonly TaskEdgeTaken[];
  readonly lease: LeaseV1 | null;
  readonly decisionRelations?: readonly CoverageRelation[];
}
export const TASK_LIFECYCLE_SCHEMA = Object.freeze({
  id: "task-lifecycle/v1",
  task: TASK_V1_SCHEMA,
  execution: EXECUTION_V1_SCHEMA,
  lease: LEASE_V1_SCHEMA,
  review: REVIEW_V1_SCHEMA,
  consent: REVIEW_CONSENT_V1_SCHEMA,
  graph: TASK_GRAPH_V1_SCHEMA,
  edgeTaken: TASK_EDGE_TAKEN_SCHEMA,
});
interface Intent<T extends string> {
  readonly type: T;
  readonly taskId: string;
}
export interface CreateReplayTaskIntent extends Intent<"CreateReplayTask"> {
  readonly title: string;
  readonly taskClass: TaskClass;
  readonly graph: TaskGraphV1;
  readonly completionGateIds: readonly string[];
  readonly presetSnapshotDigest: `sha256:${string}` | null;
}
export interface StartExecutionIntent extends Intent<"StartExecution"> {
  readonly executionId: string;
  readonly ttlMs?: number;
}
export interface TransitionTaskIntent extends Intent<"TransitionTask"> {
  readonly status: DomainStatus;
  readonly reason: string;
  readonly force: boolean;
}
export interface SubmitExecutionIntent extends Intent<"SubmitExecution"> {
  readonly executionId: string;
  readonly submission: SubmissionV1;
}
export interface RecordReviewIntent extends Intent<"RecordReview"> {
  readonly executionId: string;
  readonly reviewId: string;
  readonly verdict: ReviewVerdict;
  readonly reason: string;
  readonly evidenceChecked: readonly string[];
  readonly commitSha: string;
  readonly iteration: number;
  readonly contentDigest: `sha256:${string}`;
}
export interface RecordReviewConsentIntent extends Intent<"RecordReviewConsent"> {
  readonly executionId: string;
  readonly reviewId: string;
  readonly consentId: string;
  readonly reviewDigest: `sha256:${string}`;
  readonly contentDigest: `sha256:${string}`;
}
export interface ReconcileCodeDocIntent extends Intent<"ReconcileCodeDoc"> {
  readonly executionId: string;
  readonly witnessId: string;
  readonly commitSha: string;
  readonly iteration: number;
  readonly paths: readonly string[];
}
export interface CompleteTaskIntent extends Intent<"CompleteTask"> {
  readonly executionId: string;
}
export type TaskLifecycleCommandIntent =
  | CreateReplayTaskIntent
  | StartExecutionIntent
  | TransitionTaskIntent
  | SubmitExecutionIntent
  | RecordReviewIntent
  | RecordReviewConsentIntent
  | ReconcileCodeDocIntent
  | CompleteTaskIntent;
export type NormalizedTaskLifecycleCommand<C extends TaskLifecycleCommandIntent = TaskLifecycleCommandIntent> = C &
  NormalizedCommandEnvelope<ActorAxes>;
type Meta = {
  readonly eventId: string;
  readonly workspaceRevision: number;
  readonly occurredAt: string;
};
export type CreateReplayTaskCommand = NormalizedTaskLifecycleCommand<CreateReplayTaskIntent> & Meta;
export type StartExecutionCommand = NormalizedTaskLifecycleCommand<StartExecutionIntent> & Meta;
export type TransitionTaskCommand = NormalizedTaskLifecycleCommand<TransitionTaskIntent> & Meta;
export type SubmitExecutionCommand = NormalizedTaskLifecycleCommand<SubmitExecutionIntent> & Meta;
export type RecordReviewCommand = NormalizedTaskLifecycleCommand<RecordReviewIntent> & Meta;
export type RecordReviewConsentCommand = NormalizedTaskLifecycleCommand<RecordReviewConsentIntent> & Meta;
export type ReconcileCodeDocCommand = NormalizedTaskLifecycleCommand<ReconcileCodeDocIntent> & Meta;
export type CompleteTaskCommand = NormalizedTaskLifecycleCommand<CompleteTaskIntent> & Meta;
export type TaskLifecycleCommand =
  | CreateReplayTaskCommand
  | StartExecutionCommand
  | TransitionTaskCommand
  | SubmitExecutionCommand
  | RecordReviewCommand
  | RecordReviewConsentCommand
  | ReconcileCodeDocCommand
  | CompleteTaskCommand;
export interface CreateReplayTaskProof {
  readonly taskIdUnique: true;
  readonly actorBinding: ActorAxes;
}
export interface StartExecutionProof {
  readonly actorBinding: ActorAxes;
  readonly reservation: {
    readonly taskId: string;
    readonly executionId: string;
    readonly expiresAt: string;
    readonly ttlMs: number;
    readonly previousHolder: LeaseHolder | null;
    readonly reason: LeaseChangeReason;
    readonly version: number;
  };
}
export type TransitionTaskProof = Readonly<Record<never, never>>;
export interface SubmitExecutionProof {
  readonly actorBinding: ActorAxes;
  readonly leaseVersion: number;
  readonly sessionDisposition: "complete" | "partial" | "unavailable";
}
export interface ReviewProof {
  readonly actorBinding: ActorAxes;
  readonly capability: "execution-review@v1";
  readonly capabilityRef: string;
}
export interface ReviewConsentProof {
  readonly actorBinding: ActorAxes;
  readonly capability: "execution-consent@v1";
  readonly capabilityRef: string;
}
export interface CodeDocProof {
  readonly actorBinding: ActorAxes;
  readonly capability: "code-doc-reconcile@v1";
  readonly capabilityRef: string;
}
export interface CompleteTaskProof {
  readonly capability: "task-complete@v1";
  readonly capabilityRef: string;
  readonly actorRole: "owner" | "commander";
  readonly noActiveLease: true;
  readonly gateReceipts: readonly {
    readonly gateId: string;
    readonly receiptRef: string;
    readonly result: "pass";
    readonly executionId: string;
    readonly commitSha: string;
    readonly iteration: number;
  }[];
}
export type ProofFor<C extends TaskLifecycleCommand> = C extends CreateReplayTaskCommand
  ? CreateReplayTaskProof
  : C extends StartExecutionCommand
    ? StartExecutionProof
    : C extends TransitionTaskCommand
      ? TransitionTaskProof
      : C extends SubmitExecutionCommand
        ? SubmitExecutionProof
        : C extends RecordReviewCommand
          ? ReviewProof
          : C extends RecordReviewConsentCommand
            ? ReviewConsentProof
            : C extends ReconcileCodeDocCommand
              ? CodeDocProof
              : C extends CompleteTaskCommand
                ? CompleteTaskProof
                : never;
export interface TransitionResult {
  readonly snapshot: TaskLifecycleSnapshot;
  readonly event: TaskEventV1;
}
export interface Transition {
  readonly id: string;
  readonly commandType: TaskLifecycleCommand["type"];
  readonly from: string;
  readonly proof: readonly string[];
  readonly eventType: TaskEventType;
  readonly matches: (command: TaskLifecycleCommand, snapshot: TaskLifecycleSnapshot) => boolean;
  readonly validate: (
    snapshot: TaskLifecycleSnapshot,
    command: TaskLifecycleCommand,
    proof: unknown,
  ) => readonly ContractValidationIssue[];
  readonly reduce: (snapshot: TaskLifecycleSnapshot, command: TaskLifecycleCommand, proof: unknown) => TransitionResult;
}
