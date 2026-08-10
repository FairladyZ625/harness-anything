import type { DocSyncSubmitResultV1 } from "@harness-anything/application";
import { decodeRepoWriteCommandReceiptV2 } from "../runtime/repo-write-command-receipt.ts";
import type { RepoWriteOperationLookupResult } from "../runtime/repo-write-protocol.ts";
import { taskCompleteErrorMessage } from "./task-complete-auto-materialization-orchestration.ts";

export const defaultTaskCompleteSettlementTimeoutMs = 20_000;
const initialSettlementPollIntervalMs = 25;
const maximumSettlementPollIntervalMs = 1_000;

export async function waitForTaskCompleteCanonicalSettlement(
  result: Extract<DocSyncSubmitResultV1, { readonly ok: true }>,
  lookup: ((receiptId: string) => Promise<RepoWriteOperationLookupResult>) | undefined,
  timing: {
    readonly timeoutMs?: number;
    readonly now?: () => number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
  } = {}
): Promise<
  | { readonly settled: true }
  | {
      readonly settled: false;
      readonly code: string;
      readonly reason: string;
      readonly fix: string;
      readonly receiptId?: string;
      readonly statusCommand?: string;
      readonly recoveryArgv?: ReadonlyArray<string>;
    }
> {
  const settlement = result.settlement;
  if (result.settlementMode === "synchronous-canonical-final/v1"
    || settlement?.canonicalVisibility === "visible") return { settled: true };
  if (settlement?.canonicalVisibility === "failed") {
    return {
      settled: false,
      code: "task_complete_auto_materialization_settlement_failed",
      reason: `${settlement.failure.code}: ${settlement.failure.message}`,
      ...settlementRecovery(settlement.receiptId, settlement.statusQuery.command,
        "The document settlement failed. Inspect the receipt before retrying task completion.")
    };
  }
  if (!settlement || !lookup) {
    const recovery = settlementInternalRecovery();
    return {
      settled: false,
      code: "task_complete_auto_materialization_settlement_unavailable",
      reason: "doc sync returned no proof of canonical settlement",
      fix: recovery.fix,
      recoveryArgv: recovery.argv
    };
  }
  const now = timing.now ?? Date.now;
  const sleep = timing.sleep ?? waitBeforeTaskCompleteSettlementPoll;
  const timeoutMs = timing.timeoutMs ?? defaultTaskCompleteSettlementTimeoutMs;
  const deadline = now() + timeoutMs;
  let state = "accepted";
  let pollIntervalMs = initialSettlementPollIntervalMs;
  while (now() < deadline) {
    let observed: RepoWriteOperationLookupResult;
    try {
      observed = await lookup(settlement.receiptId);
    } catch (error) {
      return {
        settled: false,
        code: "task_complete_auto_materialization_settlement_lookup_failed",
        reason: `Settlement lookup failed: ${taskCompleteErrorMessage(error)}`,
        ...settlementRecovery(settlement.receiptId, settlement.statusQuery.command,
          "Do not resubmit this unknown result. Restore receipt lookup and inspect the known receipt before retrying task completion.")
      };
    }
    state = observed.state;
    if (observed.state === "committed") return { settled: true };
    if (observed.state === "rejected" || observed.state === "settlement-failed"
      || observed.state === "failed" || observed.state === "unknown") {
      const reason = observed.state === "settlement-failed"
        ? settlementFailureReason(observed.receipt)
        : `doc sync settlement ended in ${observed.state}`;
      return {
        settled: false,
        code: "task_complete_auto_materialization_settlement_failed",
        reason,
        ...settlementRecovery(settlement.receiptId, settlement.statusQuery.command,
          "The document settlement failed. Inspect the receipt before retrying task completion.")
      };
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingMs));
    pollIntervalMs = Math.min(pollIntervalMs * 2, maximumSettlementPollIntervalMs);
  }
  return {
    settled: false,
    code: "task_complete_auto_materialization_settlement_pending",
    reason: `doc sync settlement remained ${state} after ${timeoutMs}ms`,
    ...settlementRecovery(settlement.receiptId, settlement.statusQuery.command,
      "Do not resubmit this unknown result. Inspect the receipt and wait for canonical visibility before retrying task completion.")
  };
}

function settlementFailureReason(receipt: unknown): string {
  try {
    const decoded = decodeRepoWriteCommandReceiptV2(receipt, "$.taskCompleteSettlementReceipt");
    const failure = decoded.settlement?.canonicalVisibility === "failed"
      ? decoded.settlement.failure
      : undefined;
    return failure
      ? `${failure.code}: ${failure.message}`
      : "settlement-failed receipt did not contain a failed settlement";
  } catch (error) {
    return `settlement-failed receipt could not be decoded: ${taskCompleteErrorMessage(error)}`;
  }
}

function settlementRecovery(receiptId: string, statusCommand: string, guidance: string) {
  return {
    receiptId,
    statusCommand,
    recoveryArgv: ["ha", "receipt", "status", receiptId, "--json"],
    fix: `${guidance} Run \`${statusCommand}\`.`
  };
}

function settlementInternalRecovery() {
  const argv = ["ha", "daemon", "logs", "--json"];
  return {
    argv,
    fix: "Run `ha daemon logs --json` and inspect the internal daemon failure before retrying task completion."
  };
}

function waitBeforeTaskCompleteSettlementPoll(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
