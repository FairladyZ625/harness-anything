import {
  attachReceiptAcceptance,
  durablePolicyActions,
  waitForReceiptAcceptance,
  type CanonicalEventStore,
  type TaskProjection,
  type WriteReceipt,
} from "../../kernel/src/index.ts";
import type { RepoTaskAction } from "./repo-cell-types.ts";

/**
 * Settlement tail of RepoCell.run: attach SQLite acceptance to durable write receipts, honor
 * receipt waits, and hold task creation until its scaffold files have materialized, so a caller
 * that immediately replaces task_plan.md merges against the settled baseline.
 */
export async function settleWriteReceipt(
  context: { readonly store: CanonicalEventStore; readonly projection: TaskProjection },
  action: RepoTaskAction,
  receipt: WriteReceipt,
  signal?: AbortSignal,
): Promise<WriteReceipt> {
  if (
    action.kind === "settings-update" &&
    receipt.effects?.length === 1 &&
    receipt.effects[0] === "settings-local/locale_changed"
  )
    return receipt;
  if (
    action.kind === "projection-rebuild" ||
    action.kind === "doc-materialize" ||
    // ci-observe-pull mints a synthetic opId over a batch of separately-opId'd imports; that
    // opId is never itself an accepted command outcome, so acceptance lookup would mislabel
    // its own already-correct applied/pending outcome as acceptance_unknown.
    action.kind === "ci-observe-pull" ||
    (!(durablePolicyActions as readonly string[]).includes(action.kind) && action.kind !== "receipt-show")
  )
    return receipt;
  const read = () => attachReceiptAcceptance(receipt, context.store, context.projection);
  if (action.kind === "task-create" && receipt.proof?.durable === true) return settleTaskCreateScaffold(context, read);
  return action.kind === "receipt-show" && action.waitFor !== undefined
    ? waitForReceiptAcceptance(read, action.waitFor, action.timeoutMs, signal, async () => {
        await context.store.settlePendingMaterialization?.("receipt wait");
      })
    : read();
}

/**
 * A follower pass that errored — Git publication or worktree settlement — must not reshape the
 * durable receipt: its git and worktree facets already report pending or failed, and SQLite
 * acceptance stays the success criterion. Only a pass that settled this acceptance interval and
 * still left the scaffold behind, because a concurrent edit owns those paths, reports
 * materialization as pending so the caller waits for the worktree instead of racing it.
 */
async function settleTaskCreateScaffold(
  context: { readonly store: CanonicalEventStore },
  read: () => WriteReceipt,
): Promise<WriteReceipt> {
  await context.store.settlePendingMaterialization?.("task create");
  const settled = read();
  if (settled.proof?.worktreeVisible === true || settled.acceptance === null) return settled;
  const worktree = context.store.followerStatus().worktree;
  return worktree.cut !== null && worktree.cut.revision >= settled.acceptance.revisionTo
    ? ({
        ...settled,
        outcome: "pending",
        summary:
          "Task creation is durable; materialization is pending. " +
          `Wait with ha receipt show ${settled.opId} --wait worktree_visible.`,
      } as WriteReceipt)
    : settled;
}
