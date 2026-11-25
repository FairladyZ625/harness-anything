// harness-test-tier: contract
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { openReplicationSlots, type BaseBackupMetadata, type ReplicationPosition } from "@harness-anything/storage";
import {
  REPLICATION_BINARY_CHUNK_BYTES,
  ReplicationDecoder,
  SNAPSHOT_BINARY_WIRE_CAPABILITY,
  SNAPSHOT_OBJECT_PACK_CAPABILITY,
  SNAPSHOT_RESUME_CAPABILITY,
  serializeReplicationWireFrame,
  type ReplicationFrame,
  type ReplicationPeer,
} from "../src/fleet-sync/fleet/protocol.ts";
import {
  readReplicaHealth,
  recordReplicaHealth,
  type ReplicaSyncProgress,
} from "../src/fleet-sync/fleet/replica-health.ts";
import { runWalReceiver, type ReplicationTarget } from "../src/daemon-host/fleet/walreceiver.ts";
import { runWalSender, type ReplicationSource } from "../src/daemon-host/fleet/walsender.ts";
import { withEdgeReadModel } from "../src/daemon-host/fleet-edge-task-read.ts";
import {
  daemonProtocolError,
  validateDaemonProtocolError,
} from "../src/daemon-host/protocol/daemon-protocol-validate-results.ts";

function createWirePeerPair(onEdgeToCenter?: (frame: ReplicationFrame) => void): {
  readonly centerPeer: ReplicationPeer;
  readonly edgePeer: ReplicationPeer;
} {
  const edgeDecoder = new ReplicationDecoder();
  const centerDecoder = new ReplicationDecoder();
  const toEdge: ReplicationFrame[] = [];
  const toCenter: ReplicationFrame[] = [];
  const edgeWaiters: Array<{ resolve: (f: ReplicationFrame) => void; reject: (e: unknown) => void }> = [];
  const centerWaiters: Array<{ resolve: (f: ReplicationFrame) => void; reject: (e: unknown) => void }> = [];
  const makeReceive =
    (queue: ReplicationFrame[], waiters: typeof edgeWaiters) =>
    async (signal?: AbortSignal): Promise<ReplicationFrame> => {
      signal?.throwIfAborted();
      const next = queue.shift();
      if (next) return next;
      return new Promise<ReplicationFrame>((resolve, reject) => {
        const onAbort = () => {
          const idx = waiters.indexOf(waiter);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(signal?.reason ?? new Error("aborted"));
        };
        const waiter = {
          resolve: (frame: ReplicationFrame) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(frame);
          },
          reject: (error: unknown) => {
            signal?.removeEventListener("abort", onAbort);
            reject(error);
          },
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        waiters.push(waiter);
      });
    };
  const makeSend =
    (
      decoder: ReplicationDecoder,
      queue: ReplicationFrame[],
      waiters: typeof edgeWaiters,
      hook?: (frame: ReplicationFrame) => void,
    ) =>
    async (frame: ReplicationFrame): Promise<void> => {
      const wire = serializeReplicationWireFrame(frame);
      const wireBuf = typeof wire === "string" ? Buffer.from(wire) : wire;
      hook?.(frame);
      for (const decoded of decoder.push(wireBuf)) {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(decoded);
        else queue.push(decoded);
      }
    };
  return {
    centerPeer: { send: makeSend(edgeDecoder, toEdge, edgeWaiters), receive: makeReceive(toCenter, centerWaiters) },
    edgePeer: {
      send: makeSend(centerDecoder, toCenter, centerWaiters, onEdgeToCenter),
      receive: makeReceive(toEdge, edgeWaiters),
    },
  };
}

test("withEdgeReadModel exposes replica_syncing with structured progress only during active healthy bootstrap", (t) => {
  const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-edge-sync-read-"));
  t.after(() => removeTempRepository(viewRoot));
  const repoId = "repo-sync";
  const nodeId = "edge-air";
  const viewDir = path.join(viewRoot, "repos", repoId, "views", nodeId);
  mkdirSync(viewDir, { recursive: true });

  // Negative control 1: no syncProgress -> replica_unavailable.
  assert.throws(
    () => withEdgeReadModel({ viewRoot, repoId, nodeId, principalId: "person_zeyu" }, () => "ok"),
    (err: unknown) => (err as { code?: string }).code === "replica_unavailable",
  );

  // Active objects pack bootstrap -> replica_syncing + structured syncProgress + wire validation.
  const nowMs = Date.parse("2026-11-23T03:00:00.000Z");
  const progress: ReplicaSyncProgress = {
    step: "objects",
    receivedBytes: 12 * 1024 * 1024,
    totalBytes: 20 * 1024 * 1024,
    receivedObjects: 3,
    totalObjects: 5,
    updatedAt: new Date(nowMs - 5_000).toISOString(),
  };
  recordReplicaHealth(viewDir, { syncProgress: progress });

  let caughtError: unknown = null;
  assert.throws(
    () =>
      withEdgeReadModel(
        { viewRoot, repoId, nodeId, principalId: "person_zeyu" },
        () => "ok",
        () => nowMs,
      ),
    (err: unknown) => {
      caughtError = err;
      return (err as { code?: string }).code === "replica_syncing";
    },
  );
  const errorResult = daemonProtocolError(
    "repo.tasks.list",
    "replica_syncing",
    (caughtError as Error).message,
    undefined,
    caughtError,
  );
  assert.deepEqual(validateDaemonProtocolError(errorResult), []);
  assert.deepEqual(errorResult.error.syncProgress, progress);
  assert.match(errorResult.rejectionExplanation ?? "", /objects · 3\/5 objects · 12\.0 MiB \/ 20\.0 MiB \(60%\)/);

  // Malformed syncProgress is rejected by protocol validator.
  assert.notEqual(
    validateDaemonProtocolError({
      ...errorResult,
      error: { code: "replica_syncing", syncProgress: { ...progress, step: "bogus" } },
    }).length,
    0,
  );

  // Negative control 2: stale syncProgress (> 120s old) falls back to replica_unavailable.
  assert.throws(
    () =>
      withEdgeReadModel(
        { viewRoot, repoId, nodeId, principalId: "person_zeyu" },
        () => "ok",
        () => nowMs + 180_000,
      ),
    (err: unknown) => (err as { code?: string }).code === "replica_unavailable",
  );

  // Negative control 3: explicit syncFailure wins over syncProgress -> replica_unavailable.
  recordReplicaHealth(viewDir, {
    syncFailure: { code: "checksum_mismatch", message: "pack sha256 mismatch" },
    syncProgress: progress,
  });
  assert.throws(
    () =>
      withEdgeReadModel(
        { viewRoot, repoId, nodeId, principalId: "person_zeyu" },
        () => "ok",
        () => nowMs,
      ),
    (err: unknown) => (err as { code?: string }).code === "replica_unavailable",
  );
});

test("walreceiver publishes basebackup, installing, and projecting progress into replica-health.json and clears on ack", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-wal-progress-"));
  let slots: ReturnType<typeof openReplicationSlots> | undefined;
  t.after(() => {
    slots?.close();
    removeTempRepository(root);
  });

  const archiveDir = path.join(root, "center-archive");
  mkdirSync(archiveDir, { recursive: true });
  const archiveFile = path.join(archiveDir, "base.tar.gz");
  const bytes = randomBytes(REPLICATION_BINARY_CHUNK_BYTES + 512);
  writeFileSync(archiveFile, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const metadata: BaseBackupMetadata = {
    schema: "fleet-basebackup/v3",
    readerProfile: { personId: "person_zeyu", nodeId: "edge-air" },
    repoId: "repo-wal-progress",
    position: { history: "hist-1", sequence: 4, revision: 4 },
    ledgerGeneration: 1,
    projectionSchema: 1,
  };

  slots = openReplicationSlots(path.join(root, "slots.sqlite"));
  const lease = slots.claim({ repoId: metadata.repoId, nodeId: "edge-air" }, metadata.position.history);

  const viewDir = path.join(root, "repos", metadata.repoId, "views", "edge-air");
  const stagingDir = path.join(viewDir, "staging");
  const observedSteps: string[] = [];
  let installedPosition: ReplicationPosition | null = null;
  const abort = new AbortController();

  const target: ReplicationTarget = {
    position: () => installedPosition,
    install: async () => {
      const duringInstall = readReplicaHealth(viewDir).syncProgress;
      if (duringInstall) observedSteps.push(duringInstall.step);
      installedPosition = metadata.position;
    },
    apply: () => undefined,
    installObject: async () => undefined,
    project: async () => {
      const duringProject = readReplicaHealth(viewDir).syncProgress;
      if (duringProject) observedSteps.push(duringProject.step);
    },
  };

  const source: ReplicationSource = {
    read: () => null,
    wait: async () => undefined,
    acknowledged: async () => undefined,
    backup: async () => ({
      metadata,
      file: archiveFile,
      size: bytes.byteLength,
      sha256,
      mode: "monolithic",
      snapshotId: "snap-progress-1",
      resumeOffset: 0,
      release: async () => undefined,
    }),
    object: async function* () {},
  };

  const pair = createWirePeerPair((frame) => {
    if (frame.type === "replica.ack") abort.abort(new Error("done"));
  });
  let chunkSeen = false;
  const wrappedEdgePeer: ReplicationPeer = {
    send: (frame) => pair.edgePeer.send(frame),
    receive: async (signal) => {
      const frame = await pair.edgePeer.receive(signal);
      if (frame.type === "replica.backup.end" && !chunkSeen) {
        chunkSeen = true;
        const duringTransfer = readReplicaHealth(viewDir).syncProgress;
        if (duringTransfer) observedSteps.push(duringTransfer.step);
      }
      return frame;
    },
  };

  await pair.centerPeer.send({
    type: "replica.accept",
    centerBuildCommit: "test",
    taskEventShapeVersion: 1,
    capabilities: [SNAPSHOT_RESUME_CAPABILITY, SNAPSHOT_BINARY_WIRE_CAPABILITY, SNAPSHOT_OBJECT_PACK_CAPABILITY],
  });

  await Promise.allSettled([
    runWalSender({
      peer: pair.centerPeer,
      slots,
      lease,
      source,
      signal: abort.signal,
    }),
    runWalReceiver({
      peer: wrappedEdgePeer,
      repoId: metadata.repoId,
      target,
      directory: stagingDir,
      quotaBytes: 64 * 1024 * 1024,
      maxBufferedBytes: 1024 * 1024,
      signal: abort.signal,
    }),
  ]);

  assert.deepEqual(observedSteps, ["basebackup", "installing", "projecting"]);
  assert.equal(readReplicaHealth(viewDir).syncProgress, null);
});
