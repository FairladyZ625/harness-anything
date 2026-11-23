// harness-test-tier: contract
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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

function createWirePeerPair(): { readonly centerPeer: ReplicationPeer; readonly edgePeer: ReplicationPeer } {
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
        const waiter = { resolve, reject };
        signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
        waiters.push(waiter);
      });
    };
  const makeSend =
    (decoder: ReplicationDecoder, queue: ReplicationFrame[], waiters: typeof edgeWaiters) =>
    async (frame: ReplicationFrame): Promise<void> => {
      const wire = serializeReplicationWireFrame(frame);
      const wireBuf = typeof wire === "string" ? Buffer.from(wire) : wire;
      for (const decoded of decoder.push(wireBuf)) {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(decoded);
        else queue.push(decoded);
      }
    };
  return {
    centerPeer: { send: makeSend(edgeDecoder, toEdge, edgeWaiters), receive: makeReceive(toCenter, centerWaiters) },
    edgePeer: { send: makeSend(centerDecoder, toCenter, centerWaiters), receive: makeReceive(toEdge, edgeWaiters) },
  };
}

test("withEdgeReadModel exposes replica_syncing with structured progress only during active healthy bootstrap", (t) => {
  const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-edge-sync-read-"));
  t.after(() => rmSync(viewRoot, { recursive: true, force: true }));
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
  assert.match(errorResult.rejectionExplanation ?? "", /objects · 3\/5 objects · 60%/);

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
  t.after(() => rmSync(root, { recursive: true, force: true }));

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

  const slots = openReplicationSlots(path.join(root, "slots.sqlite"));
  t.after(() => slots.close());
  const lease = slots.claim({ repoId: metadata.repoId, nodeId: "edge-air" }, metadata.position.history);

  const viewDir = path.join(root, "repos", metadata.repoId, "views", "edge-air");
  const stagingDir = path.join(viewDir, "staging");
  const observedSteps: string[] = [];
  let installedPosition: ReplicationPosition | null = null;

  const target: ReplicationTarget = {
    directory: stagingDir,
    currentPosition: () => installedPosition,
    installBaseBackup: async () => {
      const duringInstall = readReplicaHealth(viewDir).syncProgress;
      if (duringInstall) observedSteps.push(duringInstall.step);
    },
    projectInstalledBackup: async (pos) => {
      const duringProject = readReplicaHealth(viewDir).syncProgress;
      if (duringProject) observedSteps.push(duringProject.step);
      installedPosition = pos;
    },
    appendEvents: () => {},
  };

  const source: ReplicationSource = {
    repoId: metadata.repoId,
    history: () => metadata.position.history,
    headSequence: () => metadata.position.sequence,
    readEventsAfter: () => [],
    prepareSnapshot: async () => ({
      snapshotId: "snap-progress-1",
      archivePath: archiveFile,
      sha256,
      sizeBytes: bytes.byteLength,
      metadata,
    }),
  };

  const pair = createWirePeerPair();
  let chunkSeen = false;
  const wrappedEdgePeer: ReplicationPeer = {
    send: (frame) => pair.edgePeer.send(frame),
    receive: async (signal) => {
      const frame = await pair.edgePeer.receive(signal);
      if (frame.type === "replica.done" && !chunkSeen) {
        chunkSeen = true;
        const duringTransfer = readReplicaHealth(viewDir).syncProgress;
        if (duringTransfer) observedSteps.push(duringTransfer.step);
      }
      return frame;
    },
  };

  const abort = new AbortController();
  const senderPromise = runWalSender({
    peer: pair.centerPeer,
    slots,
    lease,
    source,
    capabilities: [SNAPSHOT_RESUME_CAPABILITY, SNAPSHOT_BINARY_WIRE_CAPABILITY, SNAPSHOT_OBJECT_PACK_CAPABILITY],
    signal: abort.signal,
  }).catch(() => {});

  const receiverPromise = runWalReceiver({
    peer: wrappedEdgePeer,
    repoId: metadata.repoId,
    nodeId: "edge-air",
    target,
    capabilities: [SNAPSHOT_RESUME_CAPABILITY, SNAPSHOT_BINARY_WIRE_CAPABILITY, SNAPSHOT_OBJECT_PACK_CAPABILITY],
    onPositionAcked: () => abort.abort(),
    signal: abort.signal,
  }).catch(() => {});

  await Promise.all([senderPromise, receiverPromise]);
  assert.deepEqual(observedSteps, ["basebackup", "installing", "projecting"]);
  assert.equal(readReplicaHealth(viewDir).syncProgress, null);
});
