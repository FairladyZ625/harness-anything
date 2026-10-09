import assert from "node:assert/strict";
import { READ_MODEL_SCHEMA_GENERATION } from "@harness-anything/kernel";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import {
  createReplicaSequence,
  readReplicaSequence,
  readReplicaRevision,
} from "../../kernel/test/store/replica-model.fixture.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { makeOffer, offerFrames } from "../src/fleet/center-replica-offer.ts";
import { openReplicaCutSource } from "../src/fleet/replica-cut-store.ts";

const { root, count } = workerData as { root: string; count: number };
const db = new DatabaseSync(path.join(root, "sequence.sqlite"));
createReplicaSequence(db);
const event = lifecycleFixture().events[0]!;
db.prepare("INSERT INTO replica_revision VALUES (?,?)").run(event.workspaceRevision, JSON.stringify(event));
const insert = db.prepare("INSERT INTO replica_entry VALUES (?,NULL,?,'model','')");
db.exec("BEGIN");
for (let i = 0; i < count; i++)
  insert.run(`.read-model/rows/${String(i).padStart(8, "0")}`, `${String(i).padStart(8, "0")}${"x".repeat(6136)}`);
db.exec("COMMIT");
parentPort!.postMessage({ phase: "seeded", count, textBytes: count * 6144 });
let peakHeap = 0,
  peakRss = 0,
  reads = 0;
const started = performance.now();
const sample = () => {
  const memory = process.memoryUsage();
  peakHeap = Math.max(peakHeap, memory.heapUsed);
  peakRss = Math.max(peakRss, memory.rss);
};
const iterate = StatementSync.prototype.iterate;
StatementSync.prototype.iterate = function (...args) {
  const cursor = iterate.apply(this, args),
    next = cursor.next.bind(cursor);
  cursor.next = (...input) => {
    const result = next(...input);
    if (!result.done && ++reads % 4096 === 0) {
      sample();
      parentPort!.postMessage({ phase: "reading", count, reads, peakHeap, peakRss });
    }
    return result;
  };
  return cursor;
};
const source = openReplicaCutSource({
  repoId: "memory",
  localRoot: root,
  readSequence: (from, read) => read(readReplicaSequence(db, from)),
  readRevision: (revision) => readReplicaRevision(db, revision),
  readContentBlob: () => null,
});
try {
  const cut = source.activate()!;
  assert.equal(cut.manifest.entryCount, count);
  assert.equal(cut.manifest.totalBytes, count * 6144);
  const publishedMs = performance.now() - started;
  const key = { repoId: "memory", nodeId: "edge", viewId: "edge" };
  const offer = { ...key, ...(await makeOffer(key, null, cut, source, new Date().toISOString())) };
  const deliveryStarted = performance.now();
  let pages = 0,
    chunks = 0,
    bytes = 0;
  for await (const frame of offerFrames(offer, source, { owner: "owner", digest: "shape" })) {
    assert.ok(performance.now() - deliveryStarted < 60_000, "complete delivery must fit the center work budget");
    if (frame.schema === "fleet.snapshot.page/v1") {
      pages++;
      sample();
    }
    if (frame.schema === "fleet.snapshot.chunk/v1") {
      chunks++;
      bytes += Buffer.from(frame.dataBase64, "base64").length;
    }
  }
  assert.equal(pages, Math.ceil(count / 128));
  assert.equal(chunks, count);
  assert.equal(bytes, count * 6144);
  const deliveryMs = performance.now() - deliveryStarted;
  // Seed an empty acknowledged predecessor without duplicating 2.46 GB of producer text.
  const checkpoints = new DatabaseSync(
    path.join(root, "replica/repos/memory", `g${READ_MODEL_SCHEMA_GENERATION}`, "checkpoints.sqlite"),
  );
  checkpoints.prepare("INSERT INTO cut VALUES (0,?, ?,0,0,?,0)").run("empty", "0".repeat(64), event.occurredAt);
  checkpoints.prepare("INSERT INTO link VALUES (?,0)").run(cut.revision);
  checkpoints.close();
  const deltaStarted = performance.now();
  const delta = source.changes(0, cut.revision)!;
  assert.equal(delta.count, count);
  let cursor: readonly [number, number] | null = null,
    deltaCount = 0,
    deltaPages = 0;
  for (;;) {
    const page = delta.page(cursor);
    deltaPages++;
    deltaCount += page.changes.length;
    assert.ok(performance.now() - deltaStarted < 60_000, "large deltas must seek without rescanning earlier pages");
    sample();
    if (page.done) break;
    cursor = page.cursor;
  }
  assert.equal(deltaCount, count);
  assert.equal(deltaPages, Math.ceil(count / 128));
  sample();
  parentPort!.postMessage({
    phase: "complete",
    deltaMs: performance.now() - deltaStarted,
    deltaPages,
    publishedMs,
    deliveryMs,
    pages,
    chunks,
    bytes,
    count,
    reads,
    peakHeap,
    peakRss,
    elapsedMs: performance.now() - started,
  });
} finally {
  source.close();
  db.close();
}
