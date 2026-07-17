// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type {
  AuthorityCommittedReceipt,
  AuthorityOperationRegistry,
  AuthorityStoredOperationRecord
} from "../../application/src/index.ts";
import type { makeLocalAuthorityAttributionEventV2Log } from "../../kernel/src/index.ts";
import { recoverPendingProductionEvents } from "../src/daemon/production-authority-lifecycle.ts";
import {
  assertPublicationMatchesMutationSet,
  type createGitCanonicalPublicationInspector
} from "../src/daemon/authority-publication-evidence.ts";

test("publication proof accepts only the declared hosted path inside a slugged task package", () => {
  const evidence = {
    commitSha: "b".repeat(40),
    previousCommit: "a".repeat(40),
    parentCommits: ["a".repeat(40), "c".repeat(40)],
    pipelineGeneratedPaths: [],
    contentAddressedPaths: [],
    physicalChanges: [{
      path: "tasks/task_T-production-route/facts.md",
      beforeDigest: null,
      afterDigest: "33".repeat(32)
    }]
  };
  const mutationSet = {
    registryVersion: 1,
    mutations: [{
      entity: { registryVersion: 1, entityKind: "fact", canonicalRef: "fact/task_T/F-TEST0001" },
      action: { registryVersion: 1, action: "create" }
    }]
  } as const;
  assertPublicationMatchesMutationSet(evidence, mutationSet);
  assert.throws(
    () => assertPublicationMatchesMutationSet({
      ...evidence,
      physicalChanges: [{
        path: "tasks/task_T-production-route/INDEX.md",
        beforeDigest: null,
        afterDigest: "44".repeat(32)
      }]
    }, mutationSet),
    /AUTHORITY_PUBLICATION_TREE_MISMATCH:tasks\/task_T-production-route\/INDEX\.md/u
  );
  assert.throws(
    () => assertPublicationMatchesMutationSet({
      ...evidence,
      physicalChanges: [{
        path: "tasks/task_X-production-route/facts.md",
        beforeDigest: null,
        afterDigest: "55".repeat(32)
      }]
    }, mutationSet),
    /AUTHORITY_PUBLICATION_TREE_MISMATCH:tasks\/task_X-production-route\/facts\.md/u
  );
});

test("restart recovery publishes one missing event for a committed effect without reapplying it", async () => {
  const record: AuthorityStoredOperationRecord = {
    workspaceId: "workspace-production",
    opId: "namespace-production:91f592f6c440131096fbc9341dcf70ed",
    semanticDigest: "a".repeat(64),
    state: "INDETERMINATE",
    receipt: {
      tag: "INDETERMINATE",
      workspaceId: "workspace-production",
      opId: "namespace-production:91f592f6c440131096fbc9341dcf70ed",
      semanticDigest: "a".repeat(64),
      reason: "PROTOCOL_DAMAGED:V2_EVENT_PUBLICATION_FAILED",
      commitSha: "b".repeat(40)
    },
    commitSha: "b".repeat(40),
    authorityIntegrity: {
      schema: "authority-operation-integrity/v2",
      semanticRequestDigest: "a".repeat(64),
      semanticMutationSetDigest: "c".repeat(64),
      mutationRegistryVersion: 1,
      actorAxesBindingDigest: "d".repeat(64),
      canonicalMutationSet: {
        registryVersion: 1,
        mutations: [{
          entity: { registryVersion: 1, entityKind: "task", canonicalRef: "task/task_RECOVERY" },
          action: { registryVersion: 1, action: "append" }
        }]
      }
    },
    recordedProtocol: {
      kind: "semantic-mutation-envelope/v2",
      schemaTuple: {
        wire: 2, event: 2, receipt: 2, digest: 2, policy: 2,
        commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1, localState: 1, applyJournal: 1
      }
    },
    canonicalRequestEnvelope: "durable-envelope"
  };
  let durable = record;
  let eventPresent = false;
  let publicationCount = 0;
  const effectApplyCount = 1;
  const operationRegistry: AuthorityOperationRegistry = {
    get: async () => durable,
    list: async () => [durable],
    put: async (next) => { durable = next; }
  };
  let change: import("../../application/src/index.ts").ReplicaChangeRecord | undefined;
  const replicaChangeLog: import("../../application/src/index.ts").ReplicaChangeLog = {
    append: async (next) => { change = next; },
    latest: async () => change,
    getByOperation: async () => change,
    changesAfter: async () => change ? [change] : []
  };
  const publicationInspector = {
    currentHead: async () => "b".repeat(40),
    inspectPublishedHead: async () => ({ commitSha: "b".repeat(40), parentCommits: ["a".repeat(40), "c".repeat(40)] }),
    inspectPublication: async () => publicationEvidence(),
    findPublication: async () => publicationEvidence(),
    findPublicationForOperation: async () => publicationEvidence()
  } as ReturnType<typeof createGitCanonicalPublicationInspector>;
  const eventLog = {
    read: () => eventPresent
      ? { workspaceId: record.workspaceId, opId: record.opId }
      : undefined
  } as unknown as ReturnType<typeof makeLocalAuthorityAttributionEventV2Log>;
  const receipt: AuthorityCommittedReceipt = {
    tag: "COMMITTED", workspaceId: record.workspaceId, opId: record.opId,
    semanticDigest: record.semanticDigest, revision: 1,
    commitSha: record.commitSha!, previousCommit: null,
    authorityIntegrity: record.authorityIntegrity,
    integrityTuple: {
      schema: "authority-integrity-tuple/v2", canonicalEventDigest: "e".repeat(64),
      changeSetDigest: "f".repeat(64), semanticMutationSetDigest: "c".repeat(64),
      actorAxesBindingDigest: "d".repeat(64)
    }
  };
  const recover = async () => {
    publicationCount += 1;
    eventPresent = true;
    return receipt;
  };

  await recoverPendingProductionEvents({
    workspaceId: record.workspaceId, operationRegistry, replicaChangeLog, eventLog, publicationInspector, recover
  });
  await recoverPendingProductionEvents({
    workspaceId: record.workspaceId, operationRegistry, replicaChangeLog, eventLog, publicationInspector, recover
  });

  assert.equal(publicationCount, 1);
  assert.equal(effectApplyCount, 1);
  assert.equal(durable.state, "COMMITTED");
  assert.deepEqual(durable.receipt, receipt);
});

test("restart recovery reports the opId and exception when fail-closed recovery is deferred", async () => {
  const record: AuthorityStoredOperationRecord = {
    workspaceId: "workspace-production",
    opId: "namespace-production:deferred-operation",
    semanticDigest: "a".repeat(64),
    state: "INDEXED",
    authorityIntegrity: {
      schema: "authority-operation-integrity/v2",
      semanticRequestDigest: "a".repeat(64),
      semanticMutationSetDigest: "c".repeat(64),
      mutationRegistryVersion: 1,
      actorAxesBindingDigest: "d".repeat(64),
      canonicalMutationSet: {
        registryVersion: 1,
        mutations: [{
          entity: { registryVersion: 1, entityKind: "task", canonicalRef: "task/task_RECOVERY" },
          action: { registryVersion: 1, action: "append" }
        }]
      }
    },
    recordedProtocol: {
      kind: "semantic-mutation-envelope/v2",
      schemaTuple: {
        wire: 2, event: 2, receipt: 2, digest: 2, policy: 2,
        commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1, localState: 1, applyJournal: 1
      }
    },
    canonicalRequestEnvelope: "durable-envelope"
  };
  const deferred: Array<{ readonly opId: string; readonly error: unknown }> = [];
  const failure = new Error("AUTHORITY_TEST_PUBLICATION_LOOKUP_FAILED");

  await recoverPendingProductionEvents({
    workspaceId: record.workspaceId,
    operationRegistry: {
      get: async () => record,
      list: async () => [record],
      put: async () => undefined
    },
    replicaChangeLog: {} as import("../../application/src/index.ts").ReplicaChangeLog,
    eventLog: {} as ReturnType<typeof makeLocalAuthorityAttributionEventV2Log>,
    publicationInspector: {
      findPublicationForOperation: async () => { throw failure; }
    } as ReturnType<typeof createGitCanonicalPublicationInspector>,
    recover: async () => { throw new Error("recovery must not run after publication lookup fails"); },
    onDeferred: async (candidate, error) => {
      deferred.push({ opId: candidate.opId, error });
    }
  });

  assert.deepEqual(deferred, [{ opId: record.opId, error: failure }]);
});

function publicationEvidence() {
  return {
    commitSha: "b".repeat(40),
    previousCommit: null,
    parentCommits: ["a".repeat(40), "c".repeat(40)],
    pipelineGeneratedPaths: [],
    contentAddressedPaths: [],
    physicalChanges: [{
      path: "tasks/task_RECOVERY-production-route/progress.md",
      beforeDigest: null,
      afterDigest: "1".repeat(64)
    }]
  };
}
