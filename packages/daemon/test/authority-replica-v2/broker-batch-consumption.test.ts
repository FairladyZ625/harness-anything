// harness-test-tier: integration
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createCompoundReceiptServiceV2,
  type AuthorityOperationIntegrity
} from "../../../application/src/index.ts";
import {
  createBrokerCompoundReceiptCoordinatorV2,
  createDurableCompoundReceiptStoreV2,
  ReplicaBroker
} from "../../src/index.ts";
import { appendSnapshot, createBrokerFixture } from "../broker-test-fixture.ts";

for (const overlap of [false, true]) {
  test(`broker and compound receipts preserve per-operation paths (${overlap ? "overlapping" : "distinct"} paths)`, async () => {
    const fixture = createBrokerFixture();
    try {
    const pathA = "tasks/task_A-work/progress.md";
    const pathB = overlap ? pathA : "tasks/task_B-work/progress.md";
    await appendSnapshot(fixture, 1, { [pathA]: "base-a\n", [pathB]: "base-b\n" });
    const broker = new ReplicaBroker({
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
    await broker.synchronize();
    writeFileSync(path.join(fixture.viewRoot, pathB), "candidate-b\n");
    await broker.recordLocalChange(pathB);
    await broker.prepareSubmission(pathB, "op-B");

    const integrityA = operationIntegrity("task_A", "a");
    const integrityB = operationIntegrity(overlap ? "task_A" : "task_B", "b");
    fixture.snapshots.set("commit-2", {
      workspaceId: "workspace-tw03",
      revision: 2,
      commitSha: "commit-2",
      entries: overlap ? [
        { path: pathA, content: Buffer.from("candidate-b\n"), logicalMode: 0o644 }
      ] : [
        { path: pathA, content: Buffer.from("remote-a\n"), logicalMode: 0o644 },
        { path: pathB, content: Buffer.from("candidate-b\n"), logicalMode: 0o644 }
      ]
    });
    await fixture.changeLog.append({
      schema: "replica-change/v2",
      workspaceId: "workspace-tw03",
      revision: 2,
      opId: "op-A",
      semanticDigest: "semantic-A",
      operations: [
        { opId: "op-A", semanticDigest: "semantic-A", authorityIntegrity: integrityA },
        { opId: "op-B", semanticDigest: "semantic-B", authorityIntegrity: integrityB }
      ],
      commitSha: "commit-2",
      previousCommit: "commit-1",
      changedAt: "2026-07-23T00:00:02.000Z",
      authorityIntegrity: integrityA,
      manifest: { digest: `sha256:${"1".repeat(64)}`, entryCount: 2 },
      paths: [
        { path: pathA, blobDigest: `sha256:${"2".repeat(64)}`, mode: "100644", tombstone: false },
        { path: pathB, blobDigest: `sha256:${"3".repeat(64)}`, mode: "100644", tombstone: false }
      ]
    });

    const receipts = createCompoundReceiptServiceV2({
      store: createDurableCompoundReceiptStoreV2({ directory: path.join(fixture.root, "receipts") }),
      createWaiterId: () => "waiter-b",
      createResultToken: () => Buffer.alloc(32, 0x61).toString("base64url")
    });
    const opened = await receipts.openWaiter({
      workspaceId: "workspace-tw03",
      viewId: "view-main",
      opId: "op-B"
    });
    const coordinator = createBrokerCompoundReceiptCoordinatorV2({ broker, receipts });
    const receipt = await coordinator.recordAuthorityAndResolve(opened.identity, {
      tag: "COMMITTED",
      workspaceId: "workspace-tw03",
      opId: "op-B",
      semanticDigest: "semantic-B",
      revision: 2,
      commitSha: "commit-2",
      previousCommit: "commit-1",
      authorityIntegrity: integrityB,
      integrityTuple: {
        schema: "authority-integrity-tuple/v2",
        canonicalEventDigest: "4".repeat(64),
        changeSetDigest: "5".repeat(64),
        semanticMutationSetDigest: integrityB.semanticMutationSetDigest,
        actorAxesBindingDigest: integrityB.actorAxesBindingDigest
      }
    });

    assert.equal(broker.pathState(pathB)?.status, "CLEAN");
    assert.deepEqual(broker.pathState(pathB)?.pendingOpIds, []);
    assert.deepEqual(
      broker.pathState(pathA)?.canonicalHidden.lastChangeOpIds,
      overlap ? ["op-A", "op-B"] : ["op-A"]
    );
    assert.deepEqual(
      broker.pathState(pathB)?.canonicalHidden.lastChangeOpIds,
      overlap ? ["op-A", "op-B"] : ["op-B"]
    );
    assert.equal(receipt.origin?.tag, "APPLIED_EXACT_AT_CUT");
    assert.deepEqual(
      receipt.origin?.tag === "APPLIED_EXACT_AT_CUT"
        ? receipt.origin.witness.fingerprints.map((fingerprint) => fingerprint.path)
        : [],
      [pathB]
    );
    } finally {
      fixture.cleanup();
    }
  });
}

function operationIntegrity(taskId: string, digestByte: string): AuthorityOperationIntegrity {
  return {
    schema: "authority-operation-integrity/v2",
    semanticRequestDigest: digestByte.repeat(64),
    semanticMutationSetDigest: digestByte.repeat(64),
    mutationRegistryVersion: 1,
    actorAxesBindingDigest: "f".repeat(64),
    canonicalMutationSet: {
      registryVersion: 1,
      mutations: [{
        entity: { registryVersion: 1, entityKind: "task", canonicalRef: `task/${taskId}` },
        action: { registryVersion: 1, action: "append" }
      }]
    }
  };
}
