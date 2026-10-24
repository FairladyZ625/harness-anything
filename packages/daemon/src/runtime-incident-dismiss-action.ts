import type { WriteReceiptDraft as WriteReceipt } from "@harness-anything/kernel";
import { dismissIncidentActionReceipt } from "./decision-incident-receipt.ts";
import { noChanges } from "./entity-action-write-helpers.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

/** `runtime-incident-dismiss`: the owner's explicit close of one escalated incident receipt. The
 * settle happens on the dispatch's own durable stream inside the center's single write queue, so
 * the receipt's state is exactly what every edge node's agenda read already consumes. */
export function runIncidentDismissAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
  const dispatchId = cell.requiredCellText(action.dispatchId, "dispatchId"),
    reason = cell.requiredCellText(action.reason, "reason"),
    revision = cell.store.readHead()?.revision ?? 0,
    opId = cell.operationId(action, binding, cell.input.repoId, revision),
    outcome = dismissIncidentActionReceipt(cell.rootDir, dispatchId, reason, cell.now());
  if (outcome.settled === "missing")
    throw cell.cellCodedError("entity_not_found", `Dispatch ${dispatchId} has no incident action receipt to dismiss.`);
  if (outcome.settled === "claimed")
    throw cell.cellCodedError(
      "content_not_ready",
      `Dispatch ${dispatchId} has a disposition claim in flight; retry after it settles.`,
    );
  if (outcome.settled === "already_settled")
    return noChanges({ opId, revision, evidence: JSON.stringify({ dispatchId, settled: "already_settled" }) });
  return {
    outcome: "applied",
    origin: "entity-action",
    opId,
    revision,
    evidence: JSON.stringify({ dispatchId, dismissed: true, reason }),
    visibility: "center",
  };
}
