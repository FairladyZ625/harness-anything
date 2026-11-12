import {
  currentExecutionCuts,
  heldLeaseForExecutionActor,
  isNativeExecution,
  stableStringify,
  type WriteReceiptDraft,
  type AuthorizationDecision,
} from "@harness-anything/kernel";
import type { RepoCellApiContext } from "./repo-cell-api.ts";
import type { RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";
import { readSubmissionAdmission, submissionSnapshotIssues, startTaskSettlement } from "./submission-admission.ts";
import { prepareSubmissionDelivery, type PreparedSubmissionDelivery } from "./submission-delivery.ts";
import { readTaskRiskManifest } from "./task-risk-tier.ts";

/** Writer-local capability: action JSON cannot provide or replay a preparation. */
export const preparedSubmission = Symbol("preparedSubmission");
export type PreparedSubmissionAction = RepoTaskAction & {
  readonly [preparedSubmission]?: {
    readonly delivery?: PreparedSubmissionDelivery;
    readonly error?: unknown;
    readonly assertCurrent: (snapshot: Snapshot) => Promise<void>;
  };
};

type BeforeReadWrite = (
  execute: (authorizationDecision?: AuthorizationDecision) => Promise<WriteReceiptDraft>,
) => Promise<WriteReceiptDraft>;

export async function prepareTaskSubmission(
  context: RepoCellApiContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  beforeReadWrite: BeforeReadWrite,
): Promise<(action: RepoTaskAction, binding: RepoCellBinding) => Promise<WriteReceiptDraft>> {
  const taskId = context.extracted.requiredCellText(action.taskId, "taskId"),
    settling = action.kind === "task-settle" || (action.asOwner === true && action.amend !== true),
    submitAction = { ...action, kind: "task-submit", ...(settling ? { asOwner: false } : {}) },
    steps: WriteReceiptDraft[] = [];
  let prepared: NonNullable<PreparedSubmissionAction[typeof preparedSubmission]> | undefined = undefined;
  const execute = async (nextAction: RepoTaskAction, nextBinding: RepoCellBinding) => {
    const receipt = await context.executeAction(
      prepared ? { ...nextAction, [preparedSubmission]: prepared } : nextAction,
      nextBinding,
    );
    return steps.length
      ? {
          ...receipt,
          steps: [
            ...steps,
            ...((receipt as WriteReceiptDraft & { readonly steps?: readonly WriteReceiptDraft[] }).steps ?? []),
          ],
        }
      : receipt;
  };
  // Invalid packets and authoritative snapshot refusals take the ordinary queued path without Git.
  if (["submission", "fromFile", "jsonInput"].some((field) => action[field] !== undefined)) return execute;
  if (settling) {
    const snapshot = context.projection.read(taskId).snapshot;
    if (submissionSnapshotIssues(snapshot).length) return execute;
    if (
      !heldLeaseForExecutionActor(snapshot, undefined, binding.actor) &&
      !currentExecutionCuts(snapshot).some((execution) => execution.state === "submitted")
    ) {
      const receipt = await beforeReadWrite(async (authorizationDecision) => {
        const started = await startTaskSettlement(context.extracted, action, { ...binding, authorizationDecision });
        return started.ok
          ? (started.steps[0] ?? {
              outcome: "no_changes",
              opId: "settle-already-started",
              revision: context.projection.read(taskId).snapshot.revision,
            })
          : started.receipt;
      });
      if (receipt.outcome !== "applied" && receipt.outcome !== "no_changes") return async () => receipt;
      if (receipt.outcome === "applied") steps.push(receipt);
    }
  }
  const snapshot = context.projection.read(taskId).snapshot;
  let admission: ReturnType<typeof readSubmissionAdmission>;
  try {
    admission = readSubmissionAdmission(context.extracted, submitAction, binding, snapshot);
  } catch {
    // Run the same judgment again at the authoritative cut so its own error and guidance survive.
    return execute;
  }
  if (!admission.ok) return execute;
  const taskInputs = (current: Snapshot) => {
      const execution = current.executions.find((execution) => execution.executionId === admission.executionId);
      return stableStringify({
        task: current.task,
        execution: execution && isNativeExecution(execution) ? execution.deliveryBaseline : undefined,
        priorDeliveries: current.executions.map((execution) => execution.submission?.commitSha ?? null),
        // This immutable event owns the selected manifest, contract and previous effective tier.
        submissionOpId: context.projection.readTaskSubmissionOperation(taskId, admission.executionId),
      });
    },
    taskCut = taskInputs(snapshot),
    settings = stableStringify(context.settings.readRepository()),
    dispatches = () =>
      context.projection
        .readRuntimeDispatchesByTaskExecution(taskId, admission.executionId)
        .map(({ event }) => event.payload)
        .filter((dispatch) => dispatch.role !== "reviewer" && dispatch.cwd)
        .map((dispatch) => dispatch.cwd),
    dispatchCut = stableStringify(dispatches()),
    riskManifest = stableStringify(readTaskRiskManifest(context.rootDir));
  const result = await prepareSubmissionDelivery(
    context.extracted,
    taskId,
    admission.executionId,
    snapshot,
    typeof action.commitSha === "string" ? action.commitSha : undefined,
    binding.source,
  ).then(
    (delivery) => ({ delivery }),
    (error: unknown) => ({ error }),
  );
  prepared = {
    ...result,
    assertCurrent: async (current) => {
      if (
        taskInputs(current) !== taskCut ||
        stableStringify(context.settings.readRepository()) !== settings ||
        stableStringify(dispatches()) !== dispatchCut ||
        stableStringify(readTaskRiskManifest(context.rootDir)) !== riskManifest
      )
        throw context.cellCodedError(
          "invalid_transition",
          "Task or risk inputs changed during submission preparation; retry task submit.",
        );
      await ("delivery" in result ? result.delivery.assertCurrent() : undefined);
    },
  };
  return execute;
}
