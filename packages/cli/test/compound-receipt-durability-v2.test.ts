// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createCompoundReceiptServiceV2,
  createHistoricalExcludedSetWitnessV1,
  preparedReceiptDigestV2,
  type AuthorityCommittedReceipt,
  type ReceiptIdentityV2
} from "../../application/src/index.ts";
import { createDurableCompoundReceiptStoreV2 } from "../src/receipt/index.ts";

const token = Buffer.alloc(32, 0x5a).toString("base64url");

test("durable v2 store atomically recovers ACK journal state without raw capability", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ha-receipt-v2-"));
  try {
    const initial = createCompoundReceiptServiceV2({
      store: createDurableCompoundReceiptStoreV2({ directory }),
      createWaiterId: () => "waiter-durable-v2",
      createResultToken: () => token
    });
    const opened = await initial.openWaiter({ workspaceId: "workspace-v2", viewId: "view-v2", opId: "op-v2" });
    await initial.recordAuthority(opened.identity, committed(opened.identity));
    await initial.recordOrigin(opened.identity, origin(opened.identity));
    const prepared = await initial.prepareResult(opened.identity);
    const preparedReceiptDigest = preparedReceiptDigestV2(prepared);

    const restartedStore = createDurableCompoundReceiptStoreV2({ directory });
    const restarted = createCompoundReceiptServiceV2({ store: restartedStore });
    const acknowledged = await restarted.commitAcknowledgement({
      ...opened.identity,
      resultToken: opened.resultToken,
      preparedSequence: prepared.sequence,
      preparedReceiptDigest
    });
    assert.equal(acknowledged.delivery, "ACK_COMMITTED");
    assert.equal(acknowledged.terminalLSN, 1);
    assert.equal((await restarted.getWaiter({ ...opened.identity, resultToken: token }))?.terminalLSN, 1);

    const durableBodies = readdirSync(directory)
      .map((name) => [name, readFileSync(path.join(directory, name), "utf8")] as const);
    for (const [name, body] of durableBodies) {
      assert.equal(body.includes(token), false, `raw result token must stay outside durable state file ${name}`);
    }
    const durableBody = durableBodies.map(([, body]) => body).join("\n");
    assert.match(durableBody, /"kind":"ACK_COMMITTED"/u);
    assert.match(durableBody, /"terminalLSN":1/u);
    assert.equal(durableBody.includes("resultTokenDigest"), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function origin(identity: ReceiptIdentityV2) {
  const witness = createHistoricalExcludedSetWitnessV1({
    cutId: "cut-v2",
    epochToken: "opaque-epoch-v2",
    revision: 4,
    selectedPathSetDigest: "sha256:selected",
    cutJournalLSN: 40,
    fingerprints: [{
      path: "task.md", objectKind: "file", logicalMode: 0o644, byteSize: 4, blobDigest: "sha256:file"
    }],
    watcherFenceEntries: [{ path: "task.md", fenceToken: "fence-task" }]
  });
  return {
    tag: "APPLIED_EXACT_AT_CUT" as const,
    viewId: identity.viewId,
    opId: identity.opId,
    version: 4,
    cutId: witness.cutId,
    cutKind: "WRITE_EXCLUDED" as const,
    cutJournalLSN: witness.cutJournalLSN,
    verifiedAffectedDigest: witness.affectedDigest,
    witness,
    witnessDigest: witness.canonicalWitnessDigest
  };
}

function committed(identity: ReceiptIdentityV2): AuthorityCommittedReceipt {
  return {
    tag: "COMMITTED",
    workspaceId: identity.workspaceId,
    opId: identity.opId,
    semanticDigest: "11".repeat(32),
    revision: 4,
    commitSha: "commit-4",
    previousCommit: "commit-3",
    authorityIntegrity: {
      schema: "authority-operation-integrity/v2",
      semanticRequestDigest: "11".repeat(32),
      semanticMutationSetDigest: "22".repeat(32),
      mutationRegistryVersion: 1,
      actorAxesBindingDigest: "33".repeat(32),
      canonicalMutationSet: { registryVersion: 1, mutations: [] }
    },
    integrityTuple: {
      schema: "authority-integrity-tuple/v2",
      canonicalEventDigest: "44".repeat(32),
      changeSetDigest: "55".repeat(32),
      semanticMutationSetDigest: "22".repeat(32),
      actorAxesBindingDigest: "33".repeat(32)
    }
  };
}
