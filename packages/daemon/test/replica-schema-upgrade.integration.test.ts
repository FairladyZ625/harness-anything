// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  READ_MODEL_META_PATH,
  READ_MODEL_SCHEMA_GENERATION,
  edgeReadAuthorizationShapeDigest,
  makeEdgeReplicaQueries,
  reduceTaskEvent,
  emptyTaskLifecycleSnapshot,
  sha256Bytes,
  stableStringify,
  type ReplicaProjectionBasis,
} from "@harness-anything/kernel";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { fleetManifestDigest, type FleetBlob, type FleetEntry, type FleetFrameV1 } from "../src/fleet/contract.ts";
import { digestId } from "../src/fleet/center-transport.ts";
import { openReplicaAckStore, type ReplicaOffer } from "../src/fleet/replica-ack-store.ts";
import { openReplicaCutSource, type ReplicaCutSource } from "../src/fleet/replica-cut-store.ts";
import { makeOffer, offerFrames } from "../src/fleet/center-replica-offer.ts";
import { openFleetEdgeView } from "../src/fleet/edge.ts";
import { locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";
import { openEdgeReadModel } from "../src/fleet/replica-read-model.ts";
import { withEdgeReadModel } from "../src/fleet-edge-task-read.ts";
import { readReplicaHealth } from "../src/fleet/replica-health.ts";

// Seed old-generation metadata and rows with valid CAS and manifest digests.
// Canonical events and the center read basis never change during the upgrade.
test("schema upgrade republishes the current cut and two edges rebuild without a canonical write", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-schema-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const event = lifecycleFixture().events[0]!;
  const basis: ReplicaProjectionBasis = {
    watermark: 1,
    sourceRevision: 1,
    headEvent: event,
    events: [],
    documents: [],
  };
  const snapshot = reduceTaskEvent(emptyTaskLifecycleSnapshot(), event);
  const options: Parameters<typeof openReplicaCutSource>[0] = {
    repoId: "schema-repo",
    localRoot: root,
    readBasis: () => basis,
    readContentBlob: () => null,
    readEdgeReadModel: (read) =>
      read({
        sourceRevision: 1,
        rootThreshold: 0,
        rows: {
          tasks: [
            {
              taskId: "task-1",
              workspaceRevision: 1,
              snapshotJson: JSON.stringify(snapshot),
              status: snapshot.task!.status,
              updatedAt: event.occurredAt,
              packagePath: null,
            },
          ],
          taskGeneration: [],
          taskProgress: [],
          entities: [],
          leases: [],
          relations: [],
          decisions: [],
          facts: [],
          presetSnapshots: [],
          repository: [],
        },
      }),
  };
  const initial = openReplicaCutSource(options);
  const original = initial.activate()!;
  const entries = initial.manifest(1)!;
  const blobs = new Map(entries.map((entry) => [entry.blob.sha256, Buffer.from(initial.content(entry.blob))]));
  initial.close();
  const repoRoot = path.join(root, "replica/repos/schema-repo");
  const generationRoot = path.join(repoRoot, `g${READ_MODEL_SCHEMA_GENERATION}`);
  const historicalRoot = path.join(repoRoot, `g${READ_MODEL_SCHEMA_GENERATION - 1}`);
  const db = new DatabaseSync(path.join(generationRoot, "checkpoints.sqlite"));
  const meta = entries.find((entry) => entry.path === READ_MODEL_META_PATH)!;
  const currentMeta = JSON.parse(blobs.get(meta.blob.sha256)!.toString("utf8"));
  const oldEntries = entries.map((entry) => {
    const oldBytes = Buffer.from(
      JSON.stringify({
        ...JSON.parse(blobs.get(entry.blob.sha256)!.toString("utf8")),
        schemaGeneration: READ_MODEL_SCHEMA_GENERATION - 1,
      }),
    );
    const oldSha = sha256Bytes(oldBytes);
    blobs.set(oldSha, oldBytes);
    db.prepare("INSERT INTO read_model_blob VALUES (?, ?)").run(oldSha, oldBytes);
    return { ...entry, blob: { ...entry.blob, sha256: oldSha, size: oldBytes.length } };
  });
  const manifestBytes = Buffer.from(stableStringify(oldEntries));
  const oldDigest = sha256Bytes(manifestBytes);
  const insert = db.prepare("INSERT INTO manifest_entry VALUES (?, ?, ?, ?)");
  for (const [index, entry] of oldEntries.entries()) insert.run(oldDigest, index, entry.path, stableStringify(entry));
  db.prepare("UPDATE cut SET manifest_digest=?, total_bytes=? WHERE revision=1").run(
    oldDigest,
    oldEntries.reduce((n, entry) => n + entry.blob.size, 0),
  );
  db.close();
  renameSync(generationRoot, historicalRoot);
  const staleCut = {
    ...original,
    manifest: {
      ...original.manifest,
      digest: oldDigest,
      totalBytes: oldEntries.reduce((n, entry) => n + entry.blob.size, 0),
    },
  };
  const stale = {
    ...initial,
    delivery: {
      ...initial.delivery,
      manifestPage: async (_revision: number, offset: number) => ({
        entries: oldEntries.slice(offset, offset + 128),
        done: offset + 128 >= oldEntries.length,
      }),
      manifestEntry: async (_revision: number, entryPath: string) =>
        oldEntries.find((entry) => entry.path === entryPath) ?? null,
      content: async (blob: { sha256: string }) => blobs.get(blob.sha256)!,
    },
    latest: () => staleCut,
    cut: () => staleCut,
    manifest: () => oldEntries,
    content: (blob: { sha256: string }) => blobs.get(blob.sha256)!,
  };
  const edgeRoot = path.join(root, "edges");
  let edge = openFleetEdgeView(edgeRoot, 64 * 1024 * 1024);
  const deliver = async (source: ReturnType<typeof openReplicaCutSource>, nodeId: string) => {
    const offer = {
      nodeId,
      viewId: nodeId,
      repoId: options.repoId,
      ...(await makeOffer(
        { nodeId, viewId: nodeId, repoId: options.repoId },
        null,
        source.latest()!,
        source,
        "2026-10-08T00:00:00Z",
      )),
    };
    for await (const frame of offerFrames(offer, source, {
      owner: "person-one",
      digest: edgeReadAuthorizationShapeDigest({ repoId: options.repoId, owner: "person-one" }),
    }))
      edge.receive(frame);
  };
  // Seed old edge views directly through the real snapshot applier, because the
  // current center offer rightly rejects incompatible metadata.
  for (const nodeId of ["node-one", "node-two"]) {
    const offer = {
      nodeId,
      viewId: nodeId,
      repoId: options.repoId,
      transferId: `old-${nodeId}`,
      fromCut: null,
      toCut: {
        revision: 1,
        headDigest: staleCut.headDigest,
        schemaGeneration: READ_MODEL_SCHEMA_GENERATION - 1,
      },
      manifestDigest: oldDigest,
      kind: "snapshot" as const,
      issuedAt: "2026-10-08T00:00:00Z",
    };
    for await (const frame of offerFrames(offer, stale, {
      owner: "person-one",
      digest: edgeReadAuthorizationShapeDigest({ repoId: options.repoId, owner: "person-one" }),
    }))
      edge.receive(frame);
    const view = locateFleetMirrorView(edgeRoot, options.repoId, nodeId)!;
    const cas = path.join(edgeRoot, "repos/schema-repo/cas/sha256");
    assert.equal(openEdgeReadModel(view, cas), null);
    assert.equal(openEdgeReadModel(view, cas), null);
    assert.equal(
      readReplicaHealth(view.viewDir).rebuildCount,
      0,
      "incompatible CAS metadata cannot be repaired by rebuilding SQLite",
    );
  }
  // Existing deployed snapshots used revision-only directories and no generation in current.json.
  for (const nodeId of ["node-one", "node-two"]) {
    const viewDir = path.join(edgeRoot, "repos/schema-repo/views", nodeId);
    renameSync(path.join(viewDir, "cuts", `1-g${READ_MODEL_SCHEMA_GENERATION - 1}`), path.join(viewDir, "cuts", "1"));
    const currentPath = path.join(viewDir, "current.json");
    const legacy = JSON.parse(readFileSync(currentPath, "utf8"));
    delete legacy.schemaGeneration;
    writeFileSync(currentPath, JSON.stringify(legacy));
  }
  stale.close();
  const upgraded = openReplicaCutSource(options);
  t.after(() => upgraded.close());
  const current = upgraded.activate()!;
  assert.equal(current.revision, original.revision);
  assert.equal(current.headDigest, original.headDigest);
  assert.notEqual(
    current.manifest.digest,
    oldDigest,
    "upgrade must publish current-schema rows without waiting for a new event",
  );
  edge = openFleetEdgeView(edgeRoot, 64 * 1024 * 1024, (point) => {
    if (point === "before_current_rename") throw new Error("crash-before-generation-switch");
  });
  await assert.rejects(deliver(upgraded, "node-one"), /crash-before-generation-switch/u);
  assert.equal(edge.current(options.repoId, "node-one")?.manifestDigest, oldDigest);
  edge = openFleetEdgeView(edgeRoot, 64 * 1024 * 1024);
  await Promise.all(["node-one", "node-two"].map((nodeId) => deliver(upgraded, nodeId)));
  for (const nodeId of ["node-one", "node-two"]) {
    const view = locateFleetMirrorView(edgeRoot, options.repoId, nodeId)!;
    assert.deepEqual(readdirSync(path.join(view.viewDir, "cuts")).sort(), ["1", `1-g${currentMeta.schemaGeneration}`]);
    const model = openEdgeReadModel(view, path.join(edgeRoot, "repos/schema-repo/cas/sha256"));
    assert.ok(model, JSON.stringify(readReplicaHealth(view.viewDir)));
    assert.equal(model.meta.schemaGeneration, currentMeta.schemaGeneration);
    assert.equal(model.meta.sourceRevision, 1);
    const queries = makeEdgeReplicaQueries({ db: model.db, cut: { status: "ready", watermark: 1, sourceRevision: 1 } });
    const list = queries.list({});
    assert.equal(list.status, "ready");
    assert.equal(list.rows.length, 1);
    assert.equal(list.rows[0]!.taskId, "task-1");
    model.db.close();
    const localList = withEdgeReadModel(
      { viewRoot: edgeRoot, repoId: options.repoId, nodeId, principalId: "person-one" },
      (projection) => projection.list({}),
    );
    assert.equal(localList.status, "ready");
    assert.equal(localList.rows[0]!.taskId, "task-1");
    const count = readReplicaHealth(view.viewDir).rebuildCount;
    for (let read = 0; read < 3; read += 1)
      openEdgeReadModel(view, path.join(edgeRoot, "repos/schema-repo/cas/sha256"))!.db.close();
    assert.equal(readReplicaHealth(view.viewDir).rebuildCount, count);
    assert.equal(readReplicaHealth(view.viewDir).modelFailure, null);
  }
  assert.deepEqual(upgraded.changeLog(), []);
  assert.equal(options.readBasis().watermark, 1);
  const historical = new DatabaseSync(path.join(historicalRoot, "checkpoints.sqlite"));
  assert.equal(
    (historical.prepare("SELECT manifest_digest FROM cut WHERE revision=1").get() as { manifest_digest: string })
      .manifest_digest,
    oldDigest,
  );
  historical.close();
  assert.equal(READ_MODEL_SCHEMA_GENERATION, currentMeta.schemaGeneration);
});

function generationDeltaFixture(prefix: string) {
  const root = mkdtempSync(path.join(tmpdir(), prefix)),
    key = { nodeId: "legacy-node", viewId: "legacy-node", repoId: "legacy-repo" },
    bytes = new Map<string, Buffer>();
  const entry = (logicalPath: string, body: string): FleetEntry => {
      const content = Buffer.from(body),
        blob: FleetBlob = { sha256: sha256Bytes(content), size: content.length, mediaType: "application/json" };
      bytes.set(blob.sha256, content);
      return { path: logicalPath, blob };
    },
    entries1 = [
      entry(
        READ_MODEL_META_PATH,
        JSON.stringify({ schemaGeneration: READ_MODEL_SCHEMA_GENERATION, sourceRevision: 414, rootThreshold: 0 }),
      ),
      entry("tasks/example.json", JSON.stringify({ schemaGeneration: READ_MODEL_SCHEMA_GENERATION, value: "one" })),
    ],
    entries2 = [
      entry(
        READ_MODEL_META_PATH,
        JSON.stringify({ schemaGeneration: READ_MODEL_SCHEMA_GENERATION, sourceRevision: 415, rootThreshold: 0 }),
      ),
      entry("tasks/example.json", JSON.stringify({ schemaGeneration: READ_MODEL_SCHEMA_GENERATION, value: "two" })),
    ],
    cut1 = {
      repoId: key.repoId,
      revision: 414,
      headDigest: `sha256:${"1".repeat(64)}`,
      manifest: {
        digest: fleetManifestDigest(entries1),
        entryCount: entries1.length,
        totalBytes: entries1.reduce((sum, item) => sum + item.blob.size, 0),
      },
    },
    cut2 = {
      repoId: key.repoId,
      revision: 415,
      headDigest: `sha256:${"2".repeat(64)}`,
      manifest: {
        digest: fleetManifestDigest(entries2),
        entryCount: entries2.length,
        totalBytes: entries2.reduce((sum, item) => sum + item.blob.size, 0),
      },
    },
    source: ReplicaCutSource = {
      activate: () => cut2,
      prepare: async () => cut2,
      delivery: {
        manifestPage: async (revision, offset) => source.manifestPage(revision, offset),
        manifestEntry: async (revision, entryPath) => source.manifestEntry(revision, entryPath),
        changes: async (from, to) => source.changes(from, to),
        content: async (blob) => source.content(blob),
      },
      manifestPage: (revision, offset) => {
        const entries = source.manifest(revision);
        return entries ? { entries: entries.slice(offset, offset + 128), done: offset + 128 >= entries.length } : null;
      },
      manifestEntry: (revision, entryPath) =>
        source.manifest(revision)?.find((entry) => entry.path === entryPath) ?? null,
      ledgerCut: () => null,
      exactRevision: () => cut2.revision,
      kick: () => undefined,
      waitForCut: async (revision) => (revision === cut1.revision ? cut1 : cut2),
      latest: () => cut2,
      cut: (revision) => (revision === cut1.revision ? cut1 : revision === cut2.revision ? cut2 : null),
      eventAt: () => "2026-10-08T00:00:00.000Z",
      receiptBasis: () => null,
      manifest: (revision) => (revision === cut1.revision ? entries1 : revision === cut2.revision ? entries2 : null),
      changes: (from, to) =>
        from === cut1.revision && to === cut2.revision
          ? entries2.map((item) => ({ op: "put" as const, path: item.path, blob: item.blob }))
          : null,
      changeLog: () => [],
      content: (blob) => bytes.get(blob.sha256)!,
      close: () => undefined,
    },
    edgeRoot = path.join(root, "edge"),
    edge = openFleetEdgeView(edgeRoot, 64 * 1024 * 1024),
    authorization = { owner: "person-one", digest: "a".repeat(64) },
    deliver = async (offer: ReplicaOffer) => {
      let ack: Extract<FleetFrameV1, { schema: "fleet.ack/v1" }> | null = null;
      for await (const frame of offerFrames(offer, source, authorization)) {
        const received = edge.receive(frame);
        if (received?.schema === "fleet.ack/v1") ack = received;
      }
      assert.ok(ack);
      return ack;
    };
  return { root, key, cut1, cut2, source, edgeRoot, edge, deliver };
}

test("generation-bearing wire retires legacy center state before snapshot then retains same-generation delta", async () => {
  const fixture = generationDeltaFixture("ha-replica-wire-generation-");
  let store = openReplicaAckStore(path.join(fixture.root, "center"));
  try {
    assert.equal(store.register(fixture.key, 414), 414);
    store.close();

    const database = new DatabaseSync(path.join(fixture.root, "center/replica/repos/legacy-repo/ack.sqlite"));
    database.exec(
      `CREATE TABLE IF NOT EXISTS ack_proof_g${READ_MODEL_SCHEMA_GENERATION}(node_id TEXT NOT NULL,view_id TEXT NOT NULL,revision INTEGER NOT NULL,head_digest TEXT NOT NULL,manifest_digest TEXT NOT NULL,transfer_id TEXT NOT NULL,acked_at TEXT NOT NULL,cut_event_at TEXT NOT NULL,PRIMARY KEY(node_id,view_id,revision)); CREATE TABLE IF NOT EXISTS ack_cursor_g${READ_MODEL_SCHEMA_GENERATION}(node_id TEXT NOT NULL,view_id TEXT NOT NULL,revision INTEGER NOT NULL,head_digest TEXT NOT NULL,manifest_digest TEXT NOT NULL,transfer_id TEXT NOT NULL,acked_at TEXT NOT NULL,cut_event_at TEXT NOT NULL,PRIMARY KEY(node_id,view_id)); CREATE TABLE IF NOT EXISTS active_offer_g${READ_MODEL_SCHEMA_GENERATION}(node_id TEXT NOT NULL,view_id TEXT NOT NULL,transfer_id TEXT NOT NULL UNIQUE,from_revision INTEGER,from_head_digest TEXT,to_revision INTEGER NOT NULL,to_head_digest TEXT NOT NULL,manifest_digest TEXT NOT NULL,kind TEXT NOT NULL,issued_at TEXT NOT NULL,PRIMARY KEY(node_id,view_id));`,
    );
    database
      .prepare(`INSERT OR REPLACE INTO ack_proof_g${READ_MODEL_SCHEMA_GENERATION} VALUES(?,?,?,?,?,?,?,?)`)
      .run(
        fixture.key.nodeId,
        fixture.key.viewId,
        414,
        fixture.cut1.headDigest,
        fixture.cut1.manifest.digest,
        "legacy-ack",
        "2026-10-08T00:00:00.000Z",
        "2026-10-07T00:00:00.000Z",
      );
    database
      .prepare(`INSERT OR REPLACE INTO ack_cursor_g${READ_MODEL_SCHEMA_GENERATION} VALUES(?,?,?,?,?,?,?,?)`)
      .run(
        fixture.key.nodeId,
        fixture.key.viewId,
        414,
        fixture.cut1.headDigest,
        fixture.cut1.manifest.digest,
        "legacy-ack",
        "2026-10-08T00:00:00.000Z",
        "2026-10-07T00:00:00.000Z",
      );
    database
      .prepare(`INSERT OR REPLACE INTO active_offer_g${READ_MODEL_SCHEMA_GENERATION} VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(
        fixture.key.nodeId,
        fixture.key.viewId,
        "legacy-delta",
        414,
        fixture.cut1.headDigest,
        415,
        fixture.cut2.headDigest,
        fixture.cut2.manifest.digest,
        "delta",
        "2026-10-08T00:00:01.000Z",
      );
    database.close();

    const viewDir = path.join(fixture.edgeRoot, "repos/legacy-repo/views/legacy-node"),
      sentinel = "legacy-manifest-must-not-be-read";
    mkdirSync(path.join(viewDir, "cuts/414"), { recursive: true });
    writeFileSync(
      path.join(viewDir, "current.json"),
      JSON.stringify({
        cut: { revision: 414, headDigest: fixture.cut1.headDigest },
        manifestDigest: fixture.cut1.manifest.digest,
        authorizationOwner: "person-one",
        authorizationShapeDigest: "a".repeat(64),
      }),
    );
    writeFileSync(path.join(viewDir, "cuts/414/manifest.json"), sentinel);

    const deltaBegin = {
      schema: "fleet.delta.begin/v1",
      messageId: "legacy-delta-begin",
      transferId: "legacy-delta",
      repoId: fixture.key.repoId,
      viewId: fixture.key.viewId,
      fromCut: {
        revision: 414,
        headDigest: fixture.cut1.headDigest,
        schemaGeneration: READ_MODEL_SCHEMA_GENERATION,
      },
      toCut: {
        revision: 415,
        headDigest: fixture.cut2.headDigest,
        schemaGeneration: READ_MODEL_SCHEMA_GENERATION,
      },
      changeCount: 2,
      resultManifestDigest: fixture.cut2.manifest.digest,
      authorizationOwner: "person-one",
      authorizationShapeDigest: "a".repeat(64),
    } as const;
    assert.throws(() => fixture.edge.receive(deltaBegin), /snapshot_required: delta base cut is not current/u);

    store = openReplicaAckStore(path.join(fixture.root, "center"));
    assert.equal(store.registrationRevision(fixture.key), 414, "registration remains shared across wire identities");
    assert.equal(store.cursor(fixture.key), null, "revision-only cursor cannot become a generation-bearing cursor");
    assert.equal(store.offerFor(fixture.key), null, "revision-only active offer cannot shadow current wire state");
    const snapshot = {
      ...fixture.key,
      ...(await makeOffer(
        fixture.key,
        store.cursor(fixture.key),
        fixture.cut1,
        fixture.source,
        "2026-10-08T00:00:02.000Z",
      )),
    };
    assert.equal(snapshot.kind, "snapshot");
    assert.equal(
      snapshot.transferId,
      digestId(
        fixture.key.nodeId,
        fixture.key.viewId,
        fixture.key.repoId,
        "0",
        "0",
        String(snapshot.toCut.revision),
        String(snapshot.toCut.schemaGeneration),
        snapshot.manifestDigest,
      ),
      "transfer identity includes both endpoint generations",
    );
    store.offer(fixture.key, snapshot);
    const snapshotLease = store.delivery.claim(
        fixture.key,
        "snapshot-holder",
        Date.parse("2026-10-08T00:00:02.000Z"),
        30_000,
      )!,
      snapshotAck = await fixture.deliver(snapshot);
    assert.equal(
      store.ack(
        fixture.key,
        snapshotAck.transferId,
        snapshotAck.cut,
        snapshotAck.manifestDigest,
        "2026-10-08T00:00:03.000Z",
        "2026-10-08T00:00:00.000Z",
        snapshotLease,
      ).outcome,
      "applied",
    );
    store.delivery.release(snapshotLease);
    assert.equal(
      fixture.edge.current(fixture.key.repoId, fixture.key.viewId)?.schemaGeneration,
      READ_MODEL_SCHEMA_GENERATION,
    );
    assert.equal(readFileSync(path.join(viewDir, "cuts/414/manifest.json"), "utf8"), sentinel);

    const delta = {
      ...fixture.key,
      ...(await makeOffer(
        fixture.key,
        store.cursor(fixture.key),
        fixture.cut2,
        fixture.source,
        "2026-10-08T00:00:04.000Z",
      )),
    };
    assert.equal(delta.kind, "delta", "the generation-bearing 414 base remains eligible for retained delta");
    assert.notEqual(delta.transferId, snapshot.transferId);
    store.offer(fixture.key, delta);
    const deltaLease = store.delivery.claim(
        fixture.key,
        "delta-holder",
        Date.parse("2026-10-08T00:00:04.000Z"),
        30_000,
      )!,
      deltaAck = await fixture.deliver(delta);
    assert.equal(
      store.ack(
        fixture.key,
        deltaAck.transferId,
        deltaAck.cut,
        deltaAck.manifestDigest,
        "2026-10-08T00:00:05.000Z",
        "2026-10-08T00:00:00.000Z",
        deltaLease,
      ).outcome,
      "applied",
    );
    assert.equal(store.cursor(fixture.key)?.revision, 415);
    assert.equal(fixture.edge.current(fixture.key.repoId, fixture.key.viewId)?.cut.revision, 415);

    assert.throws(
      () =>
        fixture.edge.receive({
          ...deltaBegin,
          transferId: "wrong-generation",
          fromCut: { ...deltaBegin.fromCut, schemaGeneration: READ_MODEL_SCHEMA_GENERATION - 1 },
          toCut: { ...deltaBegin.toCut, revision: 416 },
        }),
      /snapshot_required: delta base cut is not current/u,
    );
  } finally {
    store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
