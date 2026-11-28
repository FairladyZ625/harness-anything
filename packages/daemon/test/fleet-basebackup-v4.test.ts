// harness-test-tier: contract
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DOC_CODEC_ID, DOC_POLICY_ID } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { REPLAY_TASK_GRAPH } from "@harness-anything/kernel/internal/domain/task-graph.ts";
import {
  activateEmptyCanonicalGeneration,
  COLD_BLOB_SIZE_THRESHOLD_BYTES,
  openReplicationSlots,
  openSqliteEventStore,
  startBaseBackup,
  type BaseBackupArchive,
  type BaseBackupObjectEntry,
  type ReplicationPosition,
} from "@harness-anything/storage";
import {
  BASEBACKUP_V4_CAPABILITY,
  REPLICATION_OBJECT_MANIFEST_BATCH,
  REPLICATION_OBJECT_MANIFEST_BATCH_V3,
  ReplicationDecoder,
  SNAPSHOT_BINARY_WIRE_CAPABILITY,
  SNAPSHOT_OBJECT_PACK_CAPABILITY,
  SNAPSHOT_RESUME_CAPABILITY,
  serializeReplicationWireFrame,
  type ReplicationFrame,
  type ReplicationPeer,
} from "../src/fleet-sync/fleet/protocol.ts";
import { installReplicaGeneration, readReplicaGeneration } from "../src/fleet-sync/fleet/replica-generation.ts";
import { runWalReceiver, type ReplicationTarget } from "../src/daemon-host/fleet/walreceiver.ts";
import { runWalSender, type ReplicationSource } from "../src/daemon-host/fleet/walsender.ts";
import { listenFleetTls } from "../src/daemon-host/fleet/center-listener.ts";
import { openReplicaProjection } from "@harness-anything/storage";
import {
  BlobDigestMismatchError,
  BlobNotFetchedOfflineError,
  fetchFleetBlobWithSession,
  inspectReplicaMissingObjects,
  prefetchReplicaBlobs,
  readEdgeViewBlobLazy,
  replicaObjectRoot,
} from "../src/daemon-host/fleet/blob-fetch.ts";
import { readEdgeViewBlob } from "../src/daemon-host/runtime-result-read.ts";
import { runFleetReplicaStream } from "../src/daemon-host/fleet/peer.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function createWirePeerPair(
  options: {
    readonly onCenterToEdge?: (frame: ReplicationFrame) => void;
    readonly onEdgeToCenter?: (frame: ReplicationFrame) => void;
    readonly mutateCenterFrame?: (frame: ReplicationFrame) => ReplicationFrame | null;
  } = {},
): { readonly centerPeer: ReplicationPeer; readonly edgePeer: ReplicationPeer } {
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
      mutate?: (frame: ReplicationFrame) => ReplicationFrame | null,
    ) =>
    async (frame: ReplicationFrame): Promise<void> => {
      const effective = mutate ? mutate(frame) : frame;
      if (effective === null) return;
      hook?.(effective);
      const wire = serializeReplicationWireFrame(effective);
      const wireBuf = typeof wire === "string" ? Buffer.from(wire) : wire;
      for (const decoded of decoder.push(wireBuf)) {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(decoded);
        else queue.push(decoded);
      }
    };

  return {
    centerPeer: {
      send: makeSend(edgeDecoder, toEdge, edgeWaiters, options.onCenterToEdge, options.mutateCenterFrame),
      receive: makeReceive(toCenter, centerWaiters),
    },
    edgePeer: {
      send: makeSend(centerDecoder, toCenter, centerWaiters, options.onEdgeToCenter),
      receive: makeReceive(toEdge, edgeWaiters),
    },
  };
}

async function seedRepoWithHotAndColdBlobs(root: string, repoId: string) {
  const repoRoot = path.join(root, "center-repo");
  mkdirSync(repoRoot, { recursive: true });
  activateEmptyCanonicalGeneration({ rootInput: repoRoot, repoId });
  const ledgerPath = path.join(repoRoot, ".harness", "store", "generations", "3", "ledger.sqlite");
  const projectionPath = path.join(repoRoot, ".harness", "cache", "task.sqlite");
  const store = openSqliteEventStore({ repoId, databasePath: ledgerPath, generation: 3 });

  const hotBody = Buffer.from("# Active Plan\nHot document body\n", "utf8");
  const coldBody1 = Buffer.from(
    `# Cold Artifact 1\n${"a".repeat(COLD_BLOB_SIZE_THRESHOLD_BYTES + 48 * 1024)}\n`,
    "utf8",
  );
  const coldBody2 = Buffer.from(
    `# Cold Artifact 2\n${"b".repeat(COLD_BLOB_SIZE_THRESHOLD_BYTES + 64 * 1024)}\n`,
    "utf8",
  );
  const hotSha = sha256(hotBody);
  const coldSha1 = sha256(coldBody1);
  const coldSha2 = sha256(coldBody2);
  const fence = { repoId, holder: "center-primary", epoch: 1 };
  const actor = { principal: { personId: "owner" }, executor: { kind: "agent" as const, id: "codex" } };
  const taskRecord = (status: "planned" | "done") => ({
    schema: "task/v2" as const,
    taskId: "task_cold_hist",
    title: "Historical Archived Task",
    taskClass: "standard" as const,
    status,
    graph: REPLAY_TASK_GRAPH,
    currentNode: "implementation",
    iteration: 0,
    createdBy: actor,
    completionGateIds: [],
    presetSnapshotDigest: null,
    pinned: false,
  });

  try {
    store.appendCommand({
      fence,
      intent: { opId: "op_1", intentDigest: `sha256:${sha256("op_1")}`, summary: "create task" },
      events: [
        {
          schema: "task-event/v1",
          eventId: "ev_1",
          opId: "op_1",
          taskId: "task_cold_hist",
          type: "task_created",
          occurredAt: "2026-11-28T00:00:00.000Z",
          actor,
          source: "local",
          workspaceRevision: 1,
          payload: { task: taskRecord("planned") },
        } as never,
      ],
    });
    store.appendCommand({
      fence,
      intent: { opId: "op_2", intentDigest: `sha256:${sha256("op_2")}`, summary: "commit hot and cold blobs" },
      events: [
        {
          schema: "doc-event/v1",
          eventId: "ev_2",
          opId: "op_2",
          type: "documents_written",
          occurredAt: "2026-11-28T00:00:01.000Z",
          actor,
          source: "local",
          workspaceRevision: 2,
          payload: {
            executionId: "exe_1",
            baseLedgerSha: { repoId, revision: 1, headDigest: `sha256:${"0".repeat(64)}` },
            changes: [
              {
                path: "tasks/task_cold_hist-hist/task_plan.md",
                baseBlobSha256: null,
                policyId: DOC_POLICY_ID,
                candidate: { sha256: hotSha, size: hotBody.length, mediaType: "text/markdown" },
                regionProofs: [
                  {
                    regionId: "heading/shared",
                    policyId: DOC_POLICY_ID,
                    codecId: DOC_CODEC_ID,
                    baseSha256: sha256(""),
                    candidateSha256: hotSha,
                    insertBytes: hotBody.length,
                  },
                ],
              },
              {
                path: "tasks/task_cold_hist-hist/artifacts/cold-1.md",
                baseBlobSha256: null,
                policyId: DOC_POLICY_ID,
                candidate: { sha256: coldSha1, size: coldBody1.length, mediaType: "text/markdown" },
                regionProofs: [
                  {
                    regionId: "heading/shared",
                    policyId: DOC_POLICY_ID,
                    codecId: DOC_CODEC_ID,
                    baseSha256: sha256(""),
                    candidateSha256: coldSha1,
                    insertBytes: coldBody1.length,
                  },
                ],
              },
              {
                path: "tasks/task_cold_hist-hist/artifacts/cold-2.md",
                baseBlobSha256: null,
                policyId: DOC_POLICY_ID,
                candidate: { sha256: coldSha2, size: coldBody2.length, mediaType: "text/markdown" },
                regionProofs: [
                  {
                    regionId: "heading/shared",
                    policyId: DOC_POLICY_ID,
                    codecId: DOC_CODEC_ID,
                    baseSha256: sha256(""),
                    candidateSha256: coldSha2,
                    insertBytes: coldBody2.length,
                  },
                ],
              },
            ],
          },
        } as never,
      ],
      blobs: [
        { sha256: hotSha, size: hotBody.length, mediaType: "text/markdown", body: hotBody },
        { sha256: coldSha1, size: coldBody1.length, mediaType: "text/markdown", body: coldBody1 },
        { sha256: coldSha2, size: coldBody2.length, mediaType: "text/markdown", body: coldBody2 },
      ],
    });
    store.appendCommand({
      fence,
      intent: { opId: "op_3", intentDigest: `sha256:${sha256("op_3")}`, summary: "complete historical task" },
      events: [
        {
          schema: "task-event/v1",
          eventId: "ev_3",
          opId: "op_3",
          taskId: "task_cold_hist",
          type: "task_archived",
          occurredAt: "2026-11-28T00:00:02.000Z",
          actor,
          source: "local",
          workspaceRevision: 3,
          payload: {
            task: taskRecord("done"),
            mutation: { command: "archive", reason: "historical archive", fields: ["status"] },
            documentClaims: [],
          },
        } as never,
      ],
    });
  } finally {
    store.close();
  }

  const projection = openReplicaProjection({ repoId, rootDir: repoRoot, ledgerPath, projectionPath, generation: 3 });
  try {
    await projection.projection.catchUpAsync!();
  } finally {
    projection.close();
  }
  return { repoRoot, ledgerPath, projectionPath, hotBody, hotSha, coldBody1, coldSha1, coldBody2, coldSha2 };
}

function makeSelfSignedTls(dir: string) {
  mkdirSync(dir, { recursive: true });
  const key = path.join(dir, "server.key");
  const cert = path.join(dir, "server.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  return { key: readFileSync(key), cert: readFileSync(cert), ca: readFileSync(cert) };
}

test("fleet-basebackup/v4 streams zstd direct unpack with zero archive.part, defers cold blobs, and rejects tamper/truncation", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-v4-direct-unpack-"));
  const slots = openReplicationSlots(path.join(root, "slots.sqlite"));
  t.after(() => {
    slots.close();
    removeTempRepository(root);
  });

  const seeded = await seedRepoWithHotAndColdBlobs(root, "repo-v4-direct");
  const backupDir = path.join(root, "center-backup");
  mkdirSync(backupDir, { recursive: true });
  const built = await (
    await startBaseBackup({
      ledgerPath: seeded.ledgerPath,
      projectionPath: seeded.projectionPath,
      directory: backupDir,
      mode: "split",
      format: "v4",
      readerProfile: { personId: "owner", nodeId: "edge-v4" },
    })
  ).complete;
  const blobs = new Map<string, Buffer>([
    [seeded.hotSha, seeded.hotBody],
    [seeded.coldSha1, seeded.coldBody1],
    [seeded.coldSha2, seeded.coldBody2],
  ]);

  const lease = slots.claim({ repoId: "repo-v4-direct", nodeId: "edge-v4" }, built.metadata.position.history);
  const edgeViewRoot = path.join(root, "edge-view");
  const edgeStagingDir = path.join(edgeViewRoot, "staging");
  const wantedByEdge: string[][] = [];
  const sentObjects: string[] = [];

  const source: ReplicationSource = {
    read: () => null,
    wait: async () => undefined,
    acknowledged: async () => undefined,
    backup: async (_signal, _resume, opts) => {
      assert.equal(opts?.mode, "split");
      assert.equal(opts?.format, "v4");
      return {
        ...built,
        snapshotId: "snap-v4-direct",
        resumeOffset: 0,
        release: async () => undefined,
      };
    },
    object: async function* (hash) {
      sentObjects.push(hash);
      yield blobs.get(hash)!;
    },
  };

  // Positive control: direct streaming zstd unpack with NO archive.part ever written.
  const abort1 = new AbortController();
  const pair1 = createWirePeerPair({
    onEdgeToCenter: (frame) => {
      if (frame.type === "replica.objects.want") wantedByEdge.push([...frame.sha256s]);
    },
  });
  let currentPos: ReplicationPosition | null = null;
  let archiveArgSeen: string | null = null;
  let preunpackedSeen: string | undefined;
  const target1: ReplicationTarget = {
    generationsDir: path.join(edgeViewRoot, "generations"),
    position: () => currentPos,
    install: async (archive, metadata, size, sha, installOpts) => {
      archiveArgSeen = archive;
      preunpackedSeen = installOpts?.preunpackedDir;
      // Verify NO archive.part was written anywhere under staging/snapshots!
      assert.equal(existsSync(path.join(edgeStagingDir, "snapshots", "snap-v4-direct", "archive.part")), false);
      const gen = await installReplicaGeneration({
        root: edgeViewRoot,
        archive,
        metadata,
        size,
        sha256: sha,
        quotaBytes: 64 * 1024 * 1024,
        ...installOpts,
      });
      currentPos = gen.metadata.position;
    },
    apply: () => undefined,
    installObject: async () => undefined,
    project: async () => {
      abort1.abort(new Error("done"));
    },
  };

  await pair1.centerPeer.send({
    type: "replica.accept",
    centerBuildCommit: "test",
    taskEventShapeVersion: 1,
    capabilities: [
      SNAPSHOT_RESUME_CAPABILITY,
      SNAPSHOT_BINARY_WIRE_CAPABILITY,
      SNAPSHOT_OBJECT_PACK_CAPABILITY,
      BASEBACKUP_V4_CAPABILITY,
    ],
  });
  await Promise.allSettled([
    runWalSender({ peer: pair1.centerPeer, source, slots, lease, signal: abort1.signal }),
    runWalReceiver({
      peer: pair1.edgePeer,
      repoId: "repo-v4-direct",
      target: target1,
      directory: edgeStagingDir,
      quotaBytes: 64 * 1024 * 1024,
      maxBufferedBytes: 1024 * 1024,
      signal: abort1.signal,
    }),
  ]);

  assert.equal(archiveArgSeen, "", "v4 direct unpack never passes an archive.part file path");
  assert.ok(preunpackedSeen, "v4 direct unpack passes preunpacked staging directory");
  assert.deepEqual(wantedByEdge, [[seeded.hotSha]], "v4 hot-set-first join requests only hot blobs");
  assert.deepEqual(sentObjects, [seeded.hotSha], "center transfers only hot blobs during v4 join");
  const installedGen = readReplicaGeneration(edgeViewRoot);
  assert.ok(installedGen);
  assert.equal(installedGen.metadata.schema, "fleet-basebackup/v4");
  const inv = inspectReplicaMissingObjects(installedGen);
  assert.equal(inv.totalObjects, 3);
  assert.equal(inv.alreadyPresent, 1);
  assert.deepEqual([...inv.missingSha256s].sort(), [seeded.coldSha1, seeded.coldSha2].sort());

  // Negative controls: corrupted byte AND truncated stream fail closed with no current.json published.
  for (const mode of ["corrupt", "truncate"] as const) {
    const badViewRoot = path.join(root, `edge-${mode}`);
    const badStaging = path.join(badViewRoot, "staging");
    const badAbort = new AbortController();
    let mutated = false;
    const badPair = createWirePeerPair({
      mutateCenterFrame: (frame) => {
        if (frame.type === "replica.data.bin" && !mutated) {
          mutated = true;
          if (mode === "corrupt") {
            const copy = Buffer.from(frame.data);
            copy[copy.length - 1] = copy[copy.length - 1]! ^ 0xff;
            return { ...frame, data: copy };
          }
          // Truncate: shrink the chunk so total bytes < declared size before replica.backup.end.
          return { ...frame, data: frame.data.subarray(0, Math.max(1, frame.data.byteLength - 16)) };
        }
        return frame;
      },
    });
    const badLease = slots.claim({ repoId: "repo-v4-direct", nodeId: `edge-${mode}` }, built.metadata.position.history);
    await badPair.centerPeer.send({
      type: "replica.accept",
      centerBuildCommit: "test",
      taskEventShapeVersion: 1,
      capabilities: [
        SNAPSHOT_RESUME_CAPABILITY,
        SNAPSHOT_BINARY_WIRE_CAPABILITY,
        SNAPSHOT_OBJECT_PACK_CAPABILITY,
        BASEBACKUP_V4_CAPABILITY,
      ],
    });
    let receiverError: unknown = null;
    await Promise.allSettled([
      runWalSender({ peer: badPair.centerPeer, source, slots, lease: badLease, signal: badAbort.signal }),
      runWalReceiver({
        peer: badPair.edgePeer,
        repoId: "repo-v4-direct",
        target: {
          generationsDir: path.join(badViewRoot, "generations"),
          position: () => null,
          install: async () => {
            assert.fail("corrupt/truncated v4 stream must never reach install");
          },
          apply: () => undefined,
          installObject: async () => undefined,
          project: async () => undefined,
        },
        directory: badStaging,
        quotaBytes: 64 * 1024 * 1024,
        maxBufferedBytes: 1024 * 1024,
        signal: badAbort.signal,
      }).catch((error: unknown) => {
        receiverError = error;
        badAbort.abort(error);
      }),
    ]);
    assert.ok(receiverError, `${mode} v4 stream must fail closed`);
    assert.equal(readReplicaGeneration(badViewRoot), null, `${mode}: no generation published`);
    assert.equal(
      existsSync(path.join(badViewRoot, "generations", `${built.sha256}.staging`)),
      false,
      `${mode}: staging directory discarded on failure`,
    );
  }
});

test("protocol negotiation: v4 edge <-> v3 center falls back to v3, v3 edge <-> v4 center stays compatible, v4 uses 4096 manifest batches", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-v4-negotiation-"));
  const slots = openReplicationSlots(path.join(root, "slots.sqlite"));
  t.after(() => {
    slots.close();
    removeTempRepository(root);
  });

  const seeded = await seedRepoWithHotAndColdBlobs(root, "repo-neg");
  const v3Archive = await (
    await startBaseBackup({
      ledgerPath: seeded.ledgerPath,
      projectionPath: seeded.projectionPath,
      directory: path.join(root, "v3-build"),
      mode: "split",
      format: "v3",
      readerProfile: { personId: "owner", nodeId: "edge-neg" },
    })
  ).complete;
  const v4Archive = await (
    await startBaseBackup({
      ledgerPath: seeded.ledgerPath,
      projectionPath: seeded.projectionPath,
      directory: path.join(root, "v4-build"),
      mode: "split",
      format: "v4",
      readerProfile: { personId: "owner", nodeId: "edge-neg" },
    })
  ).complete;
  const blobs = new Map<string, Buffer>([
    [seeded.hotSha, seeded.hotBody],
    [seeded.coldSha1, seeded.coldBody1],
    [seeded.coldSha2, seeded.coldBody2],
  ]);

  // Case 1: v4 edge talking to a v3 center (which only serves fleet-basebackup/v3).
  {
    const abort = new AbortController();
    const pair = createWirePeerPair();
    const lease = slots.claim(
      { repoId: "repo-neg", nodeId: "v4-edge-vs-v3-center" },
      v3Archive.metadata.position.history,
    );
    const edgeViewRoot = path.join(root, "edge-v4-on-v3");
    let installedSchema = "";
    const v3CenterSource: ReplicationSource = {
      read: () => null,
      wait: async () => undefined,
      acknowledged: async () => undefined,
      backup: async () => ({ ...v3Archive, snapshotId: "snap-v3", resumeOffset: 0, release: async () => undefined }),
      object: async function* (hash) {
        yield blobs.get(hash)!;
      },
    };
    await pair.centerPeer.send({
      type: "replica.accept",
      centerBuildCommit: "v3-center",
      taskEventShapeVersion: 1,
      capabilities: [SNAPSHOT_RESUME_CAPABILITY, SNAPSHOT_BINARY_WIRE_CAPABILITY, SNAPSHOT_OBJECT_PACK_CAPABILITY],
    });
    await Promise.allSettled([
      runWalSender({ peer: pair.centerPeer, source: v3CenterSource, slots, lease, signal: abort.signal }),
      runWalReceiver({
        peer: pair.edgePeer,
        repoId: "repo-neg",
        target: {
          generationsDir: path.join(edgeViewRoot, "generations"),
          position: () => null,
          install: async (archive, metadata, size, sha, opts) => {
            installedSchema = metadata.schema;
            assert.ok(archive.endsWith("archive.part"), "v3 fallback uses resumable archive.part path");
            await installReplicaGeneration({
              root: edgeViewRoot,
              archive,
              metadata,
              size,
              sha256: sha,
              quotaBytes: 64 * 1024 * 1024,
              ...opts,
            });
          },
          apply: () => undefined,
          installObject: async () => undefined,
          project: async () => abort.abort(new Error("done")),
        },
        directory: path.join(edgeViewRoot, "staging"),
        quotaBytes: 64 * 1024 * 1024,
        maxBufferedBytes: 1024 * 1024,
        signal: abort.signal,
      }),
    ]);
    assert.equal(installedSchema, "fleet-basebackup/v3");
    const gen = readReplicaGeneration(edgeViewRoot);
    assert.ok(gen);
    assert.equal(inspectReplicaMissingObjects(gen).missingSha256s.length, 0, "v3 fallback syncs all objects eagerly");
  }

  // Case 2: v3 edge (no fleet-basebackup/v4 capability) talking to a v4 center -> receives v3 + 500-entry batches without tier!
  {
    const abort = new AbortController();
    const manifestBatches: Array<readonly { sha256: string; size: number; tier?: string }[]> = [];
    const pair = createWirePeerPair({
      onCenterToEdge: (frame) => {
        if (frame.type === "replica.objects.manifest") manifestBatches.push(frame.entries);
      },
    });
    const lease = slots.claim(
      { repoId: "repo-neg", nodeId: "v3-edge-vs-v4-center" },
      v3Archive.metadata.position.history,
    );
    // Synthesize 600 manifest objects to confirm v3 caps at 500 per batch (2 rounds).
    const syntheticObjects: BaseBackupObjectEntry[] = Array.from({ length: 600 }, (_, i) => ({
      sha256: sha256(`obj-${i}`),
      size: 16,
      tier: "cold" as const,
    }));
    let requestedFormat: string | undefined;
    const v4CenterSource: ReplicationSource = {
      read: () => null,
      wait: async () => undefined,
      acknowledged: async () => undefined,
      backup: async (_s, _r, opts) => {
        requestedFormat = opts?.format;
        return {
          ...(opts?.format === "v4" ? v4Archive : v3Archive),
          objects: syntheticObjects,
          objectCount: syntheticObjects.length,
          release: async () => undefined,
        };
      },
      object: async function* () {},
    };
    const sender = runWalSender({ peer: pair.centerPeer, source: v4CenterSource, slots, lease, signal: abort.signal });
    await pair.edgePeer.send({
      type: "replica.start",
      repoId: "repo-neg",
      position: null,
      edgeBuildCommit: "v3-edge",
      taskEventShapeVersion: 1,
      capabilities: [SNAPSHOT_BINARY_WIRE_CAPABILITY, SNAPSHOT_OBJECT_PACK_CAPABILITY],
    });
    const backupFrame = await pair.edgePeer.receive(abort.signal);
    assert.equal(backupFrame.type, "replica.backup");
    if (backupFrame.type === "replica.backup") {
      assert.equal(backupFrame.metadata.schema, "fleet-basebackup/v3");
    }
    for (;;) {
      const f = await pair.edgePeer.receive(abort.signal);
      if (f.type === "replica.backup.end") break;
    }
    for (;;) {
      const m = await pair.edgePeer.receive(abort.signal);
      assert.equal(m.type, "replica.objects.manifest");
      if (m.type === "replica.objects.manifest") {
        assert.equal(
          m.entries.every((e) => !("tier" in e)),
          true,
          "v3 edge never receives v4 tier property",
        );
        await pair.edgePeer.send({ type: "replica.objects.want", sha256s: [] });
        if (m.done) break;
      }
    }
    assert.equal(requestedFormat, undefined, "v3 edge never requests v4 format");
    assert.equal(manifestBatches.length, 2, "600 objects split into 2 batches of 500 + 100 for v3 edge");
    assert.equal(manifestBatches[0]!.length, REPLICATION_OBJECT_MANIFEST_BATCH_V3);
    assert.equal(manifestBatches[1]!.length, 100);
    abort.abort(new Error("done"));
    await Promise.allSettled([sender]);
  }

  // Case 3: v4 edge <-> v4 center sends 1500 objects in ONE 4096-capacity manifest batch!
  {
    const abort = new AbortController();
    const manifestBatches: Array<readonly { sha256: string; size: number; tier?: string }[]> = [];
    const pair = createWirePeerPair({
      onCenterToEdge: (frame) => {
        if (frame.type === "replica.objects.manifest") manifestBatches.push(frame.entries);
      },
    });
    const lease = slots.claim({ repoId: "repo-neg", nodeId: "v4-edge-4096" }, v4Archive.metadata.position.history);
    const syntheticObjects: BaseBackupObjectEntry[] = Array.from({ length: 1500 }, (_, i) => ({
      sha256: sha256(`v4-obj-${i}`),
      size: 16,
      tier: i % 2 === 0 ? ("hot" as const) : ("cold" as const),
    }));
    const v4CenterSource: ReplicationSource = {
      read: () => null,
      wait: async () => undefined,
      acknowledged: async () => undefined,
      backup: async (_s, _r, opts) => {
        assert.equal(opts?.format, "v4");
        return {
          ...v4Archive,
          objects: syntheticObjects,
          objectCount: syntheticObjects.length,
          release: async () => undefined,
        };
      },
      object: async function* () {},
    };
    const sender = runWalSender({ peer: pair.centerPeer, source: v4CenterSource, slots, lease, signal: abort.signal });
    await pair.edgePeer.send({
      type: "replica.start",
      repoId: "repo-neg",
      position: null,
      edgeBuildCommit: "v4-edge",
      taskEventShapeVersion: 1,
      capabilities: [SNAPSHOT_BINARY_WIRE_CAPABILITY, SNAPSHOT_OBJECT_PACK_CAPABILITY, BASEBACKUP_V4_CAPABILITY],
    });
    const backupFrame = await pair.edgePeer.receive(abort.signal);
    assert.equal(backupFrame.type, "replica.backup");
    if (backupFrame.type === "replica.backup") {
      assert.equal(backupFrame.metadata.schema, "fleet-basebackup/v4");
    }
    for (;;) {
      const f = await pair.edgePeer.receive(abort.signal);
      if (f.type === "replica.backup.end") break;
    }
    const manifest = await pair.edgePeer.receive(abort.signal);
    assert.equal(manifest.type, "replica.objects.manifest");
    if (manifest.type === "replica.objects.manifest") {
      assert.equal(manifest.done, true);
      assert.equal(manifest.entries.length, 1500);
      assert.ok(REPLICATION_OBJECT_MANIFEST_BATCH === 4096);
    }
    await pair.edgePeer.send({ type: "replica.objects.want", sha256s: [] });
    assert.equal(manifestBatches.length, 1, "1500 objects fit in a single v4 4096-entry manifest batch");
    abort.abort(new Error("done"));
    await Promise.allSettled([sender]);
  }
});

test(
  "end-to-end TLS center: segment cache reuse across 2 joins, online fleet.blob.get/v1 lazy fetch + tamper reject, offline blob_not_fetched_offline, and prefetch --all",
  { timeout: 60_000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-v4-tls-e2e-"));
    t.after(() => removeTempRepository(root));

    const repoId = "repo-v4-e2e";
    const seeded = await seedRepoWithHotAndColdBlobs(root, repoId);
    const tls = makeSelfSignedTls(path.join(root, "tls"));
    let backupBuildCount = 0;
    const centerErrors: Array<{ readonly nodeId: string | null; readonly error: unknown }> = [];

    const center = await listenFleetTls({
      stateRoot: path.join(root, "center-state"),
      key: tls.key,
      cert: tls.cert,
      replicaDiskQuotaBytes: 64 * 1024 * 1024,
      replicationSnapshotSegmentBoundaryRevisions: 10,
      authenticate: (nodeId, credential) => credential === `secret-${nodeId}`,
      nodeOwner: () => "owner",
      onError: (entry) => centerErrors.push(entry),
      verifyReplica: async (auth) => ({
        transportKind: "fleet-tls",
        fleetReplicaPrincipal: {
          personId: auth.nodePrincipal!.personId,
          nodeId: auth.nodePrincipal!.nodeId,
          expiresAt: Date.now() + 60_000,
        },
        oidcPrincipal: {
          personId: auth.nodePrincipal!.personId,
          issuer: "https://auth.example.test",
          subject: auth.nodePrincipal!.personId,
          accessToken: "tok",
          expiresAt: Date.now() + 60_000,
          scopes: ["repository-read"],
        },
      }),
      host: {
        status: () =>
          ({
            ok: true,
            daemonId: "center",
            version: "test",
            startedAt: "2026-11-28T00:00:00.000Z",
            repos: [{ repoId, rootDir: seeded.repoRoot, state: "attached", mode: "local" }],
          }) as never,
        replica: () => ({
          ledgerCut: () => ({ repoId, revision: 3, headDigest: `sha256:${"0".repeat(64)}` }),
          backup: async (request, signal): Promise<BaseBackupArchive> => {
            backupBuildCount += 1;
            const started = await startBaseBackup(
              {
                ledgerPath: seeded.ledgerPath,
                projectionPath: seeded.projectionPath,
                directory: request.directory,
                mode: request.mode,
                format: request.format,
                hotSetThresholdBytes: request.hotSetThresholdBytes,
              },
              signal,
            );
            return await started.complete;
          },
          kick: () => undefined,
          close: () => undefined,
        }),
        pruneReplicationLog: async () => undefined,
        run: async () => {
          throw new Error("unused");
        },
        read: async () => {
          throw new Error("unused");
        },
        awaitRuntimeSessions: async () => undefined,
        runtimeIngress: async () => {
          throw new Error("unused");
        },
        settleMaterialization: async () => undefined,
        authorize: async () => ({ outcome: "allowed" }) as never,
        readDispatchLifecycle: async () => {
          throw new Error("unused");
        },
        readNodeAutoClaimCandidates: async () => {
          throw new Error("unused");
        },
        readNodeAutoDispatchCandidates: async () => {
          throw new Error("unused");
        },
      },
    });
    let centerClosed = false;
    const closeCenter = async () => {
      if (centerClosed) return;
      centerClosed = true;
      await center.close();
    };
    t.after(() => closeCenter());

    const syncEdgeOnce = async (nodeId: string, viewRoot: string) => {
      const controller = new AbortController();
      let appliedPos: ReplicationPosition | null = null;
      await runFleetReplicaStream({
        hostname: "127.0.0.1",
        port: center.port,
        ca: tls.ca,
        servername: "localhost",
        nodeId,
        credential: `secret-${nodeId}`,
        readAccessToken: async () => `device-token-${nodeId}`,
        repoId,
        viewRoot,
        diskQuotaBytes: 64 * 1024 * 1024,
        signal: controller.signal,
        onApplied: (pos) => {
          appliedPos = pos;
          controller.abort(new Error("synced"));
        },
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; centerErrors=${JSON.stringify(centerErrors.map((e) => (e.error instanceof Error ? e.error.message : String(e.error))))}`,
          );
        }
      });
      assert.ok(appliedPos, `edge ${nodeId} must complete sync`);
      return appliedPos!;
    };

    // 1. Edge 1 joins via v4: builds 1 immutable segment, downloads hot blob only, defers cold blobs.
    const viewRoot1 = path.join(root, "edge1-views");
    await syncEdgeOnce("edge-1", viewRoot1);
    assert.equal(backupBuildCount, 1, "first v4 edge join builds one immutable segment");

    const viewDir1 = path.join(viewRoot1, "repos", repoId, "views", "edge-1");
    const gen1 = readReplicaGeneration(viewDir1);
    assert.ok(gen1);
    assert.equal(gen1.metadata.schema, "fleet-basebackup/v4");
    assert.equal(inspectReplicaMissingObjects(gen1).missingSha256s.length, 2);

    // 2. Edge 2 joins AFTER Edge 1 ACKed & disconnected -> MUST reuse cached immutable segment (0 new backup builds!).
    const viewRoot2 = path.join(root, "edge2-views");
    await syncEdgeOnce("edge-2", viewRoot2);
    assert.equal(backupBuildCount, 1, "second v4 edge join reuses Center's immutable snapshot segment");

    // 3. Offline read negative control (strict L3 fail-closed: blob_not_fetched_offline, never empty bytes!).
    const edgeView = { viewDir: viewDir1, repoId };
    assert.throws(
      () => readEdgeViewBlob(edgeView as never, seeded.coldSha1),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "blob_not_fetched_offline");
        return true;
      },
      "synchronous read of unfetched cold blob throws blob_not_fetched_offline",
    );
    await assert.rejects(
      () => readEdgeViewBlobLazy({ view: edgeView, sha256: seeded.coldSha1, peer: null }),
      (error: unknown) => {
        assert.ok(error instanceof BlobNotFetchedOfflineError);
        assert.equal(error.code, "blob_not_fetched_offline");
        return true;
      },
      "offline async read of unfetched cold blob throws blob_not_fetched_offline",
    );

    // 4. SHA-256 tamper negative control on fleet.blob.get/v1!
    const fakeTamperedSession = {
      messageId: () => "tamper_msg_1",
      request: async () => ({
        schema: "fleet.blob.get.result/v1" as const,
        messageId: "tamper_reply_1",
        inReplyTo: "tamper_msg_1",
        repoId,
        sha256: seeded.coldSha1,
        totalSize: seeded.coldBody1.length,
        offset: 0,
        dataBase64: Buffer.alloc(seeded.coldBody1.length, 0xaa).toString("base64"),
        eof: true,
      }),
    };
    await assert.rejects(
      () =>
        fetchFleetBlobWithSession({
          session: fakeTamperedSession,
          repoId,
          sha256: seeded.coldSha1,
          objectRoot: replicaObjectRoot(gen1),
        }),
      (error: unknown) => {
        assert.ok(error instanceof BlobDigestMismatchError);
        assert.equal(error.code, "content_blob_digest_mismatch");
        return true;
      },
    );
    assert.equal(
      inspectReplicaMissingObjects(gen1).missingSha256s.includes(seeded.coldSha1),
      true,
      "tampered blob must never be renamed into objects/sha256",
    );

    // 5. Online lazy fetch via authenticated TLS fleet.blob.get/v1 caches coldSha1 locally once.
    const peerOpts = {
      hostname: "127.0.0.1",
      port: center.port,
      ca: tls.ca,
      servername: "localhost",
      nodeId: "edge-1",
      credential: "secret-edge-1",
      readAccessToken: async () => "device-token-edge-1",
      repoId,
      timeoutMs: 10_000,
    };
    const fetchedCold1 = await readEdgeViewBlobLazy({ view: edgeView, sha256: seeded.coldSha1, peer: peerOpts });
    assert.deepEqual(Buffer.from(fetchedCold1), seeded.coldBody1);
    assert.equal(
      inspectReplicaMissingObjects(gen1).missingSha256s.includes(seeded.coldSha1),
      false,
      "lazy fetch atomically persists coldSha1 in local CAS",
    );
    // coldSha2 is still unfetched!
    assert.deepEqual(inspectReplicaMissingObjects(gen1).missingSha256s, [seeded.coldSha2]);

    // 6. Explicit prefetch --all materializes remaining cold blobs (coldSha2).
    const prefetched = await prefetchReplicaBlobs({ viewDir: viewDir1, peer: peerOpts });
    assert.equal(prefetched.totalObjects, 3);
    assert.equal(prefetched.alreadyPresent, 2);
    assert.equal(prefetched.fetchedCount, 1);
    assert.equal(prefetched.fetchedBytes, seeded.coldBody2.length);
    assert.equal(prefetched.remainingMissing, 0);

    // 7. Shut down Center (go 100% offline): ALL hot & cold reads succeed locally!
    await closeCenter();
    assert.deepEqual(Buffer.from(readEdgeViewBlob(edgeView as never, seeded.hotSha)), seeded.hotBody);
    assert.deepEqual(Buffer.from(readEdgeViewBlob(edgeView as never, seeded.coldSha1)), seeded.coldBody1);
    assert.deepEqual(Buffer.from(readEdgeViewBlob(edgeView as never, seeded.coldSha2)), seeded.coldBody2);
    const offlineLazy = await readEdgeViewBlobLazy({ view: edgeView, sha256: seeded.coldSha2, peer: peerOpts });
    assert.deepEqual(Buffer.from(offlineLazy), seeded.coldBody2);

    // And Edge 2 (which did NOT run prefetch) reading unfetched coldSha2 against the offline center throws blob_not_fetched_offline!
    const viewDir2 = path.join(viewRoot2, "repos", repoId, "views", "edge-2");
    await assert.rejects(
      () => readEdgeViewBlobLazy({ view: { viewDir: viewDir2, repoId }, sha256: seeded.coldSha2, peer: peerOpts }),
      (error: unknown) => {
        assert.ok(error instanceof BlobNotFetchedOfflineError);
        assert.equal(error.code, "blob_not_fetched_offline");
        return true;
      },
      "unreachable center during lazy cold-blob fetch fails closed with blob_not_fetched_offline",
    );
  },
);
