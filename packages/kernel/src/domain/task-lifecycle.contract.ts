import { EXECUTION_V1_SCHEMA, isNativeCommitSha, LEASE_V1_SCHEMA, validateExecutionV1, validateSubmissionV1 } from "./execution.ts";
import type { ExecutionV1, LeaseV1 } from "./execution.ts";
import { REVIEW_V1_SCHEMA, validateReviewV1 } from "./review.ts";
import type { ReviewV1 } from "./review.ts";
import { appendWriteTarget, canonicalizeContractValue, freezeValidatedWritePlan, hasOnlyFields, isFrozenWritePlan, isNonEmptyString, isRecord, TASK_V1_SCHEMA, validateActorAxes, validateTaskV1, validateWritePlanShape } from "./task.ts";
import type { ActorAxes, ContractValidationIssue, FrozenWritePlan, TaskV1, WritePlan, WriteTarget } from "./task.ts";
import { TASK_EDGE_TAKEN_SCHEMA, TASK_GRAPH_V1_SCHEMA, validateTaskGraph } from "./task-graph.ts";
import type { TaskEdgeTaken, TaskGraphV1 } from "./task-graph.ts";

export const taskEventTypes = ["task_created", "execution_started", "execution_submitted", "review_recorded", "task_completed"] as const;
export type TaskEventType = (typeof taskEventTypes)[number];

interface TaskEventEnvelope<T extends TaskEventType, P> { readonly schema: "task-event/v1"; readonly eventId: string; readonly workspaceRevision: number; readonly opId: string; readonly taskId: string; readonly type: T; readonly actor: ActorAxes; readonly occurredAt: string; readonly payload: P }
export type TaskCreatedEvent = TaskEventEnvelope<"task_created", { readonly task: TaskV1 }>;
export type ExecutionStartedEvent = TaskEventEnvelope<"execution_started", { readonly task: TaskV1; readonly execution: ExecutionV1 }>;
export type ExecutionSubmittedEvent = TaskEventEnvelope<"execution_submitted", { readonly task: TaskV1; readonly execution: ExecutionV1; readonly edge: TaskEdgeTaken }>;
export type ReviewRecordedEvent = TaskEventEnvelope<"review_recorded", { readonly task: TaskV1; readonly execution: ExecutionV1; readonly review: ReviewV1; readonly edge?: TaskEdgeTaken }>;
export type TaskCompletedEvent = TaskEventEnvelope<"task_completed", { readonly task: TaskV1; readonly execution: ExecutionV1 }>;
export type TaskEventV1 = TaskCreatedEvent | ExecutionStartedEvent | ExecutionSubmittedEvent | ReviewRecordedEvent | TaskCompletedEvent;

export interface TaskLifecycleSnapshot { readonly revision: number; readonly task: TaskV1 | null; readonly executions: readonly ExecutionV1[]; readonly reviews: readonly ReviewV1[]; readonly edgesTaken: readonly TaskEdgeTaken[]; readonly lease: LeaseV1 | null }
interface CommandMeta<T extends string> { readonly type: T; readonly taskId: string; readonly actor: ActorAxes; readonly opId: string; readonly eventId: string; readonly workspaceRevision: number; readonly occurredAt: string }
export interface CreateReplayTaskCommand extends CommandMeta<"CreateReplayTask"> { readonly title: string; readonly graph: TaskGraphV1; readonly completionGateIds: readonly string[] }
export interface StartExecutionCommand extends CommandMeta<"StartExecution"> { readonly executionId: string }
export interface SubmitExecutionCommand extends CommandMeta<"SubmitExecution"> { readonly executionId: string; readonly submission: import("./execution.ts").SubmissionV1 }
export interface RecordReviewCommand extends CommandMeta<"RecordReview"> { readonly executionId: string; readonly reviewId: string; readonly kind: import("./review.ts").ReviewKind; readonly verdict: import("./review.ts").ReviewVerdict; readonly actorRole: import("./review.ts").ReviewActorRole; readonly reason: string; readonly evidenceChecked: readonly string[]; readonly commitSha: string; readonly iteration: number; readonly archiveWarningsAcknowledged: boolean }
export interface CompleteTaskCommand extends CommandMeta<"CompleteTask"> { readonly executionId: string }
export type TaskLifecycleCommand = CreateReplayTaskCommand | StartExecutionCommand | SubmitExecutionCommand | RecordReviewCommand | CompleteTaskCommand;

export interface CreateReplayTaskProof { readonly taskIdUnique: true; readonly actorBinding: ActorAxes }
export interface StartExecutionProof { readonly actorBinding: ActorAxes; readonly expectedRevision: number; readonly reservation: { readonly taskId: string; readonly executionId: string; readonly credentialHash: string; readonly expiresAt: string; readonly version: number } }
export interface SubmitExecutionProof { readonly expectedRevision: number; readonly credentialHash: string; readonly sessionDisposition: "complete" | "partial" | "unavailable" }
export interface ReviewProof { readonly expectedRevision: number; readonly actorBinding: ActorAxes; readonly capability: "anti-entropy@v1" | "acceptance-review@v1"; readonly capabilityRef: string; readonly archiveWarningsPresent: boolean }
export interface CompleteTaskProof { readonly expectedRevision: number; readonly capability: "task-complete@v1"; readonly capabilityRef: string; readonly actorRole: "owner" | "commander"; readonly noActiveLease: true; readonly gateReceipts: readonly { readonly gateId: string; readonly result: "pass"; readonly executionId: string; readonly commitSha: string; readonly iteration: number }[] }
export type ProofFor<C extends TaskLifecycleCommand> =
  C extends CreateReplayTaskCommand ? CreateReplayTaskProof :
  C extends StartExecutionCommand ? StartExecutionProof :
  C extends SubmitExecutionCommand ? SubmitExecutionProof :
  C extends RecordReviewCommand ? ReviewProof :
  C extends CompleteTaskCommand ? CompleteTaskProof : never;

export type TaskLifecycleErrorCode = "invalid_schema" | "invalid_transition" | "invalid_proof" | "invalid_graph" | "manual_intervention_required" | "frozen_write_plan";
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
export interface TransitionResult { readonly snapshot: TaskLifecycleSnapshot; readonly event: TaskEventV1 }
interface TransitionDefinition {
  readonly id: string; readonly commandType: TaskLifecycleCommand["type"]; readonly from: string; readonly proof: readonly string[]; readonly eventType: TaskEventType;
  readonly matches: (command: TaskLifecycleCommand) => boolean;
  readonly validate: (snapshot: TaskLifecycleSnapshot, command: TaskLifecycleCommand, proof: unknown) => readonly ContractValidationIssue[];
  readonly reduce: (snapshot: TaskLifecycleSnapshot, command: TaskLifecycleCommand, proof: unknown) => TransitionResult;
}

export function emptyTaskLifecycleSnapshot(revision = 0): TaskLifecycleSnapshot {
  return { revision, task: null, executions: [], reviews: [], edgesTaken: [], lease: null };
}

function sameActor(left: ActorAxes, right: ActorAxes): boolean {
  return left.principal.personId === right.principal.personId
    && left.executor?.kind === right.executor?.kind && left.executor?.id === right.executor?.id;
}

function envelope<C extends TaskLifecycleCommand, E extends TaskEventV1>(command: C, type: E["type"], payload: E["payload"]): E {
  return { schema: "task-event/v1", eventId: command.eventId, workspaceRevision: command.workspaceRevision, opId: command.opId, taskId: command.taskId, type, actor: command.actor, occurredAt: command.occurredAt, payload } as E;
}

const createReplayTaskTransition: TransitionDefinition = {
  id: "create_replay_task", commandType: "CreateReplayTask", from: "missing",
  proof: ["taskIdUnique", "actorBinding", "validGraph"], eventType: "task_created",
  matches: (command) => command.type === "CreateReplayTask",
  validate: (snapshot, rawCommand, rawProof) => {
    const command = rawCommand as CreateReplayTaskCommand;
    const proof = rawProof as Partial<CreateReplayTaskProof>;
    const issues: ContractValidationIssue[] = [];
    if (snapshot.task !== null) issues.push({ code: "invalid_transition", message: "CreateReplayTask requires a missing aggregate" });
    if (command.workspaceRevision !== snapshot.revision + 1) issues.push({ code: "invalid_transition", message: "workspace revision must advance by one" });
    if (!isNonEmptyString(command.taskId) || !isNonEmptyString(command.title) || !Array.isArray(command.completionGateIds)) issues.push({ code: "invalid_schema", message: "create command fields are invalid" });
    if (proof.taskIdUnique !== true || proof.actorBinding === undefined || !sameActor(command.actor, proof.actorBinding)) issues.push({ code: "invalid_proof", message: "task identity and actor binding proof are required" });
    issues.push(...validateTaskGraph(command.graph));
    return issues;
  },
  reduce: (snapshot, rawCommand) => {
    const command = rawCommand as CreateReplayTaskCommand;
    const task: TaskV1 = { schema: "task/v1", taskId: command.taskId, title: command.title, status: "planned", graph: command.graph, currentNode: "implementation", iteration: 0, createdBy: command.actor, completionGateIds: command.completionGateIds };
    const event = envelope<CreateReplayTaskCommand, TaskCreatedEvent>(command, "task_created", { task });
    return { snapshot: { ...snapshot, revision: command.workspaceRevision, task }, event };
  }
};

function revisionIssues(snapshot: TaskLifecycleSnapshot, command: TaskLifecycleCommand, expectedRevision: unknown): ContractValidationIssue[] {
  return expectedRevision === snapshot.revision && command.workspaceRevision === snapshot.revision + 1
    ? []
    : [{ code: "invalid_proof", message: "expected revision and next workspace revision must match the snapshot" }];
}

const startExecutionTransition: TransitionDefinition = {
  id: "start_execution", commandType: "StartExecution", from: "planned|active/implementation",
  proof: ["actorBinding", "reservation", "expectedRevision"], eventType: "execution_started",
  matches: (command) => command.type === "StartExecution",
  validate: (snapshot, rawCommand, rawProof) => {
    const command = rawCommand as StartExecutionCommand;
    const proof = rawProof as Partial<StartExecutionProof>;
    const issues = revisionIssues(snapshot, command, proof.expectedRevision);
    const task = snapshot.task;
    if (task === null || !["planned", "active"].includes(task.status) || task.currentNode !== "implementation") issues.push({ code: "invalid_transition", message: "StartExecution requires planned or active implementation" });
    if (snapshot.lease !== null || snapshot.executions.some((execution) => execution.iteration === task?.iteration && execution.state === "active")) issues.push({ code: "invalid_transition", message: "the current round already has an active execution or lease" });
    if (!isNonEmptyString(command.executionId) || snapshot.executions.some((execution) => execution.executionId === command.executionId)) issues.push({ code: "invalid_transition", message: "execution identity must be new" });
    if (proof.actorBinding === undefined || !sameActor(command.actor, proof.actorBinding)) issues.push({ code: "invalid_proof", message: "start actor binding does not match" });
    const reservation = proof.reservation;
    if (reservation === undefined || reservation.taskId !== command.taskId || reservation.executionId !== command.executionId
      || !isNonEmptyString(reservation.credentialHash) || !isNonEmptyString(reservation.expiresAt)
      || !Number.isInteger(reservation.version) || (reservation.version ?? -1) < 0) issues.push({ code: "invalid_proof", message: "active reservation CAS proof is required" });
    return issues;
  },
  reduce: (snapshot, rawCommand, rawProof) => {
    const command = rawCommand as StartExecutionCommand;
    const proof = rawProof as StartExecutionProof;
    const task = { ...snapshot.task as TaskV1, status: "active" as const };
    const execution: ExecutionV1 = { schema: "execution/v1", executionId: command.executionId, taskId: command.taskId, nodeId: "implementation", iteration: task.iteration, state: "active", actor: command.actor, claimedAt: command.occurredAt, submittedAt: null, closedAt: null, submission: null };
    const lease: LeaseV1 = { schema: "lease/v1", taskId: command.taskId, executionId: command.executionId, actor: command.actor, credentialHash: proof.reservation.credentialHash, phase: "active", expiresAt: proof.reservation.expiresAt, version: proof.reservation.version };
    const event = envelope<StartExecutionCommand, ExecutionStartedEvent>(command, "execution_started", { task, execution });
    return { snapshot: { ...snapshot, revision: command.workspaceRevision, task, executions: [...snapshot.executions, execution], lease }, event };
  }
};

function replaceExecution(executions: readonly ExecutionV1[], replacement: ExecutionV1): readonly ExecutionV1[] {
  return executions.map((execution) => execution.executionId === replacement.executionId ? replacement : execution);
}

function takeEdge(task: TaskV1, trigger: TaskEdgeTaken["on"], reason: string, commitSha: string, iteration: number): TaskEdgeTaken {
  const definition = task.graph.edges.find((edge) => edge.on === trigger);
  if (definition === undefined) throw new TaskLifecycleContractError("invalid_graph", [{ code: "invalid_graph_shape", message: `graph has no ${trigger} edge` }]);
  return { edgeId: definition.id, from: definition.from, to: definition.to, on: definition.on, actorRole: definition.actorRole, reason, commitSha, iteration };
}

function isSelfReview(executionActor: ActorAxes, reviewer: ActorAxes): boolean {
  return executionActor.executor === null || reviewer.executor === null
    ? executionActor.executor === null && reviewer.executor === null && executionActor.principal.personId === reviewer.principal.personId
    : executionActor.executor.id === reviewer.executor.id;
}

function currentSubmittedExecution(snapshot: TaskLifecycleSnapshot, command: RecordReviewCommand): ExecutionV1 | undefined {
  return snapshot.executions.find((execution) => execution.executionId === command.executionId
    && execution.iteration === snapshot.task?.iteration && execution.state === "submitted");
}

function reviewProofIssues(snapshot: TaskLifecycleSnapshot, command: RecordReviewCommand, proof: Partial<ReviewProof>, capability: ReviewProof["capability"]): ContractValidationIssue[] {
  const issues = revisionIssues(snapshot, command, proof.expectedRevision);
  const execution = currentSubmittedExecution(snapshot, command);
  if (execution === undefined || execution.submission === null) issues.push({ code: "invalid_transition", message: "review requires the current submitted execution" });
  else {
    if (command.commitSha !== execution.submission.commitSha) issues.push({ code: "invalid_proof", message: "review commit SHA is stale" });
    if (command.iteration !== execution.iteration || command.iteration !== snapshot.task?.iteration) issues.push({ code: "invalid_proof", message: "review iteration is stale" });
    if (isSelfReview(execution.actor, command.actor)) issues.push({ code: "invalid_proof", message: "the implementation executor cannot review itself" });
  }
  if (proof.actorBinding === undefined || !sameActor(command.actor, proof.actorBinding) || proof.capability !== capability || !isNonEmptyString(proof.capabilityRef)) issues.push({ code: "invalid_proof", message: `${capability} actor binding is required` });
  if (!isNonEmptyString(command.reviewId) || !isNonEmptyString(command.reason) || !Array.isArray(command.evidenceChecked)) issues.push({ code: "invalid_schema", message: "review identity, reason, and evidence are required" });
  return issues;
}

function reviewFrom(command: RecordReviewCommand, proof: ReviewProof): ReviewV1 {
  return { schema: "review/v1", reviewId: command.reviewId, taskId: command.taskId, executionId: command.executionId, kind: command.kind, verdict: command.verdict, actor: command.actor, actorRole: command.actorRole, capabilityRef: proof.capabilityRef, reason: command.reason, evidenceChecked: command.evidenceChecked, commitSha: command.commitSha, iteration: command.iteration as 0 | 1, archiveWarningsAcknowledged: command.archiveWarningsAcknowledged, reviewedAt: command.occurredAt };
}

const submitExecutionTransition: TransitionDefinition = {
  id: "submit_execution", commandType: "SubmitExecution", from: "active/implementation",
  proof: ["leaseCredential", "sessionDisposition", "submission", "expectedRevision"], eventType: "execution_submitted",
  matches: (command) => command.type === "SubmitExecution",
  validate: (snapshot, rawCommand, rawProof) => {
    const command = rawCommand as SubmitExecutionCommand;
    const proof = rawProof as Partial<SubmitExecutionProof>;
    const issues = revisionIssues(snapshot, command, proof.expectedRevision);
    const task = snapshot.task;
    const execution = snapshot.executions.find((candidate) => candidate.executionId === command.executionId);
    if (task === null || task.status !== "active" || task.currentNode !== "implementation" || execution?.state !== "active" || execution.iteration !== task.iteration) issues.push({ code: "invalid_transition", message: "SubmitExecution requires the active execution in the current implementation round" });
    const lease = snapshot.lease;
    if (lease === null || lease.phase !== "active" || lease.taskId !== command.taskId || lease.executionId !== command.executionId
      || !sameActor(lease.actor, command.actor) || proof.credentialHash !== lease.credentialHash) issues.push({ code: "invalid_proof", message: "the exact active lease holder and credential are required" });
    if (!["complete", "partial", "unavailable"].includes(String(proof.sessionDisposition))) issues.push({ code: "invalid_proof", message: "session disposition must be terminal" });
    issues.push(...validateSubmissionV1(command.submission));
    return issues;
  },
  reduce: (snapshot, rawCommand) => {
    const command = rawCommand as SubmitExecutionCommand;
    const current = snapshot.executions.find((execution) => execution.executionId === command.executionId) as ExecutionV1;
    const execution: ExecutionV1 = { ...current, state: "submitted", submittedAt: command.occurredAt, submission: command.submission };
    const task: TaskV1 = { ...snapshot.task as TaskV1, currentNode: "anti_entropy" };
    const edge = takeEdge(task, "submitted", command.submission.claim, command.submission.commitSha, task.iteration);
    const event = envelope<SubmitExecutionCommand, ExecutionSubmittedEvent>(command, "execution_submitted", { task, execution, edge });
    return { snapshot: { ...snapshot, revision: command.workspaceRevision, task, executions: replaceExecution(snapshot.executions, execution), edgesTaken: [...snapshot.edgesTaken, edge], lease: null }, event };
  }
};

const approveAntiEntropyTransition: TransitionDefinition = {
  id: "approve_anti_entropy", commandType: "RecordReview", from: "active/anti_entropy",
  proof: ["independentActor", "anti-entropy@v1", "sameCommit", "sameIteration", "reason", "expectedRevision"], eventType: "review_recorded",
  matches: (command) => command.type === "RecordReview" && command.kind === "anti_entropy" && command.verdict === "approved",
  validate: (snapshot, rawCommand, rawProof) => {
    const command = rawCommand as RecordReviewCommand;
    const proof = rawProof as Partial<ReviewProof>;
    const issues = reviewProofIssues(snapshot, command, proof, "anti-entropy@v1");
    if (snapshot.task?.status !== "active" || snapshot.task.currentNode !== "anti_entropy") issues.push({ code: "invalid_transition", message: "anti-entropy approval requires the anti_entropy node" });
    if (command.actorRole !== "anti_entropy") issues.push({ code: "invalid_proof", message: "anti-entropy approval requires the anti_entropy actor role" });
    return issues;
  },
  reduce: (snapshot, rawCommand, rawProof) => {
    const command = rawCommand as RecordReviewCommand;
    const proof = rawProof as ReviewProof;
    const execution = currentSubmittedExecution(snapshot, command) as ExecutionV1;
    const task: TaskV1 = { ...snapshot.task as TaskV1, status: "in_review", currentNode: "review" };
    const review = reviewFrom(command, proof);
    const edge = takeEdge(task, "approved", command.reason, command.commitSha, command.iteration);
    const event = envelope<RecordReviewCommand, ReviewRecordedEvent>(command, "review_recorded", { task, execution, review, edge });
    return { snapshot: { ...snapshot, revision: command.workspaceRevision, task, reviews: [...snapshot.reviews, review], edgesTaken: [...snapshot.edgesTaken, edge] }, event };
  }
};

const requestAntiEntropyChangesTransition: TransitionDefinition = {
  id: "request_anti_entropy_changes", commandType: "RecordReview", from: "active/anti_entropy/iteration<1",
  proof: ["independentActor", "anti-entropy@v1", "sameCommit", "sameIteration", "nonEmptyReason", "expectedRevision"], eventType: "review_recorded",
  matches: (command) => command.type === "RecordReview" && command.kind === "anti_entropy" && command.verdict === "changes_requested",
  validate: (snapshot, rawCommand, rawProof) => {
    const command = rawCommand as RecordReviewCommand;
    const proof = rawProof as Partial<ReviewProof>;
    const issues = reviewProofIssues(snapshot, command, proof, "anti-entropy@v1");
    if (snapshot.task?.status !== "active" || snapshot.task.currentNode !== "anti_entropy") issues.push({ code: "invalid_transition", message: "changes_requested requires the anti_entropy node" });
    if (command.actorRole !== "anti_entropy") issues.push({ code: "invalid_proof", message: "only the anti_entropy actor role can take the return edge" });
    if (snapshot.task !== null && snapshot.task.iteration >= snapshot.task.graph.maxIterations) issues.push({ code: "manual_intervention_required", message: "return budget exhausted; escalate for manual intervention" });
    return issues;
  },
  reduce: (snapshot, rawCommand, rawProof) => {
    const command = rawCommand as RecordReviewCommand;
    const proof = rawProof as ReviewProof;
    const current = currentSubmittedExecution(snapshot, command) as ExecutionV1;
    const execution: ExecutionV1 = { ...current, state: "changes_requested", closedAt: command.occurredAt };
    const task: TaskV1 = { ...snapshot.task as TaskV1, status: "active", currentNode: "implementation", iteration: 1 };
    const review = reviewFrom(command, proof);
    const edge = takeEdge(snapshot.task as TaskV1, "changes_requested", command.reason, command.commitSha, command.iteration);
    const event = envelope<RecordReviewCommand, ReviewRecordedEvent>(command, "review_recorded", { task, execution, review, edge });
    return { snapshot: { ...snapshot, revision: command.workspaceRevision, task, executions: replaceExecution(snapshot.executions, execution), reviews: [...snapshot.reviews, review], edgesTaken: [...snapshot.edgesTaken, edge], lease: null }, event };
  }
};

const dismissReviewTransition: TransitionDefinition = {
  id: "dismiss_review", commandType: "RecordReview", from: "corresponding review node",
  proof: ["independentActor", "roleCapability", "reason", "sameCommit", "sameIteration", "expectedRevision"], eventType: "review_recorded",
  matches: (command) => command.type === "RecordReview" && command.verdict === "dismissed",
  validate: (snapshot, rawCommand, rawProof) => {
    const command = rawCommand as RecordReviewCommand;
    const proof = rawProof as Partial<ReviewProof>;
    const capability = command.kind === "anti_entropy" ? "anti-entropy@v1" : "acceptance-review@v1";
    const issues = reviewProofIssues(snapshot, command, proof, capability);
    const atNode = command.kind === "anti_entropy"
      ? snapshot.task?.status === "active" && snapshot.task.currentNode === "anti_entropy"
      : snapshot.task?.status === "in_review" && snapshot.task.currentNode === "review";
    if (!atNode) issues.push({ code: "invalid_transition", message: "dismissed review must match the current review node" });
    if (command.actorRole !== command.kind) issues.push({ code: "invalid_proof", message: "dismissed review role must match review kind" });
    return issues;
  },
  reduce: (snapshot, rawCommand, rawProof) => {
    const command = rawCommand as RecordReviewCommand;
    const proof = rawProof as ReviewProof;
    const execution = currentSubmittedExecution(snapshot, command) as ExecutionV1;
    const task = snapshot.task as TaskV1;
    const review = reviewFrom(command, proof);
    const event = envelope<RecordReviewCommand, ReviewRecordedEvent>(command, "review_recorded", { task, execution, review });
    return { snapshot: { ...snapshot, revision: command.workspaceRevision, reviews: [...snapshot.reviews, review] }, event };
  }
};

const approveAcceptanceTransition: TransitionDefinition = {
  id: "approve_acceptance", commandType: "RecordReview", from: "in_review/review",
  proof: ["independentActor", "acceptance-review@v1", "sameCommit", "sameIteration", "archiveWarningAcknowledgement", "expectedRevision"], eventType: "review_recorded",
  matches: (command) => command.type === "RecordReview" && command.kind === "acceptance" && command.verdict === "approved",
  validate: (snapshot, rawCommand, rawProof) => {
    const command = rawCommand as RecordReviewCommand;
    const proof = rawProof as Partial<ReviewProof>;
    const issues = reviewProofIssues(snapshot, command, proof, "acceptance-review@v1");
    if (snapshot.task?.status !== "in_review" || snapshot.task.currentNode !== "review") issues.push({ code: "invalid_transition", message: "acceptance approval requires in_review/review" });
    if (command.actorRole !== "acceptance") issues.push({ code: "invalid_proof", message: "acceptance approval requires the acceptance actor role" });
    if (proof.archiveWarningsPresent === true && command.archiveWarningsAcknowledged !== true) issues.push({ code: "invalid_proof", message: "archive warnings require explicit acknowledgement" });
    return issues;
  },
  reduce: (snapshot, rawCommand, rawProof) => {
    const command = rawCommand as RecordReviewCommand;
    const proof = rawProof as ReviewProof;
    const execution = currentSubmittedExecution(snapshot, command) as ExecutionV1;
    const task = snapshot.task as TaskV1;
    const review = reviewFrom(command, proof);
    const event = envelope<RecordReviewCommand, ReviewRecordedEvent>(command, "review_recorded", { task, execution, review });
    return { snapshot: { ...snapshot, revision: command.workspaceRevision, reviews: [...snapshot.reviews, review] }, event };
  }
};

function sameRoundApprovedReviews(snapshot: TaskLifecycleSnapshot, execution: ExecutionV1): readonly ReviewV1[] {
  const commitSha = execution.submission?.commitSha;
  return snapshot.reviews.filter((review) => review.verdict === "approved" && review.executionId === execution.executionId
    && review.iteration === execution.iteration && review.commitSha === commitSha);
}

export function isReadyToComplete(snapshot: TaskLifecycleSnapshot): boolean {
  if (snapshot.task?.status !== "in_review" || snapshot.task.currentNode !== "review") return false;
  const execution = snapshot.executions.find((candidate) => candidate.iteration === snapshot.task?.iteration && candidate.state === "submitted");
  if (execution === undefined) return false;
  const approved = sameRoundApprovedReviews(snapshot, execution);
  return approved.some((review) => review.kind === "anti_entropy") && approved.some((review) => review.kind === "acceptance");
}

const completeTaskTransition: TransitionDefinition = {
  id: "complete_task", commandType: "CompleteTask", from: "in_review/review/ready-to-complete",
  proof: ["ownerOrCommander", "sameRoundApprovals", "gateReceipts", "noActiveLease", "expectedRevision"], eventType: "task_completed",
  matches: (command) => command.type === "CompleteTask",
  validate: (snapshot, rawCommand, rawProof) => {
    const command = rawCommand as CompleteTaskCommand;
    const proof = rawProof as Partial<CompleteTaskProof>;
    const issues = revisionIssues(snapshot, command, proof.expectedRevision);
    const task = snapshot.task;
    const execution = snapshot.executions.find((candidate) => candidate.executionId === command.executionId
      && candidate.iteration === task?.iteration && candidate.state === "submitted");
    if (task?.status !== "in_review" || task.currentNode !== "review" || execution === undefined || !isReadyToComplete(snapshot)) issues.push({ code: "invalid_transition", message: "CompleteTask requires both approved reviews on the current submitted execution" });
    if (snapshot.lease !== null || proof.noActiveLease !== true) issues.push({ code: "invalid_proof", message: "CompleteTask requires no active lease" });
    if (proof.capability !== "task-complete@v1" || !isNonEmptyString(proof.capabilityRef) || !["owner", "commander"].includes(String(proof.actorRole))) issues.push({ code: "invalid_proof", message: "owner or commander completion capability is required" });
    if (task !== null && execution !== undefined) {
      const receipts = proof.gateReceipts ?? [];
      const declared = new Set(task.completionGateIds);
      const received = new Set(receipts.map((receipt) => receipt.gateId));
      if (declared.size !== received.size || [...declared].some((gateId) => !received.has(gateId))
        || receipts.some((receipt) => receipt.result !== "pass" || receipt.executionId !== execution.executionId
          || receipt.commitSha !== execution.submission?.commitSha || receipt.iteration !== execution.iteration)) issues.push({ code: "invalid_proof", message: "all declared gate receipts must pass on the same execution, commit, and iteration" });
    }
    return issues;
  },
  reduce: (snapshot, rawCommand) => {
    const command = rawCommand as CompleteTaskCommand;
    const current = snapshot.executions.find((execution) => execution.executionId === command.executionId) as ExecutionV1;
    const execution: ExecutionV1 = { ...current, state: "accepted", closedAt: command.occurredAt };
    const task: TaskV1 = { ...snapshot.task as TaskV1, status: "done" };
    const event = envelope<CompleteTaskCommand, TaskCompletedEvent>(command, "task_completed", { task, execution });
    return { snapshot: { ...snapshot, revision: command.workspaceRevision, task, executions: replaceExecution(snapshot.executions, execution) }, event };
  }
};

export const TASK_LIFECYCLE_TRANSITIONS: readonly TransitionDefinition[] = Object.freeze([
  createReplayTaskTransition,
  startExecutionTransition,
  submitExecutionTransition,
  approveAntiEntropyTransition,
  requestAntiEntropyChangesTransition,
  dismissReviewTransition,
  approveAcceptanceTransition,
  completeTaskTransition
]);

export function validateTransition<C extends TaskLifecycleCommand>(snapshot: TaskLifecycleSnapshot, command: C, proof: ProofFor<C>): readonly ContractValidationIssue[] {
  const transition = TASK_LIFECYCLE_TRANSITIONS.find((candidate) => candidate.matches(command));
  return transition === undefined
    ? [{ code: "invalid_transition", message: `no lifecycle transition accepts ${command.type}` }]
    : transition.validate(snapshot, command, proof);
}

function transitionErrorCode(issues: readonly ContractValidationIssue[]): TaskLifecycleErrorCode {
  return issues.some((issue) => issue.code === "manual_intervention_required") ? "manual_intervention_required"
    : issues.some((issue) => issue.code === "invalid_graph_shape" || issue.code === "invalid_node_set" || issue.code === "invalid_forward_path"
      || issue.code.startsWith("invalid_") && issue.code.includes("edge") || issue.code.startsWith("forward_")) ? "invalid_graph"
    : issues.some((issue) => issue.code === "invalid_proof") ? "invalid_proof" : "invalid_transition";
}

function previewTransition<C extends TaskLifecycleCommand>(snapshot: TaskLifecycleSnapshot, command: C, proof: ProofFor<C>): TransitionResult {
  const transition = TASK_LIFECYCLE_TRANSITIONS.find((candidate) => candidate.matches(command));
  if (transition === undefined) throw new TaskLifecycleContractError("invalid_transition", [{ code: "invalid_transition", message: `no lifecycle transition accepts ${command.type}` }]);
  const issues = transition.validate(snapshot, command, proof);
  if (issues.length > 0) throw new TaskLifecycleContractError(transitionErrorCode(issues), issues);
  return transition.reduce(snapshot, command, proof);
}

function assertTransitionResult(snapshot: TaskLifecycleSnapshot, command: TaskLifecycleCommand, proof: unknown, result: TransitionResult): void {
  const graphIssues = validateTaskGraph(result.snapshot.task?.graph ?? snapshot.task?.graph);
  if (graphIssues.length > 0) throw new TaskLifecycleContractError("invalid_graph", graphIssues);
  const addedEdges = result.snapshot.edgesTaken.slice(snapshot.edgesTaken.length);
  for (const edge of addedEdges) {
    if (!isNonEmptyString(edge.edgeId) || !isNonEmptyString(edge.reason) || !isNativeCommitSha(edge.commitSha)
      || !Number.isInteger(edge.iteration) || edge.iteration < 0 || edge.iteration > 1) {
      throw new TaskLifecycleContractError("invalid_graph", [{ code: "invalid_edge_evidence", message: "taken edge requires all seven audit fields" }]);
    }
    const expectedCommit = command.type === "SubmitExecution" ? command.submission.commitSha
      : command.type === "RecordReview" ? command.commitSha : undefined;
    const expectedIteration = command.type === "RecordReview" ? command.iteration : snapshot.task?.iteration;
    if (edge.commitSha !== expectedCommit || edge.iteration !== expectedIteration) {
      throw new TaskLifecycleContractError("invalid_proof", [{ code: "invalid_proof", message: "taken edge must match the current submission commit and iteration" }]);
    }
  }
  if (command.type === "RecordReview" && command.verdict === "changes_requested") {
    const reviewProof = proof as Partial<ReviewProof>;
    const changedExecution = result.snapshot.executions.find((execution) => execution.executionId === command.executionId);
    const edge = addedEdges[0];
    if (command.kind !== "anti_entropy" || command.actorRole !== "anti_entropy" || reviewProof.capability !== "anti-entropy@v1"
      || result.event.type !== "review_recorded" || edge?.on !== "changes_requested"
      || changedExecution?.state !== "changes_requested" || changedExecution.closedAt === null
      || result.snapshot.task?.status !== "active" || result.snapshot.task.currentNode !== "implementation"
      || result.snapshot.task.iteration !== (snapshot.task?.iteration ?? -1) + 1 || result.snapshot.lease !== null) {
      throw new TaskLifecycleContractError("invalid_graph", [{ code: "invalid_return_atomicity", message: "return Review, edge, Execution closure, Task activation, and lease release must be atomic" }]);
    }
  }
  if (command.type === "RecordReview" && command.kind === "anti_entropy" && command.verdict === "approved"
    && (result.snapshot.task?.status !== "in_review" || result.snapshot.task.currentNode !== "review"
      || result.snapshot.executions.find((execution) => execution.executionId === command.executionId)?.state !== "submitted")) {
    throw new TaskLifecycleContractError("invalid_graph", [{ code: "approve_completed_early", message: "anti-entropy approval can only enter acceptance review" }]);
  }
  if (command.type === "CompleteTask" && (result.snapshot.task?.status !== "done"
    || result.snapshot.executions.find((execution) => execution.executionId === command.executionId)?.state !== "accepted")) {
    throw new TaskLifecycleContractError("invalid_transition", [{ code: "invalid_transition", message: "CompleteTask alone marks the task and execution terminal" }]);
  }
}

export function assertAntiEntropyGraph<C extends TaskLifecycleCommand>(snapshot: TaskLifecycleSnapshot, command: C, proof: ProofFor<C>): void {
  assertTransitionResult(snapshot, command, proof, previewTransition(snapshot, command, proof));
}

export function applyTransition<C extends TaskLifecycleCommand>(snapshot: TaskLifecycleSnapshot, command: C, proof: ProofFor<C>): TransitionResult {
  const result = previewTransition(snapshot, command, proof);
  assertTransitionResult(snapshot, command, proof, result);
  return result;
}

export type TaskLifecycleCommandType = TaskLifecycleCommand["type"];
export type { FrozenWritePlan, WritePlan, WriteTarget } from "./task.ts";
export function validateWritePlan(plan: WritePlan<TaskLifecycleCommandType>): readonly ContractValidationIssue[] {
  return validateWritePlanShape(plan, TASK_LIFECYCLE_TRANSITIONS.map((transition) => transition.commandType));
}

export function freezeWritePlan<C extends TaskLifecycleCommandType>(plan: WritePlan<C>): FrozenWritePlan<C> {
  const issues = validateWritePlan(plan);
  if (issues.length > 0) throw new TaskLifecycleContractError("frozen_write_plan", issues);
  return freezeValidatedWritePlan(plan);
}

export function addWriteTarget<C extends TaskLifecycleCommandType>(plan: WritePlan<C> | FrozenWritePlan<C>, target: WriteTarget): WritePlan<C> {
  if (isFrozenWritePlan(plan)) {
    throw new TaskLifecycleContractError("frozen_write_plan", [{ code: "frozen_write_plan", message: "a frozen write plan cannot accept late targets" }]);
  }
  return appendWriteTarget(plan, target);
}

export const TASK_EVENT_V1_SCHEMA = Object.freeze({
  id: "task-event/v1",
  required: Object.freeze(["schema", "eventId", "workspaceRevision", "opId", "taskId", "type", "actor", "occurredAt", "payload"]),
  types: taskEventTypes
});

export const TASK_LIFECYCLE_SCHEMA = Object.freeze({
  id: "task-lifecycle/v1",
  task: TASK_V1_SCHEMA,
  execution: EXECUTION_V1_SCHEMA,
  lease: LEASE_V1_SCHEMA,
  review: REVIEW_V1_SCHEMA,
  graph: TASK_GRAPH_V1_SCHEMA,
  edgeTaken: TASK_EDGE_TAKEN_SCHEMA,
  event: TASK_EVENT_V1_SCHEMA
});

export function validateTaskEvent(value: unknown): readonly ContractValidationIssue[] {
  if (!isRecord(value) || !hasOnlyFields(value, TASK_EVENT_V1_SCHEMA.required)) {
    return [{ code: "invalid_event", message: "task-event/v1 fields are incomplete or unknown" }];
  }
  const issues: ContractValidationIssue[] = [];
  if (value.schema !== "task-event/v1") issues.push({ code: "invalid_schema", message: "event must use task-event/v1" });
  if (!isNonEmptyString(value.eventId) || !isNonEmptyString(value.opId) || !isNonEmptyString(value.taskId) || !isNonEmptyString(value.occurredAt)
    || typeof value.workspaceRevision !== "number" || !Number.isInteger(value.workspaceRevision) || value.workspaceRevision < 1
    || !(taskEventTypes as readonly unknown[]).includes(value.type)) issues.push({ code: "invalid_event", message: "event identity, revision, or type is invalid" });
  issues.push(...validateActorAxes(value.actor));
  if (!isRecord(value.payload)) issues.push({ code: "invalid_event_payload", message: "event payload must be an object" });
  else if (value.type === "task_created") {
    if (!hasOnlyFields(value.payload, ["task"])) issues.push({ code: "invalid_event_payload", message: "task_created payload must contain only task" });
    else issues.push(...validateTaskV1(value.payload.task));
  } else {
    const fields = value.type === "review_recorded" && Object.hasOwn(value.payload, "edge")
      ? ["task", "execution", "review", "edge"]
      : value.type === "review_recorded" ? ["task", "execution", "review"]
      : value.type === "execution_submitted" ? ["task", "execution", "edge"]
      : ["task", "execution"];
    if (!hasOnlyFields(value.payload, fields)) issues.push({ code: "invalid_event_payload", message: `${String(value.type)} payload fields are incomplete or unknown` });
    else {
      issues.push(...validateTaskV1(value.payload.task), ...validateExecutionV1(value.payload.execution));
      if (value.type === "review_recorded") issues.push(...validateReviewV1(value.payload.review));
      if ("edge" in value.payload) issues.push(...validateTakenEdge(value.payload.edge));
    }
  }
  if (isRecord(value.payload) && "task" in value.payload && isRecord(value.payload.task) && "graph" in value.payload.task) {
    issues.push(...validateTaskGraph(value.payload.task.graph));
  }
  if (isRecord(value.payload) && "task" in value.payload && isRecord(value.payload.task)
    && "taskId" in value.payload.task && value.payload.task.taskId !== value.taskId) issues.push({ code: "invalid_event_payload", message: "payload Task identity must match the envelope" });
  return issues;
}

function validateTakenEdge(value: unknown): readonly ContractValidationIssue[] {
  const fields = ["edgeId", "from", "to", "on", "actorRole", "reason", "commitSha", "iteration"];
  if (!isRecord(value) || !hasOnlyFields(value, fields) || !isNonEmptyString(value.edgeId) || !isNonEmptyString(value.reason)
    || !["implementation", "anti_entropy", "review"].includes(String(value.from)) || !["implementation", "anti_entropy", "review"].includes(String(value.to))
    || !["submitted", "approved", "changes_requested"].includes(String(value.on)) || !["executor", "anti_entropy"].includes(String(value.actorRole))
    || !isNativeCommitSha(value.commitSha) || !Number.isInteger(value.iteration) || typeof value.iteration !== "number" || value.iteration < 0 || value.iteration > 1) {
    return [{ code: "invalid_edge_evidence", message: "taken edge requires its seven audit fields" }];
  }
  return [];
}

export function serializeTaskEvent(value: TaskEventV1): string {
  const issues = validateTaskEvent(value);
  if (issues.length > 0) throw new TaskLifecycleContractError("invalid_schema", issues);
  return `${JSON.stringify(canonicalizeContractValue(value))}\n`;
}

function assertReplayEvent(snapshot: TaskLifecycleSnapshot, event: TaskEventV1, next: TaskLifecycleSnapshot): void {
  if (event.type === "execution_submitted" && (event.payload.edge.commitSha !== event.payload.execution.submission?.commitSha
    || event.payload.edge.iteration !== event.payload.execution.iteration || event.payload.edge.on !== "submitted")) {
    throw new TaskLifecycleContractError("invalid_graph", [{ code: "invalid_edge_evidence", message: "submitted edge must match the submitted execution" }]);
  }
  if (event.type === "review_recorded") {
    const { review, execution, edge, task } = event.payload;
    if (review.commitSha !== execution.submission?.commitSha || review.iteration !== execution.iteration) throw new TaskLifecycleContractError("invalid_proof", [{ code: "invalid_proof", message: "replayed Review is stale" }]);
    if (review.verdict === "changes_requested" && (review.kind !== "anti_entropy" || review.actorRole !== "anti_entropy"
      || edge?.on !== "changes_requested" || execution.state !== "changes_requested" || execution.closedAt === null
      || task.status !== "active" || task.currentNode !== "implementation" || task.iteration !== (snapshot.task?.iteration ?? -1) + 1 || next.lease !== null)) {
      throw new TaskLifecycleContractError("invalid_graph", [{ code: "invalid_return_atomicity", message: "replayed return event is incomplete" }]);
    }
    if (review.kind === "anti_entropy" && review.verdict === "approved"
      && (edge?.on !== "approved" || task.status !== "in_review" || task.currentNode !== "review" || execution.state !== "submitted")) {
      throw new TaskLifecycleContractError("invalid_graph", [{ code: "approve_completed_early", message: "replayed anti-entropy approval must enter acceptance review" }]);
    }
  }
  if (event.type === "task_completed" && (!isReadyToComplete(snapshot) || event.payload.task.status !== "done" || event.payload.execution.state !== "accepted")) {
    throw new TaskLifecycleContractError("invalid_transition", [{ code: "invalid_transition", message: "replayed completion requires both same-round approvals" }]);
  }
}

export function reduceTaskEvent(snapshot: TaskLifecycleSnapshot, event: TaskEventV1): TaskLifecycleSnapshot {
  const issues = validateTaskEvent(event);
  if (issues.length > 0) throw new TaskLifecycleContractError("invalid_schema", issues);
  if (event.workspaceRevision !== snapshot.revision + 1 || (event.type === "task_created" ? snapshot.task !== null : snapshot.task?.taskId !== event.taskId)) {
    throw new TaskLifecycleContractError("invalid_transition", [{ code: "invalid_transition", message: "event revision or aggregate identity is not replayable" }]);
  }
  let next: TaskLifecycleSnapshot;
  if (event.type === "task_created") next = { ...snapshot, revision: event.workspaceRevision, task: event.payload.task };
  else if (event.type === "execution_started") next = { ...snapshot, revision: event.workspaceRevision, task: event.payload.task, executions: [...snapshot.executions, event.payload.execution], lease: null };
  else if (event.type === "execution_submitted") next = { ...snapshot, revision: event.workspaceRevision, task: event.payload.task, executions: replaceExecution(snapshot.executions, event.payload.execution), edgesTaken: [...snapshot.edgesTaken, event.payload.edge], lease: null };
  else if (event.type === "review_recorded") next = {
    ...snapshot,
    revision: event.workspaceRevision,
    task: event.payload.task,
    executions: replaceExecution(snapshot.executions, event.payload.execution),
    reviews: [...snapshot.reviews, event.payload.review],
    edgesTaken: event.payload.edge === undefined ? snapshot.edgesTaken : [...snapshot.edgesTaken, event.payload.edge],
    lease: null
  };
  else next = { ...snapshot, revision: event.workspaceRevision, task: event.payload.task, executions: replaceExecution(snapshot.executions, event.payload.execution), lease: null };
  assertReplayEvent(snapshot, event, next);
  return next;
}

export const TASK_LIFECYCLE_COMMAND_CATALOG = Object.freeze(TASK_LIFECYCLE_TRANSITIONS.map((transition) => Object.freeze({
  id: transition.id,
  commandType: transition.commandType,
  from: transition.from,
  proof: transition.proof,
  eventType: transition.eventType
})));
export type TaskLifecycleCliCatalogEntry = (typeof TASK_LIFECYCLE_COMMAND_CATALOG)[number];

export const TASK_LIFECYCLE_PROJECTION_FIELDS = Object.freeze({
  task: TASK_V1_SCHEMA.required,
  execution: EXECUTION_V1_SCHEMA.required,
  review: REVIEW_V1_SCHEMA.required,
  edgeTaken: TASK_EDGE_TAKEN_SCHEMA.required
});

const taskLifecycleContract = Object.freeze({
  id: "task-lifecycle",
  phases: Object.freeze(["P4"]),
  commands: Object.freeze(TASK_LIFECYCLE_COMMAND_CATALOG.map((entry) => Object.freeze({ id: entry.id, phase: "P4" }))),
  gates: Object.freeze([]),
  guards: Object.freeze([]),
  schemas: Object.freeze([Object.freeze({
    id: "task-event/v1",
    schema: "packages/kernel/src/domain/task-lifecycle.contract.ts#TASK_LIFECYCLE_SCHEMA",
    parser: "packages/kernel/src/domain/task-lifecycle.contract.ts#validateTaskEvent",
    writer: "packages/kernel/src/domain/task-lifecycle.contract.ts#serializeTaskEvent",
    error: "packages/kernel/src/domain/task-lifecycle.contract.ts#TaskLifecycleContractError",
    negativeFixtures: Object.freeze(["tools/gates/test/fixtures/task-event-legacy-shape.json"])
  })])
});

export default taskLifecycleContract;
