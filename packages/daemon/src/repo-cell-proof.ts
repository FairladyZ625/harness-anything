import { type TaskLifecycleServiceProof } from "../../application/src/task-lifecycle-service.ts";
import {
  canonicalGateReceipts,
  consentedApprovedReview,
  heldLeaseForExecutionActor,
  isSameExecution,
  makeTaskProjection,
  normalizeCommandEnvelope,
  runtimeSessionIdFromActor,
  type ActorIdentity,
  type CompleteTaskCommand,
  type ProofFor,
  type TaskLifecycleCommand,
  type WriteReceipt,
} from "../../kernel/src/index.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import { verifyCodeDocCommitPaths } from "./code-doc-path-verification.ts";
import { submitLeaseRequiredMessage } from "./repo-cell-execution-selection.ts";
import { reviewerDependence } from "./repo-cell-review-lint.ts";
import type { PublicPublication, RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";
import { leaseTtlMs } from "./repo-cell-types.ts";

export async function proofFor(
  command: TaskLifecycleCommand,
  snapshot: Snapshot,
  binding: RepoCellBinding,
  projection: Pick<ReturnType<typeof makeTaskProjection>, "readRuntimeSession">,
  rootDir: string,
): Promise<TaskLifecycleServiceProof<typeof command>> {
  if (command.type === "CreateReplayTask") return { taskIdUnique: true, actorBinding: command.actor };
  if (command.type === "StartExecution") {
    const ttlMs = command.ttlMs ?? leaseTtlMs;
    return {
      actorBinding: command.actor,
      reservation: {
        taskId: command.taskId,
        executionId: command.executionId,
        expiresAt: new Date(Date.parse(command.occurredAt) + ttlMs).toISOString(),
        ttlMs,
        previousHolder: null,
        reason: "initial_claim",
        version: 0,
      },
    };
  }
  if (command.type === "TransitionTask") return {};
  if (command.type === "SubmitExecution") {
    const lease = heldLeaseForExecutionActor(snapshot, command.executionId, command.actor);
    if (!lease) throw cellCodedError("lease_required", submitLeaseRequiredMessage(command, snapshot));
    return {
      actorBinding: command.actor,
      leaseVersion: lease.version,
      sessionDisposition: "unavailable",
    };
  }
  if (command.type === "RecordReview") {
    if (!binding.roles?.includes("$arbiter"))
      throw cellCodedError(
        "actor_unauthorized",
        [
          "Execution Review requires the arbiter command class; give the reviewing ",
          "person a role that carries it in harness/people.yaml.",
        ].join(""),
      );
    const runtimeSessionId = runtimeSessionIdFromActor(command.actor),
      runtimeSession = runtimeSessionId === null ? null : projection.readRuntimeSession(runtimeSessionId);
    if (
      runtimeSession?.taskBindings.some(
        (taskBinding) => taskBinding.taskId === command.taskId && taskBinding.executionId === command.executionId,
      )
    )
      throw cellCodedError(
        "runtime_task_self_review_forbidden",
        [
          "This runtime is bound to task ",
          `${command.taskId}`,
          " and execution ",
          `${command.executionId}`,
          " and cannot review its own work; have an independent human or a runtime ",
          "with no binding to this task and execution run ha task review-execution ",
          `${command.taskId}`,
          " --execution-id ",
          `${command.executionId}`,
          " --review-id ",
          `${command.reviewId}`,
          " --from-file <review.json>.",
        ].join(""),
      );
    const blocked = reviewerDependence(command.actor, snapshot);
    if (blocked) throw cellCodedError("actor_unauthorized", blocked);
    return {
      actorBinding: command.actor,
      capability: "execution-review@v1",
      capabilityRef: `transport-reviewer:${command.actor.principal.personId}`,
    };
  }
  if (command.type === "RecordReviewConsent") {
    if (!snapshot.task || !isSameExecution(snapshot.task.createdBy, command.actor))
      throw cellCodedError(
        "actor_unauthorized",
        snapshot.task
          ? [
              "Review consent requires the Task owner (",
              `${actorHint(snapshot.task.createdBy)}`,
              "); retry with that person and executor identity.",
            ].join("")
          : "Review consent requires an existing Task owner.",
      );
    return {
      actorBinding: command.actor,
      capability: "execution-consent@v1",
      capabilityRef: `task-owner:${command.actor.principal.personId}`,
    };
  }
  if (command.type === "ReconcileCodeDoc") {
    const verified = verifyCodeDocCommitPaths({ rootDir, commitSha: command.commitSha, paths: command.paths });
    if (!verified.ok)
      throw cellCodedError(
        "invalid_proof",
        verified.code === "commit_not_found"
          ? `Code-doc reconcile cannot verify commit ${command.commitSha} in the public or authored Git repository.`
          : [
              "Code-doc reconcile requires every --path to exist at commit ",
              command.commitSha,
              " relative to the Git repository that owns it; missing or wrong-root paths: ",
              verified.missingPaths.join(", "),
              ".",
            ].join(""),
      );
    return {
      actorBinding: command.actor,
      capability: "code-doc-reconcile@v1",
      capabilityRef: `transport-writer:${command.actor.principal.personId}`,
      commitPaths: { commitSha: verified.commitSha, paths: verified.paths },
    };
  }
  return completeProof(command, snapshot) as TaskLifecycleServiceProof<typeof command>;
}

export function completeProof(command: CompleteTaskCommand, snapshot: Snapshot): ProofFor<CompleteTaskCommand> {
  if (snapshot.lease !== null)
    throw cellCodedError("active_lease", "Complete requires the execution lease to be released.");
  if (snapshot.task?.createdBy.principal.personId !== command.actor.principal.personId)
    throw cellCodedError("actor_unauthorized", "Complete requires the Task owner.");
  const execution = snapshot.executions.find(
    (candidate) => candidate.executionId === command.executionId && candidate.submission !== null,
  );
  if (!execution?.submission) throw cellCodedError("invalid_transition", "Complete requires a submitted execution.");
  const supplied = canonicalGateReceipts(snapshot, execution);
  if (supplied.length !== (snapshot.task?.completionGateIds.length ?? 0))
    throw cellCodedError(
      "gate_witness_missing",
      "Every completion gate requires a canonical typed witness; local receipt files are not authoritative.",
    );
  return {
    capability: "task-complete@v1",
    capabilityRef: `task-created-by:${command.taskId}:${command.actor.principal.personId}`,
    actorRole: "owner",
    noActiveLease: true,
    gateReceipts: supplied,
  };
}

export function createTaskId(action: RepoTaskAction, binding: RepoCellBinding, workspaceId: string): string {
  if (typeof action.taskId === "string" && action.taskId) return action.taskId;
  return `task_${operationId(action, binding, workspaceId, 0).slice(-26)}`;
}

/** StartExecution 的 id 选择：显式给了就用它；没给则优先 rejoin 当前轮那个
 * unleased active execution，
 * 只有在没有可 rejoin 的执行时才派生新 id。派生新 id 会被 canStartExecution 判为不可接纳，
 * 因此「不带 --execution-id 就必然被拒」曾是唯一结果。 */
export function startExecutionId(
  action: RepoTaskAction,
  snapshot: Snapshot,
  binding: RepoCellBinding,
  workspaceId: string,
  expectedRevision: number,
): string {
  if (typeof action.executionId === "string" && action.executionId) return action.executionId;
  const rejoin = snapshot.executions.find(
    (value) => value.iteration === snapshot.task?.iteration && value.state === "active",
  );
  return rejoin?.executionId ?? derivedExecutionId(action, binding, workspaceId, expectedRevision);
}

export function derivedExecutionId(
  action: RepoTaskAction,
  binding: RepoCellBinding,
  workspaceId: string,
  expectedRevision: number,
): string {
  return `exe_${operationId(action, binding, workspaceId, expectedRevision).slice(-26)}`;
}

export function withoutDryRun(action: RepoTaskAction): RepoTaskAction {
  const { dryRun: _dryRun, ...canonical } = action;
  return canonical;
}

export function operationId(
  action: RepoTaskAction,
  binding: RepoCellBinding,
  workspaceId: string,
  expectedRevision: number,
): string {
  const {
    actor: _actor,
    source: _source,
    root: _root,
    workspaceId: _workspace,
    serverWorkspaceId: _server,
    ...intent
  } = action;
  return normalizeCommandEnvelope({
    workspaceId,
    actor: binding.actor,
    source: binding.source,
    expectedRevision,
    command: intent,
  }).opId;
}

export function actorHint(actor: ActorIdentity): string {
  return [
    "personId=",
    `${actor.principal.personId}`,
    ", executor=",
    `${actor.executor === null ? "none" : `${actor.executor.kind}:${actor.executor.id}`}`,
    "",
  ].join("");
}

export function receiptProof(
  event: { readonly opId: string; readonly workspaceRevision: number },
  publication: PublicPublication,
): NonNullable<WriteReceipt["proof"]> {
  const canonicalVisible = publication.cut.opId === event.opId && publication.cut.revision === event.workspaceRevision;
  return {
    committedRevision: event.workspaceRevision,
    appliedCut: publication.cut.revision,
    durable: canonicalVisible,
    canonicalVisible,
    worktreeVisible: canonicalVisible,
  };
}

export function gateChecks(snapshot: Snapshot, executionId: string) {
  const execution = snapshot.executions.find(
    (value) => value.executionId === executionId && value.iteration === snapshot.task?.iteration,
  );
  return (snapshot.task?.completionGateIds ?? []).map((gate) => {
    const codeDoc =
        gate === "code-doc-reconciliation"
          ? snapshot.codeDocWitnesses.find(
              (value) =>
                value.executionId === executionId &&
                value.commitSha === execution?.submission?.commitSha &&
                value.iteration === execution?.iteration,
            )
          : undefined,
      witness =
        gate !== "code-doc-reconciliation"
          ? snapshot.gateWitnesses.find(
              (value) =>
                value.gateId === gate &&
                value.executionId === executionId &&
                value.commitSha === execution?.submission?.commitSha &&
                value.iteration === execution?.iteration,
            )
          : undefined;
    return {
      gate,
      status: codeDoc || witness ? "pass" : "blocked",
      witnessRef: codeDoc ? `event:${codeDoc.witnessId}` : witness ? `event:${witness.receiptId}` : null,
    };
  });
}

export function selectedReviewId(snapshot: Snapshot, executionId: string): string | null {
  const execution = snapshot.executions.find((value) => value.executionId === executionId);
  return execution?.submission
    ? (consentedApprovedReview(
        snapshot.reviews,
        snapshot.consents,
        executionId,
        execution.submission.commitSha,
        execution.iteration,
      )?.review.reviewId ?? null)
    : null;
}
