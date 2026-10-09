// harness-test-tier: fast
import { edgeReadModelEntries } from "../../kernel/test/store/replica-model.fixture.ts";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  applyEdgeReadModelEntry,
  deleteEdgeReadModelEntry,
  createEdgeReadModelTables,
  makeEdgeReplicaQueries,
} from "@harness-anything/kernel";

test("a projection method the edge replica does not materialize is unavailable, never an empty answer", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const queries = makeEdgeReplicaQueries({ db, cut: { status: "ready", watermark: 1, sourceRevision: 1 } });
    for (const read of [() => queries.readCanonicalEvents(0, 1), () => queries.readReplicaBasis(null)])
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

test("settings provenance missing from a populated settings cut is unavailable, not initial", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createEdgeReadModelTables(db);
    const queries = makeEdgeReplicaQueries({ db, cut: { status: "ready", watermark: 7, sourceRevision: 7 } });
    assert.equal(queries.readSettingsEvent(), null);
    db.prepare("INSERT INTO entity_projection VALUES ('settings', 'repository', '', 7, 'current', 7, '{}')").run();
    assert.throws(
      () => queries.readSettingsEvent(),
      (error: { code?: string }) => error.code === "projection_pending",
    );
  } finally {
    db.close();
  }
});

test("namespaced entity keys survive publication and deletion without path traversal", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createEdgeReadModelTables(db);
    const entities = [
      {
        entityKind: "entity-kind/KND-real",
        ownerId: "",
        entityId: "owned/汉字",
        workspaceRevision: 3,
        freshness: "current" as const,
        currentVersion: 3,
        valueJson: "{}",
      },
      {
        entityKind: "..",
        ownerId: "_",
        entityId: "literal",
        workspaceRevision: 3,
        freshness: "current" as const,
        currentVersion: 3,
        valueJson: "{}",
      },
    ];
    const entries = [
      ...edgeReadModelEntries({
        sourceRevision: 3,
        rootThreshold: 10,
        rows: {
          repository: [],
          tasks: [],
          taskGeneration: [],
          taskProgress: [],
          entities,
          leases: [],
          relations: [],
          decisions: [],
          facts: [],
          presetSnapshots: [],
        },
      }),
    ].filter((entry) => entry.path.startsWith(".read-model/entities/"));
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.equal(entry.path.split("/").includes(".."), false);
      applyEdgeReadModelEntry(db, entry.path, entry.text);
    }
    assert.equal(db.prepare("SELECT count(*) AS n FROM entity_projection").get()!.n, 2);
    deleteEdgeReadModelEntry(db, entries[0]!.path);
    assert.equal(db.prepare("SELECT count(*) AS n FROM entity_projection").get()!.n, 1);
    assert.equal(db.prepare("SELECT entity_kind FROM entity_projection").get()!.entity_kind, "..");
    deleteEdgeReadModelEntry(db, entries[1]!.path);
    assert.equal(db.prepare("SELECT count(*) AS n FROM entity_projection").get()!.n, 0);
  } finally {
    db.close();
  }
});
