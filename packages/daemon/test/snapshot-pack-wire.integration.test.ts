// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as tar from "tar";
import {
  BASE_BACKUP_ARCHIVE_ROOT,
  openReplicationSlots,
  type BaseBackupMetadata,
  type BaseBackupObjectEntry,
  type ReplicationPosition,
} from "@harness-anything/storage";
import {
  REPLICATION_BINARY_CHUNK_BYTES,
  REPLICATION_CHUNK_BYTES,
  ReplicationDecoder,
  SNAPSHOT_BINARY_WIRE_CAPABILITY,
  SNAPSHOT_OBJECT_PACK_CAPABILITY,
  SNAPSHOT_RESUME_CAPABILITY,
  serializeReplicationWireFrame,
  type ReplicationFrame,
  type ReplicationPeer,
} from "../src/fleet-sync/fleet/protocol.ts";
import { runWalReceiver, type ReplicationTarget } from "../src/daemon-host/fleet/walreceiver.ts";
import { runWalSender, type ReplicationSource } from "../src/daemon-host/fleet/walsender.ts";

function createWirePeerPair(
  options: {
    readonly onCenterToEdge?: (frame: ReplicationFrame, wireBytes: number) => void;
    readonly onEdgeToCenter?: (frame: ReplicationFrame, wireBytes: number) => void;
  } = {},
): {
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
      hook?: (frame: ReplicationFrame, wireBytes: number) => void,
    ) =>
    async (frame: ReplicationFrame): Promise<void> => {
      const wire = serializeReplicationWireFrame(frame);
      const wireBuf = typeof wire === "string" ? Buffer.from(wire) : wire;
      hook?.(frame, wireBuf.byteLength);
      for (const decoded of decoder.push(wireBuf)) {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(decoded);
        else queue.push(decoded);
      }
    };

  return {
    centerPeer: {
      send: makeSend(edgeDecoder, toEdge, edgeWaiters, options.onCenterToEdge),
      receive: makeReceive(toCenter, centerWaiters),
    },
    edgePeer: {
      send: makeSend(centerDecoder, toCenter, centerWaiters, options.onEdgeToCenter),
      receive: makeReceive(toEdge, edgeWaiters),
    },
  };
}

function makeTestArchive(dir: string, sizeBytes: number) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "base.tar.gz");
  const bytes = randomBytes(sizeBytes);
  writeFileSync(file, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const metadata: BaseBackupMetadata = {
    schema: "fleet-basebackup/v3",
    readerProfile: { personId: "owner", nodeId: "edge-one" },
    repoId: "repo-pack-test",
    position: { history: "hist-pack", sequence: 5, revision: 5 },
    ledgerGeneration: 3,
    projectionSchema: 1,
  };
  return { file, bytes, sha256, metadata };
}

test("snapshot-binary-wire/v1 streams 256 KiB binary frames with zero base64 overhead and supports offset resume", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-bin-wire-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const archive = makeTestArchive(path.join(root, "center-archive"), REPLICATION_BINARY_CHUNK_BYTES * 2 + 777);
  const snapshotId = "snap-bin-001";
  const slots = openReplicationSlots(path.join(root, "slots.sqlite"));
  t.after(() => slots.close());
  const lease = slots.claim({ repoId: archive.metadata.repoId, nodeId: "edge-one" }, archive.metadata.position.history);

  const edgeViewRoot = path.join(root, "edge-view");
  const edgeDir = path.join(edgeViewRoot, "staging");
  const snapshotsRoot = path.join(edgeDir, "snapshots");

  // Phase 1: interrupt after first binary chunk.
  const firstAbort = new AbortController();
  const seenFrames1: string[] = [];
  const maxChunkBytes: number[] = [];
  const pair1 = createWirePeerPair({
    onCenterToEdge: (frame, wireBytes) => {
      seenFrames1.push(frame.type);
      if (frame.type === "replica.data.bin") {
        maxChunkBytes.push(frame.data.byteLength);
        assert.equal(wireBytes, frame.data.byteLength + 13);
      }
    },
  });
  let edgeBinReceived = 0;
  const wrappedEdgePeer1: ReplicationPeer = {
    send: (frame) => pair1.edgePeer.send(frame),
    receive: async (signal) => {
      const frame = await pair1.edgePeer.receive(signal);
      if (frame.type === "replica.data.bin") {
        edgeBinReceived += 1;
        if (edgeBinReceived === 2) {
          firstAbort.abort(new Error("simulated cut"));
        }
      }
      return frame;
    },
  };

  const source: ReplicationSource = {
    read: () => null,
    wait: async () => undefined,
    acknowledged: async () => undefined,
    backup: async (_signal, resume) => ({
      metadata: archive.metadata,
      file: archive.file,
      size: archive.bytes.length,
      sha256: archive.sha256,
      mode: "monolithic",
      snapshotId,
      resumeOffset: resume && resume.snapshotId === snapshotId ? resume.offset : 0,
      release: async () => undefined,
    }),
    object: async function* () {},
  };

  let installedBytes: Buffer | null = null;
  const target: ReplicationTarget = {
    position: () => null,
    install: async (file) => {
      installedBytes = readFileSync(file);
    },
    apply: () => undefined,
    installObject: async () => undefined,
    project: async () => undefined,
  };

  await pair1.centerPeer.send({
    type: "replica.accept",
    centerBuildCommit: "test",
    taskEventShapeVersion: 1,
    capabilities: [SNAPSHOT_RESUME_CAPABILITY, SNAPSHOT_BINARY_WIRE_CAPABILITY],
  });
  await Promise.allSettled([
    runWalSender({ peer: pair1.centerPeer, source, slots, lease, signal: firstAbort.signal }),
    runWalReceiver({
      peer: wrappedEdgePeer1,
      repoId: archive.metadata.repoId,
      target,
      directory: edgeDir,
      quotaBytes: 64 * 1024 * 1024,
      maxBufferedBytes: 1024 * 1024,
      signal: firstAbort.signal,
    }),
  ]);
  assert.ok(seenFrames1.includes("replica.data.bin"));
  assert.equal(seenFrames1.includes("replica.data"), false);
  assert.equal(maxChunkBytes[0], REPLICATION_BINARY_CHUNK_BYTES);
  assert.equal(existsSync(path.join(snapshotsRoot, snapshotId, "archive.part")), true);

  // Phase 2: resume from persisted byte offset using binary wire framing.
  const secondAbort = new AbortController();
  let resumedFrom = -1;
  const pair2 = createWirePeerPair({
    onCenterToEdge: (frame) => {
      if (frame.type === "replica.backup") resumedFrom = frame.resumeOffset ?? 0;
    },
  });
  let currentPos: ReplicationPosition | null = null;
  const target2: ReplicationTarget = {
    position: () => currentPos,
    install: async (file) => {
      installedBytes = readFileSync(file);
      currentPos = archive.metadata.position;
    },
    apply: () => undefined,
    installObject: async () => undefined,
    project: async () => {
      secondAbort.abort(new Error("done"));
    },
  };
  await pair2.centerPeer.send({
    type: "replica.accept",
    centerBuildCommit: "test",
    taskEventShapeVersion: 1,
    capabilities: [SNAPSHOT_RESUME_CAPABILITY, SNAPSHOT_BINARY_WIRE_CAPABILITY],
  });
  await Promise.allSettled([
    runWalSender({ peer: pair2.centerPeer, source, slots, lease, signal: secondAbort.signal }),
    runWalReceiver({
      peer: pair2.edgePeer,
      repoId: archive.metadata.repoId,
      target: target2,
      directory: edgeDir,
      quotaBytes: 64 * 1024 * 1024,
      maxBufferedBytes: 1024 * 1024,
      signal: secondAbort.signal,
    }),
  ]);
  assert.ok(resumedFrom > 0);
  assert.deepEqual(installedBytes, archive.bytes);
});

test("legacy edge without Phase 3 capabilities receives JSON base64 replica.data and monolithic backup", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-legacy-compat-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const archive = makeTestArchive(path.join(root, "center-archive"), REPLICATION_CHUNK_BYTES + 500);
  const slots = openReplicationSlots(path.join(root, "slots.sqlite"));
  t.after(() => slots.close());
  const lease = slots.claim(
    { repoId: archive.metadata.repoId, nodeId: "legacy-edge" },
    archive.metadata.position.history,
  );
  const abort = new AbortController();

  const receivedFrames: ReplicationFrame[] = [];
  const pair = createWirePeerPair({
    onCenterToEdge: (frame) => {
      receivedFrames.push(frame);
    },
  });

  let requestedMode: string | undefined;
  const source: ReplicationSource = {
    read: () => null,
    wait: async () => undefined,
    acknowledged: async () => undefined,
    backup: async (_signal, _resume, opts) => {
      requestedMode = opts?.mode;
      return {
        metadata: archive.metadata,
        file: archive.file,
        size: archive.bytes.length,
        sha256: archive.sha256,
        mode: "monolithic",
        release: async () => undefined,
      };
    },
    object: async function* () {},
  };

  const sender = runWalSender({ peer: pair.centerPeer, source, slots, lease, signal: abort.signal });
  // Simulate legacy edge sending replica.start without capabilities.
  await pair.edgePeer.send({
    type: "replica.start",
    repoId: archive.metadata.repoId,
    position: null,
    edgeBuildCommit: "legacy",
    taskEventShapeVersion: 1,
  });
  const backup = await pair.edgePeer.receive(abort.signal);
  assert.equal(backup.type, "replica.backup");
  assert.equal(backup.objectsMode, undefined);
  const chunks: Buffer[] = [];
  for (;;) {
    const frame = await pair.edgePeer.receive(abort.signal);
    if (frame.type === "replica.backup.end") break;
    assert.equal(frame.type, "replica.data");
    chunks.push(Buffer.from(frame.data, "base64"));
  }
  assert.deepEqual(Buffer.concat(chunks), archive.bytes);
  assert.equal(requestedMode, undefined);
  assert.equal(
    receivedFrames.some((f) => f.type === "replica.data.bin" || f.type === "replica.objects.manifest"),
    false,
  );
  abort.abort(new Error("done"));
  await Promise.allSettled([sender]);
});

test("snapshot-object-pack/v1 deduplicates existing local objects and streams missing objects in packs", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-obj-pack-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const obj1 = Buffer.from("already-present-object-content-1");
  const sha1 = createHash("sha256").update(obj1).digest("hex");
  const obj2 = randomBytes(128 * 1024);
  const sha2 = createHash("sha256").update(obj2).digest("hex");
  const blobs = new Map<string, Buffer>([
    [sha1, obj1],
    [sha2, obj2],
  ]);

  // Build a tiny split tar.gz (without objects/sha256/*) and objects.json manifest.
  const payloadDir = path.join(root, "center-payload");
  mkdirSync(path.join(payloadDir, BASE_BACKUP_ARCHIVE_ROOT, "store", "generations", "3"), { recursive: true });
  writeFileSync(path.join(payloadDir, "backup.json"), JSON.stringify({ ok: true }));
  const tarFile = path.join(root, "base.tar.gz");
  await tar.create({ file: tarFile, cwd: payloadDir, gzip: true, portable: true, strict: true }, [
    "backup.json",
    BASE_BACKUP_ARCHIVE_ROOT,
  ]);
  const tarBytes = readFileSync(tarFile);
  const tarSha = createHash("sha256").update(tarBytes).digest("hex");
  const manifestEntries: readonly BaseBackupObjectEntry[] = [
    { sha256: sha1, size: obj1.length },
    { sha256: sha2, size: obj2.length },
  ];

  const metadata: BaseBackupMetadata = {
    schema: "fleet-basebackup/v3",
    readerProfile: { personId: "owner", nodeId: "edge-one" },
    repoId: "repo-dedup-test",
    position: { history: "hist-dedup", sequence: 7, revision: 7 },
    ledgerGeneration: 3,
    projectionSchema: 1,
  };

  // Pre-populate obj1 in an existing edge generation directory.
  const edgeViewRoot = path.join(root, "edge-view");
  const edgeDir = path.join(edgeViewRoot, "staging");
  const oldGenObj1 = path.join(
    edgeViewRoot,
    "generations",
    "gen-old",
    BASE_BACKUP_ARCHIVE_ROOT,
    "store",
    "generations",
    "3",
    "objects",
    "sha256",
    sha1.slice(0, 2),
    sha1.slice(2),
  );
  mkdirSync(path.dirname(oldGenObj1), { recursive: true });
  writeFileSync(oldGenObj1, obj1);

  const slots = openReplicationSlots(path.join(root, "slots.sqlite"));
  t.after(() => slots.close());
  const lease = slots.claim({ repoId: metadata.repoId, nodeId: "edge-one" }, metadata.position.history);

  const requestedObjects: string[] = [];
  const wantedFromEdge: string[][] = [];
  const pair = createWirePeerPair({
    onEdgeToCenter: (frame) => {
      if (frame.type === "replica.objects.want") wantedFromEdge.push([...frame.sha256s]);
    },
  });

  const abort = new AbortController();
  const source: ReplicationSource = {
    read: () => null,
    wait: async () => undefined,
    acknowledged: async () => undefined,
    backup: async (_signal, _resume, opts) => {
      assert.equal(opts?.mode, "split");
      return {
        metadata,
        file: tarFile,
        size: tarBytes.length,
        sha256: tarSha,
        mode: "split",
        objects: manifestEntries,
        objectCount: manifestEntries.length,
        snapshotId: "snap-pack-001",
        resumeOffset: 0,
        release: async () => undefined,
      };
    },
    object: async function* (sha256) {
      requestedObjects.push(sha256);
      yield blobs.get(sha256)!;
    },
  };

  let installedObj1: Buffer | null = null;
  let installedObj2: Buffer | null = null;
  const target: ReplicationTarget = {
    position: () => null,
    install: async (_file, _meta, _size, _sha, installOpts) => {
      assert.ok(installOpts?.stagedObjectsDir);
      installedObj1 = readFileSync(path.join(installOpts.stagedObjectsDir, sha1.slice(0, 2), sha1.slice(2)));
      installedObj2 = readFileSync(path.join(installOpts.stagedObjectsDir, sha2.slice(0, 2), sha2.slice(2)));
    },
    apply: () => undefined,
    installObject: async () => undefined,
    project: async () => {
      abort.abort(new Error("done"));
    },
  };

  await pair.centerPeer.send({
    type: "replica.accept",
    centerBuildCommit: "test",
    taskEventShapeVersion: 1,
    capabilities: [SNAPSHOT_RESUME_CAPABILITY, SNAPSHOT_BINARY_WIRE_CAPABILITY, SNAPSHOT_OBJECT_PACK_CAPABILITY],
  });

  await Promise.allSettled([
    runWalSender({ peer: pair.centerPeer, source, slots, lease, signal: abort.signal }),
    runWalReceiver({
      peer: pair.edgePeer,
      repoId: metadata.repoId,
      target,
      directory: edgeDir,
      quotaBytes: 64 * 1024 * 1024,
      maxBufferedBytes: 1024 * 1024,
      signal: abort.signal,
    }),
  ]);

  // Only sha2 should have been requested and transferred over the wire; sha1 was deduplicated locally.
  assert.deepEqual(wantedFromEdge, [[sha2]]);
  assert.deepEqual(requestedObjects, [sha2]);
  assert.deepEqual(installedObj1, obj1);
  assert.deepEqual(installedObj2, obj2);
  assert.equal(SNAPSHOT_BINARY_WIRE_CAPABILITY, "snapshot-binary-wire/v1");
  assert.equal(SNAPSHOT_OBJECT_PACK_CAPABILITY, "snapshot-object-pack/v1");
  assert.equal(SNAPSHOT_RESUME_CAPABILITY, "snapshot-resume/v1");
});
