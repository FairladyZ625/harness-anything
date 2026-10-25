// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";
import { auditRelationCycles, createTaskRelationProjectionTable } from "../../src/projection/task-query-projection.ts";

function ledger() {
  const db = new DatabaseSync(":memory:");
  createRelationGraphProjectionTables(db);
  createTaskRelationProjectionTable(db);
  let revision = 0;
  return {
    db,
    edge(
      relationId: string,
      sourceRef: string,
      targetRef: string,
      relationType: string,
      state = "active",
      direction = "directed",
    ) {
      revision += 1;
      db.prepare(
        "INSERT INTO task_relation VALUES (?, ?, ?, ?, ?, ?, 'strong', 'authored', ?, '', ?, '', 0, ?, '')",
      ).run(
        relationId,
        sourceRef.replace(/^task\//u, ""),
        sourceRef,
        targetRef,
        relationType,
        direction,
        state,
        sourceRef,
        revision,
      );
    },
  };
}

test("projection audit reports typed cycle issues with the closed node chain and relation ids", () => {
  const fixture = ledger();
  try {
    fixture.edge("depends-ab", "task/a", "task/b", "depends-on");
    fixture.edge("depends-ba", "task/b", "task/a", "depends-on");
    fixture.edge("supersedes-xy", "decision/x", "decision/y", "supersedes");
    fixture.edge("supersedes-yx", "decision/y", "decision/x", "supersedes");

    assert.deepEqual(auditRelationCycles(fixture.db), {
      scannedEdges: 4,
      issues: [
        {
          code: "relation_cycle_detected",
          relationType: "depends-on",
          nodeRefs: ["task/a", "task/b", "task/a"],
          relationIds: ["depends-ab", "depends-ba"],
        },
        {
          code: "relation_cycle_detected",
          relationType: "supersedes",
          nodeRefs: ["decision/x", "decision/y", "decision/x"],
          relationIds: ["supersedes-xy", "supersedes-yx"],
        },
      ],
    });
  } finally {
    fixture.db.close();
  }
});

test("projection audit ignores retired edges, undirected edges, and cycles stitched across types", () => {
  const fixture = ledger();
  try {
    fixture.edge("retired-ab", "task/a", "task/b", "derives", "retired");
    fixture.edge("retired-ba", "task/b", "task/a", "derives", "retired");
    fixture.edge("depends-ab", "task/a", "task/b", "depends-on");
    fixture.edge("undirected-ba", "task/b", "task/a", "depends-on", "active", "undirected");
    fixture.edge("supersedes-ba", "task/b", "task/a", "supersedes");
    fixture.edge("relates-xy", "task/x", "task/y", "relates");
    fixture.edge("relates-yx", "task/y", "task/x", "relates");

    assert.deepEqual(auditRelationCycles(fixture.db), { scannedEdges: 7, issues: [] });
  } finally {
    fixture.db.close();
  }
});
