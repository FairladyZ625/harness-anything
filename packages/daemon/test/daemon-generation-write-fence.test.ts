// harness-test-tier: contract
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import {
  authorityProtocolTuple,
  canonicalAuthorityRequestDigest,
  createAuthoritySubmissionService,
  createCompoundReceiptServiceV2,
  createInMemoryAuthorityOperationRegistry,
  createInMemoryReplicaChangeLog
} from "@harness-anything/application";
import { taskEntityId, type WriteAttribution } from "@harness-anything/kernel";
import {
  createDaemonGenerationAuthorityFence,
  createRuntimeDaemonGenerationWitnessFence,
  createDaemonGenerationWitness,
  createDurableCompoundReceiptStoreV2,
  DaemonGenerationFencedError,
  DaemonGenerationWitnessLostError,
  daemonGenerationRecordPath,
  daemonGenerationFencedCode,
  publishNextDaemonGeneration,
  readOrCreateDaemonMachineId
} from "../src/index.ts";

const posixOnly = process.platform === "win32"
  ? "durable generation publication is unsupported on Windows"
  : false;

test("production wiring permits only generation context or explicit Windows legacy capability", () => {
  const common = {
    workspaceId: "workspace-production-wiring",
    repo: { repoId: "repo-production-wiring", canonicalRoot: "/fixture/repo" }
  };
  assert.throws(
    () => createRuntimeDaemonGenerationWitnessFence({ runtime: {}, ...common }),
    /DAEMON_GENERATION_CONTEXT_REQUIRED_FOR_PRODUCTION_AUTHORITY/u
  );
  assert.throws(
    () => createRuntimeDaemonGenerationWitnessFence({
      runtime: { daemonGenerationCapability: () => ({ mode: "generation" }) },
      ...common
    }),
    /DAEMON_GENERATION_CONTEXT_REQUIRED_FOR_PRODUCTION_AUTHORITY/u
  );
  assert.equal(createRuntimeDaemonGenerationWitnessFence({
    runtime: {
      daemonGenerationCapability: () => ({
        mode: "legacy",
        platform: "win32",
        diagnostic: "DAEMON_GENERATION_DURABILITY_UNSUPPORTED"
      })
    },
    ...common
  }), undefined);
});

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
      connectionId: "connection-old"
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
    assert.equal(receipt.tag === "RETRYABLE_NOT_COMMITTED" ? receipt.errorCode : undefined, daemonGenerationFencedCode);
    assert.equal(flushes, 0);
    assert.deepEqual(await registry.list("workspace-generation-fence"), []);
    const context = receipt.tag === "RETRYABLE_NOT_COMMITTED" ? receipt.errorContext : undefined;
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
  const children: ChildProcess[] = [];
  try {
    const endpointIdentity = path.join(root, "daemon.sock");
    const receiptDirectory = path.join(root, "receipts");
    const machineId = readOrCreateDaemonMachineId(root);
    const first = publishNextDaemonGeneration({ userRoot: root, endpointIdentity, machineId, daemonInstanceId: "daemon-a" });
    const setupService = createCompoundReceiptServiceV2({
      store: createDurableCompoundReceiptStoreV2({ directory: receiptDirectory }),
      createWaiterId: () => "waiter-generation",
      createResultToken: () => Buffer.alloc(32, 0x61).toString("base64url")
    });
    const opened = await setupService.openWaiter({
      workspaceId: "workspace-generation-fence",
      viewId: "view-generation-fence",
      opId: "op-terminal-race"
    });
    const statePath = path.join(receiptDirectory, "compound-receipt-broker-state-v2.json");
    const old = startGenerationRacer(children, [
      "old", root, endpointIdentity, machineId, String(first.daemonGeneration), receiptDirectory, encodedIdentity(opened.identity)
    ]);
    assert.equal((await nextChildMessage(old)).type, "validated");
    const replacement = publishNextDaemonGeneration({
      userRoot: root,
      endpointIdentity,
      machineId,
      daemonInstanceId: "daemon-b"
    });
    const current = startGenerationRacer(children, [
      "current", root, endpointIdentity, machineId, String(replacement.daemonGeneration), receiptDirectory, encodedIdentity(opened.identity)
    ]);
    const currentResult = await nextChildMessage(current);
    assert.equal(currentResult.type, "committed");
    const terminal = currentResult.receipt as { delivery: string; daemonGeneration: number; runtimeRegistrationId: string };
    assert.equal(terminal.delivery, "DETACHED");
    assert.equal(terminal.daemonGeneration, replacement.daemonGeneration);
    assert.equal(terminal.runtimeRegistrationId, "22222222-2222-4222-8222-222222222222");
    const afterCurrent = readFileSync(statePath);

    old.send("release");
    const staleResult = await nextChildMessage(old);
    assert.equal(staleResult.type, "error");
    assert.equal(staleResult.code, daemonGenerationFencedCode);
    assert.equal((staleResult.context as { schema?: string }).schema, "daemon-generation-write-rejection/v1");
    assert.equal(readFileSync(statePath).equals(afterCurrent), true, "stale child overwrote current terminal bytes");
  } finally {
    for (const child of children) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("two abandoned-lock contenders cannot quarantine the newly acquired winner", {
  skip: posixOnly
}, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-generation-lock-recovery-"));
  const children: ChildProcess[] = [];
  try {
    const endpointIdentity = path.join(root, "daemon.sock");
    const machineId = readOrCreateDaemonMachineId(root);
    const generation = publishNextDaemonGeneration({
      userRoot: root,
      endpointIdentity,
      machineId,
      daemonInstanceId: "daemon-lock-base"
    });
    const lockPath = `${daemonGenerationRecordPath(root, endpointIdentity)}.lock`;
    writeFileSync(lockPath, JSON.stringify({
      schema: "daemon-generation-mutation-lock/v1",
      pid: 2_147_483_647,
      hostname: os.hostname(),
      acquiredAt: "2000-01-01T00:00:00.000Z",
      ownerToken: "abandoned-owner"
    }));
    const markerA = path.join(root, "observed-a");
    const markerB = path.join(root, "observed-b");
    const releaseA = path.join(root, "release-a");
    const releaseB = path.join(root, "release-b");
    const contenderA = startLockContender(children, [
      root, endpointIdentity, machineId, String(generation.daemonGeneration), markerA, releaseA, "a"
    ]);
    const contenderB = startLockContender(children, [
      root, endpointIdentity, machineId, String(generation.daemonGeneration), markerB, releaseB, "b"
    ]);
    await Promise.all([waitForPath(markerA), waitForPath(markerB)]);

    writeFileSync(releaseA, "release", "utf8");
    assert.deepEqual(await nextChildMessage(contenderA), { type: "acquired", contenderId: "a" });
    writeFileSync(releaseB, "release", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, contenderA.pid);

    contenderA.send("release");
    assert.deepEqual(await nextChildMessage(contenderA), { type: "done", contenderId: "a" });
    assert.deepEqual(await nextChildMessage(contenderB), { type: "acquired", contenderId: "b" });
    contenderB.send("release");
    assert.deepEqual(await nextChildMessage(contenderB), { type: "done", contenderId: "b" });
  } finally {
    for (const child of children) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("a holder whose lock token is replaced cannot perform its next durable write", {
  skip: posixOnly
}, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-generation-lock-token-"));
  try {
    const endpointIdentity = path.join(root, "daemon.sock");
    const machineId = readOrCreateDaemonMachineId(root);
    const generation = publishNextDaemonGeneration({
      userRoot: root,
      endpointIdentity,
      machineId,
      daemonInstanceId: "daemon-token-owner"
    });
    const witness = createDaemonGenerationWitness({
      userRoot: root,
      endpointIdentity,
      machineId,
      daemonGeneration: generation.daemonGeneration
    });
    const receiptDirectory = path.join(root, "receipts");
    const setupService = createCompoundReceiptServiceV2({
      store: createDurableCompoundReceiptStoreV2({ directory: receiptDirectory }),
      createWaiterId: () => "waiter-lock-token",
      createResultToken: () => Buffer.alloc(32, 0x61).toString("base64url")
    });
    const opened = await setupService.openWaiter({
      workspaceId: "workspace-lock-token",
      viewId: "view-lock-token",
      opId: "op-lock-token"
    });
    const statePath = path.join(receiptDirectory, "compound-receipt-broker-state-v2.json");
    const before = readFileSync(statePath);
    const store = createDurableCompoundReceiptStoreV2({
      directory: receiptDirectory,
      generationFence: {
        axes: { machineId, daemonGeneration: generation.daemonGeneration },
        assertCurrent: async () => witness.assertCurrent(),
        runExclusive: (_identity, operation) => witness.runExclusive(operation)
      }
    });
    const lockPath = `${daemonGenerationRecordPath(root, endpointIdentity)}.lock`;

    await assert.rejects(witness.runExclusive(async () => {
      rmSync(lockPath);
      writeFileSync(lockPath, JSON.stringify({
        schema: "daemon-generation-mutation-lock/v1",
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
        ownerToken: "replacement-owner"
      }));
      await store.compareAndSet(opened.identity, opened.sequence, {
        ...opened,
        sequence: opened.sequence + 1,
        updatedAt: new Date().toISOString()
      });
    }), (error: unknown) => error instanceof DaemonGenerationWitnessLostError
      && error.reason === "exclusive-lock-lost");
    assert.equal(readFileSync(statePath).equals(before), true, "lost holder wrote durable receipt bytes");
    assert.throws(() => witness.assertCurrent(), (error: unknown) =>
      error instanceof DaemonGenerationWitnessLostError && error.reason === "exclusive-lock-lost");
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
    assert.equal(receipt.tag === "RETRYABLE_NOT_COMMITTED" ? receipt.errorCode : undefined, daemonGenerationFencedCode);
    assert.equal(enqueued, 0);
    assert.equal(flushed, 0);
    assert.equal((await registry.get(envelope.workspaceId, envelope.opId))?.state, "RECEIVED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generation exclusion spans canonical flush through the corresponding terminal record", async () => {
  const memory = createInMemoryAuthorityOperationRegistry();
  const changeLog = createInMemoryReplicaChangeLog();
  let generationLockDepth = 0;
  const registry = {
    get: memory.get,
    list: memory.list,
    put: async (record: Parameters<typeof memory.put>[0]) => {
      assert.equal(generationLockDepth > 0, true, `${record.state} escaped the generation exclusion`);
      await memory.put(record);
    }
  };
  const service = createAuthoritySubmissionService({
    workspaceId: "workspace-flush-lock",
    coordinatorFactory: {
      create: () => ({
        enqueue: (operation) => Effect.succeed({ opId: operation.opId, entityId: operation.entityId, accepted: true as const }),
        flush: () => {
          assert.equal(generationLockDepth > 0, true, "canonical flush escaped the generation exclusion");
          return Effect.succeed({ reason: "explicit" as const, opCount: 1, committed: true });
        },
        recover: Effect.succeed({ replayedOps: 0 })
      })
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

test("a process that observes post-publish staleness leaves PREPARED for current-owner recovery", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-generation-post-publish-"));
  try {
    let staleObserved = false;
    const stale = new DaemonGenerationFencedError({
      schema: "daemon-generation-write-rejection/v1",
      machineId: "machine-post-publish",
      attemptedDaemonGeneration: 1,
      currentDaemonGeneration: 2,
      workspaceId: "workspace-post-publish",
      opId: "op-post-publish",
      stage: "after-canonical-publish"
    });
    const memory = createInMemoryAuthorityOperationRegistry();
    const writes: string[] = [];
    const replicaWrites: string[] = [];
    const shadowWrites: string[] = [];
    const replica = createInMemoryReplicaChangeLog();
    const registry = {
      get: memory.get,
      list: memory.list,
      put: async (record: Parameters<typeof memory.put>[0]) => {
        writes.push(record.state);
        await memory.put(record);
      }
    };
    const service = createAuthoritySubmissionService({
      workspaceId: "workspace-post-publish",
      coordinatorFactory: {
        create: () => ({
          enqueue: (operation) => Effect.succeed({ opId: operation.opId, entityId: operation.entityId, accepted: true as const }),
          flush: () => Effect.succeed({ reason: "explicit" as const, opCount: 1, committed: true }),
          recover: Effect.succeed({ replayedOps: 0 })
        })
      },
      tokenVerifier: validLegacyVerifier("workspace-post-publish"),
      operationRegistry: registry,
      replicaChangeLog: {
        ...replica,
        append: async (change) => {
          replicaWrites.push(change.opId);
          await replica.append(change);
        }
      },
      shadowPublicationLog: {
        list: async () => [],
        append: async (entry) => { shadowWrites.push(...entry.opIds); }
      },
      publicationInspector: {
        currentHead: async () => "head-before",
        inspectPublishedHead: async () => {
          staleObserved = true;
          return { commitSha: "head-after", parentCommits: ["head-before"] };
        }
      },
      fenceWitness: { assertHeld: async () => undefined },
      generationFenceWitness: {
        assertHeld: async () => { if (staleObserved) throw stale; },
        runExclusive: async (_stage, _context, operation) => operation()
      }
    });
    const firstEnvelope = legacyEnvelope("workspace-post-publish", "op-post-publish");
    const receipt = await service.submit(firstEnvelope);

    assert.equal(receipt.tag, "INDETERMINATE");
    assert.equal(receipt.tag === "INDETERMINATE" ? receipt.errorCode : undefined, daemonGenerationFencedCode);
    assert.equal(receipt.tag === "INDETERMINATE" ? receipt.errorContext?.stage : undefined, "after-canonical-publish");
    assert.equal((await registry.get(firstEnvelope.workspaceId, firstEnvelope.opId))?.state, "PREPARED");
    assert.deepEqual(writes, ["RECEIVED", "PREPARED"]);
    assert.deepEqual(replicaWrites, []);
    assert.deepEqual(shadowWrites, []);
    assert.equal(writes.includes("COMMITTED"), false);
    assert.equal(writes.includes("INDETERMINATE"), false);
    const writesAfterObservation = writes.length;

    const retry = await service.submit(legacyEnvelope("workspace-post-publish", "op-after-stale-observed"));
    assert.equal(retry.tag, "RETRYABLE_NOT_COMMITTED");
    assert.equal(retry.tag === "RETRYABLE_NOT_COMMITTED" ? retry.errorCode : undefined, daemonGenerationFencedCode);
    assert.equal(writes.length, writesAfterObservation);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function startGenerationRacer(children: ChildProcess[], args: ReadonlyArray<string>): ChildProcess {
  const child = fork(fileURLToPath(new URL("./fixtures/generation-terminal-racer.ts", import.meta.url)), [...args], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv: process.execArgv.filter((argument) => argument !== "--test-force-exit")
  });
  children.push(child);
  return child;
}

function startLockContender(children: ChildProcess[], args: ReadonlyArray<string>): ChildProcess {
  const child = fork(fileURLToPath(new URL("./fixtures/generation-lock-contender.ts", import.meta.url)), [...args], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv: process.execArgv.filter((argument) => argument !== "--test-force-exit")
  });
  children.push(child);
  return child;
}

async function waitForPath(target: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(target)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${target}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function nextChildMessage(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      cleanup();
      resolve(message as Record<string, unknown>);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`generation racer exited before response: code=${code};signal=${signal}`));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.once("message", onMessage);
    child.once("exit", onExit);
  });
}

function encodedIdentity(identity: unknown): string {
  return Buffer.from(JSON.stringify(identity), "utf8").toString("base64url");
}

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
