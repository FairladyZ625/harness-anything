import type {
  AuthorityCommittedEventPublisherV2,
  AuthorityCommittedReceipt,
  AuthoritySubmissionV2Options
} from "@harness-anything/application";
import type { DurableAuthorityServiceState } from "./service-state.ts";

export async function recoverProductionCommittedReceipt(input: {
  readonly operationRegistry: DurableAuthorityServiceState["operationRegistry"];
  readonly publisher: AuthorityCommittedEventPublisherV2;
  readonly workspaceId: string;
  readonly opId: string;
}): Promise<AuthorityCommittedReceipt> {
  const record = await input.operationRegistry.get(input.workspaceId, input.opId);
  if (!record) throw new Error(`AUTHORITY_OPERATION_NOT_FOUND:opId=${input.opId}`);
  if (record.receipt?.tag === "COMMITTED") return record.receipt;
  if (record.receipt?.tag === "INDETERMINATE") {
    throw new Error(`AUTHORITY_SETTLEMENT_INDETERMINATE:${record.receipt.reason}`);
  }
  if (record.receipt) {
    throw new Error(`AUTHORITY_SETTLEMENT_${record.receipt.tag}`);
  }
  const recover = (input.publisher as typeof input.publisher & {
    recoverCommittedReceipt?: NonNullable<AuthoritySubmissionV2Options["recoverCommittedReceipt"]>
  }).recoverCommittedReceipt;
  if (!recover) throw new Error("AUTHORITY_COMMITTED_RECEIPT_RECOVERY_UNAVAILABLE");
  return recover(record);
}
