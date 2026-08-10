// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  authorityProtocolTuple,
  canonicalAuthorityRequestDigest,
  createAuthoritySubmissionService,
  createInMemoryAuthorityOperationRegistry,
  createInMemoryReplicaChangeLog
} from "@harness-anything/application";
import { taskEntityId, withExactCommit, type WriteAttribution } from "@harness-anything/kernel";

test("generation exclusion ends at durable replica cut before derived terminal evidence", async () => {
  const memory = createInMemoryAuthorityOperationRegistry();
  const changeLog = createInMemoryReplicaChangeLog();
  let generationLockDepth = 0;
  const registry = {
    get: memory.get,
    list: memory.list,
    put: async (record: Parameters<typeof memory.put>[0]) => {
      assert.equal(
        generationLockDepth > 0,
        record.state !== "COMMITTED",
        `${record.state} used the wrong side of the generation exclusion`
      );
      await memory.put(record);
    }
  };
  const service = createAuthoritySubmissionService({
    workspaceId: "workspace-flush-lock",
    coordinatorFactory: {
      create: ({ exactWriteScope }) => withExactCommit({
        enqueue: (operation) => Effect.succeed({ opId: operation.opId, entityId: operation.entityId, accepted: true as const }),
        recover: Effect.succeed({ replayedOps: 0 })
      }, (reason) => {
        assert.equal(generationLockDepth > 0, true, "canonical flush escaped the generation exclusion");
        return Effect.succeed({ reason, opCount: 1, committed: true });
      }, exactWriteScope)
    },
    tokenVerifier: validLegacyVerifier("workspace-flush-lock"),
    operationRegistry: registry,
    replicaChangeLog: {
      ...changeLog,
      append: async (change) => {
        assert.equal(generationLockDepth > 0, true, "replica append escaped the generation exclusion");
        await changeLog.append(change);
      }
    },
    publicationInspector: {
      currentHead: async () => "head-before",
      inspectPublishedHead: async () => ({ commitSha: "head-after", parentCommits: ["head-before"] })
    },
    fenceWitness: { assertHeld: async () => undefined },
    generationFenceWitness: {
      assertHeld: async () => undefined,
      runExclusive: async (_stage, _context, operation) => {
        generationLockDepth += 1;
        try {
          return await operation();
        } finally {
          generationLockDepth -= 1;
        }
      }
    }
  });

  const receipt = await service.submit(legacyEnvelope("workspace-flush-lock", "op-flush-lock"));
  assert.equal(receipt.tag, "COMMITTED");
  assert.equal(generationLockDepth, 0);
});

function legacyEnvelope(workspaceId: string, opId: string) {
  const envelope = {
    workspaceId,
    opId,
    claimedDigest: "pending",
    command: "repo.document.write",
    operation: {
      opId,
      entityId: taskEntityId("task_GENERATION_FENCE"),
      kind: "doc_write" as const,
      payload: { path: "notes.md", body: "current only\n" }
    },
    delegationToken: "generation-token",
    channelNonceDigest: "c".repeat(64),
    protocol: authorityProtocolTuple
  };
  return { ...envelope, claimedDigest: canonicalAuthorityRequestDigest(envelope) };
}

function validLegacyVerifier(workspaceId: string) {
  return {
    verify: async ({ envelope }: { readonly envelope: ReturnType<typeof legacyEnvelope> }) => {
      const attribution: WriteAttribution = {
        actor: {
          principal: { kind: "person", personId: "person_generation" },
          executor: { kind: "agent", id: "agent_generation" }
        },
        principalSource: {
          kind: "daemon-authenticated",
          providerId: "generation-fence.test",
          credentialFingerprint: "sha256:redacted"
        },
        executorSource: "client-asserted"
      };
      return {
        attribution,
        claims: {
          tokenId: "token-generation",
          issuer: "generation-fence.test",
          keyId: "key-generation",
          workspaceId,
          deviceId: "device-generation",
          viewId: "view-generation",
          actorId: "person_generation",
          executorId: "agent_generation",
          sessionId: "session-generation",
          authorityGeneration: 1,
          channelNonceDigest: envelope.channelNonceDigest,
          protocol: authorityProtocolTuple,
          commandScopes: [envelope.command],
          pathScopes: ["harness/tasks/**"],
          maxBytes: 65_536,
          maxOps: 1,
          issuedAt: "2026-07-21T00:00:00.000Z",
          notBefore: "2026-07-21T00:00:00.000Z",
          expiresAt: "2026-07-21T01:00:00.000Z",
          revocationEpoch: 1
        }
      };
    }
  };
}
