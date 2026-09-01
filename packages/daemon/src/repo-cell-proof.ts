import { type TaskLifecycleServiceProof } from "../../application/src/task-lifecycle-service.ts";
import {
  canonicalGateReceipts,
  codeDocRecordId,
  consentedApprovedReview,
  currentCodeDocWitness,
  heldLeaseForExecutionActor,
  getTaskActionForTransition,
  isIndependentFrom,
  isSamePerson,
  makeTaskProjection,
  normalizeCommandEnvelope,
  requiredGateWitnessCount,
  runtimeSessionIdFromActor,
  TASK_LIFECYCLE_TRANSITIONS,
  type ActorIdentity,
  type AuthorizationDecision,
  type CompleteTaskCommand,
  type ProofFor,
  type TaskLifecycleCommand,
  type WriteReceipt,
} from "../../kernel/src/index.ts";
import { cellCodedError, cellCriterionError } from "./repo-cell-errors.ts";
import { verifyCodeDocCommitPaths } from "./code-doc-path-verification.ts";
import type { PublicPublication, RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";
import { leaseTtlMs } from "./repo-cell-types.ts";

const START_VALIDATION_CRITERION = "task-lifecycle-command-transitions/start.validate";
const SUBMIT_LEASE_CRITERION = "actor-domain-services/heldLeaseForExecutionActor";
const REVIEW_PROOF_CRITERION = "repo-cell-proof/proofFor.RecordReview";
const COMPLETE_VALIDATION_CRITERION = "task-lifecycle-review-transitions/complete.validate";

export async function proofFor(
  command: TaskLifecycleCommand,
  snapshot: Snapshot,
  binding: RepoCellBinding,
  projection: Pick<ReturnType<typeof makeTaskProjection>, "readRuntimeSession">,
  rootDir: string,
): Promise<TaskLifecycleServiceProof<typeof command> & { readonly authorizationDecision?: AuthorizationDecision }> {
  if (command.type === "CreateReplayTask") return { taskIdUnique: true, actorBinding: command.actor };
  const transition = TASK_LIFECYCLE_TRANSITIONS.find((candidate) => candidate.matches(command, snapshot)),
    lifecycleAction = transition ? getTaskActionForTransition(transition.id) : undefined,
    lifecycleExecution = lifecycleAction?.execution?.lifecycle;
  if (lifecycleExecution?.coordination === "reserve") {
    const commandFields = command as unknown as Readonly<Record<string, unknown>>,
      executionId = commandFields[lifecycleExecution.targetIdField],
      ttlMs = typeof commandFields.ttlMs === "number" ? commandFields.ttlMs : leaseTtlMs;
    if (typeof executionId !== "string")
      throw cellCriterionError(
        "invalid_command",
        `${lifecycleExecution.commandType} requires a target entity id.`,
        "start",
        START_VALIDATION_CRITERION,
      );
    const authorizationDecision = requiredAuthorizationDecision(binding);
    return {
      actorBinding: command.actor,
      reservation: {
        taskId: command.taskId,
        executionId,
        expiresAt: new Date(Date.parse(command.occurredAt) + ttlMs).toISOString(),
        ttlMs,
        previousHolder: null,
        reason: "initial_claim",
        version: 0,
      },
      authorizationDecision,
    };
  }
  if (command.type === "TransitionTask") return {};
  if (command.type === "SubmitExecution") {
    const lease = heldLeaseForExecutionActor(snapshot, command.executionId, command.actor);
    if (!lease)
      throw cellCriterionError(
        "lease_required",
        "Task submit lease proof was not satisfied.",
        "submit",
        SUBMIT_LEASE_CRITERION,
      );
    return {
      actorBinding: command.actor,
      leaseVersion: lease.version,
      sessionDisposition: "unavailable",
    };
  }
  if (command.type === "RecordReview") {
    const runtimeSessionId = runtimeSessionIdFromActor(command.actor),
      runtimeSession = runtimeSessionId === null ? null : projection.readRuntimeSession(runtimeSessionId),
      runtimeBinding = runtimeSession?.taskBindings.some(
        (taskBinding) => taskBinding.taskId === command.taskId && taskBinding.executionId === command.executionId,
      )
        ? {
            runtimeSessionId: runtimeSession.runtimeSessionId,
            taskId: command.taskId,
            executionId: command.executionId,
          }
        : null,
      execution = snapshot.executions.find(
        (candidate) => candidate.executionId === command.executionId && candidate.submission !== null,
      ),
      authorizationDecision = requiredAuthorizationDecision(binding);
    if (runtimeBinding !== null)
      throw cellCriterionError(
        "runtime_task_self_review_forbidden",
        "Task review runtime-binding independence proof was not satisfied.",
        "review",
        REVIEW_PROOF_CRITERION,
      );
    if (execution === undefined || !isIndependentFrom(execution.actor, command.actor)) {
      throw cellCriterionError(
        "actor_unauthorized",
        "Task review actor independence proof was not satisfied.",
        "review",
        REVIEW_PROOF_CRITERION,
      );
    }
    return {
      actorBinding: command.actor,
      capability: "execution-review@v1",
      capabilityRef: authorizationDecision.policyRef,
      authorizationDecision,
    };
  }
  if (command.type === "RecordReviewConsent") {
    const authorizationDecision = requiredAuthorizationDecision(binding);
    if (!snapshot.task || !isSamePerson(snapshot.task.createdBy, command.actor))
      throw cellCodedError(
        "actor_unauthorized",
        snapshot.task
          ? [
              "Review consent requires the Execution owner principal (personId=",
              `${snapshot.task.createdBy.principal.personId}`,
              ").",
            ].join("")
          : "Review consent requires an existing Execution owner.",
      );
    return {
      actorBinding: command.actor,
      capability: "execution-consent@v1",
      capabilityRef: authorizationDecision.policyRef,
      authorizationDecision,
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
      capabilityRef: requiredAuthorizationDecision(binding).policyRef,
      commitPaths: { commitSha: verified.commitSha, paths: verified.paths },
    };
  }
  if (command.type === "RepointCodeDoc") {
    if (command.paths.length === 0)
      return {
        actorBinding: command.actor,
        capability: "code-doc-repoint@v1",
        capabilityRef: requiredAuthorizationDecision(binding).policyRef,
        commitPaths: { commitSha: command.commitSha, paths: command.paths },
      };
    const verified = verifyCodeDocCommitPaths({ rootDir, commitSha: command.commitSha, paths: command.paths });
    if (!verified.ok)
      throw cellCodedError(
        "invalid_proof",
        verified.code === "commit_not_found"
          ? `Code-doc repoint cannot verify commit ${command.commitSha} in the public or authored Git repository.`
          : [
              "Code-doc repoint requires every --path to exist at commit ",
              command.commitSha,
              " relative to the Git repository that owns it; missing or wrong-root paths: ",
              verified.missingPaths.join(", "),
              ".",
            ].join(""),
      );
    return {
      actorBinding: command.actor,
      capability: "code-doc-repoint@v1",
      capabilityRef: requiredAuthorizationDecision(binding).policyRef,
      commitPaths: { commitSha: verified.commitSha, paths: verified.paths },
    };
  }
  if (command.type !== "CompleteTask")
    throw cellCodedError("invalid_command", `No authority proof plan exists for ${command.type}.`);
  return completeProof(command, snapshot, binding) as TaskLifecycleServiceProof<typeof command>;
}

export function completeProof(
  command: CompleteTaskCommand,
  snapshot: Snapshot,
  binding: RepoCellBinding,
): ProofFor<CompleteTaskCommand> & { readonly authorizationDecision: AuthorizationDecision } {
  if (snapshot.lease !== null)
    throw cellCriterionError(
      "active_lease",
      "Task completion lease-release proof was not satisfied.",
      "complete",
      COMPLETE_VALIDATION_CRITERION,
    );
  const authorizationDecision = requiredAuthorizationDecision(binding);
  if (!snapshot.task || !isSamePerson(snapshot.task.createdBy, command.actor))
    throw cellCriterionError(
      "actor_unauthorized",
      "Task completion owner proof was not satisfied.",
      "complete",
      COMPLETE_VALIDATION_CRITERION,
    );
  const execution = snapshot.executions.find(
    (candidate) => candidate.executionId === command.executionId && candidate.submission !== null,
  );
  if (!execution?.submission)
    throw cellCriterionError(
      "invalid_transition",
      "Task completion submitted-execution proof was not satisfied.",
      "complete",
      COMPLETE_VALIDATION_CRITERION,
    );
  const supplied = canonicalGateReceipts(snapshot, execution);
  if (supplied.length !== requiredGateWitnessCount(snapshot, execution))
    throw cellCriterionError(
      "gate_witness_missing",
      "Task completion canonical gate-witness proof was not satisfied.",
      "complete",
      COMPLETE_VALIDATION_CRITERION,
    );
  return {
    capability: "task-complete@v1",
    capabilityRef: authorizationDecision.policyRef,
    actorRole: "owner",
    noActiveLease: true,
    gateReceipts: supplied,
    authorizationDecision,
  };
}

function requiredAuthorizationDecision(binding: RepoCellBinding): AuthorizationDecision {
  if (!binding.authorizationDecision || binding.authorizationDecision.outcome !== "allowed")
    throw cellCodedError(
      "authorization_missing",
      "Durable Task criteria require the center AuthorizationPort decision.",
    );
  return binding.authorizationDecision;
}

export function createTaskId(action: RepoTaskAction, binding: RepoCellBinding, workspaceId: string): string {
  if (typeof action.taskId === "string" && action.taskId) return action.taskId;
  return `task_${operationId(action, binding, workspaceId, 0).slice(-26)}`;
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
        gate === "code-doc-reconciliation" ? currentCodeDocWitness(snapshot.codeDocWitnesses, executionId) : undefined,
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
      witnessRef: codeDoc ? `event:${codeDocRecordId(codeDoc)}` : witness ? `event:${witness.receiptId}` : null,
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
