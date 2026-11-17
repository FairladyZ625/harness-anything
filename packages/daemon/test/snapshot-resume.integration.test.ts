// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openReplicationSlots, type BaseBackupMetadata, type ReplicationPosition } from "@harness-anything/storage";
import {
  REPLICATION_CHUNK_BYTES,
  SNAPSHOT_RESUME_CAPABILITY,
  serializeReplicationFrame,
  type ReplicationFrame,
  type ReplicationPeer,
} from "../src/fleet-sync/fleet/protocol.ts";
import { runWalReceiver, type ReplicationTarget } from "../src/daemon-host/fleet/walreceiver.ts";
import { runWalSender, type ReplicationSource } from "../src/daemon-host/fleet/walsender.ts";
import {
  fleetReplicationFixture,
  replicationPeer,
  replicationRepoId,
  seedCenterData,
  waitForState,
} from "./fleet-replication.fixture.ts";

const seededTask = { taskId: "task_snapres000000000000000000001", executionId: "exe_snapres", title: "Resume" };

function createInMemoryPeerPair(
  options: {
    readonly onCenterToEdge?: (frame: ReplicationFrame) => void;
    readonly onEdgeToCenter?: (frame: ReplicationFrame) => void;
  } = {},
): {
  readonly centerPeer: ReplicationPeer;
  readonly edgePeer: ReplicationPeer;
} {
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
    (queue: ReplicationFrame[], waiters: typeof edgeWaiters, hook?: (frame: ReplicationFrame) => void) =>
    async (frame: ReplicationFrame): Promise<void> => {
      hook?.(frame);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(frame);
      else queue.push(frame);
    };

  return {
    centerPeer: {
      send: makeSend(toEdge, edgeWaiters, options.onCenterToEdge),
      receive: makeReceive(toCenter, centerWaiters),
    },
    edgePeer: {
      send: makeSend(toCenter, centerWaiters, options.onEdgeToCenter),
      receive: makeReceive(toEdge, edgeWaiters),
    },
  };
}

function makeTestArchive(
  dir: string,
  sizeBytes: number,
): {
  readonly file: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly metadata: BaseBackupMetadata;
} {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "base.tar.gz");
  const bytes = randomBytes(sizeBytes);
  writeFileSync(file, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const metadata: BaseBackupMetadata = {
    schema: "fleet-basebackup/v3",
    readerProfile: { personId: "owner", nodeId: "edge-one" },
    repoId: "repo-resume-test",
    position: { history: "hist-1", sequence: 5, revision: 5 },
    ledgerGeneration: 1,
    projectionSchema: 1,
  };
  return { file, bytes, sha256, metadata };
}

test("walsender and walreceiver resume interrupted snapshot transfer from persisted byte offset", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-snap-resume-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const archive = makeTestArchive(path.join(root, "center-archive"), REPLICATION_CHUNK_BYTES * 3 + 1234);
  const snapshotId = "snap-pinned-001";
  const stagingDir = path.join(root, "edge-staging");
  const slots = openReplicationSlots(path.join(root, "slots.sqlite"));
  t.after(() => slots.close());

  let installedBytes: Buffer | null = null;
  let installedPosition: ReplicationPosition | null = null;
  const target: ReplicationTarget = {
    position: () => installedPosition,
    install: async (file, metadata, size, sha256) => {
      const data = readFileSync(file);
      assert.equal(data.length, size);
      assert.equal(createHash("sha256").update(data).digest("hex"), sha256);
      installedBytes = data;
      installedPosition = metadata.position;
    },
    apply: () => undefined,
    installObject: async () => undefined,
    project: async () => undefined,
  };

  const makeSource = (onBackupCall?: (resume?: { snapshotId: string; offset: number }) => void): ReplicationSource => ({
    read: (after) => ({ commits: [], done: true, head: after }),
    wait: async (_after, signal) => {
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    acknowledged: async () => undefined,
    backup: async (_signal, resumeSnapshot) => {
      onBackupCall?.(resumeSnapshot);
      const canResume =
        resumeSnapshot &&
        resumeSnapshot.snapshotId === snapshotId &&
        resumeSnapshot.offset > 0 &&
        resumeSnapshot.offset <= archive.bytes.length;
      return {
        metadata: archive.metadata,
        file: archive.file,
        size: archive.bytes.length,
        sha256: archive.sha256,
        snapshotId,
        resumeOffset: canResume ? resumeSnapshot.offset : 0,
        release: async () => undefined,
      };
    },
    object: async function* () {},
  });

  // Attempt 1: Interrupt after edge receives 2 replica.data chunks (so chunk #1 is durably written).
  const abort1 = new AbortController();
  let edgeDataFrames1 = 0;
  const pair1 = createInMemoryPeerPair();
  const edgePeer1: ReplicationPeer = {
    send: (frame) => pair1.edgePeer.send(frame),
    receive: async (signal) => {
      const frame = await pair1.edgePeer.receive(signal);
      if (frame.type === "replica.data") {
        edgeDataFrames1 += 1;
        if (edgeDataFrames1 === 2) {
          abort1.abort(new Error("simulated network drop"));
        }
      }
      return frame;
    },
  };
  const lease1 = slots.claim({ repoId: "repo-resume-test", nodeId: "edge-one" }, archive.metadata.position.history);
  await pair1.centerPeer.send({
    type: "replica.accept",
    centerBuildCommit: null,
    taskEventShapeVersion: 1,
    capabilities: [SNAPSHOT_RESUME_CAPABILITY],
  });
  await Promise.allSettled([
    runWalSender({ peer: pair1.centerPeer, source: makeSource(), slots, lease: lease1, signal: abort1.signal }),
    runWalReceiver({
      peer: edgePeer1,
      repoId: "repo-resume-test",
      target,
      directory: stagingDir,
      quotaBytes: 64 * 1024 * 1024,
      maxBufferedBytes: 1024 * 1024,
      signal: abort1.signal,
    }),
  ]);

  const partDir = path.join(stagingDir, "snapshots", snapshotId);
  assert.ok(existsSync(path.join(partDir, "archive.part")), "partial archive must be preserved on disconnect");
  assert.ok(existsSync(path.join(partDir, "transfer.json")), "transfer metadata must be preserved on disconnect");
  const partialState = JSON.parse(readFileSync(path.join(partDir, "transfer.json"), "utf8")) as {
    receivedBytes: number;
  };
  assert.ok(partialState.receivedBytes > 0 && partialState.receivedBytes < archive.bytes.length);

  // Attempt 2: Reconnect and resume from persisted offset.
  const abort2 = new AbortController();
  let startFrame2: ReplicationFrame | null = null;
  let backupFrame2: ReplicationFrame | null = null;
  const sentOffsets2: number[] = [];
  let resumeRequested: { snapshotId: string; offset: number } | undefined;

  const pair2 = createInMemoryPeerPair({
    onEdgeToCenter: (frame) => {
      if (frame.type === "replica.start") startFrame2 = frame;
    },
    onCenterToEdge: (frame) => {
      if (frame.type === "replica.backup") backupFrame2 = frame;
      if (frame.type === "replica.data") sentOffsets2.push(frame.offset);
    },
  });
  const lease2 = slots.claim({ repoId: "repo-resume-test", nodeId: "edge-one" }, archive.metadata.position.history);
  await pair2.centerPeer.send({
    type: "replica.accept",
    centerBuildCommit: null,
    taskEventShapeVersion: 1,
    capabilities: [SNAPSHOT_RESUME_CAPABILITY],
  });
  const results2 = await Promise.allSettled([
    runWalSender({
      peer: pair2.centerPeer,
      source: makeSource((req) => {
        resumeRequested = req;
      }),
      slots,
      lease: lease2,
      signal: abort2.signal,
      onAcknowledged: () => abort2.abort(new Error("done")),
    }),
    runWalReceiver({
      peer: pair2.edgePeer,
      repoId: "repo-resume-test",
      target,
      directory: stagingDir,
      quotaBytes: 64 * 1024 * 1024,
      maxBufferedBytes: 1024 * 1024,
      signal: abort2.signal,
    }),
  ]);
  for (const res of results2) {
    if (res.status === "rejected" && (res.reason as Error)?.message !== "done") {
      throw res.reason;
    }
  }

  assert.equal(
    (startFrame2 as { resumeSnapshot?: { snapshotId: string; offset: number } } | null)?.resumeSnapshot?.snapshotId,
    snapshotId,
  );
  assert.equal(resumeRequested?.offset, partialState.receivedBytes);
  assert.equal((backupFrame2 as { resumeOffset?: number } | null)?.resumeOffset, partialState.receivedBytes);
  assert.ok(sentOffsets2.length > 0);
  assert.equal(sentOffsets2[0], partialState.receivedBytes, "walsender must resume at exact offset");
  assert.deepEqual(installedBytes, archive.bytes, "reassembled archive must match original bytes");
  assert.equal(existsSync(path.join(stagingDir, "snapshots")), false, "staging/snapshots must be cleaned up after ACK");
});

test("walsender falls back to offset 0 with new snapshotId when requested snapshot is missing/expired", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-snap-fallback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const archive = makeTestArchive(path.join(root, "center-archive"), REPLICATION_CHUNK_BYTES + 500);
  const staleSnapshotId = "snap-expired-999";
  const newSnapshotId = "snap-fresh-002";
  const stagingDir = path.join(root, "edge-staging");
  const staleDir = path.join(stagingDir, "snapshots", staleSnapshotId);
  mkdirSync(staleDir, { recursive: true });
  writeFileSync(path.join(staleDir, "archive.part"), randomBytes(1024));
  writeFileSync(
    path.join(staleDir, "transfer.json"),
    JSON.stringify({
      schema: "fleet-snapshot-transfer/v1",
      snapshotId: staleSnapshotId,
      metadata: archive.metadata,
      size: archive.bytes.length,
      sha256: archive.sha256,
      receivedBytes: 1024,
    }),
  );

  const slots = openReplicationSlots(path.join(root, "slots.sqlite"));
  t.after(() => slots.close());
  let installedBytes: Buffer | null = null;
  let installedPosition: ReplicationPosition | null = null;
  const target: ReplicationTarget = {
    position: () => installedPosition,
    install: async (file, metadata, size, sha256) => {
      const data = readFileSync(file);
      assert.equal(data.length, size);
      assert.equal(createHash("sha256").update(data).digest("hex"), sha256);
      installedBytes = data;
      installedPosition = metadata.position;
    },
    apply: () => undefined,
    installObject: async () => undefined,
    project: async () => undefined,
  };

  const abort = new AbortController();
  let backupFrame: ReplicationFrame | null = null;
  const sentOffsets: number[] = [];
  const pair = createInMemoryPeerPair({
    onCenterToEdge: (frame) => {
      if (frame.type === "replica.backup") backupFrame = frame;
      if (frame.type === "replica.data") sentOffsets.push(frame.offset);
    },
  });
  const lease = slots.claim({ repoId: "repo-resume-test", nodeId: "edge-one" }, archive.metadata.position.history);
  await pair.centerPeer.send({
    type: "replica.accept",
    centerBuildCommit: null,
    taskEventShapeVersion: 1,
    capabilities: [SNAPSHOT_RESUME_CAPABILITY],
  });
  await Promise.allSettled([
    runWalSender({
      peer: pair.centerPeer,
      source: {
        read: (after) => ({ commits: [], done: true, head: after }),
        wait: async (_after, signal) => {
          await new Promise<void>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
        acknowledged: async () => undefined,
        backup: async () => ({
          metadata: archive.metadata,
          file: archive.file,
          size: archive.bytes.length,
          sha256: archive.sha256,
          snapshotId: newSnapshotId,
          resumeOffset: 0,
          release: async () => undefined,
        }),
        object: async function* () {},
      },
      slots,
      lease,
      signal: abort.signal,
      onAcknowledged: () => abort.abort(new Error("done")),
    }),
    runWalReceiver({
      peer: pair.edgePeer,
      repoId: "repo-resume-test",
      target,
      directory: stagingDir,
      quotaBytes: 64 * 1024 * 1024,
      maxBufferedBytes: 1024 * 1024,
      signal: abort.signal,
    }),
  ]);

  assert.equal((backupFrame as { snapshotId?: string } | null)?.snapshotId, newSnapshotId);
  assert.equal((backupFrame as { resumeOffset?: number } | null)?.resumeOffset, 0);
  assert.equal(sentOffsets[0], 0);
  assert.deepEqual(installedBytes, archive.bytes);
  assert.equal(existsSync(staleDir), false, "stale partial download must be discarded");
  assert.equal(existsSync(path.join(stagingDir, "snapshots")), false);
});

test(
  "center reloads pinned snapshot across restart and resumes edge download from persisted offset",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    const { planPath } = await seedCenterData(fixture, seededTask);
    // Add ~680 KiB document so basebackup spans 4+ 128 KiB replication chunks.
    const bulkPath = `${path.posix.dirname(planPath)}/artifacts/resume-bulk.md`;
    mkdirSync(path.join(fixture.repo, "harness", path.posix.dirname(bulkPath)), { recursive: true });
    writeFileSync(
      path.join(fixture.repo, "harness", bulkPath),
      `# Bulk\n\n${randomBytes(512 * 1024).toString("base64")}\n`,
    );
    const submitted = await fixture.centerRun({ kind: "doc-submit", paths: [bulkPath] });
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));

    const center1 = await fixture.openCenter();
    const edgeStaging = path.join(fixture.root, "edge-staging");
    const backupsRoot = path.join(fixture.stateRoot, "replication-backups");

    let installedPos: ReplicationPosition | null = null;
    let installedSize = 0;
    let installedSha = "";
    const target: ReplicationTarget = {
      position: () => installedPos,
      install: async (file, metadata, size, sha256) => {
        const data = readFileSync(file);
        assert.equal(data.length, size);
        assert.equal(createHash("sha256").update(data).digest("hex"), sha256);
        installedSize = size;
        installedSha = sha256;
        installedPos = metadata.position;
      },
      apply: () => undefined,
      installObject: async () => undefined,
      project: async () => undefined,
    };

    // Session 1: connect, receive 2 replica.data frames (so chunk #1 is written), then abort before completion.
    const peer1 = await replicationPeer(fixture.track, center1.port, fixture.cert, "edge-one", "secret-edge-one");
    const abort1 = new AbortController();
    let dataFrames = 0;
    const wrappedPeer1: ReplicationPeer = {
      send: async (frame) => {
        peer1.socket.write(serializeReplicationFrame(frame));
      },
      receive: async (receiveSignal) => {
        receiveSignal?.throwIfAborted();
        const frame = await peer1.receive();
        if (frame.type === "replica.data") {
          dataFrames += 1;
          if (dataFrames === 2) {
            abort1.abort(new Error("simulated drop"));
            abort1.signal.throwIfAborted();
          }
        }
        return frame;
      },
    };
    await assert.rejects(() =>
      runWalReceiver({
        peer: wrappedPeer1,
        repoId: replicationRepoId,
        target,
        directory: edgeStaging,
        quotaBytes: 64 * 1024 * 1024,
        maxBufferedBytes: 1024 * 1024,
        signal: abort1.signal,
      }),
    );
    peer1.close();

    // Center must keep the pinned snapshot on disk after edge disconnect.
    const repoPinsDir = path.join(backupsRoot, replicationRepoId);
    const pinIds = readdirSync(repoPinsDir);
    assert.equal(pinIds.length, 1);
    const snapshotId = pinIds[0]!;
    assert.ok(existsSync(path.join(repoPinsDir, snapshotId, "pin.json")));
    assert.ok(existsSync(path.join(edgeStaging, "snapshots", snapshotId, "archive.part")));

    // Restart center completely!
    await center1.close();
    const center2 = await fixture.openCenter();
    assert.ok(existsSync(path.join(repoPinsDir, snapshotId, "pin.json")), "pin must survive center reboot");

    // Session 2: reconnect edge to restarted center; verify resumeOffset > 0 and completion.
    const peer2 = await replicationPeer(fixture.track, center2.port, fixture.cert, "edge-one", "secret-edge-one");
    const abort2 = new AbortController();
    let resumedOffset = 0;
    let resolveAcked!: () => void;
    const acked = new Promise<void>((resolve) => {
      resolveAcked = resolve;
    });
    const wrappedPeer2: ReplicationPeer = {
      send: async (frame) => {
        peer2.socket.write(serializeReplicationFrame(frame));
        if (frame.type === "replica.ack") {
          resolveAcked();
        }
      },
      receive: async (receiveSignal) => {
        receiveSignal?.throwIfAborted();
        const frame = await peer2.receive();
        if (frame.type === "replica.backup") {
          resumedOffset = frame.resumeOffset ?? 0;
        }
        return frame;
      },
    };
    const receiverPromise = assert.rejects(() =>
      runWalReceiver({
        peer: wrappedPeer2,
        repoId: replicationRepoId,
        target,
        directory: edgeStaging,
        quotaBytes: 64 * 1024 * 1024,
        maxBufferedBytes: 1024 * 1024,
        signal: abort2.signal,
      }),
    );
    await acked;
    await waitForState(() => readdirSync(backupsRoot).length === 0, "center to retire pinned snapshot after ACK");
    abort2.abort(new Error("ack sent"));
    peer2.close();
    await receiverPromise;

    assert.ok(resumedOffset > 0, `expected resumedOffset > 0, got ${resumedOffset}`);
    assert.ok(installedSize > resumedOffset);
    assert.match(installedSha, /^[a-f0-9]{64}$/u);
    assert.equal(existsSync(path.join(edgeStaging, "snapshots")), false, "edge staging cleaned after ACK");
  },
);
