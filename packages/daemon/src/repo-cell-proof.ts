import { type TaskLifecycleServiceProof } from "../../application/src/task-lifecycle-service.ts";
import {
  canonicalGateReceipts,
  codeDocRecordId,
  completionGateRequiresWitness,
  consentedApprovedReview,
  currentCodeDocWitness,
  deriveOwnerRoleBinding,
  heldLeaseForExecutionActor,
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
import { cellCodedError } from "./repo-cell-errors.ts";
import { verifyCodeDocCommitPaths } from "./code-doc-path-verification.ts";
import { submitLeaseRequiredMessage } from "./repo-cell-execution-selection.ts";
import { authorizeAction } from "./authorization.ts";
import { resolveLifecycleTransition } from "./repo-cell-lifecycle-action.ts";
import { roleBindingAuthorizationContext } from "./repo-cell-role-bindings.ts";
import type { PublicPublication, RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";
import { leaseTtlMs } from "./repo-cell-types.ts";

export async function proofFor(
  command: TaskLifecycleCommand,
  snapshot: Snapshot,
  binding: RepoCellBinding,
  projection: Pick<ReturnType<typeof makeTaskProjection>, "readRuntimeSession">,
  rootDir: string,
): Promise<TaskLifecycleServiceProof<typeof command> & { readonly authorizationDecision?: AuthorizationDecision }> {
  if (command.type === "CreateReplayTask") return { taskIdUnique: true, actorBinding: command.actor };
  const transition = TASK_LIFECYCLE_TRANSITIONS.find((candidate) => candidate.matches(command, snapshot)),
    lifecycleAction = transition ? resolveLifecycleTransition(transition.id) : null;
  if (lifecycleAction?.coordination === "reserve") {
    const commandFields = command as unknown as Readonly<Record<string, unknown>>,
      executionId = commandFields[lifecycleAction.targetIdField],
      ttlMs = typeof commandFields.ttlMs === "number" ? commandFields.ttlMs : leaseTtlMs;
    if (typeof executionId !== "string")
      throw cellCodedError("invalid_command", `${lifecycleAction.commandType} requires a target entity id.`);
    const authorizationDecision = authorizeAction(
      lifecycleAction.actionKind,
      lifecycleAction.targetRef(executionId),
      command.actor,
      `authorization:${command.eventId}`,
      {
        ...roleBindingAuthorizationContext(binding),
        target: {},
        evaluatedAtCut: `canonical:${snapshot.revision}`,
      },
      command.opId,
    );
    if (authorizationDecision.outcome === "denied")
      throw cellCodedError(
        "actor_unauthorized",
        `${lifecycleAction.commandType} requires an admitted repo-write command.`,
      );
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
    if (!lease) throw cellCodedError("lease_required", submitLeaseRequiredMessage(command, snapshot));
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
      authorizationDecision = authorizeAction(
        "execution.review",
        `execution/${command.executionId}`,
        command.actor,
        command.opId,
        {
          ...roleBindingAuthorizationContext(binding),
          target: { executionActor: execution?.actor ?? null, runtimeBinding },
          evaluatedAtCut: `canonical:${snapshot.revision}`,
        },
      );
    if (authorizationDecision.outcome === "denied" && runtimeBinding !== null)
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
    if (authorizationDecision.outcome === "denied") {
      const commandClassFailed = authorizationDecision.bindingsUsed.some(
        (used) => used.predicate === "hasCommandClass" && used.satisfied === false,
      );
      if (commandClassFailed)
        throw cellCodedError(
          "actor_unauthorized",
          [
            "Execution Review requires an active arbiter RoleBinding; run ha people bind ",
            "for the reviewing actor and repository target.",
          ].join(""),
        );
      const undeclared = execution?.actor.executor === null && command.actor.executor === null;
      throw cellCodedError(
        "actor_unauthorized",
        undeclared
          ? [
              "Execution Review requires a reviewer independent of the submitter: the ",
              "submitted execution's original start declared no executor, so only a ",
              "different person can review it. Run ha task declare-executor with that ",
              "principal and an agent executor to record an auditable recovery before ",
              "same-person review.",
            ].join("")
          : [
              "Execution Review requires a reviewer independent of the submitting executor; ",
              "review without declaring that executor.",
            ].join(""),
      );
    }
    return {
      actorBinding: command.actor,
      capability: "execution-review@v1",
      capabilityRef: `transport-reviewer:${command.actor.principal.personId}`,
      authorizationDecision,
    };
  }
  if (command.type === "RecordReviewConsent") {
    const executionTarget = `execution/${command.executionId}` as const,
      ownerRoleBindings = snapshot.task ? [deriveOwnerRoleBinding(snapshot.task.createdBy, executionTarget)] : [];
    const authorizationDecision = authorizeAction("task.consent", executionTarget, command.actor, command.opId, {
      roleBindings: ownerRoleBindings,
      target: {},
      evaluatedAtCut: `canonical:${snapshot.revision}`,
    });
    if (authorizationDecision.outcome === "denied")
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
      capabilityRef: `execution-owner:${command.executionId}:${command.actor.principal.personId}`,
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
      capabilityRef: `transport-writer:${command.actor.principal.personId}`,
      commitPaths: { commitSha: verified.commitSha, paths: verified.paths },
    };
  }
  if (command.type === "RepointCodeDoc") {
    if (command.paths.length === 0)
      return {
        actorBinding: command.actor,
        capability: "code-doc-repoint@v1",
        capabilityRef: `transport-writer:${command.actor.principal.personId}`,
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
      capabilityRef: `transport-writer:${command.actor.principal.personId}`,
      commitPaths: { commitSha: verified.commitSha, paths: verified.paths },
    };
  }
  if (command.type !== "CompleteTask")
    throw cellCodedError("invalid_command", `No authority proof plan exists for ${command.type}.`);
  return completeProof(command, snapshot) as TaskLifecycleServiceProof<typeof command>;
}

export function completeProof(
  command: CompleteTaskCommand,
  snapshot: Snapshot,
): ProofFor<CompleteTaskCommand> & { readonly authorizationDecision: AuthorizationDecision } {
  if (snapshot.lease !== null)
    throw cellCodedError("active_lease", "Complete requires the execution lease to be released.");
  const authorizationDecision = authorizeAction(
    "task.complete",
    `execution/${command.executionId}`,
    command.actor,
    command.opId,
    {
      roleBindings: snapshot.task
        ? [deriveOwnerRoleBinding(snapshot.task.createdBy, `execution/${command.executionId}`)]
        : [],
      target: {},
      evaluatedAtCut: `canonical:${snapshot.revision}`,
    },
  );
  if (authorizationDecision.outcome === "denied")
    throw cellCodedError("actor_unauthorized", "Complete requires the Execution owner principal.");
  const execution = snapshot.executions.find(
    (candidate) => candidate.executionId === command.executionId && candidate.submission !== null,
  );
  if (!execution?.submission) throw cellCodedError("invalid_transition", "Complete requires a submitted execution.");
  const supplied = canonicalGateReceipts(snapshot, execution);
  if (supplied.length !== requiredGateWitnessCount(snapshot, execution))
    throw cellCodedError(
      "gate_witness_missing",
      "Every applicable completion gate requires a canonical typed witness; local receipt files are not authoritative.",
    );
  return {
    capability: "task-complete@v1",
    capabilityRef: `execution-owner:${command.executionId}:${command.actor.principal.personId}`,
    actorRole: "owner",
    noActiveLease: true,
    gateReceipts: supplied,
    authorizationDecision,
  };
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
    const notApplicable = !completionGateRequiresWitness(gate, execution?.submission);
    return {
      gate,
      status: codeDoc || witness || notApplicable ? "pass" : "blocked",
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
