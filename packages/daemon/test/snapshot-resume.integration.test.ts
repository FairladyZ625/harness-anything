// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  openFleetStorage,
  openReplicationSlots,
  openSqliteEventStore,
  sqliteLedgerPath,
  type BaseBackupMetadata,
  type ReplicationPosition,
} from "@harness-anything/storage";
import { TASK_EVENT_SHAPE_COMPAT_VERSION } from "@harness-anything/kernel";
import { pgRuntimeFixture } from "../../storage/test/postgres/pg-runtime.fixture.ts";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { applyFleetMirrorCut, locateFleetMirrorView } from "../src/daemon-host/fleet-edge-mirror.ts";
import { runFleetEdgeTask } from "../src/daemon-host/fleet-edge-task.ts";
import {
  REPLICATION_BINARY_CHUNK_BYTES,
  REPLICATION_CHUNK_BYTES,
  SNAPSHOT_OBJECT_PACK_CAPABILITY,
  SNAPSHOT_RESUME_CAPABILITY,
  serializeReplicationFrame,
  type ReplicationFrame,
  type ReplicationPeer,
} from "../src/fleet-sync/fleet/protocol.ts";
import { readReplicaGeneration } from "../src/fleet-sync/fleet/replica-generation.ts";
import { runFleetReplicaSync } from "../src/daemon-host/fleet/replica-sync.ts";
import { runWalReceiver, type ReplicationTarget } from "../src/daemon-host/fleet/walreceiver.ts";
import { runWalSender, type ReplicationSource } from "../src/daemon-host/fleet/walsender.ts";
import {
  fleetReplicationFixture,
  replicationPeer,
  replicationRepoId,
  seedCenterData,
  waitForState,
} from "./fleet-replication.fixture.ts";
import { fleetNodeOwners } from "./fleet-store.fixture.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

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
  const slots = openReplicationSlots(path.join(root, "slots.sqlite"));
  t.after(() => {
    slots.close();
    removeTempRepository(root);
  });

  const archive = makeTestArchive(path.join(root, "center-archive"), REPLICATION_BINARY_CHUNK_BYTES * 3 + 1234);
  const snapshotId = "snap-pinned-001";
  const stagingDir = path.join(root, "edge-staging");

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
      if (frame.type === "replica.data" || frame.type === "replica.data.bin") {
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
      if (frame.type === "replica.data" || frame.type === "replica.data.bin") sentOffsets2.push(frame.offset);
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

test("resume-only admission rejection preserves the existing replica", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "ha-repoint-resume-reject-"));
  t.after(() => removeTempRepository(directory));
  const position = { history: "a".repeat(64), sequence: 4, revision: 2 };
  let resetCount = 0,
    revokeCount = 0,
    startSent = false;
  await assert.rejects(
    runWalReceiver({
      peer: {
        send: async (frame) => {
          if (frame.type === "replica.start") startSent = frame.capabilities.includes("repoint-resume-only/v1");
        },
        receive: async () => ({ type: "replica.resync", reason: "authorization_denied" }),
      },
      resumeOnly: true,
      repoId: replicationRepoId,
      target: {
        position: () => position,
        install: async () => {},
        apply: () => {},
        installObject: async () => {},
        project: async () => {},
        reset: async () => {
          resetCount += 1;
        },
        revoke: async () => {
          revokeCount += 1;
        },
      },
      directory,
      quotaBytes: 1_024,
      maxBufferedBytes: 1_024,
      signal: new AbortController().signal,
    }),
    { code: "authorization_denied" },
  );
  assert.equal(startSent, true);
  assert.equal(resetCount, 0);
  assert.equal(revokeCount, 0);
});

test("walsender falls back to offset 0 with new snapshotId when requested snapshot is missing/expired", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-snap-fallback-"));
  const slots = openReplicationSlots(path.join(root, "slots.sqlite"));
  t.after(() => {
    slots.close();
    removeTempRepository(root);
  });

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
      if (frame.type === "replica.data" || frame.type === "replica.data.bin") sentOffsets.push(frame.offset);
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
        const outbound =
          frame.type === "replica.start" ? { ...frame, capabilities: [SNAPSHOT_RESUME_CAPABILITY] } : frame;
        peer1.socket.write(serializeReplicationFrame(outbound));
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
        const outbound =
          frame.type === "replica.start" ? { ...frame, capabilities: [SNAPSHOT_RESUME_CAPABILITY] } : frame;
        peer2.socket.write(serializeReplicationFrame(outbound));
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

test(
  "PG-backed Fleet center started via startCenter ignores leftover SQLite generation, slots, and snapshot pins",
  { timeout: 180_000 },
  async (t) => {
    const repoId = "pg-stale-sqlite-center",
      nodeId = "edge-one",
      root = mkdtempSync(path.join(tmpdir(), "ha-pg-stale-sqlite-")),
      repo = path.join(root, "repo"),
      userRoot = path.join(root, "user"),
      stateRoot = path.join(root, "state"),
      keyPath = path.join(root, "tls.key"),
      certPath = path.join(root, "tls.crt"),
      workspaceRoot = path.join(root, "edge-workspace"),
      viewRoot = path.join(root, "edge-views"),
      viewDir = path.join(viewRoot, "repos", repoId, "views", nodeId),
      trackedClosers: Array<() => void> = [],
      localAuth = {
        transportKind: "unix-socket" as const,
        unixSocketOwnerBoundary: {
          ownerUid: process.getuid?.() ?? 0,
          source: "unix-socket-filesystem-owner-boundary" as const,
        },
      };

    mkdirSync(path.join(repo, "harness"), { recursive: true });
    mkdirSync(userRoot, { recursive: true });
    mkdirSync(stateRoot, { recursive: true });
    const git = (...args: readonly string[]): string =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "PG Stale SQLite Test");
    git("config", "user.email", "pg-stale-sqlite@example.invalid");
    git("commit", "--allow-empty", "-qm", "base");
    writeFileSync(
      path.join(repo, "harness/harness.yaml"),
      "schema: harness-anything/v1\nname: pg-stale-sqlite\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    git("add", "harness");
    git("commit", "-qm", "harness");
    registerBootstrappedDaemonRepo({ canonicalRoot: repo, repoId, userRoot, createConvenienceLinks: false });

    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-subj",
        "/CN=localhost",
        "-days",
        "1",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    const cert = readFileSync(certPath);

    const owners = await fleetNodeOwners({
      userRoot,
      owners: { [nodeId]: "person-owner" },
      repoIds: [repoId],
      localPersonId: "person-local",
    });
    const pg = await pgRuntimeFixture();
    let sqliteHost: Awaited<ReturnType<typeof openDaemonHost>> | null = null;
    let pgHost: Awaited<ReturnType<typeof openDaemonHost>> | null = null;
    const controller = new AbortController();
    let syncLoop: Promise<void> | null = null;

    t.after(async () => {
      for (const close of trackedClosers.splice(0)) close();
      controller.abort();
      await syncLoop?.catch(() => undefined);
      await pgHost?.close().catch(() => undefined);
      await sqliteHost?.close().catch(() => undefined);
      await owners.close().catch(() => undefined);
      await pg.pool.end().catch(() => undefined);
      await pg.close().catch(() => undefined);
      removeTempRepository(root);
    });

    // Phase 1: Run on SQLite first so a genuine generation-3 SQLite ledger + slot + pinned snapshot remain on disk.
    sqliteHost = await openDaemonHost({ daemonId: "center-pre-pg", userRoot });
    await sqliteHost.attachmentsSettled();
    for (const index of [1, 2]) {
      const created = await sqliteHost.run(
        repoId,
        {
          kind: "task-create",
          taskId: `task-sqlite-${index}`,
          title: `Pre-migration SQLite task ${index}`,
          presetId: "docs-task",
          riskTier: "low",
        },
        localAuth,
      );
      assert.equal(created.outcome, "applied", JSON.stringify(created));
    }
    await sqliteHost.settleMaterialization(repoId, "pre-migration sqlite seed");
    await sqliteHost.close();
    sqliteHost = null;

    const leftoverSqliteLedger = sqliteLedgerPath(repo, 3);
    assert.equal(existsSync(leftoverSqliteLedger), true, "pre-migration SQLite generation 3 ledger must exist on disk");
    const sqliteReader = openSqliteEventStore({
      databasePath: leftoverSqliteLedger,
      rootInput: repo,
      repoId,
      readOnly: true,
    });
    let sqlitePos;
    try {
      sqlitePos = sqliteReader.replicationPosition();
    } finally {
      sqliteReader.close();
    }
    assert.ok(sqlitePos.revision >= 2, `expected SQLite revision >= 2, got ${sqlitePos.revision}`);

    // Seed a leftover pre-migration SQLite replication slot row for the same repo/node.
    const leftoverSlotsFile = path.join(stateRoot, "replication-slots.sqlite");
    const leftoverSlots = openReplicationSlots(leftoverSlotsFile);
    try {
      const lease = leftoverSlots.claim({ repoId, nodeId }, sqlitePos.history);
      leftoverSlots.acknowledge(lease, { durable: sqlitePos, applied: sqlitePos }, sqlitePos);
    } finally {
      leftoverSlots.close();
    }
    assert.equal(existsSync(leftoverSlotsFile), true);

    // Seed a leftover pre-migration pinned snapshot directory with the old SQLite history.
    const staleSnapshotId = "stale-sqlite-pin-1";
    const stalePinDir = path.join(stateRoot, "replication-backups", repoId, staleSnapshotId);
    mkdirSync(stalePinDir, { recursive: true });
    const dummyArchive = Buffer.from("stale-sqlite-backup-bytes");
    writeFileSync(path.join(stalePinDir, "base.tar.gz"), dummyArchive);
    writeFileSync(
      path.join(stalePinDir, "pin.json"),
      JSON.stringify({
        schema: "fleet-snapshot-pin/v1",
        snapshotId: staleSnapshotId,
        repoId,
        mode: "split",
        metadata: {
          schema: "fleet-basebackup/v3",
          repoId,
          readerProfile: null,
          position: sqlitePos,
          ledgerGeneration: 3,
          projectionSchema: 40,
        },
        position: sqlitePos,
        size: dummyArchive.byteLength,
        sha256: createHash("sha256").update(dummyArchive).digest("hex"),
        archiveFile: "base.tar.gz",
        objects: [],
        objectCount: 0,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    );

    // Phase 2: Switch the center repository to PostgreSQL while leaving the old SQLite generation/slots/pin on disk.
    const storage = {
      backend: "postgres" as const,
      connectionString: pg.connectionString,
      authorityConnectionString: pg.managementConnectionString,
      materialize: true,
      scope: { tenantId: "tenant", projectId: "project", readers: ["person-owner", "person-local"], policyEpoch: 1 },
    };
    writeFileSync(path.join(userRoot, "daemon-storage.json"), JSON.stringify({ [repoId]: storage }));

    pgHost = await openDaemonHost({ daemonId: "center-pg", userRoot });
    await pgHost.attachmentsSettled();

    // Bootstrap Settings in the fresh PG store (simulating an active PG repository), then advance past SQLite revision.
    const settingsBootstrapped = await pgHost.run(repoId, { kind: "settings-update", locale: "en-US" }, localAuth);
    assert.equal(settingsBootstrapped.outcome, "applied", JSON.stringify(settingsBootstrapped));
    for (let index = 1; index <= sqlitePos.revision + 2; index += 1) {
      const created = await pgHost.run(
        repoId,
        {
          kind: "task-create",
          taskId: `task-pg-${index}`,
          title: `PG authoritative task ${index}`,
          presetId: "docs-task",
          riskTier: "low",
        },
        localAuth,
      );
      assert.equal(created.outcome, "applied", JSON.stringify(created));
    }
    await pgHost.settleMaterialization(repoId, "pg authoritative seed");

    const pgSource = openFleetStorage({ rootDir: repo, repoId, storage });
    let pgPos;
    try {
      pgPos = pgSource.replicationPosition();
    } finally {
      pgSource.close();
    }
    assert.notEqual(pgPos.history, sqlitePos.history, "PG history must differ from leftover SQLite history");
    assert.ok(
      pgPos.revision > sqlitePos.revision,
      `PG revision (${pgPos.revision}) must exceed leftover SQLite revision (${sqlitePos.revision})`,
    );

    // Start Fleet center through the real host.fleet.startCenter RPC (ha daemon fleet center start).
    const started = await pgHost.fleet.startCenter(
      {
        port: 0,
        bind: "127.0.0.1",
        keyPath,
        certPath,
        repoId,
        stateRoot,
        quotaBytes: 64 * 1024 * 1024,
      },
      localAuth,
    );
    const centerPort = Number(started.port);
    assert.ok(Number.isSafeInteger(centerPort) && centerPort > 0, JSON.stringify(started));

    // Before edge connects, leftover replication-slots.sqlite must not surface phantom rows for the PG repo.
    const overviewBefore = await pgHost.read(repoId, "repo.fleet.overview.read", {}, localAuth);
    assert.equal(overviewBefore.centerRevision, pgPos.revision);
    assert.deepEqual(
      overviewBefore.links,
      [],
      `stale SQLite replication slot must not appear for PG repo: ${JSON.stringify(overviewBefore.links)}`,
    );

    // Phase 3a: An edge requesting resume of the stale pre-migration SQLite snapshot pin must NOT trigger history mismatch;
    // the center must discard the mismatched pin and stream a fresh PG basebackup at resumeOffset=0.
    const probePeer = await replicationPeer(
      (close) => trackedClosers.push(close),
      centerPort,
      cert,
      nodeId,
      `secret-${nodeId}`,
    );
    try {
      const accepted = await probePeer.request({
        type: "replica.start",
        repoId,
        position: null,
        edgeBuildCommit: null,
        taskEventShapeVersion: TASK_EVENT_SHAPE_COMPAT_VERSION,
        capabilities: [SNAPSHOT_RESUME_CAPABILITY, SNAPSHOT_OBJECT_PACK_CAPABILITY],
        resumeSnapshot: { snapshotId: staleSnapshotId, offset: 5 },
      });
      assert.equal(accepted.type, "replica.accept", JSON.stringify(accepted));
      const backupFrame = await probePeer.receive();
      assert.equal(backupFrame.type, "replica.backup", JSON.stringify(backupFrame));
      assert.equal(backupFrame.metadata.position.history, pgPos.history);
      assert.equal(backupFrame.metadata.position.revision, pgPos.revision);
      assert.equal(backupFrame.resumeOffset ?? 0, 0);
      assert.notEqual(backupFrame.snapshotId, staleSnapshotId);
      assert.equal(existsSync(stalePinDir), false, "stale pre-migration snapshot pin must be retired");
    } finally {
      probePeer.close();
      await probePeer.closed;
    }

    // Phase 3b: Connect full edge replica and verify clean basebackup + convergence to lag=0rev on PG history.
    const failures: unknown[] = [];
    syncLoop = runFleetReplicaSync({
      hostname: "127.0.0.1",
      port: centerPort,
      ca: cert,
      servername: "localhost",
      nodeId,
      credential: `secret-${nodeId}`,
      readAccessToken: async () => `device-token-${nodeId}`,
      repoId,
      viewRoot,
      diskQuotaBytes: 64 * 1024 * 1024,
      signal: controller.signal,
      onConfirmed: (changedPaths) => {
        applyFleetMirrorCut(viewRoot, repoId, workspaceRoot, "sync", { viewId: nodeId, changedPaths });
      },
      onFailure: (error) => failures.push(error),
      onConfirmedFailure: (error) => failures.push(error),
    });

    await waitForState(
      () => {
        const gen = readReplicaGeneration(viewDir);
        return (
          gen?.metadata.position.history === pgPos.history &&
          gen.metadata.position.sequence === pgPos.sequence &&
          gen.metadata.position.revision === pgPos.revision
        );
      },
      () => `PG edge convergence; failures=${JSON.stringify(failures.map(String))}`,
      30_000,
    );
    assert.deepEqual(failures, [], `unexpected edge sync failures: ${JSON.stringify(failures.map(String))}`);

    // Verify daemon fleet status (repo.fleet.overview.read) sync view reports PG revision & lag=0rev with no duplicate stale link.
    await waitForState(
      async () => {
        const overview = await pgHost!.read(repoId, "repo.fleet.overview.read", {}, localAuth);
        const edgeRow = overview.nodes.find((node) => node.nodeId === nodeId);
        return (
          edgeRow?.replica?.centerRevision === pgPos.revision &&
          edgeRow.replica.ackRevision === pgPos.revision &&
          edgeRow.replica.lagRevisions === 0 &&
          edgeRow.replica.delivery === "current"
        );
      },
      async () => {
        const overview = await pgHost!.read(repoId, "repo.fleet.overview.read", {}, localAuth);
        return `fleet overview convergence; overview=${JSON.stringify({ centerRevision: overview.centerRevision, links: overview.links, edge: overview.nodes.find((n) => n.nodeId === nodeId)?.replica })}`;
      },
      15_000,
    );
    const overviewAfter = await pgHost.read(repoId, "repo.fleet.overview.read", {}, localAuth);
    const edgeRowAfter = overviewAfter.nodes.find((node) => node.nodeId === nodeId);
    assert.equal(overviewAfter.centerRevision, pgPos.revision);
    assert.equal(edgeRowAfter?.replica?.centerRevision, pgPos.revision);
    assert.equal(edgeRowAfter?.replica?.ackRevision, pgPos.revision);
    assert.equal(edgeRowAfter?.replica?.lagRevisions, 0);
    assert.equal(edgeRowAfter?.replica?.delivery, "current");
    assert.equal(edgeRowAfter?.replica?.syncFailure, null);
    assert.equal(overviewAfter.links.length, 1, JSON.stringify(overviewAfter.links));
    assert.equal(overviewAfter.links[0]?.state, "fresh");
    assert.equal(overviewAfter.links[0]?.centerRevision, pgPos.revision);
    assert.equal(overviewAfter.links[0]?.lagRevisions, 0);

    // Phase 4: Verify edge write-forward succeeds without replica_lag_timeout and converges to lag=0rev.
    const forwarded = await runFleetEdgeTask(
      {
        payload: {
          host: "127.0.0.1",
          port: centerPort,
          caPath: certPath,
          servername: "localhost",
          nodeId,
          credential: `secret-${nodeId}`,
          principalId: "person-owner",
          repoId,
          viewRoot,
          workspaceRoot,
          quotaBytes: 64 * 1024 * 1024,
          action: {
            kind: "task-create",
            taskId: "task-pg-edge-forward",
            title: "Edge forwarded write on PG center",
            presetId: "docs-task",
            riskTier: "low",
          },
        },
      },
      async () => `device-token-${nodeId}`,
    );
    assert.equal(forwarded.outcome, "applied", JSON.stringify(forwarded));

    const expectedRevision = pgPos.revision + 1;
    await waitForState(
      () => {
        const view = locateFleetMirrorView(viewRoot, repoId);
        return view !== null && view.revision === expectedRevision;
      },
      "edge mirror to reflect forwarded PG write",
      15_000,
    );
    const overviewFinal = await pgHost.read(repoId, "repo.fleet.overview.read", {}, localAuth);
    const edgeRowFinal = overviewFinal.nodes.find((node) => node.nodeId === nodeId);
    assert.equal(overviewFinal.centerRevision, expectedRevision);
    assert.equal(edgeRowFinal?.replica?.centerRevision, expectedRevision);
    assert.equal(edgeRowFinal?.replica?.ackRevision, expectedRevision);
    assert.equal(edgeRowFinal?.replica?.lagRevisions, 0);
    assert.equal(existsSync(leftoverSqliteLedger), true, "leftover SQLite ledger was not touched or deleted");
  },
);

test("walsender retains history-divergence fence when archive history differs from lease history", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-walsender-history-fence-"));
  const slots = openReplicationSlots(path.join(root, "slots.sqlite"));
  t.after(() => {
    slots.close();
    removeTempRepository(root);
  });
  const lease = slots.claim({ repoId: "fence-repo", nodeId: "edge-one" }, "history-lease");
  const dummyFile = path.join(root, "base.tar.gz");
  writeFileSync(dummyFile, "archive");
  let released = false;
  const mismatchedMeta: BaseBackupMetadata = {
    schema: "fleet-basebackup/v3",
    repoId: "fence-repo",
    readerProfile: { personId: "owner", nodeId: "edge-one" },
    position: { history: "history-forked", sequence: 1, revision: 1 },
    ledgerGeneration: 3,
    projectionSchema: 40,
  };
  const source: ReplicationSource = {
    read: () => null,
    wait: async () => undefined,
    acknowledged: async () => undefined,
    backup: async () => ({
      metadata: mismatchedMeta,
      file: dummyFile,
      size: 7,
      sha256: createHash("sha256").update("archive").digest("hex"),
      release: async () => {
        released = true;
      },
    }),
    object: async function* () {},
  };
  const inbound: ReplicationFrame[] = [
    { type: "replica.start", repoId: "fence-repo", position: null, taskEventShapeVersion: 1 },
  ];
  const peer: ReplicationPeer = {
    send: async () => undefined,
    receive: async () => inbound.shift()!,
  };
  await assert.rejects(
    runWalSender({ peer, source, slots, lease, signal: new AbortController().signal }),
    /replication history changed during backup/u,
  );
  assert.equal(released, true, "archive must still be released when history fence trips");
});
