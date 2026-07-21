// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  authorityProtocolTuple,
  canonicalAuthorityRequestDigest,
  createAuthoritySubmissionService,
  createCompoundReceiptServiceV2,
  createInMemoryAuthorityOperationRegistry,
  createInMemoryReplicaChangeLog,
  type DaemonLogAppendInput
} from "@harness-anything/application";
import { taskEntityId, type WriteAttribution } from "@harness-anything/kernel";
import {
  createDaemonGenerationAuthorityFence,
  createDaemonGenerationWitness,
  createDurableCompoundReceiptStoreV2,
  daemonGenerationFencedCode,
  publishNextDaemonGeneration,
  readOrCreateDaemonMachineId
} from "../src/index.ts";

const posixOnly = process.platform === "win32"
  ? "durable generation publication is unsupported on Windows"
  : false;

test("disease A/C: replacement rejects an old connection before canonical publication", {
  skip: posixOnly
}, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-generation-authority-fence-"));
  try {
    const endpointIdentity = path.join(root, "daemon.sock");
    const machineId = readOrCreateDaemonMachineId(root);
    const first = publishNextDaemonGeneration({
      userRoot: root,
      endpointIdentity,
      machineId,
      daemonInstanceId: "daemon-a"
    });
    const logInputs: DaemonLogAppendInput[] = [];
    const oldFence = createDaemonGenerationAuthorityFence({
      authorityFence: { assertHeld: async () => undefined },
      generationWitness: createDaemonGenerationWitness({
        userRoot: root,
        endpointIdentity,
        machineId,
        daemonGeneration: first.daemonGeneration
      }),
      workspaceId: "workspace-generation-fence",
      repo: { repoId: "repo-generation-fence", canonicalRoot: root },
      runtimeRegistrationId: () => "11111111-1111-4111-8111-111111111111",
      connectionId: "connection-old",
      logService: {
        append: async (input) => {
          logInputs.push(input);
          return {} as never;
        },
        list: async () => ({ schema: "daemon-log-page/v1", entries: [], nextCursor: null, truncated: false, droppedCount: 0 })
      }
    });
    const registry = createInMemoryAuthorityOperationRegistry();
    let flushes = 0;
    const service = createAuthoritySubmissionService({
      workspaceId: "workspace-generation-fence",
      coordinatorFactory: {
        create: () => ({
          enqueue: (operation) => Effect.succeed({ opId: operation.opId, entityId: operation.entityId, accepted: true as const }),
          flush: () => Effect.sync(() => {
            flushes += 1;
            return { reason: "explicit" as const, opCount: 1, committed: true };
          }),
          recover: Effect.succeed({ replayedOps: 0 })
        })
      },
      tokenVerifier: { verify: async () => { throw new Error("stale generation must reject before token verification"); } },
      operationRegistry: registry,
      replicaChangeLog: createInMemoryReplicaChangeLog(),
      publicationInspector: {
        currentHead: async () => null,
        inspectPublishedHead: async () => { throw new Error("stale generation must not publish"); }
      },
      fenceWitness: { assertHeld: async () => undefined },
      generationFenceWitness: oldFence
    });

    // A failed replacement consumes generation 2; the next legal owner advances to 3.
    publishNextDaemonGeneration({ userRoot: root, endpointIdentity, machineId, daemonInstanceId: "daemon-b-failed" });
    const current = publishNextDaemonGeneration({ userRoot: root, endpointIdentity, machineId, daemonInstanceId: "daemon-c" });
    const receipt = await service.submit({
      workspaceId: "workspace-generation-fence",
      opId: "op-stale-connection",
      claimedDigest: "a".repeat(64),
      command: "task.progress.append",
      operation: {
        opId: "op-stale-connection",
        entityId: "task/task_STALE",
        kind: "progress_append",
        payload: { path: "progress.md", append: "stale\n" }
      },
      delegationToken: "stale-token",
      channelNonceDigest: "b".repeat(64),
      protocol: authorityProtocolTuple
    });

    assert.equal(current.daemonGeneration, first.daemonGeneration + 2);
    assert.equal(receipt.tag, "RETRYABLE_NOT_COMMITTED");
    assert.match(receipt.tag === "RETRYABLE_NOT_COMMITTED" ? receipt.reason : "", /^DAEMON_GENERATION_FENCED:/u);
    assert.equal(flushes, 0);
    assert.deepEqual(await registry.list("workspace-generation-fence"), []);
    assert.equal(logInputs.length, 1);
    assert.equal(logInputs[0]?.errorCode, daemonGenerationFencedCode);
    const context = JSON.parse(logInputs[0]?.hint ?? "null") as Record<string, unknown>;
    assert.deepEqual(context, {
      schema: "daemon-generation-write-rejection/v1",
      machineId,
      attemptedDaemonGeneration: first.daemonGeneration,
      currentDaemonGeneration: current.daemonGeneration,
      runtimeRegistrationId: "11111111-1111-4111-8111-111111111111",
      connectionId: "connection-old",
      workspaceId: "workspace-generation-fence",
      opId: "op-stale-connection",
      stage: "before-prepare"
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("disease B: stale daemon cannot win compound terminal CAS after replacement", {
  skip: posixOnly
}, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-generation-terminal-fence-"));
  try {
    const endpointIdentity = path.join(root, "daemon.sock");
    const receiptDirectory = path.join(root, "receipts");
    const machineId = readOrCreateDaemonMachineId(root);
    const first = publishNextDaemonGeneration({ userRoot: root, endpointIdentity, machineId, daemonInstanceId: "daemon-a" });
    const oldFence = createDaemonGenerationAuthorityFence({
      authorityFence: { assertHeld: async () => undefined },
      generationWitness: createDaemonGenerationWitness({
        userRoot: root,
        endpointIdentity,
        machineId,
        daemonGeneration: first.daemonGeneration
      }),
      workspaceId: "workspace-generation-fence",
      repo: { repoId: "repo-generation-fence", canonicalRoot: root },
      runtimeRegistrationId: () => "11111111-1111-4111-8111-111111111111"
    });
    const oldService = createCompoundReceiptServiceV2({
      store: createDurableCompoundReceiptStoreV2({
        directory: receiptDirectory,
        generationFence: {
          axes: {
            machineId,
            daemonGeneration: first.daemonGeneration,
            runtimeRegistrationId: "11111111-1111-4111-8111-111111111111"
          },
          assertCurrent: (context) => oldFence.assertHeld("before-terminal-journal", context)
        }
      }),
      createWaiterId: () => "waiter-generation",
      createResultToken: () => Buffer.alloc(32, 0x61).toString("base64url")
    });
    const opened = await oldService.openWaiter({
      workspaceId: "workspace-generation-fence",
      viewId: "view-generation-fence",
      opId: "op-terminal-race"
    });
    const statePath = path.join(receiptDirectory, "compound-receipt-broker-state-v2.json");
    const before = readFileSync(statePath);
    const replacement = publishNextDaemonGeneration({
      userRoot: root,
      endpointIdentity,
      machineId,
      daemonInstanceId: "daemon-b"
    });

    await assert.rejects(oldService.detach(opened.identity, "stale daemon detached"), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === daemonGenerationFencedCode);
    assert.equal(readFileSync(statePath).equals(before), true, "stale terminal attempt changed durable receipt bytes");

    const currentWitness = createDaemonGenerationWitness({
      userRoot: root,
      endpointIdentity,
      machineId,
      daemonGeneration: replacement.daemonGeneration
    });
    const currentService = createCompoundReceiptServiceV2({
      store: createDurableCompoundReceiptStoreV2({
        directory: receiptDirectory,
        generationFence: {
          axes: {
            machineId,
            daemonGeneration: replacement.daemonGeneration,
            runtimeRegistrationId: "22222222-2222-4222-8222-222222222222"
          },
          assertCurrent: async () => currentWitness.assertCurrent()
        }
      })
    });
    const terminal = await currentService.detach(opened.identity, "replacement daemon detached");
    assert.equal(terminal.delivery, "DETACHED");
    assert.equal(terminal.daemonGeneration, replacement.daemonGeneration);
    assert.equal(terminal.runtimeRegistrationId, "22222222-2222-4222-8222-222222222222");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authority replacement between prepare and flush is fenced without a canonical effect", {
  skip: posixOnly
}, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-generation-before-publish-"));
  try {
    const endpointIdentity = path.join(root, "daemon.sock");
    const machineId = readOrCreateDaemonMachineId(root);
    const first = publishNextDaemonGeneration({ userRoot: root, endpointIdentity, machineId, daemonInstanceId: "daemon-a" });
    const generationFence = createDaemonGenerationAuthorityFence({
      authorityFence: { assertHeld: async () => undefined },
      generationWitness: createDaemonGenerationWitness({
        userRoot: root,
        endpointIdentity,
        machineId,
        daemonGeneration: first.daemonGeneration
      }),
      workspaceId: "workspace-before-publish",
      repo: { repoId: "repo-before-publish", canonicalRoot: root },
      connectionId: "connection-before-publish"
    });
    const registry = createInMemoryAuthorityOperationRegistry();
    let enqueued = 0;
    let flushed = 0;
    const service = createAuthoritySubmissionService({
      workspaceId: "workspace-before-publish",
      coordinatorFactory: {
        create: () => ({
          enqueue: (operation) => Effect.sync(() => {
            enqueued += 1;
            return { opId: operation.opId, entityId: operation.entityId, accepted: true as const };
          }),
          flush: () => Effect.sync(() => {
            flushed += 1;
            return { reason: "explicit" as const, opCount: 1, committed: true };
          }),
          recover: Effect.succeed({ replayedOps: 0 })
        })
      },
      tokenVerifier: validLegacyVerifier("workspace-before-publish"),
      operationRegistry: registry,
      replicaChangeLog: createInMemoryReplicaChangeLog(),
      publicationInspector: {
        currentHead: async () => {
          publishNextDaemonGeneration({ userRoot: root, endpointIdentity, machineId, daemonInstanceId: "daemon-b" });
          return "head-before-replacement";
        },
        inspectPublishedHead: async () => { throw new Error("stale generation must not inspect a published head"); }
      },
      fenceWitness: { assertHeld: async () => undefined },
      generationFenceWitness: generationFence
    });
    const envelope = legacyEnvelope("workspace-before-publish", "op-before-publish");

    const receipt = await service.submit(envelope);

    assert.equal(receipt.tag, "RETRYABLE_NOT_COMMITTED");
    assert.match(receipt.tag === "RETRYABLE_NOT_COMMITTED" ? receipt.reason : "", /^DAEMON_GENERATION_FENCED:/u);
    assert.equal(enqueued, 0);
    assert.equal(flushed, 0);
    assert.equal((await registry.get(envelope.workspaceId, envelope.opId))?.state, "RECEIVED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
