import { isNativeExecution, validateSubmissionV1 } from "./execution.ts";
import type { ExecutionV1, LeaseV1 } from "./execution.ts";
import { taskClasses } from "./task.ts";
import type { TaskV1 } from "./task.ts";
import { validateTaskGraph } from "./task-graph.ts";
import { isNonEmptyString } from "./write-chain.contract.ts";
import { stableStringify } from "../integrity/stable-hash.ts";
import type {
  ExecutionStartedEvent,
  ExecutionSubmittedEvent,
  TaskCreatedEvent,
  TaskMutationEvent,
} from "./task-lifecycle-event.ts";
import { isSameExecution } from "./actor-domain-services.ts";
import { explainStatusTransition, reinstateTaskTargets } from "./lifecycle-status.ts";
import type { DomainStatus } from "./lifecycle-status.ts";
import type {
  CreateReplayTaskCommand,
  CreateReplayTaskProof,
  StartExecutionCommand,
  StartExecutionProof,
  SubmitExecutionCommand,
  SubmitExecutionProof,
  TaskLifecycleSnapshot,
  Transition,
  TransitionResult,
  TransitionTaskCommand,
} from "./task-lifecycle-contract-internal-types.ts";
import {
  envelope,
  execution,
  lifecycleContractIssue,
  replaceExecution,
  revisionIssues,
  takeEdge,
} from "./task-lifecycle-contract-support.ts";

// Creation, execution, and aggregate-status transition definitions.
export const create: Transition = {
  id: "create_replay_task",
  commandType: "CreateReplayTask",
  from: "missing",
  proof: ["taskIdUnique", "actorBinding", "validGraph"],
  eventType: "task_created",
  matches: (command) => command.type === "CreateReplayTask",
  validate: (snapshot, raw, rawProof) => {
    const command = raw as CreateReplayTaskCommand,
      proof = rawProof as Partial<CreateReplayTaskProof>,
      issues = revisionIssues(snapshot, command);
    if (snapshot.task !== null)
      issues.push(lifecycleContractIssue("invalid_transition", "CreateReplayTask requires a missing aggregate"));
    if (
      !isNonEmptyString(command.taskId) ||
      !isNonEmptyString(command.title) ||
      !taskClasses.includes(command.taskClass) ||
      !Array.isArray(command.completionGateIds) ||
      (command.presetSnapshotDigest !== null && !/^sha256:[0-9a-f]{64}$/u.test(command.presetSnapshotDigest))
    )
      issues.push(lifecycleContractIssue("invalid_schema", "create command fields are invalid"));
    if (proof.taskIdUnique !== true || !proof.actorBinding || !isSameExecution(command.actor, proof.actorBinding))
      issues.push(lifecycleContractIssue("invalid_proof", "task identity and actor binding proof are required"));
    issues.push(...validateTaskGraph(command.graph));
    return issues;
  },
  reduce: (snapshot, raw) => {
    const command = raw as CreateReplayTaskCommand,
      task: TaskV1 = {
        schema: "task/v1",
        taskId: command.taskId,
        title: command.title,
        taskClass: command.taskClass,
        status: "planned",
        graph: command.graph,
        currentNode: "implementation",
        iteration: 0,
        createdBy: command.actor,
        completionGateIds: command.completionGateIds,
        presetSnapshotDigest: command.presetSnapshotDigest,
      };
    return {
      snapshot: { ...snapshot, revision: command.workspaceRevision, task },
      event: envelope<TaskCreatedEvent>(command, "task_created", { task }),
    };
  },
};
/**
 * The state-side admissibility of StartExecution: a new execution, or the
 * unleased active execution of the current round.
 * Exported so the daemon preview and this transition answer with one rule instead of two. */
export function canStartExecution(snapshot: TaskLifecycleSnapshot, executionId: string): boolean {
  const task = snapshot.task,
    rejoin = snapshot.executions.find((value) => value.executionId === executionId),
    round = snapshot.executions.find(
      (value) => isNativeExecution(value) && value.iteration === task?.iteration && value.state === "active",
    );
  return (
    Boolean(task) &&
    ["planned", "active"].includes(task!.status) &&
    task!.currentNode === "implementation" &&
    !snapshot.lease &&
    isNonEmptyString(executionId) &&
    rejoin === round
  );
}
/** The state-side admissibility shared by the block/unblock/cancel catalog entries. */
export function allowsTaskStatusMove(
  snapshot: TaskLifecycleSnapshot,
  target: "active" | "blocked" | "cancelled",
): boolean {
  const task = snapshot.task;
  return (
    Boolean(task) && !snapshot.lease && task!.status !== target && explainStatusTransition(task!.status, target).allowed
  );
}
export const start: Transition = {
  id: "start_execution",
  commandType: "StartExecution",
  from: "planned|active/implementation",
  proof: ["actorBinding", "reservation"],
  eventType: "execution_started",
  matches: (command) => command.type === "StartExecution",
  validate: (snapshot, raw, rawProof) => {
    const command = raw as StartExecutionCommand,
      proof = rawProof as Partial<StartExecutionProof>,
      issues = revisionIssues(snapshot, command),
      reservation = proof.reservation;
    if (!canStartExecution(snapshot, command.executionId))
      issues.push(
        lifecycleContractIssue(
          "invalid_transition",
          "StartExecution requires a new execution, or the unleased active execution of the current round, " +
            "in planned or returned implementation",
        ),
      );
    if (
      !proof.actorBinding ||
      !isSameExecution(command.actor, proof.actorBinding) ||
      !reservation ||
      reservation.taskId !== command.taskId ||
      reservation.executionId !== command.executionId ||
      !isNonEmptyString(reservation.expiresAt) ||
      !Number.isInteger(reservation.ttlMs) ||
      reservation.ttlMs < 1 ||
      !Number.isInteger(reservation.version) ||
      reservation.version < 0
    )
      issues.push(lifecycleContractIssue("invalid_proof", "active reservation CAS proof is required"));
    return issues;
  },
  reduce: (snapshot, raw, rawProof) => {
    const command = raw as StartExecutionCommand,
      reservation = (rawProof as StartExecutionProof).reservation,
      task = { ...(snapshot.task as TaskV1), status: "active" as const },
      rejoin = snapshot.executions.find((value) => value.executionId === command.executionId) as
        | ExecutionV1
        | undefined,
      execution: ExecutionV1 = rejoin ?? {
        schema: "execution/v1",
        executionId: command.executionId,
        taskId: command.taskId,
        nodeId: "implementation",
        iteration: task.iteration,
        state: "active",
        actor: command.actor,
        claimedAt: command.occurredAt,
        submittedAt: null,
        closedAt: null,
        submission: null,
      },
      lease: LeaseV1 = {
        schema: "lease/v1",
        taskId: command.taskId,
        executionId: command.executionId,
        actor: command.actor,
        source: command.source,
        phase: "held",
        expiresAt: reservation.expiresAt,
        ttlMs: reservation.ttlMs,
        version: reservation.version,
      };
    return {
      snapshot: {
        ...snapshot,
        revision: command.workspaceRevision,
        task,
        executions: rejoin ? snapshot.executions : [...snapshot.executions, execution],
        lease,
      },
      event: envelope<ExecutionStartedEvent>(command, "execution_started", {
        task,
        execution,
        lease,
        previousHolder: reservation.previousHolder,
        leaseExpiresAt: lease.expiresAt,
        reason: reservation.reason,
      }),
    };
  },
};
function transitionTask(
  snapshot: TaskLifecycleSnapshot,
  command: TransitionTaskCommand,
  status: "planned" | "active" | "in_review" | "blocked" | "cancelled",
): TransitionResult {
  const task: TaskV1 = {
      ...(snapshot.task as TaskV1),
      status,
      ...(status === "cancelled" ? { pinned: false } : {}),
    },
    reason =
      status === "active" && !isNonEmptyString(command.reason)
        ? "Explicit lifecycle transition to active"
        : command.reason,
    mutation = { command: "transition" as const, reason, fields: ["status"] };
  return {
    snapshot: { ...snapshot, revision: command.workspaceRevision, task },
    event: envelope<TaskMutationEvent>(command, "task_transitioned", {
      task,
      mutation,
    }),
  };
}
export const block: Transition = {
  id: "block_task",
  commandType: "TransitionTask",
  from: "planned|active|in_review",
  proof: [],
  eventType: "task_transitioned",
  matches: (command) => command.type === "TransitionTask" && command.status === "blocked",
  validate: (snapshot, raw) => {
    const command = raw as TransitionTaskCommand,
      issues = revisionIssues(snapshot, command);
    if (!allowsTaskStatusMove(snapshot, "blocked"))
      issues.push(
        lifecycleContractIssue(
          "invalid_transition",
          "BlockTask requires an unleased planned, active, or in_review task",
        ),
      );
    if (!isNonEmptyString(command.reason))
      issues.push(lifecycleContractIssue("invalid_schema", "BlockTask requires a reason"));
    return issues;
  },
  reduce: (snapshot, raw) => transitionTask(snapshot, raw as TransitionTaskCommand, "blocked"),
};
/** The sole exit from cancelled: a compensating rollback (batch mis-cancellation recovery) to the
 * adjudicated pre-cancel status. Writer semantics mirror cancel — audit-first, aggregate-only —
 * except force stays cancel-specific: reinstate restores recorded state rather than destroying it.
 * Dispatches ahead of unblock so a cancelled→active command lands here, not on the blocked-only entry. */
export const reinstate: Transition = {
  id: "reinstate_task",
  commandType: "TransitionTask",
  from: "cancelled",
  proof: ["auditedReason"],
  eventType: "task_transitioned",
  matches: (command, snapshot) =>
    command.type === "TransitionTask" &&
    (reinstateTaskTargets as readonly DomainStatus[]).includes(command.status) &&
    snapshot.task?.status === "cancelled",
  validate: (snapshot, raw) => {
    const command = raw as TransitionTaskCommand,
      issues = revisionIssues(snapshot, command);
    if (
      snapshot.task?.status !== "cancelled" ||
      snapshot.lease !== null ||
      !(reinstateTaskTargets as readonly DomainStatus[]).includes(command.status) ||
      !explainStatusTransition("cancelled", command.status).allowed
    )
      issues.push(
        lifecycleContractIssue(
          "invalid_transition",
          "ReinstateTask requires an unleased cancelled task moving back to planned, active, or in_review",
        ),
      );
    if (!isNonEmptyString(command.reason))
      issues.push(lifecycleContractIssue("invalid_schema", "ReinstateTask requires an auditable reason"));
    return issues;
  },
  reduce: (snapshot, raw) =>
    transitionTask(
      snapshot,
      raw as TransitionTaskCommand,
      (raw as TransitionTaskCommand).status as "planned" | "active" | "in_review",
    ),
};
export const unblock: Transition = {
  id: "unblock_task",
  commandType: "TransitionTask",
  from: "blocked",
  proof: [],
  eventType: "task_transitioned",
  matches: (command) => command.type === "TransitionTask" && command.status === "active",
  validate: (snapshot, raw) => {
    const command = raw as TransitionTaskCommand,
      issues = revisionIssues(snapshot, command);
    if (snapshot.task?.status !== "blocked" || !allowsTaskStatusMove(snapshot, "active"))
      issues.push(lifecycleContractIssue("invalid_transition", "UnblockTask requires an unleased blocked task"));
    return issues;
  },
  reduce: (snapshot, raw) => transitionTask(snapshot, raw as TransitionTaskCommand, "active"),
};
export const cancel: Transition = {
  id: "cancel_task",
  commandType: "TransitionTask",
  from: "planned|active|blocked|in_review",
  proof: ["forcedReason"],
  eventType: "task_transitioned",
  matches: (command) => command.type === "TransitionTask" && command.status === "cancelled",
  validate: (snapshot, raw) => {
    const command = raw as TransitionTaskCommand,
      issues = revisionIssues(snapshot, command);
    if (!allowsTaskStatusMove(snapshot, "cancelled"))
      issues.push(lifecycleContractIssue("invalid_transition", "CancelTask requires an unleased non-terminal task"));
    if (!command.force || !isNonEmptyString(command.reason))
      issues.push(lifecycleContractIssue("force_reason_required", "CancelTask requires force and an auditable reason"));
    return issues;
  },
  reduce: (snapshot, raw) => transitionTask(snapshot, raw as TransitionTaskCommand, "cancelled"),
};
export const submit: Transition = {
  id: "submit_execution",
  commandType: "SubmitExecution",
  from: "active/implementation",
  proof: ["actorBinding", "leaseVersion", "submission"],
  eventType: "execution_submitted",
  matches: (command) => command.type === "SubmitExecution",
  validate: (snapshot, raw, rawProof) => {
    const command = raw as SubmitExecutionCommand,
      proof = rawProof as Partial<SubmitExecutionProof>,
      issues = revisionIssues(snapshot, command),
      task = snapshot.task,
      current = execution(snapshot, command.executionId),
      lease = snapshot.lease;
    if (!task || task.status !== "active" || task.currentNode !== "implementation" || current?.state !== "active")
      issues.push(
        lifecycleContractIssue("invalid_transition", "SubmitExecution requires the active current execution"),
      );
    if (
      !lease ||
      lease.phase !== "held" ||
      lease.executionId !== command.executionId ||
      !isSameExecution(lease.actor, command.actor) ||
      stableStringify(lease.source) !== stableStringify(command.source) ||
      !proof.actorBinding ||
      !isSameExecution(proof.actorBinding, command.actor) ||
      proof.leaseVersion !== lease.version ||
      !["complete", "partial", "unavailable"].includes(String(proof.sessionDisposition))
    )
      issues.push(lifecycleContractIssue("invalid_proof", "submit must own and atomically release the active lease"));
    issues.push(...validateSubmissionV1(command.submission));
    return issues;
  },
  reduce: (snapshot, raw) => {
    const command = raw as SubmitExecutionCommand,
      current = execution(snapshot, command.executionId) as ExecutionV1,
      nextExecution: ExecutionV1 = {
        ...current,
        state: "submitted",
        submittedAt: command.occurredAt,
        submission: command.submission,
      },
      task: TaskV1 = {
        ...(snapshot.task as TaskV1),
        status: "in_review",
        currentNode: "review",
      },
      edge = takeEdge(
        task,
        "submitted",
        command.submission.completionClaim,
        command.submission.commitSha,
        task.iteration,
      );
    return {
      snapshot: {
        ...snapshot,
        revision: command.workspaceRevision,
        task,
        executions: replaceExecution(snapshot.executions, nextExecution),
        edgesTaken: [...snapshot.edgesTaken, edge],
        lease: null,
      },
      event: envelope<ExecutionSubmittedEvent>(command, "execution_submitted", {
        task,
        execution: nextExecution,
        edge,
      }),
    };
  },
};
