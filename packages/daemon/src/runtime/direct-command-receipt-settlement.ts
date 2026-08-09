import type {
  AuthorityOperationReceipt,
  CommandReceiptEnvelope
} from "@harness-anything/application";
import type { AuthorityDurableAcceptance } from "./authority-durable-acceptance-context.ts";
import {
  failedCommandReceiptSettlement,
  pendingCommandReceiptSettlement,
  settlementFailure,
  visibleCommandReceiptSettlement,
  withCommandReceiptSettlement
} from "./command-receipt-settlement.ts";
import { ReceiptSettlementStore } from "./receipt-settlement-store.ts";

export interface CapturedAuthorityDurableSubmission {
  acceptance?: AuthorityDurableAcceptance;
  readonly settlement: Promise<AuthorityOperationReceipt>;
}

export function settleDirectAuthorityCommandReceipt(input: {
  readonly receipt: CommandReceiptEnvelope;
  readonly submissions: ReadonlyArray<CapturedAuthorityDurableSubmission>;
  readonly store: ReceiptSettlementStore;
  readonly now: () => Date;
}): CommandReceiptEnvelope {
  const acceptances = input.submissions.flatMap((entry) =>
    entry.acceptance ? [entry.acceptance] : []
  );
  if (acceptances.length === 0) return input.receipt;
  const lastAcceptance = acceptances.at(-1)!;
  const pending = pendingCommandReceiptSettlement({
    receiptId: `repo-write-direct:${lastAcceptance.flush.watermark}`,
    acceptedAt: input.now().toISOString(),
    sessionId: lastAcceptance.sessionId,
    acceptedCommitSha: lastAcceptance.acceptedCommitSha,
    authorityOperationIds: acceptances.map((acceptance) => acceptance.flush.watermark)
  });
  const acceptedReceipt = withCommandReceiptSettlement(input.receipt, pending);
  input.store.accept(acceptedReceipt);
  void Promise.all(input.submissions.map((entry) => entry.settlement)).then(
    (evidence) => {
      const committed = evidence.filter((entry) => entry.tag === "COMMITTED");
      if (committed.length !== evidence.length || committed.length === 0) {
        throw new Error(`AUTHORITY_DIRECT_SETTLEMENT_INCOMPLETE:${evidence.map((entry) =>
          entry.tag === "INDETERMINATE" ? `${entry.tag}:${entry.reason}` : entry.tag
        ).join(",")}`);
      }
      const visible = withCommandReceiptSettlement(
        acceptedReceipt,
        visibleCommandReceiptSettlement(
          pending,
          committed.at(-1)!.commitSha,
          input.now().toISOString()
        )
      );
      input.store.visible(visible);
    }
  ).catch((error) => {
    const failed = withCommandReceiptSettlement(
      acceptedReceipt,
      failedCommandReceiptSettlement(pending, {
        failedAt: input.now().toISOString(),
        ...settlementFailure(error)
      })
    );
    input.store.fail(failed);
  });
  return acceptedReceipt;
}
