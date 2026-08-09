import type {
  CommandReceipt,
  DocSyncSubmitResultV1
} from "@harness-anything/application";
import {
  pendingCommandReceiptSettlement,
  successReceipt,
  withCommandReceiptSettlement
} from "@harness-anything/daemon";

export function buildDocSyncCommandReceipt(input: {
  readonly result: Extract<DocSyncSubmitResultV1, { readonly ok: true }>;
  readonly sessionId: string;
  readonly acceptedAt: string;
  readonly includeSettlement?: boolean;
}): CommandReceipt {
  const changed = input.result.appliedChanges.length > 0;
  const base = successReceipt(
    "repo.doc.sync.submit",
    changed ? "accepted repo.doc.sync.submit" : "repo.doc.sync.submit completed with no changes (no-op)",
    input.result as unknown as import("@harness-anything/daemon").JsonObject
  );
  if (!changed || input.includeSettlement === false) return base;
  const receipt = withCommandReceiptSettlement(base, pendingCommandReceiptSettlement({
    receiptId: `doc-sync:${input.result.intentId}`,
    acceptedAt: input.acceptedAt,
    sessionId: input.sessionId,
    acceptedCommitSha: input.result.appliedLedgerSha
  }));
  if (!receipt.ok) throw new Error("DOC_SYNC_ACCEPTANCE_RECEIPT_REVERSED");
  return receipt;
}
