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
  const options = {
    repoId: "schema-repo",
    localRoot: root,
    readBasis: () => basis,
    readContentBlob: () => null,
    readEdgeReadModel: () => ({
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
  initial.close();
  const repoRoot = path.join(root, "replica/repos/schema-repo");
  const generationRoot = path.join(repoRoot, `g${READ_MODEL_SCHEMA_GENERATION}`);
  const historicalRoot = path.join(repoRoot, `g${READ_MODEL_SCHEMA_GENERATION - 1}`);
  const blobRoot = path.join(generationRoot, "read-model-blobs");
  const meta = entries.find((entry) => entry.path === READ_MODEL_META_PATH)!;
  const currentMeta = JSON.parse(readFileSync(path.join(blobRoot, meta.blob.sha256), "utf8"));
  const oldEntries = entries.map((entry) => {
    const oldBytes = Buffer.from(
      JSON.stringify({
        ...JSON.parse(readFileSync(path.join(blobRoot, entry.blob.sha256), "utf8")),
        schemaGeneration: READ_MODEL_SCHEMA_GENERATION - 1,
      }),
    );
    const oldSha = sha256Bytes(oldBytes);
    writeFileSync(path.join(blobRoot, oldSha), oldBytes);
    return { ...entry, blob: { ...entry.blob, sha256: oldSha, size: oldBytes.length } };
  });
  const manifestBytes = Buffer.from(stableStringify(oldEntries));
  const oldDigest = sha256Bytes(manifestBytes);
  const manifestPath = path.join(generationRoot, "manifests/sha256", oldDigest.slice(0, 2), oldDigest);
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, manifestBytes);
  renameSync(generationRoot, historicalRoot);
  const db = new DatabaseSync(path.join(historicalRoot, "cuts.sqlite"));
  db.prepare("UPDATE cut SET manifest_digest=?, total_bytes=? WHERE revision=1").run(
    oldDigest,
    oldEntries.reduce((n, entry) => n + entry.blob.size, 0),
  );
  db.close();
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
    latest: () => staleCut,
    manifest: () => oldEntries,
    content: (blob: { sha256: string }) => readFileSync(path.join(historicalRoot, "read-model-blobs", blob.sha256)),
  };
  const edgeRoot = path.join(root, "edges");
  let edge = openFleetEdgeView(edgeRoot, 64 * 1024 * 1024);
  const deliver = async (source: ReturnType<typeof openReplicaCutSource>, nodeId: string) => {
    const offer = {
      nodeId,
      viewId: nodeId,
      repoId: options.repoId,
      ...makeOffer(
        { nodeId, viewId: nodeId, repoId: options.repoId },
        null,
        source.latest()!,
        source,
        "2026-10-08T00:00:00Z",
      ),
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
      toCut: { revision: 1, headDigest: staleCut.headDigest },
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
    for (const oldEntry of oldEntries) {
      const casPath = path.join(
        edgeRoot,
        "repos/schema-repo/cas/sha256",
        oldEntry.blob.sha256.slice(0, 2),
        oldEntry.blob.sha256,
      );
      assert.equal(
        sha256Bytes(readFileSync(casPath)),
        oldEntry.blob.sha256,
        "retained legacy snapshot keeps its CAS bytes through concurrent upgrade",
      );
    }
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
  const historical = new DatabaseSync(path.join(historicalRoot, "cuts.sqlite"));
  assert.equal(
    (historical.prepare("SELECT manifest_digest FROM cut WHERE revision=1").get() as { manifest_digest: string })
      .manifest_digest,
    oldDigest,
  );
  historical.close();
  assert.equal(READ_MODEL_SCHEMA_GENERATION, currentMeta.schemaGeneration);
});

function deltaFixture(prefix: string) {
  const root = mkdtempSync(path.join(tmpdir(), prefix)),
    key = { nodeId: "legacy-node", viewId: "legacy-node", repoId: "legacy-repo" },
    bytes = new Map<string, Buffer>();
  const entry = (logicalPath: string, body: string): FleetEntry => {
      const content = Buffer.from(body),
        blob: FleetBlob = { sha256: sha256Bytes(content), size: content.length, mediaType: "text/markdown" };
      bytes.set(blob.sha256, content);
      return { path: logicalPath, blob };
    },
    entries1 = [entry("tasks/example/INDEX.md", "one\n")],
    entries2 = [entry("tasks/example/INDEX.md", "two\n")],
    cut1 = {
      repoId: key.repoId,
      revision: 1,
      headDigest: `sha256:${"1".repeat(64)}`,
      manifest: {
        digest: fleetManifestDigest(entries1),
        entryCount: entries1.length,
        totalBytes: entries1[0]!.blob.size,
      },
    },
    cut2 = {
      repoId: key.repoId,
      revision: 2,
      headDigest: `sha256:${"2".repeat(64)}`,
      manifest: {
        digest: fleetManifestDigest(entries2),
        entryCount: entries2.length,
        totalBytes: entries2[0]!.blob.size,
      },
    },
    source: ReplicaCutSource = {
      activate: () => cut2,
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
          ? [{ op: "put", path: entries2[0]!.path, blob: entries2[0]!.blob }]
          : null,
      changeLog: () => [],
      content: (blob) => bytes.get(blob.sha256)!,
      close: () => undefined,
    },
    edge = openFleetEdgeView(path.join(root, "edge"), 64 * 1024 * 1024),
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
  return { root, key, cut1, cut2, source, edge, deliver };
}

test("a retained delta migrates an ACKed revision-only edge base", async () => {
  const fixture = deltaFixture("ha-replica-legacy-delta-");
  try {
    const store = openReplicaAckStore(path.join(fixture.root, "center")),
      baseOffer = {
        ...fixture.key,
        ...makeOffer(fixture.key, null, fixture.cut1, fixture.source, "2026-10-08T00:00:00.000Z"),
      };
    store.register(fixture.key, 0);
    const baseLease = store.delivery.claim(fixture.key, "base-holder", Date.parse("2026-10-08T00:00:00.000Z"), 30_000)!,
      baseAck = await fixture.deliver(baseOffer);
    store.offer(fixture.key, baseOffer);
    assert.equal(
      store.ack(
        fixture.key,
        baseAck.transferId,
        baseAck.cut,
        baseAck.manifestDigest,
        "2026-10-08T00:00:01.000Z",
        "2026-10-08T00:00:00.000Z",
        baseLease,
      ).outcome,
      "applied",
    );
    store.delivery.release(baseLease);

    const viewDir = path.join(fixture.root, "edge/repos/legacy-repo/views/legacy-node"),
      currentPath = path.join(viewDir, "current.json"),
      legacyCurrent = JSON.parse(readFileSync(currentPath, "utf8"));
    renameSync(path.join(viewDir, "cuts", "1-g0"), path.join(viewDir, "cuts", "1"));
    delete legacyCurrent.schemaGeneration;
    writeFileSync(currentPath, JSON.stringify(legacyCurrent));

    const deltaOffer = {
      ...fixture.key,
      ...makeOffer(fixture.key, store.cursor(fixture.key), fixture.cut2, fixture.source, "2026-10-08T00:00:02.000Z"),
    };
    assert.equal(deltaOffer.kind, "delta");
    store.offer(fixture.key, deltaOffer);
    const deltaLease = store.delivery.claim(
        fixture.key,
        "delta-holder",
        Date.parse("2026-10-08T00:00:02.000Z"),
        30_000,
      )!,
      deltaAck = await fixture.deliver(deltaOffer);
    assert.equal(
      store.ack(
        fixture.key,
        deltaAck.transferId,
        deltaAck.cut,
        deltaAck.manifestDigest,
        "2026-10-08T00:00:03.000Z",
        "2026-10-08T00:00:02.000Z",
        deltaLease,
      ).outcome,
      "applied",
    );
    assert.equal(store.cursor(fixture.key)?.revision, 2);
    assert.equal(
      locateFleetMirrorView(path.join(fixture.root, "edge"), fixture.key.repoId, fixture.key.viewId)?.revision,
      2,
    );
    assert.equal(fixture.edge.current(fixture.key.repoId, fixture.key.viewId)?.schemaGeneration, 0);
    store.close();
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a generation-bearing current rejects a delta when its exact manifest is missing", async () => {
  const fixture = deltaFixture("ha-replica-missing-generation-delta-");
  try {
    const baseOffer = {
      ...fixture.key,
      ...makeOffer(fixture.key, null, fixture.cut1, fixture.source, "2026-10-08T00:00:00.000Z"),
    };
    await fixture.deliver(baseOffer);
    const viewDir = path.join(fixture.root, "edge/repos/legacy-repo/views/legacy-node");
    renameSync(path.join(viewDir, "cuts", "1-g0"), path.join(viewDir, "cuts", "1"));
    assert.equal(fixture.edge.current(fixture.key.repoId, fixture.key.viewId)?.schemaGeneration, 0);
    const deltaOffer = {
      ...fixture.key,
      ...makeOffer(
        fixture.key,
        {
          ...fixture.key,
          revision: fixture.cut1.revision,
          headDigest: fixture.cut1.headDigest,
          manifestDigest: fixture.cut1.manifest.digest,
          transferId: baseOffer.transferId,
          ackedAt: "2026-10-08T00:00:01.000Z",
          cutEventAt: "2026-10-08T00:00:00.000Z",
        },
        fixture.cut2,
        fixture.source,
        "2026-10-08T00:00:02.000Z",
      ),
    };
    assert.equal(deltaOffer.kind, "delta");
    await assert.rejects(fixture.deliver(deltaOffer), /snapshot_required: current manifest missing/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
