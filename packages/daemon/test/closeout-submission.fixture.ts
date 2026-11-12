/** Exercise the production preparation/finalization ports without the command-runner fixture. */
import { finalizeCloseoutSubmission, readCloseoutSubmission as finalize } from "../src/repo-cell-submit.ts";
import { prepareSubmissionDelivery } from "../src/submission-delivery.ts";

type FinalizeArgs = Parameters<typeof finalizeCloseoutSubmission>;
type DeriveArgs = [
  cell: FinalizeArgs[0],
  taskId: string,
  executionId: string,
  snapshot: FinalizeArgs[3],
  bodyOverrides?: FinalizeArgs[5],
  requestedCommit?: string,
  source?: import("@harness-anything/kernel").WriteSource,
  carried?: FinalizeArgs[6],
];

export async function deriveCloseoutSubmission(...args: DeriveArgs) {
  const [cell, taskId, executionId, snapshot, body, commit, source, carried] = args,
    delivery = await prepareSubmissionDelivery(cell, taskId, executionId, snapshot, commit, source);
  return finalizeCloseoutSubmission(cell, taskId, executionId, snapshot, delivery, body, carried).submission;
}

export async function readCloseoutSubmission(...args: [...DeriveArgs, preserveLegacyCut?: boolean]) {
  const [cell, taskId, executionId, snapshot, body, commit, source, carried, preserve] = args;
  try {
    const delivery = await prepareSubmissionDelivery(cell, taskId, executionId, snapshot, commit, source);
    return finalize(cell, taskId, executionId, snapshot, delivery, body, carried, preserve);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      !["invalid_submission", "gate_mapping_invalid", "ignored_ledger_delivery"].includes(String(error.code))
    )
      throw error;
    return { ok: false as const, error };
  }
}
