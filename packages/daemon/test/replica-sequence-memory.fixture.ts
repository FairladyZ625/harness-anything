import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import {
  createReplicaSequence,
  readReplicaSequence,
  readReplicaRevision,
} from "../../kernel/test/store/replica-model.fixture.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
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
  sample();
  parentPort!.postMessage({
    phase: "complete",
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
