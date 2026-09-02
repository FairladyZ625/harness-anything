import {
  VcsCommandError,
  completionBlockers,
  getExecutableEntityAction,
  type EntityActionContract,
  type TaskProgressEvidence,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import { actionCriterionFailure, cellCodedError, cellCriterionError, cellErrorCode } from "./repo-cell-errors.ts";
import { gateChecks, selectedReviewId } from "./repo-cell-proof.ts";
import type { Snapshot } from "./repo-cell-types.ts";
import { diagnosticForError } from "./receipt-guidance.ts";

export function completionApplied(
  receipt: WriteReceipt,
  snapshot: Snapshot,
  executionId: string,
  steps: readonly WriteReceipt[],
): WriteReceipt {
  return {
    ...receipt,
    taskId: snapshot.task?.taskId,
    executionId,
    reviewId: selectedReviewId(snapshot, executionId),
    gateChecks: gateChecks(snapshot, executionId),
    next: [],
    steps,
  } as WriteReceipt;
}

export function completionSettlement(
  receipt: WriteReceipt,
  snapshot: Snapshot,
  executionId: string,
  steps: readonly WriteReceipt[],
  stoppedAt: string,
): WriteReceipt {
  const command = `ha receipt show ${receipt.opId}`,
    reason =
      receipt.outcome === "indeterminate"
        ? "The publication outcome is unknown; query the stable receipt before any retry."
        : receipt.outcome === "pending"
          ? "Wait for canonical settlement, then query this receipt."
          : "Resolve the rejected canonical step before retrying completion.",
    state = `${snapshot.task?.status ?? "missing"}/${snapshot.task?.currentNode ?? "missing"}`;
  return {
    ...receipt,
    ...(receipt.outcome === "pending" || receipt.outcome === "indeterminate" ? { unmetCriteria: [] } : {}),
    taskId: snapshot.task?.taskId,
    executionId,
    reviewId: selectedReviewId(snapshot, executionId),
    transition: {
      from: snapshot.task?.status === "done" ? "in_review/review" : state,
      to: state,
    },
    gateChecks: gateChecks(snapshot, executionId),
    next: [{ command, reason }],
    steps,
    stoppedAt,
  } as WriteReceipt;
}

export function completionStopped(
  opId: string,
  snapshot: Snapshot,
  executionId: string,
  blocker: ReturnType<typeof completionBlockers>[number],
  steps: readonly WriteReceipt[],
): WriteReceipt {
  const action = { kind: "task-complete", taskId: snapshot.task?.taskId },
    contract = getExecutableEntityAction(action.kind);
  if (!contract) throw cellCodedError("invalid_store", "Task complete Action contract is unavailable.");
  const receipt = failed(
    opId,
    cellCriterionError(blocker.code, blocker.next.command, "complete", "closeout-readiness/closeoutReadiness", [
      blocker.next.command,
    ]),
    contract,
    action,
  );
  return {
    ...receipt,
    taskId: snapshot.task?.taskId,
    executionId,
    reviewId: selectedReviewId(snapshot, executionId),
    transition: {
      from: `${snapshot.task?.status ?? "missing"}/${snapshot.task?.currentNode ?? "missing"}`,
      to: `${snapshot.task?.status ?? "missing"}/${snapshot.task?.currentNode ?? "missing"}`,
    },
    gateChecks: gateChecks(snapshot, executionId),
    next: [blocker.next],
    steps,
    stoppedAt: blocker.code,
  } as WriteReceipt;
}

export function rejected(opId: string, code: string): WriteReceipt {
  return {
    outcome: "op_rejected",
    opId,
    code,
    origin: "daemon",
    evidence: `rejection:${code}`,
    diagnostic: { kind: "failure", code },
  };
}

export function failed(
  opId: string,
  error: unknown,
  contract?: EntityActionContract,
  action?: Readonly<Record<string, unknown>>,
): WriteReceipt {
  const code = cellErrorCode(error);
  const receipt: WriteReceipt =
    error instanceof VcsCommandError || code === "publication_indeterminate"
      ? {
          outcome: "indeterminate",
          opId,
          code,
          origin: error instanceof VcsCommandError ? error.origin : "daemon",
          evidence: error instanceof VcsCommandError ? `git-failure:${error.command}` : "publication-cut:indeterminate",
          guidance: [{ kind: "retry-receipt", args: { opId } }],
        }
      : rejected(opId, code);
  const diagnostic = diagnosticForError(error),
    diagnosed = diagnostic ? { ...receipt, diagnostic } : receipt,
    criterionFailure = actionCriterionFailure(error);
  if (criterionFailure === null) return diagnosed;
  if (!contract || !action)
    throw cellCodedError(
      "invalid_store",
      `Criterion-bearing ${criterionFailure.actionId} failure reached settlement without its Action contract.`,
    );
  if (criterionFailure.actionId !== contract.id)
    throw cellCodedError(
      "invalid_store",
      `Action ${contract.target.kind}.${contract.id} received criterion ${criterionFailure.criterionRef} ` +
        `attributed to ${criterionFailure.actionId}.`,
    );
  const criterion = contract.criteria.find(({ ref }) => ref === criterionFailure.criterionRef);
  if (!criterion)
    throw cellCodedError(
      "invalid_store",
      `Action ${contract.target.kind}.${contract.id} does not declare criterion ${criterionFailure.criterionRef}.`,
    );
  return {
    ...diagnosed,
    evidence: `criterion:${criterion.ref}`,
    unmetCriteria: [criterion],
    rejectionExplanation: criterion.explain,
    nextActions: Object.freeze([...new Set(criterionFailure.nextActions)]),
  };
}

export function requiredCellText(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw cellCodedError("invalid_command", `${name} is required.`);
}

export function projectionReady(value: { readonly status: string }): boolean {
  return value.status === "ready";
}

export function cellStringList(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

export function progressEvidence(value: unknown): readonly TaskProgressEvidence[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw cellCodedError("invalid_progress", "evidence must be an ordered list");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object")
      throw cellCodedError("invalid_progress", "evidence entries require type, path, and summary");
    const item = entry as Record<string, unknown>;
    return {
      type: requiredCellText(item.type, "evidence.type"),
      path: requiredCellText(item.path, "evidence.path"),
      summary: requiredCellText(item.summary, "evidence.summary"),
    };
  });
}
