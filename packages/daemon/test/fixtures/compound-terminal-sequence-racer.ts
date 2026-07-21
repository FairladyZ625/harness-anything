import {
  compoundTerminalJournalSchema,
  type ReceiptIdentityV2
} from "@harness-anything/application";
import { createDurableCompoundReceiptStoreV2 } from "../../src/index.ts";

const [contenderId, receiptDirectory, identityText] = process.argv.slice(2);
if (!contenderId || !receiptDirectory || !identityText) {
  throw new Error("compound terminal sequence racer arguments missing");
}
const identity = JSON.parse(Buffer.from(identityText, "base64url").toString("utf8")) as ReceiptIdentityV2;
let barrierEntered = false;
const store = createDurableCompoundReceiptStoreV2({
  directory: receiptDirectory,
  generationFence: {
    axes: {
      machineId: "machine-terminal-sequence-race",
      daemonGeneration: 1
    },
    runExclusive: (_operationIdentity, operation) => operation(),
    assertCurrent: async () => {
      if (barrierEntered) return;
      barrierEntered = true;
      await new Promise<void>((resolve) => {
        process.once("message", (message) => {
          if (message === "release") resolve();
        });
        process.send?.({ type: "ready", contenderId });
      });
    }
  }
});

void run().catch((error: unknown) => {
  process.send?.({
    type: "error",
    contenderId,
    code: error instanceof Error && "code" in error ? error.code : undefined,
    message: error instanceof Error ? error.message : String(error)
  }, () => process.disconnect());
});

async function run(): Promise<void> {
  const current = await store.get(identity);
  if (!current) throw new Error("compound terminal sequence racer receipt missing");
  const receipt = await store.commitTerminal(identity, current.sequence, {
    schema: compoundTerminalJournalSchema,
    workspaceId: current.workspaceId,
    viewId: current.viewId,
    opId: current.opId,
    waiterId: current.waiterId,
    kind: "DETACHED",
    pinReleaseEligible: true,
    recordedAt: new Date().toISOString(),
    reason: `contender ${contenderId}`
  }, (terminalLSN) => ({
    ...current,
    delivery: "DETACHED",
    pinReleaseEligible: true,
    terminalLSN,
    sequence: current.sequence + 1,
    updatedAt: new Date().toISOString()
  }));
  if (!receipt) throw new Error("compound terminal sequence racer lost before publication");
  process.send?.({ type: "committed", contenderId, receipt }, () => process.disconnect());
}
