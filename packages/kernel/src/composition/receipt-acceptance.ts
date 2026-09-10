import { setTimeout as delay } from "node:timers/promises";
import {
  receiptWaitPredicates,
  unsatisfiedReceiptPredicates,
  type ReceiptWaitPredicate,
} from "../domain/receipt-acceptance.ts";
import type { CanonicalEventStore } from "./index.ts";
import type { ReceiptAcceptanceFields, ReceiptConsumerCut, ReceiptFacet } from "../domain/receipt-acceptance.ts";
import type { TaskProjection, WriteReceiptDraft } from "../index.ts";

type AcceptedCommandOutcome = NonNullable<ReturnType<CanonicalEventStore["readCommandOutcome"]>> & {
  readonly status: "accepted_durable";
  readonly firstRevision: number;
  readonly lastRevision: number;
};

/** Resolve only a committed command with its complete acceptance interval. */
export function readAcceptedCommandOutcome(store: CanonicalEventStore, opId: string): AcceptedCommandOutcome | null {
  const outcome = store.readCommandOutcome(opId);
  return outcome?.status === "accepted_durable" && outcome.firstRevision !== null && outcome.lastRevision !== null
    ? (outcome as AcceptedCommandOutcome)
    : null;
}

/** Query the accepting database after execution; draft outcomes never certify durability. */
export function attachReceiptAcceptance<R extends WriteReceiptDraft>(
  receipt: R,
  store: CanonicalEventStore,
  projection: TaskProjection,
): R & ReceiptAcceptanceFields {
  const outcome = readAcceptedCommandOutcome(store, receipt.opId);
  const pending = { state: "pending", cut: null } as const;
  const empty = {
    ...("worktreeVisible" in receipt ? { worktreeVisible: false } : {}),
    ...("canonicalVisible" in receipt ? { canonicalVisible: false } : {}),
    acceptance: null,
    projection: pending,
    git: { ...pending, commitSha: null },
    worktree: pending,
    replica: { state: "not_configured", cut: null },
  } as const;
  // A rejected invocation may reuse an operation id belonging to an older accepted intent.
  // Observing that older outcome must not turn this rejection into a successful write.
  const { cut: _cut, commitSha: _commitSha, proof: _proof, ...unprovenReceipt } = receipt;
  if (receipt.outcome === "op_rejected")
    return { ...unprovenReceipt, ...empty, status: "rejected" } as R & ReceiptAcceptanceFields;
  if (!outcome) {
    const rejected = store.readCommandOutcome(receipt.opId)?.status === "rejected" || receipt.outcome === "no_changes";
    const { revision: _revision, ...unaccepted } = unprovenReceipt;
    return {
      ...(rejected ? unprovenReceipt : unaccepted),
      ...empty,
      status: rejected ? "rejected" : "unknown",
      ...(receipt.outcome === "applied"
        ? { outcome: "indeterminate", code: "acceptance_unknown", origin: "daemon" }
        : {}),
    } as R & ReceiptAcceptanceFields;
  }
  const lastOpId = outcome.memberOpIds.at(-1)!;
  const event = store.readEvent(lastOpId);
  if (!event) throw new Error("committed command outcome has no final event");
  const { repoId, revision, headDigest } = store.publication(event).cut,
    generation = store.ledgerMetadata().generation;
  if (generation !== 1 && generation !== 2) throw new Error("store generation is invalid");
  const acceptedCut: ReceiptConsumerCut = { repoId, revision, headDigest, generation };
  const follower = store.followerStatus();
  const facet = (value: typeof follower.worktree, coversAcceptance: boolean): ReceiptFacet => ({
    state: value.status === "verified" && !coversAcceptance ? "pending" : value.status,
    cut: coversAcceptance && value.cut ? { ...value.cut, generation } : null,
    ...(value.reason ? { reason: value.reason } : {}),
  });
  const gitCoversAcceptance =
    follower.git.status === "verified" &&
    follower.git.cut !== null &&
    follower.git.cut.repoId === acceptedCut.repoId &&
    follower.git.cut.revision >= acceptedCut.revision;
  const worktreeCoversAcceptance =
    follower.worktree.status === "verified" &&
    follower.worktree.cut !== null &&
    follower.worktree.cut.repoId === acceptedCut.repoId &&
    follower.worktree.cut.revision >= acceptedCut.revision;
  const projected = projection.readCut();
  const visible = projected.watermark >= outcome.lastRevision;
  const { rejectionExplanation: _rejectionExplanation, ...acceptedReceipt } = receipt;
  return {
    ...acceptedReceipt,
    ...("worktreeVisible" in receipt ? { worktreeVisible: worktreeCoversAcceptance } : {}),
    ...("canonicalVisible" in receipt ? { canonicalVisible: visible } : {}),
    status: "accepted_durable",
    acceptance: {
      storage: "sqlite",
      durability: "local_fsync",
      recordedAt: outcome.recordedAt,
      revisionFrom: outcome.firstRevision,
      revisionTo: outcome.lastRevision,
      memberOpIds: outcome.memberOpIds,
      cut: acceptedCut,
    },
    projection: { state: visible ? "verified" : "pending", cut: visible ? acceptedCut : null },
    git: {
      ...facet(follower.git, gitCoversAcceptance),
      commitSha: gitCoversAcceptance ? follower.git.commitSha : null,
    },
    worktree: facet(follower.worktree, worktreeCoversAcceptance),
    replica: empty.replica,
    outcome: receipt.outcome === "no_changes" ? "no_changes" : visible ? "applied" : "pending",
    revision: outcome.lastRevision,
    evidence: receipt.evidence ?? `sqlite-command:${outcome.opId}`,
    visibility: "center",
    proof: {
      committedRevision: outcome.lastRevision,
      appliedCut: visible ? outcome.lastRevision : projected.watermark,
      durable: true,
      canonicalVisible: visible,
      worktreeVisible: worktreeCoversAcceptance,
    },
    cut: {
      repoId: acceptedCut.repoId,
      revision: acceptedCut.revision,
      headDigest: acceptedCut.headDigest,
      opId: event.opId,
    },
    commitSha: gitCoversAcceptance ? follower.git.commitSha : null,
  } as R & ReceiptAcceptanceFields;
}

export async function waitForReceiptAcceptance<R extends WriteReceiptDraft>(
  read: () => R & ReceiptAcceptanceFields,
  predicates: unknown,
  timeoutMs: unknown,
  signal?: AbortSignal,
  settlePendingMaterialization?: () => Promise<void>,
): Promise<R & ReceiptAcceptanceFields> {
  if (
    !Array.isArray(predicates) ||
    predicates.length === 0 ||
    !predicates.every((value) => (receiptWaitPredicates as readonly unknown[]).includes(value))
  )
    throw Object.assign(
      new Error("Use accepted_durable, projection_visible, git_verified, worktree_visible, or replica_verified."),
      { code: "unsupported_wait_condition" },
    );
  const timeout = timeoutMs ?? 5000;
  if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60_000)
    throw Object.assign(new Error("Receipt wait timeout must be 0–60000 ms."), { code: "invalid_command" });
  const requested = predicates as ReceiptWaitPredicate[],
    evaluate = (receipt: R & ReceiptAcceptanceFields) => {
      if (requested.includes("replica_verified") && receipt.replica.state === "not_configured")
        throw Object.assign(new Error("Replica verification is not configured for this receipt."), {
          code: "unsupported_wait_condition",
        });
      return unsatisfiedReceiptPredicates(receipt, requested);
    },
    deadline = performance.now() + timeout;
  let receipt = read(),
    unsatisfied = evaluate(receipt);
  if (unsatisfied.length > 0 && receipt.status !== "rejected" && performance.now() < deadline) {
    // The writer's pending follower settlement is the only in-process signal that advances these
    // facets; await it once, raced against the caller's deadline, instead of rebuilding the
    // receipt on a fixed poll tick.
    await Promise.race([
      settlePendingMaterialization?.() ?? Promise.resolve(),
      delay(Math.max(1, deadline - performance.now()), undefined, { signal }),
    ]);
    receipt = read();
    unsatisfied = evaluate(receipt);
  }
  return { ...receipt, wait: { state: unsatisfied.length ? "timed_out" : "satisfied", unsatisfied } };
}
