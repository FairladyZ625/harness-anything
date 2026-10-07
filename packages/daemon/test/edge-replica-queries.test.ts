// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { makeEdgeReplicaQueries } from "@harness-anything/kernel";

test("a projection method the edge replica does not materialize is unavailable, never an empty answer", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const queries = makeEdgeReplicaQueries({ db, cut: { status: "ready", watermark: 1, sourceRevision: 1 } });
    for (const read of [() => queries.readRuntimeSession("runtime-a"), () => queries.list()])
      assert.throws(read, (error: { code?: string }) => error.code === "replica_unavailable");
  } finally {
    db.close();
  }
});
