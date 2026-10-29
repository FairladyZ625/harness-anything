import type { TaskAssignment, TaskClaimant } from "./task-assignment.ts";
import { EXECUTION_V1_SCHEMA, LEASE_V1_SCHEMA } from "./execution.ts";
import type { ExecutionDeliveryBaseline, LeaseHolder, LeaseV1, ProjectedExecution, SubmissionV1 } from "./execution.ts";
import { REVIEW_CONSENT_V1_SCHEMA, REVIEW_V1_SCHEMA } from "./review.ts";
import type {
  ReviewConsentV1,
  ReviewDispositionV1,
  ReviewFindingV1,
  ReviewResponseDisposition,
  ReviewV1,
  ReviewVerdict,
  TaskReviewResponseV1,
} from "./review.ts";
import type { CompletionGateWitnessV1 } from "./completion-gate-witness.ts";
import type { CoverageRelation } from "./decision-coverage.ts";
import { TASK_V2_SCHEMA } from "./task.ts";
import type { ActorAxes, ContractValidationIssue, TaskClass, TaskV2 } from "./task.ts";
import { TASK_EDGE_TAKEN_SCHEMA, TASK_GRAPH_V1_SCHEMA } from "./task-graph.ts";
import type { TaskEdgeTaken, TaskGraphV1 } from "./task-graph.ts";
import type { NormalizedCommandEnvelope } from "./write-chain.contract.ts";
import type { LeaseChangeReason, TaskEventV1 } from "./task-lifecycle-event.ts";
import type { DomainStatus } from "./lifecycle-status.ts";
import type { FactStillHoldsAttestation } from "./fact-retirement-readiness.ts";
import type { CloseoutGate } from "./settings-closeout.ts";
import type { CompletionDeliveryStatus } from "./closeout-readiness.ts";
import type { ReviewFindingDisposition } from "./review-settlement.ts";
import type { ReviewFindingTriageV1 } from "./review-settlement.ts";

// Shared public contract shapes and internal transition protocol.
/** The owner's forward adjudication on one cut, keyed (executionId, iteration): the corridor
 * record that re-arms the review verdict a lifted profile skipped. An amendment replaces the
 * submission but keeps both keys, so the corridor stance survives a cut replacement; a return
 * order starts a new iteration and the record stops matching the next cut. */
export interface ForwardedCutRecord {
  readonly executionId: string;
  readonly iteration: number;
}
export interface TaskLifecycleSnapshot {
  readonly revision: number;
  readonly task: TaskV2 | null;
  readonly executions: readonly ProjectedExecution[];
  readonly reviews: readonly ReviewV1[];
  readonly consents: readonly ReviewConsentV1[];
  readonly reviewResponses?: readonly TaskReviewResponseV1[];
  readonly reviewDispositions?: readonly ReviewDispositionV1[];
  /** Center-owned settlement inputs joined into read snapshots, never written to Task events. */
  readonly reviewFindingTriages?: readonly ReviewFindingTriageV1[];
  readonly gateWitnesses: readonly CompletionGateWitnessV1[];
  readonly edgesTaken: readonly TaskEdgeTaken[];
  readonly lease: LeaseV1 | null;
  readonly forwardedCuts?: readonly ForwardedCutRecord[];
  readonly decisionRelations?: readonly CoverageRelation[];
  readonly siblingResolution?: { readonly sourceTaskId: string; readonly rationale: string; readonly factRef: string };
}
export const TASK_LIFECYCLE_SCHEMA = Object.freeze({
  id: "task-lifecycle/v1",
  task: TASK_V2_SCHEMA,
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
export interface AssignTaskIntent extends Intent<"AssignTask"> {
  readonly assignment: TaskAssignment;
}
export type UnassignTaskIntent = Intent<"UnassignTask">;
export interface RetireCompletionGenerationIntent extends Intent<"RetireCompletionGeneration"> {
  readonly executionId: string;
  readonly sourceGeneration: 1 | 2;
}
export interface StartExecutionIntent extends Intent<"StartExecution"> {
  readonly executionId: string;
  readonly ttlMs?: number;
  readonly stackOn?: string;
}
export interface TransitionTaskIntent extends Intent<"TransitionTask"> {
  readonly status: DomainStatus;
  readonly reason: string;
  readonly force: boolean;
}
export interface SubmitExecutionIntent extends Intent<"SubmitExecution"> {
  readonly executionId: string;
  readonly submission: SubmissionV1;
  readonly amend?: true;
  readonly asOwner?: true;
}
export interface ReworkTaskIntent extends Intent<"ReworkTask"> {
  readonly executionId: string;
  readonly reviewId: string;
  readonly reason: string;
}
export interface RecordReviewIntent extends Intent<"RecordReview"> {
  readonly executionId: string;
  readonly reviewId: string;
  readonly verdict: ReviewVerdict;
  readonly reason: string;
  readonly evidenceChecked: readonly string[];
  readonly externalCompletionAnchor?: string;
  readonly noDispatchReason?: string;
  readonly noIndependentReview?: boolean;
  readonly noIndependentReviewReason?: string;
  readonly commitSha: string | null;
  readonly iteration: number;
  readonly contentDigest: `sha256:${string}`;
  readonly submissionDigest: `sha256:${string}`;
  readonly findings?: readonly ReviewFindingV1[];
  readonly resolutions?: readonly {
    readonly reviewId: string;
    readonly findingId: string;
    readonly resolution: "upheld" | "withdrawn";
  }[];
}
export interface RespondReviewIntent extends Intent<"RespondReview"> {
  readonly executionId: string;
  readonly responses: readonly {
    readonly reviewId: string;
    readonly findingId: string;
    readonly disposition: ReviewResponseDisposition;
    readonly rationale: string;
  }[];
}
export interface RecordReviewConsentIntent extends Intent<"RecordReviewConsent"> {
  readonly executionId: string;
  readonly reviewId: string;
  readonly consentId: string;
  readonly reviewDigest: `sha256:${string}`;
  readonly contentDigest: `sha256:${string}`;
  readonly disposedReviewIds?: readonly string[];
  readonly rationale?: string;
  readonly findingId?: string;
  readonly findingDisposition?: ReviewFindingDisposition;
}
export interface CompleteTaskIntent extends Intent<"CompleteTask"> {
  readonly executionId: string;
  readonly resolution?: { readonly resolvedByTaskId: string; readonly rationale: string; readonly factRef: string };
  readonly factRetirementAttestations?: readonly FactStillHoldsAttestation[];
}
export type TaskLifecycleCommandIntent =
  | RetireCompletionGenerationIntent
  | CreateReplayTaskIntent
  | AssignTaskIntent
  | UnassignTaskIntent
  | StartExecutionIntent
  | TransitionTaskIntent
  | SubmitExecutionIntent
  | ReworkTaskIntent
  | RecordReviewIntent
  | RespondReviewIntent
  | RecordReviewConsentIntent
  | CompleteTaskIntent;
export type NormalizedTaskLifecycleCommand<C extends TaskLifecycleCommandIntent = TaskLifecycleCommandIntent> = C &
  NormalizedCommandEnvelope<ActorAxes>;
type Meta = {
  readonly eventId: string;
  readonly workspaceRevision: number;
  readonly occurredAt: string;
};
export type RetireCompletionGenerationCommand = NormalizedTaskLifecycleCommand<RetireCompletionGenerationIntent> & Meta;
export type CreateReplayTaskCommand = NormalizedTaskLifecycleCommand<CreateReplayTaskIntent> & Meta;
export type AssignTaskCommand = NormalizedTaskLifecycleCommand<AssignTaskIntent> & Meta;
export type UnassignTaskCommand = NormalizedTaskLifecycleCommand<UnassignTaskIntent> & Meta;
export type StartExecutionCommand = NormalizedTaskLifecycleCommand<StartExecutionIntent> & Meta;
export type TransitionTaskCommand = NormalizedTaskLifecycleCommand<TransitionTaskIntent> & Meta;
export type SubmitExecutionCommand = NormalizedTaskLifecycleCommand<SubmitExecutionIntent> & Meta;
export type ReworkTaskCommand = NormalizedTaskLifecycleCommand<ReworkTaskIntent> & Meta;
export type RecordReviewCommand = NormalizedTaskLifecycleCommand<RecordReviewIntent> & Meta;
export type RespondReviewCommand = NormalizedTaskLifecycleCommand<RespondReviewIntent> & Meta;
export type RecordReviewConsentCommand = NormalizedTaskLifecycleCommand<RecordReviewConsentIntent> & Meta;
export type CompleteTaskCommand = NormalizedTaskLifecycleCommand<CompleteTaskIntent> & Meta;
export type TaskLifecycleCommand =
  | RetireCompletionGenerationCommand
  | CreateReplayTaskCommand
  | AssignTaskCommand
  | UnassignTaskCommand
  | StartExecutionCommand
  | TransitionTaskCommand
  | SubmitExecutionCommand
  | ReworkTaskCommand
  | RecordReviewCommand
  | RespondReviewCommand
  | RecordReviewConsentCommand
  | CompleteTaskCommand;
export interface CreateReplayTaskProof {
  readonly taskIdUnique: true;
  readonly actorBinding: ActorAxes;
}
export interface StartExecutionProof {
  readonly claimant?: TaskClaimant;
  readonly actorBinding: ActorAxes;
  readonly deliveryBaseline: ExecutionDeliveryBaseline;
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
  readonly leaseVersion: number | null;
  readonly sessionDisposition: "complete" | "partial" | "unavailable";
}
export interface ReworkTaskProof {
  readonly actorBinding: ActorAxes;
  readonly capability: "task-rework@v1";
  readonly capabilityRef: string;
  /** The effective repository budget at this owner write; the transition only accepts exhaustion. */
  readonly reworkBudget: number;
}
export interface ReviewProof {
  readonly actorBinding: ActorAxes;
  readonly capability: "execution-review@v1";
  readonly capabilityRef: string;
  /**
   * The effective repository rework budget at this write: a changes_requested verdict below it
   * reopens the implementation iteration in the same transition; at or beyond it the verdict only
   * records and the cut awaits the owner.
   */
  readonly reworkBudget: number;
}
export interface ReviewResponseProof {
  readonly actorBinding: ActorAxes;
  readonly capability: "execution-review-response@v1";
  readonly capabilityRef: string;
}
export interface ReviewConsentProof {
  readonly actorBinding: ActorAxes;
  readonly capability: "execution-consent@v1";
  readonly capabilityRef: string;
  /** Center-owned triage journal records used to admit one owner ruling for a currently escalated finding. */
  readonly reviewFindingTriages?: readonly ReviewFindingTriageV1[];
}
export interface CompleteTaskProof {
  readonly capability: "task-complete@v1";
  readonly capabilityRef: string;
  readonly actorRole: "owner" | "commander";
  readonly noActiveLease: true;
  readonly closeoutGates: Readonly<Record<CloseoutGate, boolean>>;
  readonly delivery?: CompletionDeliveryStatus;
  readonly gateReceipts: readonly {
    readonly gateId: string;
    readonly receiptRef: string;
    readonly result: "pass";
    readonly executionId: string;
    readonly commitSha: string | null;
    readonly iteration: number;
  }[];
  readonly siblingResolution?: { readonly sourceTaskId: string; readonly sourceDone: true; readonly factRef: string };
}
export type ProofFor<C extends TaskLifecycleCommand> = C extends CreateReplayTaskCommand
  ? CreateReplayTaskProof
  : C extends AssignTaskCommand | UnassignTaskCommand
    ? TransitionTaskProof
    : C extends StartExecutionCommand
      ? StartExecutionProof
      : C extends TransitionTaskCommand | RetireCompletionGenerationCommand
        ? TransitionTaskProof
        : C extends SubmitExecutionCommand
          ? SubmitExecutionProof
          : C extends RecordReviewCommand
            ? ReviewProof
            : C extends RespondReviewCommand
              ? ReviewResponseProof
              : C extends ReworkTaskCommand
                ? ReworkTaskProof
                : C extends RecordReviewCommand
                  ? ReviewProof
                  : C extends RecordReviewConsentCommand
                    ? ReviewConsentProof
                    : C extends CompleteTaskCommand
                      ? CompleteTaskProof
                      : never;
export interface TransitionResult {
  readonly snapshot: TaskLifecycleSnapshot;
  readonly event: TaskEventV1;
}
export interface Transition {
  readonly offline?: true;
  readonly actionId: string;
  readonly matches: (command: TaskLifecycleCommand, snapshot: TaskLifecycleSnapshot) => boolean;
  readonly validate: (
    snapshot: TaskLifecycleSnapshot,
    command: TaskLifecycleCommand,
    proof: unknown,
  ) => readonly ContractValidationIssue[];
  readonly reduce: (snapshot: TaskLifecycleSnapshot, command: TaskLifecycleCommand, proof: unknown) => TransitionResult;
}
