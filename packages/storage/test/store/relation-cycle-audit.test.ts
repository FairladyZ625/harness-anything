// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";
import {
  auditRelationCycles,
  createTaskRelationProjectionTable,
  readTaskRelationPage,
} from "../../src/projection/task-query-projection.ts";
import { findRelationCycleWitnesses } from "@harness-anything/kernel/internal/domain/relation-cycle.ts";
import {
  ensureRelationCycleAudit,
  refreshRelationCycleAudit,
} from "../../src/projection/relation-cycle-audit-projection.ts";

function ledger() {
  const db = new DatabaseSync(":memory:");
  createRelationGraphProjectionTables(db);
  createTaskRelationProjectionTable(db);
  ensureRelationCycleAudit(db);
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
      refresh = true,
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
      db.prepare("INSERT INTO relation_edge VALUES (?, ?, ?, ?, ?, NULL, ?, ?, '', ?, 'current', NULL)").run(
        relationId,
        sourceRef,
        targetRef,
        relationType,
        state,
        sourceRef,
        revision,
        JSON.stringify({
          direction,
          strength: "strong",
          origin: "authored",
          rationale: "",
          sourcePath: "",
          recordIndex: 0,
        }),
      );
      if (refresh) refreshRelationCycleAudit(db);
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

test("relation mirror triggers keep a repeated dirty endpoint unique until the batch refresh", () => {
  const fixture = ledger();
  try {
    for (let index = 0; index < 100; index++)
      fixture.edge(`parallel-${index}`, "task/a", "task/b", "depends-on", "active", "directed", false);

    assert.equal(
      Number(
        (fixture.db.prepare("SELECT count(*) AS count FROM relation_cycle_dirty").get() as { count: number }).count,
      ),
      2,
    );
    refreshRelationCycleAudit(fixture.db);
    assert.deepEqual(auditRelationCycles(fixture.db), { scannedEdges: 100, issues: [] });
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

test("incremental audit matches the full domain audit across independent cycles, splits and event precedence", () => {
  const fixture = ledger();
  const check = () => {
    refreshRelationCycleAudit(fixture.db);
    const rows = readTaskRelationPage(fixture.db, {}).rows;
    assert.deepEqual(auditRelationCycles(fixture.db), {
      scannedEdges: rows.length,
      issues: findRelationCycleWitnesses(rows).map((witness) => ({ code: "relation_cycle_detected", ...witness })),
    });
  };
  try {
    for (const [id, from, to] of [
      ["ab", "a", "b"],
      ["ba", "b", "a"],
      ["cd", "C", "d"],
      ["dc", "d", "C"],
      ["entry", "A", "C"],
      ["bridge", "b", "C"],
    ]) {
      fixture.edge(id!, `task/${from}`, `task/${to}`, "depends-on");
      check();
    }
    fixture.db.exec("UPDATE task_relation SET state='retired' WHERE relation_id='bridge'");
    assert.throws(() => auditRelationCycles(fixture.db), { code: "projection_pending" });
    check();
    fixture.db.exec("DELETE FROM task_relation WHERE relation_id IN ('ab','ba')");
    check();
    // Event-backed truth replaces the legacy row with the same id, including after deletion.
    fixture.db.exec("DELETE FROM task_relation WHERE relation_id='cd'");
    fixture.db.exec("DELETE FROM relation_edge WHERE relation_id='cd'");
    fixture.db
      .prepare(
        "INSERT INTO relation_edge VALUES ('cd','task/C','task/d','depends-on','retired',NULL,'task/C',99,'',?,'current',NULL)",
      )
      .run(JSON.stringify({ direction: "directed" }));
    check();
    fixture.db.exec("DELETE FROM relation_edge WHERE relation_id='cd'");
    check();
    fixture.db.exec("BEGIN; DELETE FROM task_relation; ROLLBACK");
    check();
  } finally {
    fixture.db.close();
  }
});
