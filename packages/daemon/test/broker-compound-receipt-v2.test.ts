// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  classifyCompoundExit,
  createCompoundReceiptServiceV2,
  type AuthorityCommittedReceipt,
  type CompoundReceiptServiceV2,
  type ReceiptIdentityV2
} from "../../application/src/index.ts";
import { createDurableCompoundReceiptStoreV2 } from "../src/index.ts";
import {
  createBrokerCompoundReceiptCoordinatorV2,
  ReplicaBroker
} from "../src/index.ts";
import { appendSnapshot, createBrokerFixture, type BrokerFixture } from "./broker-test-fixture.ts";

const resultToken = Buffer.alloc(32, 0x61).toString("base64url");

test("broker compound coordinator durably prepares and acknowledges an exact same-operation candidate", async () => {
  const fixture = createBrokerFixture();
  try {
    await appendSnapshot(fixture, 1, { "tasks/a.md": "base\n" });
    const broker = exactBroker(fixture);
    await broker.synchronize();
    writeFileSync(path.join(fixture.viewRoot, "tasks/a.md"), "candidate\n");
    await broker.recordLocalChange("tasks/a.md");
    await broker.prepareSubmission("tasks/a.md", "op-2");
    await appendSnapshot(fixture, 2, { "tasks/a.md": "candidate\n" });

    const service = durableService(fixture, "waiter-exact");
    const coordinator = createBrokerCompoundReceiptCoordinatorV2({ broker, receipts: service });
    const opened = await coordinator.wire.handle({
      type: "harness-compound-receipt-wire/v1",
      kind: "OPEN_WAITER",
      requestId: "request-open",
      workspaceId: "workspace-tw03",
      viewId: "view-main",
      opId: "op-2"
    });
    assert.equal(opened.kind, "WAITER_OPENED");
    if (opened.kind !== "WAITER_OPENED") return;
    const identity = receiptIdentity(opened);

    const prepared = await coordinator.recordAuthorityAndResolve(identity, committed(identity, 2));

    assert.equal(prepared.delivery, "RESULT_PREPARED");
    assert.equal(prepared.origin?.tag, "APPLIED_EXACT_AT_CUT");
    assert.equal(prepared.origin?.tag === "APPLIED_EXACT_AT_CUT" && prepared.origin.witness.kind,
      "HISTORICAL_EXCLUDED_SET");
    assert.equal(broker.pathState("tasks/a.md")?.status, "CLEAN");
    assert.deepEqual(broker.pathState("tasks/a.md")?.pendingOpIds, []);

    const preparedFrame = coordinator.wire.resultPrepared(prepared);
    const acknowledged = await coordinator.wire.handle({
      type: "harness-compound-receipt-wire/v1",
      kind: "DELIVERY_ACK",
      workspaceId: identity.workspaceId,
      viewId: identity.viewId,
      opId: identity.opId,
      waiterId: identity.waiterId,
      resultToken: opened.resultToken,
      preparedSequence: preparedFrame.preparedSequence,
      preparedReceiptDigest: preparedFrame.preparedReceiptDigest
    });
    assert.equal(acknowledged.kind, "ACK_COMMITTED");
    if (acknowledged.kind !== "ACK_COMMITTED") return;
    assert.equal(classifyCompoundExit({ kind: "RECEIPT", receipt: acknowledged.receipt }).code, 0);

    const restarted = createBrokerCompoundReceiptCoordinatorV2({
      broker,
      receipts: createCompoundReceiptServiceV2({
        store: createDurableCompoundReceiptStoreV2({ directory: receiptDirectory(fixture) })
      })
    });
    const recovered = await restarted.wire.handle({
      type: "harness-compound-receipt-wire/v1",
      kind: "GET_WAITER",
      requestId: "request-recover",
      ...identity,
      resultToken: opened.resultToken
    });
    assert.equal(recovered.kind === "WAITER_STATE" && recovered.state, "RECEIPT");
    assert.equal(recovered.kind === "WAITER_STATE" && recovered.receipt?.terminalLSN, acknowledged.terminalLSN);
    const durableBody = readFileSync(path.join(receiptDirectory(fixture), "compound-receipt-broker-state-v2.json"), "utf8");
    assert.equal(durableBody.includes(opened.resultToken), false);
  } finally {
    fixture.cleanup();
  }
});

test("broker refuses to persist a historical witness with a different fence path set", async () => {
  const fixture = createBrokerFixture();
  try {
    await appendSnapshot(fixture, 1, { "tasks/a.md": "base\n" });
    let released = false;
    const broker = new ReplicaBroker({
      workspaceId: "workspace-tw03",
      viewId: "view-main",
      viewRoot: fixture.viewRoot,
      stateRoot: fixture.stateRoot,
      replicaChangeLog: fixture.changeLog,
      snapshotSource: fixture.snapshotSource,
      writerExclusion: { acquire: async () => ({ release: async () => { released = true; } }) },
      watcherFence: { fence: async () => ({ "another-path.md": "fence-1" }) }
    });
    await broker.synchronize();

    await assert.rejects(
      broker.barrier({ paths: ["tasks/a.md"], targetRevision: 1 }),
      /BROKER_WATCHER_FENCE_SET_MISMATCH/u
    );
    assert.equal(released, true);
    assert.deepEqual(broker.snapshotState().witnesses, {});
  } finally {
    fixture.cleanup();
  }
});

test("broker compound coordinator records an older committed revision as superseded", async () => {
  const fixture = createBrokerFixture();
  try {
    await appendSnapshot(fixture, 1, { "tasks/a.md": "one\n" });
    await appendSnapshot(fixture, 2, { "tasks/a.md": "two\n" });
    await appendSnapshot(fixture, 3, { "tasks/a.md": "three\n" });
    const broker = exactBroker(fixture);
    await broker.synchronize();
    const service = durableService(fixture, "waiter-superseded");
    const opened = await service.openWaiter({ workspaceId: "workspace-tw03", viewId: "view-main", opId: "op-2" });
    const coordinator = createBrokerCompoundReceiptCoordinatorV2({ broker, receipts: service });

    const receipt = await coordinator.recordAuthorityAndResolve(opened.identity, committed(opened.identity, 2));

    assert.deepEqual(receipt.origin, {
      tag: "SUPERSEDED",
      viewId: "view-main",
      opId: "op-2",
      committedVersion: 2,
      visibleVersion: 3
    });
    assert.equal(classifyCompoundExit({ kind: "RECEIPT", receipt }).symbol, "COMMITTED_SUPERSEDED");
    assert.deepEqual(broker.snapshotState().witnesses, {});
  } finally {
    fixture.cleanup();
  }
});

function exactBroker(fixture: BrokerFixture): ReplicaBroker {
  return new ReplicaBroker({
    workspaceId: "workspace-tw03",
    viewId: "view-main",
    viewRoot: fixture.viewRoot,
    stateRoot: fixture.stateRoot,
    replicaChangeLog: fixture.changeLog,
    snapshotSource: fixture.snapshotSource,
    writerExclusion: { acquire: async () => ({ release: async () => {} }) },
    watcherFence: {
      fence: async (paths) => Object.fromEntries(paths.map((pathName) => [pathName, `fence:${pathName}`]))
    }
  });
}

function durableService(fixture: BrokerFixture, waiterId: string): CompoundReceiptServiceV2 {
  return createCompoundReceiptServiceV2({
    store: createDurableCompoundReceiptStoreV2({ directory: receiptDirectory(fixture) }),
    createWaiterId: () => waiterId,
    createResultToken: () => resultToken
  });
}

function receiptDirectory(fixture: BrokerFixture): string {
  return path.join(fixture.root, "compound-receipts");
}

function receiptIdentity(input: {
  readonly workspaceId: string;
  readonly viewId: string;
  readonly opId: string;
  readonly waiterId: string;
}): ReceiptIdentityV2 {
  return {
    workspaceId: input.workspaceId,
    viewId: input.viewId,
    opId: input.opId,
    waiterId: input.waiterId
  };
}

function committed(identity: ReceiptIdentityV2, revision: number): AuthorityCommittedReceipt {
  return {
    tag: "COMMITTED",
    workspaceId: identity.workspaceId,
    opId: identity.opId,
    semanticDigest: "11".repeat(32),
    revision,
    commitSha: `commit-${revision}`,
    previousCommit: revision === 1 ? null : `commit-${revision - 1}`,
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
