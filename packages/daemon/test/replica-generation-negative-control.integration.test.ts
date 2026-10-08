// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { READ_MODEL_META_PATH, READ_MODEL_SCHEMA_GENERATION, sha256Bytes } from "@harness-anything/kernel";
import { fleetManifestDigest, type FleetBlob, type FleetEntry, type FleetFrameV1 } from "../src/fleet/contract.ts";
import { openReplicaAckStore, type ReplicaOffer } from "../src/fleet/replica-ack-store.ts";
import type { ReplicaCutSource } from "../src/fleet/replica-cut-store.ts";
import { makeOffer, offerFrames } from "../src/fleet/center-replica-offer.ts";
import { openFleetEdgeView } from "../src/fleet/edge.ts";

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

test("legacy revision-only cursor selects snapshot rather than retained delta", () => {
  const f = generationDeltaFixture("ha-negative-legacy-cursor-");
  let store = openReplicaAckStore(path.join(f.root, "center"));
  try {
    store.register(f.key, 414);
    store.close();
    const db = new DatabaseSync(path.join(f.root, "center/replica/repos/legacy-repo/ack.sqlite"));
    db.exec(
      `CREATE TABLE IF NOT EXISTS ack_cursor_g${READ_MODEL_SCHEMA_GENERATION}(node_id TEXT NOT NULL,view_id TEXT NOT NULL,revision INTEGER NOT NULL,head_digest TEXT NOT NULL,manifest_digest TEXT NOT NULL,transfer_id TEXT NOT NULL,acked_at TEXT NOT NULL,cut_event_at TEXT NOT NULL,PRIMARY KEY(node_id,view_id));`,
    );
    db.prepare(`INSERT INTO ack_cursor_g${READ_MODEL_SCHEMA_GENERATION} VALUES(?,?,?,?,?,?,?,?)`).run(
      f.key.nodeId,
      f.key.viewId,
      414,
      f.cut1.headDigest,
      f.cut1.manifest.digest,
      "legacy-proof",
      "2026-10-08T00:00:00Z",
      "2026-10-08T00:00:00Z",
    );
    db.close();
    store = openReplicaAckStore(path.join(f.root, "center"));
    assert.equal(
      makeOffer(f.key, store.cursor(f.key), f.cut2, f.source, "2026-10-08T00:00:01Z").kind,
      "snapshot",
      "legacy wire cursor must not select retained delta",
    );
  } finally {
    store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("414-g6 delta fidelity survives unrelated legacy identity mutations", async () => {
  const f = generationDeltaFixture("ha-negative-delta-fidelity-");
  const store = openReplicaAckStore(path.join(f.root, "center"));
  try {
    for (const cut of [f.cut1, f.cut2]) {
      const offer = { ...f.key, ...makeOffer(f.key, store.cursor(f.key), cut, f.source, "2026-10-08T00:00:00Z") };
      assert.equal(offer.kind, cut.revision === 414 ? "snapshot" : "delta");
      store.offer(f.key, offer);
      const lease = store.delivery.claim(f.key, "fidelity-holder", Date.parse("2026-10-08T00:00:00Z"), 30_000)!;
      const ack = await f.deliver(offer);
      assert.equal(
        store.ack(
          f.key,
          ack.transferId,
          ack.cut,
          ack.manifestDigest,
          "2026-10-08T00:00:01Z",
          "2026-10-08T00:00:00Z",
          lease,
        ).outcome,
        "applied",
      );
      store.delivery.release(lease);
      assert.equal(f.edge.current(f.key.repoId, f.key.viewId)?.cut.revision, cut.revision);
      assert.equal(ack.cut.schemaGeneration, READ_MODEL_SCHEMA_GENERATION);
    }
    assert.equal(store.cursor(f.key)?.revision, 415);
  } finally {
    store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("delta begin rejects generation alone with revision and digest held equal", async (t) => {
  for (const generation of [undefined, READ_MODEL_SCHEMA_GENERATION - 1]) {
    await t.test(generation === undefined ? "missing generation" : "mismatched generation", async () => {
      const f = generationDeltaFixture("ha-negative-generation-only-");
      try {
        const snapshot = { ...f.key, ...makeOffer(f.key, null, f.cut1, f.source, "2026-10-08T00:00:00Z") };
        await f.deliver(snapshot);
        const begin = {
          schema: "fleet.delta.begin/v1",
          messageId: "generation-only",
          transferId: "generation-only",
          repoId: f.key.repoId,
          viewId: f.key.viewId,
          fromCut: { revision: 414, headDigest: f.cut1.headDigest, schemaGeneration: generation },
          toCut: { revision: 415, headDigest: f.cut2.headDigest, schemaGeneration: READ_MODEL_SCHEMA_GENERATION },
          changeCount: 2,
          resultManifestDigest: f.cut2.manifest.digest,
          authorizationOwner: "person-one",
          authorizationShapeDigest: "a".repeat(64),
        } as unknown as FleetFrameV1;
        assert.throws(() => f.edge.receive(begin), /snapshot_required: delta base cut is not current/u);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    });
  }
});
