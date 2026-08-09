import { execFileSync } from "node:child_process";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import type {
  AuthorityCommittedReceipt,
  CommandReceiptEnvelope,
  CommandReceiptSettlement
} from "@harness-anything/application";
import {
  failedCommandReceiptSettlement,
  settlementFailure,
  visibleCommandReceiptSettlement,
  withCommandReceiptSettlement,
  type DurableRepoWriteOutcomeStoreV1,
  type HarnessDaemonRuntime,
  type ReceiptSettlementStore
} from "@harness-anything/daemon";

type PendingSettlement = Extract<
  CommandReceiptSettlement,
  { readonly canonicalVisibility: "pending" }
>;

export interface ReceiptSettlementRecoveryLoop {
  readonly trigger: () => Promise<void>;
  readonly stop: () => void;
}

export function createReceiptSettlementRecoveryLoop(input: {
  readonly intervalMs: number;
  readonly recover: () => Promise<void>;
  readonly onError?: (error: unknown) => void;
}): ReceiptSettlementRecoveryLoop {
  let stopped = false;
  let active: Promise<void> | undefined;
  const trigger = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    active ??= input.recover()
      .catch((error) => input.onError?.(error))
      .finally(() => {
        active = undefined;
      });
    return active;
  };
  const timer = setInterval(() => {
    void trigger();
  }, input.intervalMs);
  timer.unref();
  return {
    trigger,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    }
  };
}

export async function settleAcceptedSession(input: {
  readonly settlements: ReceiptSettlementStore;
  readonly runtime: HarnessDaemonRuntime;
  readonly authoredRoot: string;
  readonly acceptedReceipt: CommandReceiptEnvelope;
  readonly pending: PendingSettlement;
}): Promise<void> {
  try {
    await nextEventLoopTurn();
    await input.runtime.enqueueMaterializerBatch({ sessionId: input.pending.sessionId });
    const visible = withCommandReceiptSettlement(
      input.acceptedReceipt,
      visibleCommandReceiptSettlement(
        input.pending,
        canonicalCommitContaining(input.authoredRoot, input.pending.acceptedCommitSha),
        new Date().toISOString()
      )
    );
    if (!visible.ok) throw new Error("DOC_SYNC_VISIBLE_RECEIPT_REVERSED");
    input.settlements.visible(visible);
  } catch (error) {
    failSettlement(input.settlements, input.acceptedReceipt, input.pending, error);
  }
}

export async function recoverPendingSettlementMaterialization(input: {
  readonly settlements: ReceiptSettlementStore;
  readonly outcomes: DurableRepoWriteOutcomeStoreV1;
  readonly runtime: HarnessDaemonRuntime;
  readonly authoredRoot: string;
  readonly deadlineAt: number;
  readonly recoverCommittedReceipt: (opId: string) => Promise<AuthorityCommittedReceipt>;
}): Promise<void> {
  for (const record of input.settlements.listUnsettled()) {
    if (Date.now() >= input.deadlineAt) return;
    const pending = record.receipt.settlement;
    if (!pending || pending.canonicalVisibility !== "pending") continue;
    if (input.outcomes.lookup(record.receiptId).state === "terminal") continue;
    if (record.receiptId.startsWith("doc-sync:")) {
      await settleAcceptedSession({
        settlements: input.settlements,
        runtime: input.runtime,
        authoredRoot: input.authoredRoot,
        acceptedReceipt: record.receipt,
        pending
      });
      continue;
    }
    if (record.receiptId.startsWith("repo-write-direct:")) {
      await recoverDirectSettlement({ ...input, acceptedReceipt: record.receipt, pending });
      continue;
    }
    try {
      await input.runtime.enqueueMaterializerBatch({ sessionId: pending.sessionId });
      const visible = withCommandReceiptSettlement(
        record.receipt,
        visibleCommandReceiptSettlement(
          pending,
          canonicalCommitContaining(input.authoredRoot, pending.acceptedCommitSha),
          new Date().toISOString()
        )
      );
      input.settlements.visible(visible);
    } catch (error) {
      failSettlement(input.settlements, record.receipt, pending, error);
    }
  }
}

export function reconcileTerminalSettlements(
  settlements: ReceiptSettlementStore,
  outcomes: DurableRepoWriteOutcomeStoreV1
): void {
  for (const record of settlements.listUnsettled()) {
    const pending = record.receipt.settlement;
    if (!pending || pending.canonicalVisibility !== "pending") continue;
    const durable = outcomes.lookup(record.receiptId);
    if (durable.state !== "terminal") continue;
    const evidence = durable.outcome.terminalProof.evidence;
    if (evidence.tag !== "COMMITTED") {
      const failed = withCommandReceiptSettlement(
        record.receipt,
        failedCommandReceiptSettlement(pending, {
          failedAt: new Date().toISOString(),
          stage: "publication-proof",
          code: `AUTHORITY_SETTLEMENT_${evidence.tag}`,
          message: "Durable authority acceptance did not reach a committed canonical publication."
        })
      );
      settlements.fail(failed);
      continue;
    }
    const visible = withCommandReceiptSettlement(
      record.receipt,
      visibleCommandReceiptSettlement(pending, evidence.commitSha, new Date().toISOString())
    );
    settlements.visible(visible);
  }
}

async function recoverDirectSettlement(input: {
  readonly settlements: ReceiptSettlementStore;
  readonly runtime: HarnessDaemonRuntime;
  readonly authoredRoot: string;
  readonly recoverCommittedReceipt: (opId: string) => Promise<AuthorityCommittedReceipt>;
  readonly acceptedReceipt: CommandReceiptEnvelope;
  readonly pending: PendingSettlement;
}): Promise<void> {
  try {
    await input.runtime.enqueueMaterializerBatch({ sessionId: input.pending.sessionId });
    const operationIds = input.pending.authorityOperationIds ?? [];
    if (operationIds.length === 0) {
      throw new Error("AUTHORITY_DIRECT_RECOVERY_OPERATION_IDS_MISSING");
    }
    await Promise.all(operationIds.map(input.recoverCommittedReceipt));
    const visible = withCommandReceiptSettlement(
      input.acceptedReceipt,
      visibleCommandReceiptSettlement(
        input.pending,
        canonicalCommitContaining(input.authoredRoot, input.pending.acceptedCommitSha),
        new Date().toISOString()
      )
    );
    input.settlements.visible(visible);
  } catch (error) {
    failSettlement(input.settlements, input.acceptedReceipt, input.pending, error);
  }
}

function failSettlement(
  settlements: ReceiptSettlementStore,
  receipt: CommandReceiptEnvelope,
  pending: PendingSettlement,
  error: unknown
): void {
  const failed = withCommandReceiptSettlement(
    receipt,
    failedCommandReceiptSettlement(pending, {
      failedAt: new Date().toISOString(),
      ...settlementFailure(error)
    })
  );
  settlements.fail(failed);
}

export function canonicalCommitContaining(authoredRoot: string, acceptedCommitSha: string): string {
  const canonicalCommitSha = execFileSync(
    "git",
    ["-C", authoredRoot, "rev-parse", "--verify", "HEAD^{commit}"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  ).trim();
  execFileSync(
    "git",
    ["-C", authoredRoot, "merge-base", "--is-ancestor", acceptedCommitSha, canonicalCommitSha],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }
  );
  return canonicalCommitSha;
}
