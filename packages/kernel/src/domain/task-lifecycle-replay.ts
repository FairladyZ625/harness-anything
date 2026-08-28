import type { ExecutionV1, LeaseV1 } from "./execution.ts";
import { reviewDigest } from "./review.ts";
import { currentTaskForWrite, type ActorAxes, type ContractValidationIssue } from "./task.ts";
import { validateTaskGraph } from "./task-graph.ts";
import { isNonEmptyString } from "./write-chain.contract.ts";
import type { WriteSource } from "./write-chain.contract.ts";
import { stableStringify } from "../integrity/stable-hash.ts";
import { TaskLifecycleContractError, validateTaskEvent } from "./task-lifecycle-event.ts";
import type { ExecutionExecutorDeclaredEvent, TaskEventV1 } from "./task-lifecycle-event.ts";
import { isSamePerson } from "./actor-domain-services.ts";
import { codeDocRecordId, currentCodeDocRecord } from "./code-doc-witness.ts";
import type {
  ProofFor,
  TaskLifecycleCommand,
  TaskLifecycleSnapshot,
  TransitionResult,
} from "./task-lifecycle-contract-internal-types.ts";
import { validateTaskLifecycleCommandEnvelope } from "./task-lifecycle-contract-commands.ts";
import {
  canonicalGateReceipts,
  errorCode,
  execution,
  executionExecutorDeclarationCandidates,
  lifecycleContractIssue,
  replaceExecution,
  requiredGateWitnessCount,
} from "./task-lifecycle-contract-support.ts";
import { isReadyToComplete } from "./task-lifecycle-review-transitions.ts";
import { TASK_LIFECYCLE_TRANSITIONS } from "./task-lifecycle-transitions.ts";
import { explainStatusTransition } from "./lifecycle-status.ts";

// Transition application plus event replay and executor-declaration repair.
export function validateTransition<C extends TaskLifecycleCommand>(
  snapshot: TaskLifecycleSnapshot,
  command: C,
  proof: ProofFor<C>,
): readonly ContractValidationIssue[] {
  const envelopeIssues = validateTaskLifecycleCommandEnvelope(command);
  if (envelopeIssues.length) return envelopeIssues;
  const transition = TASK_LIFECYCLE_TRANSITIONS.find((value) => value.matches(command, snapshot));
  return transition
    ? transition.validate(snapshot, command, proof)
    : [lifecycleContractIssue("invalid_transition", `no lifecycle transition accepts ${command.type}`)];
}
export function applyTransition<C extends TaskLifecycleCommand>(
  snapshot: TaskLifecycleSnapshot,
  command: C,
  proof: ProofFor<C>,
): TransitionResult {
  const normalized = validateTaskLifecycleCommandEnvelope(command);
  if (normalized.length) throw new TaskLifecycleContractError("invalid_schema", normalized);
  const transition = TASK_LIFECYCLE_TRANSITIONS.find((value) => value.matches(command, snapshot));
  if (!transition)
    throw new TaskLifecycleContractError("invalid_transition", [
      lifecycleContractIssue("invalid_transition", `no lifecycle transition accepts ${command.type}`),
    ]);
  const issues = transition.validate(snapshot, command, proof);
  if (issues.length) throw new TaskLifecycleContractError(errorCode(issues), issues);
  const result = transition.reduce(snapshot, command, proof);
  assertAtomic(snapshot, command, result);
  return result;
}
function assertAtomic(snapshot: TaskLifecycleSnapshot, command: TaskLifecycleCommand, result: TransitionResult): void {
  const graphIssues = validateTaskGraph(result.snapshot.task?.graph ?? snapshot.task?.graph),
    changed =
      "executionId" in command
        ? result.snapshot.executions.find((value) => value.executionId === command.executionId)
        : undefined;
  if (graphIssues.length) throw new TaskLifecycleContractError("invalid_graph", graphIssues);
  if (
    command.type === "TransitionTask" &&
    (result.event.type !== "task_transitioned" ||
      result.snapshot.task?.status !== command.status ||
      result.snapshot.lease !== snapshot.lease)
  )
    throw new TaskLifecycleContractError("invalid_transition", [
      lifecycleContractIssue(
        "invalid_status_transition_atomicity",
        "block, unblock, cancel, and reinstate must land the requested status without touching the lease",
      ),
    ]);
  if (
    command.type === "SubmitExecution" &&
    (result.snapshot.task?.status !== "in_review" ||
      result.snapshot.task.currentNode !== "review" ||
      result.snapshot.lease !== null ||
      changed?.state !== "submitted" ||
      result.event.type !== "execution_submitted")
  )
    throw new TaskLifecycleContractError("invalid_transition", [
      lifecycleContractIssue(
        "invalid_submit_atomicity",
        "submit must finalize Execution, release lease, and enter in_review atomically",
      ),
    ]);
  if (
    command.type === "RecordReview" &&
    command.verdict === "changes_requested" &&
    (result.snapshot.task?.status !== "active" ||
      result.snapshot.task.currentNode !== "implementation" ||
      result.snapshot.task.iteration !== (snapshot.task?.iteration ?? -1) + 1 ||
      changed?.state !== "changes_requested" ||
      result.snapshot.lease !== null)
  )
    throw new TaskLifecycleContractError("invalid_graph", [
      lifecycleContractIssue(
        "invalid_return_atomicity",
        "changes_requested must close Execution and return to implementation atomically",
      ),
    ]);
}
export function compileExecutionExecutorDeclaration(input: {
  readonly snapshot: TaskLifecycleSnapshot;
  readonly taskId: string;
  readonly executionId: string;
  readonly actor: ActorAxes;
  readonly source: WriteSource;
  readonly reason: string;
  readonly opId: string;
  readonly eventId: string;
  readonly workspaceRevision: number;
  readonly occurredAt: string;
}): {
  readonly event: ExecutionExecutorDeclaredEvent;
  readonly snapshot: TaskLifecycleSnapshot;
} {
  const task = input.snapshot.task,
    current = execution(input.snapshot, input.executionId),
    eligible = executionExecutorDeclarationCandidates(input.snapshot, input.taskId, input.actor).some(
      (value) => value.executionId === input.executionId,
    );
  if (
    !task ||
    !current ||
    !eligible ||
    !isNonEmptyString(input.reason) ||
    input.workspaceRevision <= input.snapshot.revision
  )
    throw new TaskLifecycleContractError("invalid_proof", [
      lifecycleContractIssue(
        "invalid_executor_declaration",
        "executor declaration requires the same principal to name an agent for a submitted Execution at the " +
          "review node that originally declared no executor; unblock a blocked task before retrying",
      ),
    ]);
  const nextTask = { ...task, status: "in_review" as const },
    nextExecution: ExecutionV1 = { ...current, actor: input.actor },
    event: ExecutionExecutorDeclaredEvent = {
      schema: "task-event/v1",
      eventId: input.eventId,
      workspaceRevision: input.workspaceRevision,
      opId: input.opId,
      taskId: input.taskId,
      type: "execution_executor_declared",
      actor: input.actor,
      source: input.source,
      occurredAt: input.occurredAt,
      payload: {
        task: nextTask,
        execution: nextExecution,
        previousActor: current.actor,
        reason: input.reason,
        documentClaims: [],
      },
    };
  return { event, snapshot: reduceTaskEvent(input.snapshot, event) };
}
export function reduceTaskEvent(snapshot: TaskLifecycleSnapshot, event: TaskEventV1): TaskLifecycleSnapshot {
  const issues = validateTaskEvent(event);
  if (issues.length) throw new TaskLifecycleContractError("invalid_schema", issues);
  if (
    event.workspaceRevision <= snapshot.revision ||
    (event.type === "task_created" ? snapshot.task !== null : snapshot.task?.taskId !== event.taskId)
  )
    throw new TaskLifecycleContractError("invalid_transition", [
      lifecycleContractIssue("invalid_transition", "event revision or aggregate identity is not replayable"),
    ]);
  let next: TaskLifecycleSnapshot;
  if (event.type === "task_created")
    next = {
      ...snapshot,
      revision: event.workspaceRevision,
      task: event.payload.task,
    };
  else if (event.type === "execution_started")
    next = {
      ...snapshot,
      revision: event.workspaceRevision,
      task: event.payload.task,
      executions: snapshot.executions.some((value) => value.executionId === event.payload.execution.executionId)
        ? replaceExecution(snapshot.executions, event.payload.execution)
        : [...snapshot.executions, event.payload.execution],
      lease: event.payload.lease,
    };
  else if (event.type === "lease_renewed")
    next = {
      ...snapshot,
      revision: event.workspaceRevision,
      lease: event.payload.lease,
    };
  else if (event.type === "execution_submitted")
    next = {
      ...snapshot,
      revision: event.workspaceRevision,
      task: event.payload.task,
      executions: replaceExecution(snapshot.executions, event.payload.execution),
      edgesTaken: [...snapshot.edgesTaken, event.payload.edge],
      lease: null,
    };
  else if (event.type === "execution_executor_declared")
    next = {
      ...snapshot,
      revision: event.workspaceRevision,
      task: event.payload.task,
      executions: replaceExecution(snapshot.executions, event.payload.execution),
    };
  else if (event.type === "review_recorded")
    next = {
      ...snapshot,
      revision: event.workspaceRevision,
      task: event.payload.task,
      executions: replaceExecution(snapshot.executions, event.payload.execution),
      reviews: [...snapshot.reviews, event.payload.review],
      edgesTaken: event.payload.edge ? [...snapshot.edgesTaken, event.payload.edge] : snapshot.edgesTaken,
      lease: null,
    };
  else if (event.type === "review_consent_recorded")
    next = {
      ...snapshot,
      revision: event.workspaceRevision,
      consents: [...snapshot.consents, event.payload.consent],
    };
  else if (event.type === "code_doc_reconciled")
    next = {
      ...snapshot,
      revision: event.workspaceRevision,
      codeDocWitnesses: [
        ...snapshot.codeDocWitnesses.filter((value) => value.executionId !== event.payload.witness.executionId),
        event.payload.witness,
      ],
    };
  else if (event.type === "code_doc_repointed")
    next = {
      ...snapshot,
      revision: event.workspaceRevision,
      codeDocWitnesses: [...snapshot.codeDocWitnesses, event.payload.record],
    };
  else if (event.type === "completion_gate_verified")
    next = {
      ...snapshot,
      revision: event.workspaceRevision,
      gateWitnesses: [
        ...snapshot.gateWitnesses.filter(
          (value) =>
            value.executionId !== event.payload.witness.executionId || value.gateId !== event.payload.witness.gateId,
        ),
        event.payload.witness,
      ],
    };
  else if (event.type === "lease_released")
    next = {
      ...snapshot,
      revision: event.workspaceRevision,
      task: event.payload.task,
      executions: replaceExecution(snapshot.executions, event.payload.execution),
      lease: null,
    };
  else if (event.type !== "task_completed")
    next = {
      ...snapshot,
      revision: event.workspaceRevision,
      task: event.payload.task,
    };
  else
    next = {
      ...snapshot,
      revision: event.workspaceRevision,
      task: event.payload.task,
      executions: replaceExecution(snapshot.executions, event.payload.execution),
      lease: null,
    };
  assertReplay(snapshot, event, next);
  return next;
}
function sameReleasedLease(current: LeaseV1, released: LeaseV1): boolean {
  if (stableStringify(released) === stableStringify(current)) return true;
  // `orphaned` is derived from the wall clock by the live projection; canonical
  // replay still sees the same stored lease as `held`. Normalize only that
  // derived phase while preserving every field that identifies the lease CAS.
  return (
    current.phase === "held" &&
    released.phase === "orphaned" &&
    stableStringify({ ...released, phase: "held" }) === stableStringify(current)
  );
}
function sameReplayTask(current: TaskLifecycleSnapshot["task"], recorded: TaskLifecycleSnapshot["task"]): boolean {
  if (!current || !recorded) return current === recorded;
  return stableStringify(currentTaskForWrite(current)) === stableStringify(currentTaskForWrite(recorded));
}
function assertReplay(snapshot: TaskLifecycleSnapshot, event: TaskEventV1, next: TaskLifecycleSnapshot): void {
  if (event.type === "code_doc_repointed") {
    const target = snapshot.codeDocWitnesses.find(
      (value) => codeDocRecordId(value) === event.payload.record.supersedes,
    );
    if (
      !target ||
      currentCodeDocRecord(snapshot.codeDocWitnesses, target.executionId) !== target ||
      target.taskId !== event.taskId ||
      target.executionId !== event.payload.record.executionId ||
      target.iteration !== event.payload.record.iteration ||
      snapshot.codeDocWitnesses.some((value) => codeDocRecordId(value) === event.payload.record.recordId) ||
      currentCodeDocRecord(next.codeDocWitnesses, target.executionId) !== event.payload.record
    )
      throw new TaskLifecycleContractError("invalid_transition", [
        lifecycleContractIssue(
          "invalid_transition",
          "replayed code-doc repoint must supersede exactly one active witness record",
        ),
      ]);
  }
  if (
    event.type === "execution_submitted" &&
    (event.payload.task.status !== "in_review" ||
      event.payload.task.currentNode !== "review" ||
      event.payload.execution.state !== "submitted" ||
      event.payload.edge.on !== "submitted" ||
      next.lease !== null)
  )
    throw new TaskLifecycleContractError("invalid_transition", [
      lifecycleContractIssue("invalid_submit_atomicity", "replayed submit is incomplete"),
    ]);
  if (event.type === "lease_released") {
    const changesStatus = event.payload.mutation.fields.includes("status"),
      expectedTask = changesStatus && snapshot.task ? { ...snapshot.task, status: "blocked" as const } : snapshot.task;
    if (
      !snapshot.lease ||
      !sameReleasedLease(snapshot.lease, event.payload.releasedLease) ||
      event.payload.execution.executionId !== snapshot.lease.executionId ||
      !sameReplayTask(event.payload.task, expectedTask) ||
      (changesStatus && (!snapshot.task || !explainStatusTransition(snapshot.task.status, "blocked").allowed)) ||
      next.lease !== null
    )
      throw new TaskLifecycleContractError("invalid_transition", [
        lifecycleContractIssue("invalid_release_atomicity", "replayed lease release is incomplete"),
      ]);
  }
  if (event.type === "execution_executor_declared") {
    const current = execution(snapshot, event.payload.execution.executionId),
      expected = current ? { ...current, actor: event.actor } : null,
      expectedTask = snapshot.task ? { ...snapshot.task, status: "in_review" as const } : null;
    if (
      !current ||
      !sameReplayTask(event.payload.task, expectedTask) ||
      stableStringify(event.payload.previousActor) !== stableStringify(current.actor) ||
      stableStringify(event.payload.execution) !== stableStringify(expected) ||
      current.actor.executor !== null ||
      event.actor.executor === null ||
      !isSamePerson(current.actor, event.actor) ||
      !["active", "in_review"].includes(String(snapshot.task?.status)) ||
      snapshot.task?.currentNode !== "review" ||
      snapshot.lease !== null ||
      current.state !== "submitted" ||
      !current.submission
    )
      throw new TaskLifecycleContractError("invalid_proof", [
        lifecycleContractIssue(
          "invalid_executor_declaration",
          "replayed executor declaration is not a same-principal repair of a submitted execution at review",
        ),
      ]);
  }
  if (
    event.type === "review_recorded" &&
    snapshot.reviews.some((value) => value.reviewId === event.payload.review.reviewId)
  )
    throw new TaskLifecycleContractError("invalid_transition", [
      lifecycleContractIssue("invalid_transition", "replayed append-only Review reused an existing review id"),
    ]);
  if (
    event.type === "review_recorded" &&
    event.payload.review.verdict === "changes_requested" &&
    (event.payload.edge?.on !== "changes_requested" ||
      event.payload.execution.state !== "changes_requested" ||
      event.payload.task.status !== "active" ||
      event.payload.task.currentNode !== "implementation" ||
      event.payload.task.iteration !== (snapshot.task?.iteration ?? -1) + 1)
  )
    throw new TaskLifecycleContractError("invalid_graph", [
      lifecycleContractIssue("invalid_return_atomicity", "replayed changes_requested is incomplete"),
    ]);
  if (
    event.type === "review_consent_recorded" &&
    (event.payload.consent.reviewDigest !== reviewDigest(event.payload.review) ||
      event.payload.consent.contentDigest !== event.payload.review.contentDigest)
  )
    throw new TaskLifecycleContractError("invalid_proof", [
      lifecycleContractIssue("invalid_proof", "replayed consent is not content pinned"),
    ]);
  if (
    event.type === "completion_gate_verified" &&
    (!snapshot.task?.completionGateIds.includes(event.payload.witness.gateId) ||
      event.payload.witness.executionId !== event.payload.execution.executionId ||
      event.payload.witness.commitSha !== event.payload.execution.submission?.commitSha ||
      event.payload.witness.iteration !== event.payload.execution.iteration)
  )
    throw new TaskLifecycleContractError("invalid_proof", [
      lifecycleContractIssue("invalid_proof", "replayed checker witness is not bound to the execution cut"),
    ]);
  if (
    event.type === "task_completed" &&
    (!isReadyToComplete(snapshot) ||
      canonicalGateReceipts(snapshot, event.payload.execution).length !==
        requiredGateWitnessCount(snapshot, event.payload.execution) ||
      event.payload.task.status !== "done" ||
      event.payload.execution.state !== "accepted")
  )
    throw new TaskLifecycleContractError("invalid_transition", [
      lifecycleContractIssue(
        "invalid_transition",
        "replayed completion lacks review, consent, gate witnesses, or the decision derives edge",
      ),
    ]);
}
