// @slice-activation PLT-Boundary W2 daemon-owned compound receipt lifecycle query.
import { createCompoundReceiptServiceV2, type CompoundExitInput } from "@harness-anything/application";
import { createDurableCompoundReceiptStoreV2 } from "./durable-compound-receipt-store.ts";

/**
 * Top-level daemon owner for the compound exit contract. A recovered waiter is
 * classified only from durable state; this command never infers success from a
 * lost RESULT_PREPARED/ACK_COMMITTED transport frame.
 */
export async function resolveCompoundReceiptExit(input: {
  readonly stateDirectory: string;
  readonly workspaceId: string;
  readonly viewId: string;
  readonly opId: string;
  readonly waiterId: string;
  readonly resultToken: string;
}): Promise<CompoundExitInput> {
  try {
    const receipt = await createCompoundReceiptServiceV2({
      store: createDurableCompoundReceiptStoreV2({ directory: input.stateDirectory })
    }).getWaiter(input);
    return receipt ? { kind: "RECEIPT", receipt } : { kind: "INTERNAL_ERROR" };
  } catch {
    return { kind: "INTERNAL_ERROR" };
  }
}
