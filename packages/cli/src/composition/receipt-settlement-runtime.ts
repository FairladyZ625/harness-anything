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

export const receiptSettlementRecoveryPhases = [
  "inspect",
  "materializer",
  "canonical-proof",
  "authority-receipt",
  "canonical-publication",
  "settlement-store"
] as const;

export type ReceiptSettlementRecoveryPhase =
  typeof receiptSettlementRecoveryPhases[number];

export interface ReceiptSettlementRecoveryProgress {
  readonly receiptId: string;
  readonly phase: ReceiptSettlementRecoveryPhase;
  readonly status: "started" | "visible" | "failed" | "pending" | "timed-out";
}

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
  readonly onRecoveryPhase?: (phase: ReceiptSettlementRecoveryPhase) => void;
}): Promise<void> {
  try {
    await nextEventLoopTurn();
    input.onRecoveryPhase?.("materializer");
    await input.runtime.enqueueMaterializerBatch({ sessionId: input.pending.sessionId, priority: "recovery" });
    input.onRecoveryPhase?.("canonical-proof");
    const visible = withCommandReceiptSettlement(
      input.acceptedReceipt,
      visibleCommandReceiptSettlement(
        input.pending,
        canonicalCommitContaining(input.authoredRoot, input.pending.acceptedCommitSha),
        new Date().toISOString()
      )
    );
    if (!visible.ok) throw new Error("DOC_SYNC_VISIBLE_RECEIPT_REVERSED");
    input.onRecoveryPhase?.("settlement-store");
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
  readonly perReceiptTimeoutMs?: number;
  readonly onReceiptProgress?: (progress: ReceiptSettlementRecoveryProgress) => void;
  readonly shouldRecoverReceipt?: (receiptId: string) => boolean;
  readonly recoverCommittedReceipt: (opId: string) => Promise<AuthorityCommittedReceipt>;
  readonly recoverCanonicalPublication?: (input: {
    readonly outerOpId: string;
    readonly canonicalCommitSha: string;
  }) => Promise<"live-owner" | "recovered" | "terminal" | "blocked">;
}): Promise<void> {
  for (const record of input.settlements.listUnsettled()) {
    if (Date.now() >= input.deadlineAt) return;
    if (input.shouldRecoverReceipt && !input.shouldRecoverReceipt(record.receiptId)) continue;
    const pending = record.receipt.settlement;
    if (!pending || pending.canonicalVisibility !== "pending") continue;
    const durable = input.outcomes.lookup(record.receiptId);
    if (durable.state === "terminal") continue;
    const observedSettlement = input.settlements.lookup(record.receiptId);
    if (observedSettlement?.state === "failed"
      && observedSettlement.receipt.settlement?.canonicalVisibility === "failed"
      && observedSettlement.receipt.settlement.failure.retryable === false) {
      continue;
    }
    let lastPhase: ReceiptSettlementRecoveryPhase = "inspect";
    const onRecoveryPhase = (phase: ReceiptSettlementRecoveryPhase): void => {
      lastPhase = phase;
      input.onReceiptProgress?.({
        receiptId: record.receiptId,
        phase,
        status: "started"
      });
    };
    onRecoveryPhase("inspect");
    const recovery = recoverPendingSettlementRecord({
      ...input,
      record,
      pending,
      onRecoveryPhase
    });
    try {
      if (input.perReceiptTimeoutMs === undefined) {
        await recovery;
      } else {
        await waitForReceiptRecovery(
          recovery,
          Math.min(
            Math.max(1, input.perReceiptTimeoutMs),
            Math.max(1, input.deadlineAt - Date.now())
          )
        );
      }
    } catch (error) {
      if (!(error instanceof ReceiptSettlementRecoveryTimeoutError)) throw error;
      input.onReceiptProgress?.({
        receiptId: record.receiptId,
        phase: lastPhase,
        status: "timed-out"
      });
      continue;
    }
    const recovered = input.settlements.lookup(record.receiptId);
    input.onReceiptProgress?.({
      receiptId: record.receiptId,
      phase: lastPhase,
      status: recovered?.state === "canonical-visible"
        ? "visible"
        : recovered?.state ?? "pending"
    });
  }
}

async function recoverPendingSettlementRecord(input: {
  readonly settlements: ReceiptSettlementStore;
  readonly outcomes: DurableRepoWriteOutcomeStoreV1;
  readonly runtime: HarnessDaemonRuntime;
  readonly authoredRoot: string;
  readonly recoverCommittedReceipt: (opId: string) => Promise<AuthorityCommittedReceipt>;
  readonly recoverCanonicalPublication?: (input: {
    readonly outerOpId: string;
    readonly canonicalCommitSha: string;
  }) => Promise<"live-owner" | "recovered" | "terminal" | "blocked">;
  readonly record: ReturnType<ReceiptSettlementStore["listUnsettled"]>[number];
  readonly pending: PendingSettlement;
  readonly onRecoveryPhase: (phase: ReceiptSettlementRecoveryPhase) => void;
}): Promise<void> {
  const { record, pending } = input;
  const durable = input.outcomes.lookup(record.receiptId);
  if (durable.state === "proceeding"
    && durable.outcome.canonicalCommand.commandName === "doc-sync-submit") {
    try {
      await nextEventLoopTurn();
      input.onRecoveryPhase("materializer");
      await input.runtime.enqueueMaterializerBatch({ sessionId: pending.sessionId, priority: "recovery" });
      input.onRecoveryPhase("canonical-proof");
      const canonicalCommitSha = canonicalCommitContaining(
        input.authoredRoot,
        pending.acceptedCommitSha
      );
      if (!input.recoverCanonicalPublication) {
        throw new Error("DOC_SYNC_CANONICAL_PUBLICATION_RECOVERY_UNAVAILABLE");
      }
      input.onRecoveryPhase("canonical-publication");
      await input.recoverCanonicalPublication({
        outerOpId: record.receiptId,
        canonicalCommitSha
      });
    } catch (error) {
      failSettlement(input.settlements, record.receipt, pending, error);
    }
    return;
  }
  if (record.receiptId.startsWith("doc-sync:")) {
    await settleAcceptedSession({
      settlements: input.settlements,
      runtime: input.runtime,
      authoredRoot: input.authoredRoot,
      acceptedReceipt: record.receipt,
      pending,
      onRecoveryPhase: input.onRecoveryPhase
    });
    return;
  }
  if (record.receiptId.startsWith("repo-write-direct:")) {
    await recoverDirectSettlement({
      ...input,
      acceptedReceipt: record.receipt,
      pending,
      onRecoveryPhase: input.onRecoveryPhase
    });
    return;
  }
  try {
    input.onRecoveryPhase("materializer");
    await input.runtime.enqueueMaterializerBatch({ sessionId: pending.sessionId, priority: "recovery" });
    input.onRecoveryPhase("canonical-proof");
    const visible = withCommandReceiptSettlement(
      record.receipt,
      visibleCommandReceiptSettlement(
        pending,
        canonicalCommitContaining(input.authoredRoot, pending.acceptedCommitSha),
        new Date().toISOString()
      )
    );
    input.onRecoveryPhase("settlement-store");
    input.settlements.visible(visible);
  } catch (error) {
    failSettlement(input.settlements, record.receipt, pending, error);
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
    if (evidence.tag !== "COMMITTED" && evidence.tag !== "CANONICAL_PUBLICATION") {
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
  readonly onRecoveryPhase: (phase: ReceiptSettlementRecoveryPhase) => void;
}): Promise<void> {
  try {
    input.onRecoveryPhase("materializer");
    await input.runtime.enqueueMaterializerBatch({ sessionId: input.pending.sessionId, priority: "recovery" });
    const operationIds = input.pending.authorityOperationIds ?? [];
    if (operationIds.length === 0) {
      throw new Error("AUTHORITY_DIRECT_RECOVERY_OPERATION_IDS_MISSING");
    }
    input.onRecoveryPhase("authority-receipt");
    await Promise.all(operationIds.map(input.recoverCommittedReceipt));
    input.onRecoveryPhase("canonical-proof");
    const visible = withCommandReceiptSettlement(
      input.acceptedReceipt,
      visibleCommandReceiptSettlement(
        input.pending,
        canonicalCommitContaining(input.authoredRoot, input.pending.acceptedCommitSha),
        new Date().toISOString()
      )
    );
    input.onRecoveryPhase("settlement-store");
    input.settlements.visible(visible);
  } catch (error) {
    failSettlement(input.settlements, input.acceptedReceipt, input.pending, error);
  }
}

class ReceiptSettlementRecoveryTimeoutError extends Error {
  constructor() {
    super("RECEIPT_SETTLEMENT_RECOVERY_TIMEOUT");
    this.name = "ReceiptSettlementRecoveryTimeoutError";
  }
}

async function waitForReceiptRecovery(
  recovery: Promise<void>,
  timeoutMs: number
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      recovery,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ReceiptSettlementRecoveryTimeoutError()),
          timeoutMs
        );
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 5_000
    }
  ).trim();
  execFileSync(
    "git",
    ["-C", authoredRoot, "merge-base", "--is-ancestor", acceptedCommitSha, canonicalCommitSha],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, timeout: 5_000 }
  );
  return canonicalCommitSha;
}
