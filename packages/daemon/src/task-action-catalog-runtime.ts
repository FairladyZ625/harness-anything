import {
  canStartExecution,
  evaluateTaskActionCapability,
  getExecutableEntityAction,
  heldLeaseForExecutionActor,
  revisionIssues,
  type EntityActionContract,
  type EntityActionUnmetCriterionV1,
  type TaskLifecycleCommand,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import { actionCriterionFailure, attributeCellCriterion } from "./repo-cell-errors.ts";
import { leaseTtlMs, type RepoCellBinding, type RepoTaskAction } from "./repo-cell-types.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";

const REVISION_CRITERION = "task-lifecycle-contract-support/revisionIssues";
const START_CRITERION = "task-lifecycle-command-transitions/canStartExecution";
const SUBMIT_LEASE_CRITERION = "actor-domain-services/heldLeaseForExecutionActor";

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
    evaluations =
      contract?.target.kind === "task"
        ? evaluateTaskActionCapability({ action: contract, snapshot: current.snapshot, actor: binding.actor })
        : [],
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
    if (!contract) throw new Error(`Task Action ${action.kind} is not declared.`);
    return taskActionRejection(cell, action, binding, current.snapshot.revision, contract, [
      criterionEvaluation(evaluations, START_CRITERION),
    ]);
  }
  const submitLeaseEvaluation = evaluations.find(({ criterionRef }) => criterionRef === SUBMIT_LEASE_CRITERION);
  if (action.kind === "task-submit" && submitLeaseEvaluation?.status === "unmet" && contract)
    return taskActionRejection(cell, action, binding, current.snapshot.revision, contract, [submitLeaseEvaluation]);
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
    const rejection = taskActionFailure(
      cell,
      action,
      binding,
      current.snapshot.revision,
      contract,
      evaluations,
      contract ? attributeCellCriterion(error, contract.id, invocationCriterionRef(contract)) : error,
    );
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
    const criterion = contract.criteria.find(({ ref }) => ref === REVISION_CRITERION);
    if (!criterion)
      throw new Error(`Task Action ${contract.id} does not declare its existing revisionIssues predicate.`);
    return taskActionRejection(cell, action, binding, current.snapshot.revision, contract, [
      {
        criterionRef: criterion.ref,
        nextActions: [`${criterion.explain} Then retry with --expected-version ${String(current.snapshot.revision)}.`],
      },
    ]);
  }
  if (lifecycle?.coordination === "reserve") {
    const commandFields = normalized as unknown as Readonly<Record<string, unknown>>,
      executionId = commandFields[lifecycle.targetIdField];
    if (typeof executionId !== "string")
      throw cell.cellCodedError("invalid_command", `${lifecycle.commandType} requires a target entity id.`);
    if (!canStartExecution(current.snapshot, executionId) && contract)
      return taskActionRejection(cell, action, binding, current.snapshot.revision, contract, [
        criterionEvaluation(evaluations, START_CRITERION),
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
    const rejection = taskActionFailure(cell, action, binding, current.snapshot.revision, contract, evaluations, error);
    if (rejection) return rejection;
    throw error;
  }
  let result: Awaited<ReturnType<RepoCellOperationalContext["service"]["execute"]>>;
  try {
    result = await cell.service.execute(command, authorityProof);
  } catch (error) {
    if (!isTaskLifecycleContractError(error) || !contract) throw error;
    const rejection = taskActionFailure(
      cell,
      action,
      binding,
      current.snapshot.revision,
      contract,
      evaluations,
      attributeCellCriterion(error, contract.id, invocationCriterionRef(contract)),
    );
    if (rejection) return rejection;
    throw error;
  }
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
  evaluations: readonly {
    readonly criterionRef: string;
    readonly status: string;
    readonly nextActions: readonly string[];
  }[],
  error: unknown,
): WriteReceipt | null {
  const failure = actionCriterionFailure(error);
  if (!contract || failure?.actionId !== contract.id) return null;
  const evaluation = evaluations.find(({ criterionRef }) => criterionRef === failure.criterionRef),
    rejected = cell.failed(
      cell.errorOperationId(error) ?? cell.operationId(action, binding, cell.input.repoId, revision),
      error,
    );
  return taskActionRejection(
    cell,
    action,
    binding,
    revision,
    contract,
    [
      {
        criterionRef: failure.criterionRef,
        nextActions: failure.nextActions.length ? failure.nextActions : (evaluation?.nextActions ?? []),
      },
    ],
    rejected,
  );
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
    nextActions = Object.freeze([...new Set([...unmet.flatMap(({ nextActions: next }) => next)])]),
    first = unmetCriteria[0]!;
  return {
    ...(rejected ??
      cell.rejected(
        cell.operationId(action, binding, cell.input.repoId, revision),
        first.failureCode,
        nextActions[0] ?? first.explain,
      )),
    nextAction: nextActions[0] ?? first.explain,
    evidence: `criterion:${first.ref}`,
    unmetCriteria,
    rejectionExplanation: first.explain,
    nextActions,
  };
}

function criterionEvaluation(
  evaluations: readonly {
    readonly criterionRef: string;
    readonly nextActions: readonly string[];
  }[],
  criterionRef: string,
): { readonly criterionRef: string; readonly nextActions: readonly string[] } {
  const evaluation = evaluations.find((candidate) => candidate.criterionRef === criterionRef);
  if (!evaluation) throw new Error(`Task Action criterion ${criterionRef} has no capability evaluation.`);
  return evaluation;
}

function invocationCriterionRef(contract: EntityActionContract): string {
  const suffix = `/${contract.id}.validate`,
    criterion = contract.criteria.find(({ ref }) => ref.endsWith(suffix));
  if (!criterion) throw new Error(`Task Action ${contract.id} does not declare its invocation validator criterion.`);
  return criterion.ref;
}

function isTaskLifecycleContractError(error: unknown): error is Error & { readonly issues: readonly unknown[] } {
  if (!(error instanceof Error) || error.name !== "TaskLifecycleContractError") return false;
  return Array.isArray((error as Error & { readonly issues?: unknown }).issues);
}
