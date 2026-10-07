// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createEdgeReadModelTables, makeEdgeReplicaQueries } from "@harness-anything/kernel";

test("a projection method the edge replica does not materialize is unavailable, never an empty answer", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const queries = makeEdgeReplicaQueries({ db, cut: { status: "ready", watermark: 1, sourceRevision: 1 } });
    for (const read of [() => queries.readCanonicalEvents(0, 1), () => queries.list()])
      assert.throws(read, (error: { code?: string }) => error.code === "replica_unavailable");
  } finally {
    db.close();
  }
});

test("edge version witnesses use the replicated entity revision", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createEdgeReadModelTables(db);
    db.prepare("INSERT INTO entity_projection VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "settings",
      "repository",
      "",
      7,
      "current",
      7,
      "{}",
    );
    const queries = makeEdgeReplicaQueries({ db, cut: { status: "ready", watermark: 7, sourceRevision: 7 } });
    assert.deepEqual(queries.readEntityVersionWitness("settings/repository"), {
      entityRef: "settings/repository",
      freshness: "current",
      currentVersion: 7,
    });
  } finally {
    db.close();
  }
});
