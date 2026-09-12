// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createFactProjectionTables,
  readFactAnchorRows,
  searchFactRowsPage,
} from "../../src/projection/fact-event-projection.ts";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";
import { createTaskRelationProjectionTable, readTaskRelationPage } from "../../src/projection/task-query-projection.ts";

test("large ref sets filter before limit, preserve order, and never decode unrelated facts", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createFactProjectionTables(db);
    createRelationGraphProjectionTables(db);
    const insert = db.prepare(
      "INSERT INTO fact(task_id,fact_id,ref,statement,evidence_source,observed_at,confidence,memory_class,op_id,workspace_revision,row_json) VALUES(NULL,?,?,?,'fixture',?,'high','semantic',?,1,?)",
    );
    for (let i = 0; i < 1200; i++) {
      const factId = `F-${String(i).padStart(8, "0")}`,
        ref = `fact/${factId}`,
        observedAt = "2026-09-12T00:00:00.000Z";
      // Unselected records are intentionally undecodable: a full-decode fallback must fail.
      const row =
        i < 1000
          ? "invalid unrelated JSON"
          : JSON.stringify({
              schema: "fact-row/v1",
              ref,
              factId,
              statement: ref,
              observedAt,
              memoryClass: "semantic",
              confidence: "high",
            });
      insert.run(factId, ref, ref, observedAt, `op-${i}`, row);
    }
    const refs = [
      ...Array.from({ length: 1000 }, (_, i) => `fact/missing-${i}`),
      ...Array.from({ length: 200 }, (_, i) => `fact/F-${String(i + 1000).padStart(8, "0")}`),
    ];
    refs.push(refs.at(-1)!);
    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const result = searchFactRowsPage(db, { refs, limit: 73, ...(cursor ? { cursor } : {}) });
      collected.push(...result.rows.map((row) => row.ref));
      cursor = result.page!.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(collected, refs.slice(1000, 1200));
    assert.deepEqual(
      readFactAnchorRows(db, refs).map((row) => row.factRef),
      collected,
    );
    assert.deepEqual(searchFactRowsPage(db, { refs: [], limit: 5 }).rows, []);
    assert.deepEqual(readFactAnchorRows(db, []), []);
    assert.equal(searchFactRowsPage(db, { refs, limit: 73, confidence: "low" }).rows.length, 0);
  } finally {
    db.close();
  }
});

test("direction filtering precedes pagination in both relation sources", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createRelationGraphProjectionTables(db);
    createTaskRelationProjectionTable(db);
    db.exec("CREATE TABLE event_index(workspace_revision INTEGER, event_json TEXT)");
    const edge = db.prepare("INSERT INTO relation_edge VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
      taskEdge = db.prepare("INSERT INTO task_relation VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (let i = 0; i < 6; i++) {
      const relationId = `rel-${i}`;
      if (i % 2 === 0) {
        taskEdge.run(
          relationId,
          "a",
          "task/a",
          "task/b",
          "relates",
          i < 3 ? "undirected" : "directed",
          "weak",
          "declared",
          "active",
          "fixture",
          "task/a",
          "fixture",
          i,
          i,
          "",
        );
        continue;
      }
      edge.run(
        relationId,
        "task/a",
        "task/b",
        "relates",
        "active",
        null,
        "task/a",
        i,
        JSON.stringify({
          relationId,
          direction: i < 3 ? "undirected" : "directed",
          strength: "weak",
          origin: "declared",
          rationale: "fixture",
          sourcePath: "fixture",
          recordIndex: i,
        }),
      );
    }
    const first = readTaskRelationPage(db, { direction: "directed", limit: 2 });
    assert.deepEqual(
      first.rows.map((row) => row.relationId),
      ["rel-3", "rel-4"],
    );
    const second = readTaskRelationPage(db, { direction: "directed", limit: 2, cursor: first.page!.nextCursor! });
    assert.deepEqual(
      second.rows.map((row) => row.relationId),
      ["rel-5"],
    );
    assert.equal(second.page!.nextCursor, null);
  } finally {
    db.close();
  }
});
