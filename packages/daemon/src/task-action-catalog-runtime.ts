import {
  canStartExecution,
  evaluateTaskActionCapability,
  getExecutableEntityAction,
  heldLeaseForExecutionActor,
  isTerminalStatus,
  revisionIssues,
  type EntityActionContract,
  type EntityActionUnmetCriterionV1,
  type TaskLifecycleCommand,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import { actorHint } from "./repo-cell-proof.ts";
import { leaseTtlMs, type RepoCellBinding, type RepoTaskAction } from "./repo-cell-types.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";

export async function runTaskActionCatalogRuntime(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceipt> {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    current = await cell.service.read(taskId),
    expectedRevision = Number.isSafeInteger(action.expectedVersion)
      ? Number(action.expectedVersion)
      : current.snapshot.revision,
    contract = getExecutableEntityAction(action.kind),
    lifecycle = contract?.execution?.lifecycle,
    preview = lifecycle?.coordination === "reserve" && action.dryRun === true,
    activeLease = cell.projection.currentLease(taskId, cell.now());
  if (
    lifecycle?.coordination === "reserve" &&
    !preview &&
    activeLease &&
    ["held", "reserving"].includes(activeLease.phase)
  ) {
    if (heldLeaseForExecutionActor(current.snapshot, activeLease.executionId, binding.actor)) {
      const revision = current.snapshot.revision;
      return {
        outcome: "applied",
        opId: `noop:${cell.operationId(action, binding, cell.input.repoId, revision)}`,
        revision,
        evidence: JSON.stringify({ noOp: true, taskId, executionId: activeLease.executionId }),
        visibility: "center",
        proof: {
          committedRevision: revision,
          appliedCut: revision,
          durable: true,
          canonicalVisible: true,
          worktreeVisible: true,
        },
        taskId,
        executionId: activeLease.executionId,
        changedPaths: [],
        worktreeVisible: true,
        summary: `reused active execution ${activeLease.executionId}`,
      } as WriteReceipt;
    }
    throw cell.cellCodedError(
      "lease_conflict",
      activeLease.phase === "reserving"
        ? `Task ${taskId} is being reserved by ${actorHint(activeLease.actor)}; ` +
            "wait for that reservation to publish " +
            `or lapse at ${activeLease.expiresAt}, then retry ha task start ${taskId}.`
        : `Task ${taskId} is held by ${actorHint(activeLease.actor)}; ` +
            `that holder must run ha task release ${taskId}. ` +
            `This caller must wait for release, then retry ha task start ${taskId}.`,
    );
  }
  if (preview && !current.snapshot.task)
    throw cell.cellCodedError("task_not_found", "Run ha task list, choose an existing task id, then retry task start.");
  if (preview && current.snapshot.lease)
    throw cell.cellCodedError(
      "lease_conflict",
      `Run ha task release ${taskId} as the current holder before starting another execution.`,
    );
  if (preview && current.snapshot.task && isTerminalStatus(current.snapshot.task.status))
    throw cell.cellCodedError(
      "terminal_task",
      `Run ha task supersede ${taskId} --title <follow-up-title> for new work.`,
    );
  const unmet =
    contract?.target.kind === "task"
      ? evaluateTaskActionCapability({
          action: contract,
          snapshot: current.snapshot,
          actor: binding.actor,
        }).filter(({ status }) => status === "unmet")
      : [];
  if (lifecycle?.coordination === "reserve" && !preview)
    cell.assertTaskTransitionDocumentReady({
      rootDir: cell.rootDir,
      projection: cell.projection,
      taskId,
      slot: "task.plan",
      transition: "task.start",
    });
  let normalized: ReturnType<RepoCellOperationalContext["buildCommand"]>;
  try {
    normalized = cell.buildCommand(
      preview ? cell.withoutDryRun(action) : action,
      taskId,
      binding,
      cell.input.repoId,
      expectedRevision,
      cell.rootDir,
      current.snapshot,
    );
  } catch (error) {
    const rejection = taskActionFailure(cell, action, binding, current.snapshot.revision, contract, unmet, error);
    if (rejection) return rejection;
    throw error;
  }
  if (
    contract?.target.kind === "task" &&
    revisionIssues(current.snapshot, {
      ...normalized,
      workspaceRevision: current.snapshot.revision + 1,
    } as TaskLifecycleCommand).length > 0
  ) {
    const criterion = contract.criteria.find(({ ref }) => ref === "task-lifecycle-contract-support/revisionIssues");
    if (!criterion)
      throw new Error(`Task Action ${contract.id} does not declare its existing revisionIssues predicate.`);
    return taskActionRejection(cell, action, binding, current.snapshot.revision, contract, [
      {
        criterionRef: criterion.ref,
        nextActions: [`${criterion.explain} Then retry with --expected-version ${String(current.snapshot.revision)}.`],
      },
    ]);
  }
  if (preview && lifecycle) {
    const commandFields = normalized as unknown as Readonly<Record<string, unknown>>,
      executionId = commandFields[lifecycle.targetIdField];
    if (typeof executionId !== "string")
      throw cell.cellCodedError("invalid_command", `${lifecycle.commandType} requires a target entity id.`);
    return cell.previewResult(
      `preview:${normalized.opId}`,
      {
        taskId,
        executionId,
        ttlMs: typeof commandFields.ttlMs === "number" ? commandFields.ttlMs : leaseTtlMs,
        admissible: canStartExecution(current.snapshot, executionId),
      },
      current.snapshot.revision,
      "Remove --dry-run to acquire the lease and publish the execution-start event.",
    );
  }
  const command = cell.withServerMeta(
    normalized,
    cell.store.readTaskEvent(normalized.opId),
    cell.store.readHead()?.revision ?? 0,
    cell.now(),
  );
  let authorityProof: Awaited<ReturnType<RepoCellOperationalContext["proofFor"]>>;
  try {
    authorityProof = await cell.proofFor(command, current.snapshot, binding, cell.projection);
  } catch (error) {
    const rejection = taskActionFailure(cell, action, binding, current.snapshot.revision, contract, unmet, error);
    if (rejection) return rejection;
    throw error;
  }
  if (unmet.length > 0 && contract)
    return taskActionRejection(cell, action, binding, current.snapshot.revision, contract, unmet);
  const result = await cell.service.execute(command, authorityProof);
  if (result.outcome === "applied" && result.event && result.proof)
    return cell.lifecycleReceipt(
      result.event,
      result.snapshot,
      cell.publicPublication(cell.store.publication(result.event)),
      result.proof,
      authorityProof.authorizationDecision,
    );
  if (result.outcome === "pending")
    return {
      outcome: "pending",
      opId: command.opId,
      revision: result.revision,
      evidence: result.evidence,
      visibility: result.visibility,
      proof: result.proof,
      nextAction: result.nextAction ?? "Retry receipt show.",
    };
  return cell.rejected(
    command.opId,
    result.code ?? "publication_unknown",
    result.nextAction ?? "Retry receipt show before resubmitting.",
  );
}

function taskActionFailure(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  revision: number,
  contract: EntityActionContract | undefined,
  unmet: readonly {
    readonly criterionRef: string;
    readonly nextActions: readonly string[];
  }[],
  error: unknown,
): WriteReceipt | null {
  if (!contract) return null;
  const rejected = cell.failed(
      cell.errorOperationId(error) ?? cell.operationId(action, binding, cell.input.repoId, revision),
      error,
    ),
    withCriteria = attachTaskActionCriteria(cell, action, binding, revision, contract, unmet, rejected);
  return withCriteria.unmetCriteria?.length ? withCriteria : null;
}

function taskActionRejection(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  revision: number,
  contract: EntityActionContract,
  unmet: readonly {
    readonly criterionRef: string;
    readonly nextActions: readonly string[];
  }[],
  rejected?: WriteReceipt,
): WriteReceipt {
  const unmetCriteria: readonly EntityActionUnmetCriterionV1[] = unmet.map(({ criterionRef }) => {
      const criterion = contract.criteria.find(({ ref }) => ref === criterionRef);
      if (!criterion) throw new Error(`Task Action ${contract.id} criterion ${criterionRef} is not declared.`);
      return criterion;
    }),
    nextActions = Object.freeze([
      ...new Set([
        ...(rejected?.nextActions ?? []),
        ...(rejected?.nextAction ? [rejected.nextAction] : []),
        ...unmet.flatMap(({ nextActions: next }) => next),
      ]),
    ]),
    first = unmetCriteria[0]!;
  return {
    ...(rejected ??
      cell.rejected(
        cell.operationId(action, binding, cell.input.repoId, revision),
        first.failureCode,
        nextActions[0] ?? first.explain,
      )),
    unmetCriteria,
    rejectionExplanation: first.explain,
    nextActions,
  };
}

function attachTaskActionCriteria(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  revision: number,
  contract: EntityActionContract,
  unmet: readonly {
    readonly criterionRef: string;
    readonly nextActions: readonly string[];
  }[],
  rejected: WriteReceipt,
): WriteReceipt {
  const matching = unmet.filter(({ criterionRef }) =>
    contract.criteria.some(({ ref, failureCode }) => ref === criterionRef && failureCode === rejected.code),
  );
  return matching.length > 0
    ? taskActionRejection(cell, action, binding, revision, contract, matching, rejected)
    : rejected;
}
