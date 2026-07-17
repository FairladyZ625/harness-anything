// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createCompoundReceiptServiceV2,
  createCompoundReceiptWireBrokerV1,
  createHistoricalExcludedSetWitnessV1,
  preparedReceiptDigestV2,
  type AppliedExactAtCutV2,
  type AuthorityCommittedReceipt,
  type ReceiptIdentityV2
} from "../../application/src/index.ts";
import { createProductionCompoundReceiptComposition } from "../src/daemon/compound-receipt-composition.ts";
import { createDurableCompoundReceiptStoreV2 } from "../src/receipt/durable-store-v2.ts";
import { createInMemoryReplicaChangeLog } from "../../application/src/index.ts";

const restartWorkerFlag = "--compound-receipt-restart-worker";

if (process.argv.includes(restartWorkerFlag)) {
  const [stateDirectory, root, waiterId, resultToken] = process.argv.slice(process.argv.indexOf(restartWorkerFlag) + 1);
  const composition = createProductionCompoundReceiptComposition({
    workspaceId: "workspace-production",
    viewId: "view-production",
    canonicalRoot: root!,
    stateDirectory: stateDirectory!,
    replicaChangeLog: createInMemoryReplicaChangeLog()
  });
  const recovered = await composition.recover({
    requestId: "recover-1",
    workspaceId: "workspace-production",
    viewId: "view-production",
    opId: "operation-1",
    waiterId: waiterId!,
    resultToken: resultToken!
  });
  process.stdout.write(JSON.stringify(recovered));
  process.exit(0);
}

test("production daemon composition recovers a waiter after a fresh process-style rebuild", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-compound-production-"));
  try {
    const stateDirectory = path.join(root, "state");
    const input = {
      workspaceId: "workspace-production",
      viewId: "view-production",
      canonicalRoot: root,
      stateDirectory,
      replicaChangeLog: createInMemoryReplicaChangeLog()
    };
    const first = createProductionCompoundReceiptComposition(input);
    const opened = await first.openWaiter({ requestId: "open-1", opId: "operation-1" });
    const child = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url), restartWorkerFlag,
      stateDirectory, root, opened.waiterId, opened.resultToken], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const recovered = JSON.parse(child.stdout) as { readonly state: string; readonly receipt?: { readonly waiterId: string } };
    assert.equal(recovered.state, "RECEIPT");
    assert.equal(recovered.receipt?.waiterId, opened.waiterId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ACK-loss recovery uses the top-level CLI runner's durable 12-way exit mapping", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-compound-ack-loss-"));
  try {
    const stateDirectory = path.join(root, "receipts");
    const token = Buffer.alloc(32, 0x61).toString("base64url");
    const service = createCompoundReceiptServiceV2({
      store: createDurableCompoundReceiptStoreV2({ directory: stateDirectory }),
      createWaiterId: () => "waiter-ack-loss",
      createResultToken: () => token
    });
    const wire = createCompoundReceiptWireBrokerV1(service);
    const opened = await service.openWaiter({ workspaceId: "workspace-production", viewId: "view-production", opId: "operation-ack-loss" });
    await service.recordAuthority(opened.identity, committed(opened.identity));
    await service.recordOrigin(opened.identity, exactOrigin(opened.identity));
    const prepared = await service.prepareResult(opened.identity);
    const digest = preparedReceiptDigestV2(prepared);
    // The ACK was durably committed but its response frame is deliberately lost.
    await wire.handle({
      type: "harness-compound-receipt-wire/v1",
      kind: "DELIVERY_ACK",
      ...opened.identity,
      resultToken: opened.resultToken,
      preparedSequence: prepared.sequence,
      preparedReceiptDigest: digest
    });

    const cliEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const child = spawnSync(process.execPath, ["--experimental-strip-types", cliEntry, "compound-receipt", "exit", "--json",
      "--state-dir", stateDirectory, "--workspace-id", opened.identity.workspaceId, "--view-id", opened.identity.viewId,
      "--op-id", opened.identity.opId, "--waiter-id", opened.identity.waiterId, "--result-token", opened.resultToken], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { symbol: "COMMITTED_APPLIED", exitCode: 0, authority: committed(opened.identity),
      origin: exactOrigin(opened.identity), phase: "ACK_COMMITTED", delivery: "ACK_COMMITTED", historicalCut: exactOrigin(opened.identity),
      currentLease: "NOT_REQUESTED", acknowledgement: (await service.getWaiter({ ...opened.identity, resultToken: opened.resultToken }))?.acknowledgement,
      nextAction: "Do not retry." });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function exactOrigin(identity: ReceiptIdentityV2): AppliedExactAtCutV2 {
  const witness = createHistoricalExcludedSetWitnessV1({
    cutId: "cut-production",
    epochToken: "epoch-production",
    revision: 7,
    selectedPathSetDigest: "sha256:selected",
    cutJournalLSN: 70,
    writerExclusionId: "exclusion-production",
    fingerprints: [{ path: "tasks/a.md", objectKind: "file", logicalMode: 0o644, byteSize: 1, blobDigest: "sha256:a" }],
    watcherFenceEntries: [{ path: "tasks/a.md", fenceToken: "fence-a" }]
  });
  return {
    tag: "APPLIED_EXACT_AT_CUT", viewId: identity.viewId, opId: identity.opId, version: 7,
    cutId: witness.cutId, cutKind: "WRITE_EXCLUDED", cutJournalLSN: witness.cutJournalLSN,
    verifiedAffectedDigest: witness.affectedDigest, writerExclusionId: witness.writerExclusionId,
    witness, witnessDigest: witness.canonicalWitnessDigest
  };
}

function committed(identity: ReceiptIdentityV2): AuthorityCommittedReceipt {
  return {
    tag: "COMMITTED", workspaceId: identity.workspaceId, opId: identity.opId, semanticDigest: "11".repeat(32),
    revision: 7, commitSha: "commit-7", previousCommit: "commit-6",
    authorityIntegrity: { schema: "authority-operation-integrity/v2", semanticRequestDigest: "11".repeat(32),
      semanticMutationSetDigest: "22".repeat(32), mutationRegistryVersion: 1, actorAxesBindingDigest: "33".repeat(32),
      canonicalMutationSet: { registryVersion: 1, mutations: [] } },
    integrityTuple: { schema: "authority-integrity-tuple/v2", canonicalEventDigest: "44".repeat(32),
      changeSetDigest: "55".repeat(32), semanticMutationSetDigest: "22".repeat(32), actorAxesBindingDigest: "33".repeat(32) }
  };
}
