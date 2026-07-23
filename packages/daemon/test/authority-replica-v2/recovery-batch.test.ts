// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  createInMemoryReplicaChangeLog,
  type AuthorityCommittedReceipt,
  type AuthorityOperationRegistry,
  type AuthorityStoredOperationRecord
} from "../../../application/src/index.ts";
import type { SemanticMutationSetV2 } from "../../../kernel/src/index.ts";
import { recoverPendingProductionEvents } from "../../src/index.ts";

for (const overlap of [false, true]) {
  test(`normal recovery rebuilds one ordered multi-operation publication and returns COMMITTED receipts (${overlap ? "overlapping" : "distinct"} paths)`, async () => {
    const workspaceId = "workspace-recovery-v2";
    const mutationSets = overlap
      ? [taskMutationSet("task_A"), taskMutationSet("task_A")]
      : [taskMutationSet("task_A"), taskMutationSet("task_B")];
    const records = [
      storedRecord(workspaceId, "op-A", "a".repeat(64), mutationSets[0]!),
      storedRecord(workspaceId, "op-B", "b".repeat(64), mutationSets[1]!)
    ];
    const durable = new Map(records.map((record) => [record.opId, record]));
    const operationRegistry: AuthorityOperationRegistry = {
      get: async (_workspaceId, opId) => durable.get(opId),
      list: async () => [...durable.values()],
      put: async (record) => { durable.set(record.opId, record); }
    };
    const replicaChangeLog = createInMemoryReplicaChangeLog();
    const recovered: string[] = [];
    const physicalPaths = overlap
      ? ["tasks/task_A-work/progress.md"]
      : ["tasks/task_A-work/progress.md", "tasks/task_B-work/progress.md"];

    await recoverPendingProductionEvents({
      workspaceId,
      operationRegistry,
      replicaChangeLog,
      eventLog: {} as never,
      publicationInspector: {
        findPublicationForOperation: async () => ({
          opIds: ["op-A", "op-B"],
          commitSha: "c".repeat(40),
          previousCommit: "d".repeat(40),
          parentCommits: ["d".repeat(40), "e".repeat(40)],
          pipelineGeneratedPaths: [],
          contentAddressedPaths: [],
          physicalChanges: physicalPaths.map((path) => ({
            path,
            beforeDigest: "1".repeat(64),
            afterDigest: "2".repeat(64)
          }))
        })
      } as never,
      recover: async (record) => {
        recovered.push(record.opId);
        return committedReceipt(record, 1);
      }
    });

    const changes = await replicaChangeLog.changesAfter(workspaceId, 0);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.schema, "replica-change/v2");
    assert.equal(changes[0]?.revision, 1);
    assert.deepEqual(changes[0]?.operations.map((operation) => operation.opId), ["op-A", "op-B"]);
    assert.equal(changes[0]?.opId, "op-A");
    assert.equal(changes[0]?.semanticDigest, changes[0]?.operations[0]?.semanticDigest);
    assert.deepEqual(recovered.sort(), ["op-A", "op-B"]);
    assert.deepEqual([...durable.values()].map((record) => record.state), ["COMMITTED", "COMMITTED"]);
    assert.deepEqual(
      [...durable.values()].map((record) => record.receipt?.tag),
      ["COMMITTED", "COMMITTED"]
    );
  });
}

function taskMutationSet(taskId: string): SemanticMutationSetV2 {
  return {
    registryVersion: 1,
    mutations: [{
      entity: { registryVersion: 1, entityKind: "task", canonicalRef: `task/${taskId}` },
      action: { registryVersion: 1, action: "append" }
    }]
  };
}

function storedRecord(
  workspaceId: string,
  opId: string,
  semanticDigest: string,
  canonicalMutationSet: SemanticMutationSetV2
): AuthorityStoredOperationRecord {
  return {
    workspaceId,
    opId,
    semanticDigest,
    state: "PUBLISHED",
    commitSha: "c".repeat(40),
    authorityIntegrity: {
      schema: "authority-operation-integrity/v2",
      semanticRequestDigest: semanticDigest,
      semanticMutationSetDigest: semanticDigest,
      mutationRegistryVersion: 1,
      actorAxesBindingDigest: "f".repeat(64),
      canonicalMutationSet
    },
    recordedProtocol: {
      kind: "semantic-mutation-envelope/v2",
      schemaTuple: {
        wire: 2,
        event: 2,
        receipt: 2,
        digest: 2,
        policy: 2,
        commandRegistry: 1,
        entityRegistry: 1,
        mutationRegistry: 1,
        localState: 1,
        applyJournal: 1
      }
    },
    canonicalRequestEnvelope: "durable-envelope"
  };
}

function committedReceipt(record: AuthorityStoredOperationRecord, revision: number): AuthorityCommittedReceipt {
  return {
    tag: "COMMITTED",
    workspaceId: record.workspaceId,
    opId: record.opId,
    semanticDigest: record.semanticDigest,
    revision,
    commitSha: record.commitSha!,
    previousCommit: "d".repeat(40),
    authorityIntegrity: record.authorityIntegrity
  };
}
