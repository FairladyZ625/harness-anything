import {
  actionDeclarations,
  attachReceiptAcceptance,
  isArtifactActionIngressKind,
  isSha256Digest,
  requestedAgentScopeFromAction,
  waitForReceiptAcceptance,
  type CanonicalEventStore,
  type TaskProjection,
  type WriteReceipt,
  type WriteReceiptDraft,
  type DaemonRepoMode,
} from "@harness-anything/kernel";
import type { ReceiptAcceptanceFields } from "@harness-anything/kernel/internal/domain/receipt-acceptance.ts";
import type { CommandAction, TaskCreateReceipt } from "./command-ports.ts";

const canonicalSettlementActions = new Set(
  actionDeclarations
    .filter(({ receiptSettlement }) => receiptSettlement === "canonical-acceptance")
    .map(({ kind }) => kind),
);
// Host-local effects do not claim canonical acceptance; their residency is declared by Ontology.
const ledgerFreeActions = new Set(
  actionDeclarations
    .filter(({ receiptSettlement, residency }) => receiptSettlement === "none" && residency.scope === "host-local")
    .map(({ kind }) => kind),
);

/**
 * Settlement tail of RepoCell.run: attach SQLite acceptance to durable write receipts, honor
 * receipt waits, and hold task creation until its scaffold files have materialized, so a caller
 * that immediately replaces task_plan.md merges against the settled baseline.
 */
export async function settleWriteReceipt(
  context: { readonly mode: DaemonRepoMode; readonly store: CanonicalEventStore; readonly projection: TaskProjection },
  action: CommandAction,
  receipt: WriteReceipt,
  signal?: AbortSignal,
): Promise<WriteReceipt> {
  // The local setting is already authorized and persisted. Reconcile outside the writer queue,
  // even at the same canonical revision: node policy changes never append canonical retirements.
  if (
    action.kind === "settings-update" &&
    context.mode !== "remote-edge" &&
    action.taskMaterializationPolicy !== undefined &&
    (receipt.outcome === "applied" || receipt.outcome === "no_changes")
  ) {
    await context.store.settlePendingMaterialization?.("node materialization policy update");
    const materialized = context.store.materialize({ reconcileNodePolicy: true });
    if (materialized.conflicts.length)
      receipt = {
        ...receipt,
        outcome: "pending",
        status: "unknown",
        guidance: [
          ...(receipt.guidance ?? []),
          {
            kind: "run-command",
            args: { command: `ha settings update --task-materialization-policy ${action.taskMaterializationPolicy}` },
          },
        ],
        warnings: [
          ...(receipt.warnings ?? []),
          `Local materialization conflicts: ${materialized.conflicts.join(", ")}`,
        ],
      };
  }
  if (action.kind === "agent-install" && requestedAgentScopeFromAction(action) === "local")
    return settleHostLocalReceipt(action, receipt);
  if (action.kind === "agent-delete" && receipt.proof?.durable === true && receipt.proof?.canonicalVisible === false)
    return settleHostLocalReceipt(action, receipt);
  if (action.kind === "kb-put" && receipt.proof?.durable === true && receipt.proof?.canonicalVisible === false)
    return settleHostLocalReceipt(action, receipt);
  // A locale-only settings update writes this machine's preference file, never the ledger.
  const localSettingsOnly =
    action.kind === "settings-update" &&
    receipt.effects?.length === 1 &&
    receipt.effects[0] === "settings-local/locale_changed";
  if (localSettingsOnly || ledgerFreeActions.has(action.kind)) {
    return settleHostLocalReceipt(action, receipt);
  }
  if (
    !canonicalSettlementActions.has(action.kind) &&
    !isArtifactActionIngressKind(action.kind) &&
    action.kind !== "receipt-show"
  )
    return receipt;
  const read = () => attachWriteReceiptAcceptance(context, action, receipt);
  if (action.kind === "task-create" && receipt.proof?.durable === true) return settleTaskCreateScaffold(context, read);
  if (action.kind === "migrate-import" && receipt.proof?.durable === true) {
    // Import hands back an authored id map. The batch is already durable and the writer turn
    // has ended, so settling here leaves the queue available for other commands.
    await context.store.settlePendingMaterialization?.("migration import");
    const settled = read();
    if (settled.proof?.worktreeVisible === true) return settled;
    return {
      ...settled,
      outcome: "pending",
      code: "materialization_failed",
      exitCode: 3,
      nextAction: `ha receipt show ${settled.opId} --wait worktree_visible`,
    } as WriteReceipt;
  }
  if (isRelationWrite(action) && receipt.proof?.durable === true) {
    await context.store.settlePendingMaterialization?.("relation document write");
    return read();
  }
  return action.kind === "receipt-show" && action.waitFor !== undefined
    ? waitForReceiptAcceptance(read, action.waitFor, action.timeoutMs, signal, async () => {
        await context.store.settlePendingMaterialization?.("receipt wait");
      })
    : read();
}

/** The same synchronous receipt judgment serves writer settlement and independent read sessions. */
export function attachWriteReceiptAcceptance<R extends WriteReceiptDraft>(
  context: { readonly store: CanonicalEventStore; readonly projection: TaskProjection },
  action: CommandAction,
  receipt: R,
): R & ReceiptAcceptanceFields {
  const { store } = context;
  // Fresh writes usually settle at the accepted head. The store already has its event digest,
  // so settlement can certify that cut without serializing and hashing the whole event again.
  const acceptanceStore: CanonicalEventStore =
    action.kind !== "receipt-show" && receipt.cut
      ? {
          ...store,
          publication(event) {
            const { repoId, revision, headDigest } = store.currentCut();
            return revision === event.workspaceRevision && isSha256Digest(headDigest)
              ? { commitSha: null, cut: { repoId, revision, headDigest, opId: event.opId } }
              : store.publication(event);
          },
        }
      : store;
  return relationWorktreeSettlement(
    action,
    attachReceiptAcceptance(receipt, acceptanceStore, context.projection),
    store,
  );
}

export function settleHostLocalReceipt(action: CommandAction, receipt: WriteReceipt): WriteReceipt {
  const { proof: _committedProof, ...local } = receipt;
  if (action.dryRun === true && receipt.outcome === "pending") return { ...local, acceptance: null };
  if (action.kind === "doc-materialize" && receipt.outcome === "pending")
    return {
      ...local,
      guidance: [...(local.guidance ?? []), { kind: "run-command", args: { command: "ha doc status" } }],
    };
  return receipt.outcome === "applied" || receipt.outcome === "no_changes"
    ? { ...local, status: "settled_no_write" }
    : local;
}

function relationWorktreeSettlement<R extends WriteReceiptDraft & ReceiptAcceptanceFields>(
  action: CommandAction,
  receipt: R,
  store: CanonicalEventStore,
): R {
  const relationAction =
    isRelationWrite(action) ||
    (action.kind === "receipt-show" && store.readEvent(receipt.opId)?.schema === "relation-event/v1");
  if (!relationAction) return receipt;
  if (receipt.outcome !== "applied" || !("worktree" in receipt) || receipt.worktree.state === "verified")
    return receipt;
  return {
    ...receipt,
    outcome: "pending",
    nextAction: `ha receipt show ${receipt.opId} --wait worktree_visible`,
  } as R;
}

function isRelationWrite(action: CommandAction): boolean {
  return (
    action.kind === "relation-relate" || action.kind === "relation-unrelate" || action.kind === "relation-reconfirm"
  );
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
          `Task creation for ${(settled as TaskCreateReceipt).taskId} is durable; materialization is pending. ` +
          `Wait with ha receipt show ${settled.opId} --wait worktree_visible.`,
      } as WriteReceipt)
    : settled;
}
