import {
  completionContractGap,
  evaluateTaskActionCapability,
  getTaskActionForTransition,
  TASK_LIFECYCLE_TRANSITIONS,
  taskLifecycleNextActions,
  completionGuidance,
  currentExecutionCuts,
  heldLeaseForExecutionActor,
  isSameExecution,
  isSamePerson,
  isTaskEvent,
  sameWriteSource,
  submissionDigest,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import {
  reviewResponseSubmissionIssues,
  submitExecutionStateIssues,
  submitPresetSnapshotIssues,
} from "@harness-anything/kernel/internal/domain/task-lifecycle-command-transitions.ts";
import { TaskLifecycleContractError } from "@harness-anything/kernel/internal/domain/task-lifecycle-event.ts";
import { errorCode } from "@harness-anything/kernel/internal/domain/task-lifecycle-contract-support.ts";
import { attributeCellCriterion } from "./repo-cell-errors.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";
import { assertCurrentSubmittedExecution } from "./repo-cell-execution-selection.ts";

/** Snapshot judgments shared by submit and settlement before its optional lease write. */
export function submissionSnapshotIssues(snapshot: Snapshot, executionId?: string, amend = false) {
  return [
    ...(executionId ? submitExecutionStateIssues(snapshot, { executionId, ...(amend ? { amend: true } : {}) }) : []),
    ...submitPresetSnapshotIssues(snapshot),
    ...reviewResponseSubmissionIssues(snapshot, snapshot.reviewResponses),
  ];
}

/** Shared, side-effect-free admission. A rejection is executed only at the authoritative writer cut. */
export function readSubmissionAdmission(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  snapshot: Snapshot,
) {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    current = { snapshot },
    held = heldLeaseForExecutionActor(current.snapshot, undefined, binding.actor),
    cuts = currentExecutionCuts(current.snapshot),
    selected =
      typeof action.executionId === "string"
        ? current.snapshot.executions.find((execution) => execution.executionId === action.executionId)
        : held
          ? current.snapshot.executions.find((execution) => execution.executionId === held.executionId)
          : cuts.length === 1
            ? cuts[0]
            : undefined;
  // The completion-contract judgment already names these tasks. Submit answers with the same named
  // refusal and the explicit migration instead of walking into a null snapshot below.
  const contractGap = completionContractGap(current.snapshot.task);
  if (contractGap)
    return {
      ok: false as const,
      reject: () =>
        ({
          ...cell.rejected(
            cell.operationId(action, binding, cell.input.repoId, current.snapshot.revision),
            contractGap.code,
          ),
          rejectionExplanation: `${contractGap.reason} Run ${contractGap.action}.`,
          next: [
            completionGuidance(
              current.snapshot,
              typeof action.executionId === "string" ? action.executionId : "",
              contractGap.action,
              contractGap.reason,
            ),
          ],
        }) as WriteReceiptDraft,
    };
  const ownerAmendment =
    action.amend === true &&
    action.asOwner === true &&
    current.snapshot.task !== null &&
    isSamePerson(current.snapshot.task.createdBy, binding.actor);
  // An owning principal who rejoined from a terminal holds the lease without an executor
  // descriptor; the execution still records the runtime that did the work. First submission
  // through that held lease is admitted on person identity alone — the ordinary lease, source,
  // version, and CAS checks below still gate it.
  const ownerSubmission =
    action.amend !== true &&
    selected !== undefined &&
    selected.submission === null &&
    current.snapshot.task !== null &&
    isSamePerson(current.snapshot.task.createdBy, binding.actor) &&
    isSamePerson(selected.actor, binding.actor);
  // Recovery authority is the submission event caller, not the retained execution attribution.
  const submissionOpId =
      selected?.submission && action.amend !== true
        ? cell.projection.readTaskSubmissionOperation(taskId, selected.executionId)
        : null,
    event = submissionOpId === null ? null : cell.store.readEvent(submissionOpId);
  if (selected?.submission && action.amend !== true) {
    if (
      !event ||
      !isTaskEvent(event) ||
      event.type !== "execution_submitted" ||
      event.taskId !== taskId ||
      event.payload.execution.executionId !== selected.executionId ||
      !event.payload.execution.submission ||
      submissionDigest(event.payload.execution.submission) !== submissionDigest(selected.submission) ||
      !isSameExecution(event.actor, binding.actor) ||
      !sameWriteSource(event.source, binding.source)
    )
      throw cell.cellCodedError(
        "lease_required",
        `Only the original submission holder may resume this cut.${ownerResumeLanes(current.snapshot, taskId, binding.actor)}`,
      );
  }
  if (!selected || (!isSameExecution(selected.actor, binding.actor) && !ownerAmendment && !ownerSubmission && !event))
    return { ok: false as const, reject: () => cell.lifecycleAction(action, binding) };
  const executionId = selected.executionId,
    amendCommand = `ha task submit ${taskId} --amend${
      current.snapshot.task &&
      isSamePerson(current.snapshot.task.createdBy, binding.actor) &&
      !isSameExecution(selected.actor, binding.actor)
        ? " --as-owner"
        : ""
    }`;
  if (action.amend === true) assertCurrentSubmittedExecution(current.snapshot, taskId, executionId);
  if (!selected.submission && (!held || !sameWriteSource(current.snapshot.lease?.source, binding.source)))
    return { ok: false as const, reject: () => cell.lifecycleAction(action, binding) };
  // Resume reuses a stored cut; only new submissions/amendments enter the transition.
  // Document acceptance cannot change these lifecycle facts. Reject before inventory, sync or Git.
  if (!selected.submission || action.amend === true) {
    const issues = submissionSnapshotIssues(current.snapshot, executionId, action.amend === true);
    if (issues.length) {
      const contract = getTaskActionForTransition("submit")!,
        criterionRef = contract.execution!.lifecycle!.validatorCriterionRef!,
        evaluation = evaluateTaskActionCapability({
          action: contract,
          snapshot: current.snapshot,
          actor: binding.actor,
          invocation: {
            taskId,
            executionId,
            amend: action.amend === true,
            ...(action.asOwner === true ? { asOwner: true } : {}),
          },
        }).find((value) => value.criterionRef === criterionRef),
        nextActions = evaluation?.nextActions.length
          ? evaluation.nextActions
          : taskLifecycleNextActions({
              snapshot: current.snapshot,
              actor: binding.actor,
              taskId,
              rejectedActionId: contract.id,
              actions: [...new Set(TASK_LIFECYCLE_TRANSITIONS.map(({ actionId }) => actionId))].flatMap((actionId) => {
                const candidate = getTaskActionForTransition(actionId);
                return candidate && candidate.execution?.ingress !== action.kind ? [candidate] : [];
              }),
            });
      return {
        ok: false as const,
        reject: () =>
          cell.failed(
            cell.operationId(action, binding, cell.input.repoId, current.snapshot.revision),
            attributeCellCriterion(
              new TaskLifecycleContractError(errorCode(issues), issues),
              contract.id,
              criterionRef,
              nextActions,
            ),
            contract,
            action,
          ),
      };
    }
  }
  return { ok: true as const, selected, executionId, event, amendCommand };
}

/**
 * The owning creator who is not the submission holder has one real lane onto a submitted cut that
 * is not the plain resume this refusal just denied: replace the cut in place with an owner
 * amendment. Reopen-on-findings is the reviewer's verdict, not an owner command.
 */
function ownerResumeLanes(snapshot: Snapshot, taskId: string, actor: RepoCellBinding["actor"]): string {
  const task = snapshot.task;
  if (!task || !isSamePerson(task.createdBy, actor)) return "";
  return (
    ` The owning creator may instead replace the cut with ha task submit ${taskId} --amend --as-owner, ` +
    "or wait for the reviewer verdict: changes_requested reopens rework only while the automatic rework budget " +
    `remains; after it is exhausted, the owner can return the cut with ha task rework ${taskId} --reason <why>.`
  );
}

export async function startTaskSettlement(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
) {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    current = await cell.service.read(taskId);
  if (!current.snapshot.task) throw cell.cellCodedError("entity_not_found", `Task ${taskId} does not exist.`);
  const held = heldLeaseForExecutionActor(current.snapshot, undefined, binding.actor),
    submittedCut = currentExecutionCuts(current.snapshot).find((execution) => execution.state === "submitted"),
    alreadySubmitted = submittedCut !== undefined,
    steps: WriteReceiptDraft[] = [];
  // A submitted current round needs no lease — the holder checks inside submitTask decide
  // whether this caller may resume or amend that cut. Everything else needs a held lease;
  // the ordinary start path rejoins the active round execution or starts a fresh one and
  // rejects with its own guidance when admission is impossible.
  if (!held && !alreadySubmitted) {
    cell.assertTaskWipCapacity(taskId, "active");
    const started = await cell.lifecycleAction({ kind: "task-start", taskId }, binding);
    steps.push(started);
    if (!["applied", "no_changes"].includes(started.outcome))
      return {
        ok: false as const,
        receipt: {
          ...started,
          // A nested start/submit receipt names the criteria of its own contract. The settle catalog
          // contract cannot resolve those refs, so keep the nested code and guidance but report no
          // settle criteria; the step receipt in `steps` carries the nested explanation.
          unmetCriteria: [],
          opId: cell.operationId(action, binding, cell.input.repoId, current.snapshot.revision),
          steps,
        } as WriteReceiptDraft,
      };
  }
  return { ok: true as const, steps };
}
