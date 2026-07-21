import {
  createCompoundReceiptServiceV2,
  compoundTerminalJournalSchema,
  type ReceiptIdentityV2
} from "@harness-anything/application";
import {
  createDaemonGenerationAuthorityFence,
  createDaemonGenerationWitness,
  createDurableCompoundReceiptStoreV2
} from "../../src/index.ts";

const [mode, root, endpointIdentity, machineId, generationText, receiptDirectory, identityText] = process.argv.slice(2);
if (!mode || !root || !endpointIdentity || !machineId || !generationText || !receiptDirectory || !identityText) {
  throw new Error("generation terminal racer arguments missing");
}
const daemonGeneration = Number(generationText);
const identity = JSON.parse(Buffer.from(identityText, "base64url").toString("utf8")) as ReceiptIdentityV2;
const fence = createDaemonGenerationAuthorityFence({
  authorityFence: { assertHeld: async () => undefined },
  generationWitness: createDaemonGenerationWitness({
    userRoot: root,
    endpointIdentity,
    machineId,
    daemonGeneration
  }),
  workspaceId: identity.workspaceId,
  repo: { repoId: "repo-generation-racer", canonicalRoot: root },
  runtimeRegistrationId: () => mode === "old" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222"
});
const store = createDurableCompoundReceiptStoreV2({
  directory: receiptDirectory,
  generationFence: {
    axes: {
      machineId,
      daemonGeneration,
      runtimeRegistrationId: mode === "old" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222"
    },
    runExclusive: (operationIdentity, operation) => fence.runExclusive(
      "before-terminal-journal",
      operationIdentity,
      operation
    )
  }
});

void run().catch((error: unknown) => {
  process.send?.({
    type: "error",
    code: error instanceof Error && "code" in error ? error.code : undefined,
    context: error instanceof Error && "context" in error ? error.context : undefined,
    message: error instanceof Error ? error.message : String(error)
  }, () => process.disconnect());
});

async function run(): Promise<void> {
  if (mode === "current") {
    const service = createCompoundReceiptServiceV2({ store });
    const receipt = await service.detach(identity, "replacement daemon detached");
    process.send?.({ type: "committed", receipt }, () => process.disconnect());
    return;
  }
  if (mode !== "old") throw new Error(`unknown generation racer mode: ${mode}`);
  const current = await store.get(identity);
  if (!current) throw new Error("generation racer receipt missing");
  await fence.assertHeld("before-terminal-journal", identity);
  process.send?.({ type: "validated" });
  await new Promise<void>((resolve) => process.once("message", (message) => {
    if (message === "release") resolve();
  }));
  await store.commitTerminal(identity, current.sequence, {
    schema: compoundTerminalJournalSchema,
    workspaceId: current.workspaceId,
    viewId: current.viewId,
    opId: current.opId,
    waiterId: current.waiterId,
    kind: "DETACHED",
    pinReleaseEligible: true,
    recordedAt: new Date().toISOString(),
    reason: "stale daemon detached"
  }, (terminalLSN) => ({
    ...current,
    delivery: "DETACHED",
    pinReleaseEligible: true,
    terminalLSN,
    sequence: current.sequence + 1,
    updatedAt: new Date().toISOString()
  }));
  process.send?.({ type: "unexpected-commit" }, () => process.disconnect());
}
