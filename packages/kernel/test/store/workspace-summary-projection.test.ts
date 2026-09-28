// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { blockingOf } from "../../src/domain/task-blocking.ts";
import { isDomainStatus } from "../../src/domain/lifecycle-status.ts";
import { summarizeWorkspace, workspaceTaskStatus, type WorkspaceSummary } from "../../src/domain/workspace-summary.ts";
import type { PackageDisposition } from "../../src/domain/package-disposition.ts";
import type { DecisionState } from "../../src/domain/decision-event.ts";
import { createDecisionProjectionTables } from "../../src/projection/decision-projection-schema.ts";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";
import { createTaskRelationProjectionTable, readTaskRelationPage } from "../../src/projection/task-query-projection.ts";
import { readWorkspaceSummaryRows } from "../../src/projection/workspace-summary-projection.ts";

// A projection holding only the tables the workspace census reads. Every statement is recorded with
// the rows it returned, the same count G1's sqlRowsRead takes.
function ledger() {
  const db = new DatabaseSync(":memory:"),
    reads = { rows: 0 },
    prepare = db.prepare.bind(db);
  createTaskRelationProjectionTable(db);
  createRelationGraphProjectionTables(db);
  createDecisionProjectionTables(db);
  db.exec(
    "CREATE TABLE event_index (op_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL UNIQUE, " +
      "task_id TEXT, event_json TEXT NOT NULL); " +
      "CREATE TABLE task_snapshot (task_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, " +
      "snapshot_json TEXT NOT NULL, status TEXT, package_disposition TEXT NOT NULL GENERATED ALWAYS AS (" +
      "COALESCE(json_extract(snapshot_json, '$.task.packageDisposition'), 'active')) STORED, " +
      "updated_at TEXT NOT NULL DEFAULT '')",
  );
  db.prepare = ((sql: string) => {
    const statement = prepare(sql),
      all = statement.all.bind(statement),
      get = statement.get.bind(statement);
    statement.all = ((...args: Parameters<typeof all>) => {
      const result = all(...args);
      reads.rows += result.length;
      return result;
    }) as typeof statement.all;
    statement.get = ((...args: Parameters<typeof get>) => {
      const result = get(...args);
      reads.rows += result === undefined ? 0 : 1;
      return result;
    }) as typeof statement.get;
    return statement;
  }) as typeof db.prepare;
  let revision = 0;
  return {
    db,
    reads,
    task(taskId: string, status: string | null, packageDisposition?: PackageDisposition) {
      revision += 1;
      db.prepare(
        "INSERT INTO task_snapshot(task_id, workspace_revision, snapshot_json, status) VALUES (?, ?, ?, ?)",
      ).run(
        taskId,
        revision,
        JSON.stringify({ task: { taskId, ...(packageDisposition ? { packageDisposition } : {}) } }),
        status,
      );
    },
    dependsOn(relationId: string, sourceRef: string, targetRef: string, state = "active") {
      revision += 1;
      db.prepare(
        "INSERT INTO task_relation VALUES (?, ?, ?, ?, 'depends-on', 'directed', 'strong', 'authored', ?, '', ?, '', 0, ?, '')",
      ).run(relationId, sourceRef.replace(/^task\//u, ""), sourceRef, targetRef, state, sourceRef, revision);
    },
    decision(decisionId: string, state: DecisionState) {
      revision += 1;
      db.prepare(
        "INSERT INTO decision(decision_id,state,title,question,risk_tier,urgency,vertical,preset,decision_class," +
          "applies_json,proposer_json,arbiter_json,proposed_at,decided_at,workspace_revision) " +
          "VALUES (?, ?, 'title', 'question', 'high', 'medium', 'census', 'default', 'ordinary', '{}', '{}', NULL, " +
          "'2026-09-28T00:00:00.000Z', NULL, ?)",
      ).run(decisionId, state, revision);
    },
  };
}

/** The census as it was computed before it counted in SQL: every task and decision row read and
 * judged in memory. The SQL census must reproduce it field for field. */
function rowByRowCensus(db: DatabaseSync): WorkspaceSummary {
  const taskRows = db
    .prepare("SELECT task_id, status, package_disposition FROM task_snapshot ORDER BY task_id")
    .all() as unknown as { task_id: string; status: string | null; package_disposition: PackageDisposition }[];
  const relations: Array<ReturnType<typeof readTaskRelationPage>["rows"][number]> = [];
  let cursor: string | undefined;
  do {
    const page = readTaskRelationPage(db, { relationType: "depends-on", limit: 500, ...(cursor ? { cursor } : {}) });
    relations.push(...page.rows);
    cursor = page.page?.nextCursor ?? undefined;
  } while (cursor !== undefined);
  const blocking = new Map(
    blockingOf(
      taskRows.map((row) => ({ taskId: row.task_id, status: row.status ?? "unknown" })),
      relations,
    ).map((row) => [row.taskId, row.state]),
  );
  const decisions = db.prepare("SELECT decision_id, state FROM decision ORDER BY decision_id").all() as unknown as {
    decision_id: string;
    state: DecisionState;
  }[];
  return summarizeWorkspace(
    taskRows.map((row) => ({
      coordinationStatus:
        row.status !== null && isDomainStatus(row.status)
          ? workspaceTaskStatus({ status: row.status, blockingState: blocking.get(row.task_id) ?? "unknown" })
          : ("unknown" as const),
      packageDisposition: row.package_disposition,
    })),
    decisions.map((row) => ({ decisionId: row.decision_id, state: row.state })),
  );
}

function seedCensus(fixture: ReturnType<typeof ledger>): void {
  fixture.task("a-planned-waits-on-active", "planned");
  fixture.task("b-active-waits-on-done", "active");
  fixture.task("c-done", "done");
  fixture.task("d-active-waits-on-cancelled", "active");
  fixture.task("e-cancelled", "cancelled");
  fixture.task("f-review-waits-on-planned", "in_review");
  fixture.task("g-cycle", "planned");
  fixture.task("h-cycle", "planned");
  fixture.task("i-archived-waits-on-planned", "planned", "archived");
  fixture.task("j-no-status", null);
  fixture.task("k-legacy-status", "legacy");
  fixture.task("l-waits-on-missing", "planned");
  fixture.task("m-retired-edge", "active");
  fixture.task("n-submitted", "submitted");
  fixture.task("o-blocked", "blocked");
  fixture.task("p-tombstoned", "active", "tombstoned");
  fixture.task("q-waits-on-decision", "planned");
  fixture.dependsOn("rel-a-b", "task/a-planned-waits-on-active", "task/b-active-waits-on-done");
  fixture.dependsOn("rel-b-c", "task/b-active-waits-on-done", "task/c-done");
  fixture.dependsOn("rel-d-e", "task/d-active-waits-on-cancelled", "task/e-cancelled");
  fixture.dependsOn("rel-f-a", "task/f-review-waits-on-planned", "task/a-planned-waits-on-active");
  fixture.dependsOn("rel-g-h", "task/g-cycle", "task/h-cycle");
  fixture.dependsOn("rel-h-g", "task/h-cycle", "task/g-cycle");
  fixture.dependsOn("rel-i-a", "task/i-archived-waits-on-planned", "task/a-planned-waits-on-active");
  fixture.dependsOn("rel-l-x", "task/l-waits-on-missing", "task/x-missing");
  fixture.dependsOn("rel-m-a", "task/m-retired-edge", "task/a-planned-waits-on-active", "retired");
  fixture.dependsOn("rel-q-dec", "task/q-waits-on-decision", "decision/dec_B_effect");
  // Retired interleaves its two states by decision id; every other group holds one state.
  fixture.decision("dec_A_proposed", "proposed");
  fixture.decision("dec_B_effect", "in_effect");
  fixture.decision("dec_C_retired", "outcome_retired");
  fixture.decision("dec_D_superseded", "superseded");
  fixture.decision("dec_E_retired", "outcome_retired");
  fixture.decision("dec_F_rejected", "rejected");
  fixture.decision("dec_G_deferred", "deferred");
  fixture.decision("dec_H_proposed", "proposed");
}

test("the SQL census reproduces the row-by-row census field for field", () => {
  const fixture = ledger();
  try {
    seedCensus(fixture);
    const expected = rowByRowCensus(fixture.db);
    assert.deepEqual(readWorkspaceSummaryRows(fixture.db), expected);
    // The fixture exercises the blocking judgment, not only the plain status counts.
    assert.deepEqual(expected.tasks, {
      total: 14,
      byStatus: { planned: 2, active: 2, submitted: 1, blocked: 5, in_review: 1, done: 1, cancelled: 0, unknown: 2 },
    });
    assert.deepEqual(expected.decisions.groups.find(({ id }) => id === "retired")?.decisionIds, [
      "dec_C_retired",
      "dec_D_superseded",
      "dec_E_retired",
    ]);
  } finally {
    fixture.db.close();
  }
});

test("the census reads the same number of rows however many tasks and decisions the ledger holds", () => {
  const rowsRead = [0, 500].map((filler) => {
    const fixture = ledger();
    try {
      seedCensus(fixture);
      for (let index = 0; index < filler; index += 1) {
        fixture.task(`z-filler-${String(index).padStart(4, "0")}`, index % 3 === 0 ? "done" : "planned");
        if (index % 10 === 0) fixture.decision(`dec_Z${String(index).padStart(4, "0")}`, "in_effect");
      }
      const expected = rowByRowCensus(fixture.db);
      fixture.reads.rows = 0;
      assert.deepEqual(readWorkspaceSummaryRows(fixture.db), expected);
      return fixture.reads.rows;
    } finally {
      fixture.db.close();
    }
  });
  assert.equal(rowsRead[1], rowsRead[0]);
});
