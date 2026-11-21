// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { REPLAY_TASK_GRAPH } from "@harness-anything/kernel/internal/domain/task-graph.ts";
import type { TaskV2 } from "@harness-anything/kernel/internal/domain/task.ts";
import { createDecisionProjectionTables } from "../../src/projection/decision-projection-schema.ts";
import {
  createFactProjectionTables,
  factObservedCommitSql,
  searchFactRowsPage,
} from "../../src/projection/fact-event-projection.ts";
import {
  EXECUTION_SUBMISSION_COMMIT_SQL,
  TASK_EXTERNAL_COMMIT_SQL,
  TASK_INDEX_TABLES_SQL,
} from "../../src/projection/projection-tables.ts";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";
import {
  latestTaskSubmissionCommitSql,
  readTaskIndexRows,
  TASK_TRACE_COMMIT_MATCH_SQL,
} from "../../src/projection/task-query-projection.ts";

const ENTITY_PROJECTION_INDEX_SQL = `
  CREATE TABLE IF NOT EXISTS entity_projection (
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    workspace_revision INTEGER NOT NULL,
    freshness TEXT NOT NULL,
    current_version,
    value_json TEXT NOT NULL,
    PRIMARY KEY(entity_kind, task_id, entity_id)
  );
  CREATE INDEX IF NOT EXISTS entity_projection_task
    ON entity_projection(entity_kind, task_id, workspace_revision, entity_id);
  CREATE INDEX IF NOT EXISTS entity_projection_execution_commit
    ON entity_projection(${EXECUTION_SUBMISSION_COMMIT_SQL}, task_id, entity_kind)
    WHERE entity_kind = 'execution';
`;

function insertDecision(db: DatabaseSync, decisionId: string, appliesJson: string): void {
  db.prepare(
    `INSERT INTO decision(decision_id, legacy_number, decision_sort_key, state, title, question, risk_tier, urgency,
       vertical, preset, decision_class, applies_json, proposer_json, proposed_at, workspace_revision)
     VALUES (?, NULL, ?, 'in_effect', 't', 'q', 'low', 'low', 'v', 'p', 'ordinary', ?, '{}', '2026-11-19T00:00:00.000Z', 1)`,
  ).run(decisionId, decisionId, appliesJson);
}

function validTaskSnapshot(taskId: string, externalCommitSha?: string): string {
  const task: TaskV2 = {
    schema: "task/v2",
    taskId,
    title: `Task ${taskId}`,
    taskClass: "standard",
    status: "active",
    graph: REPLAY_TASK_GRAPH,
    currentNode: "implementation",
    iteration: 1,
    pinned: false,
    createdBy: { principal: { personId: "person-trace" }, executor: null },
    completionGateIds: [],
    presetSnapshotDigest: null,
  };
  return JSON.stringify({
    task,
    executions: [],
    reviews: [],
    ...(externalCommitSha === undefined
      ? {}
      : { externalResolution: { commitSha: externalCommitSha, rationale: "r", factRef: "fact/F-00000001" } }),
  });
}

const prefixes = (db: DatabaseSync) =>
  db
    .prepare("SELECT module_prefix, decision_id FROM decision_applies_module ORDER BY module_prefix, decision_id")
    .all()
    .map((row) => `${String(row.module_prefix)}=${String(row.decision_id)}`);

const plan = (db: DatabaseSync, sql: string, ...values: string[]) =>
  db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...values)
    .map((row) => String(row.detail))
    .join(" | ");

test("decision_applies_module triggers normalize, refresh, delete and tolerate malformed applies_json", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createDecisionProjectionTables(db);
    insertDecision(
      db,
      "dec_A",
      JSON.stringify({
        modules: ["packages/storage/", ".\\tools\\gates", "", 7, "packages/daemon/src"],
        productLines: [],
      }),
    );
    insertDecision(db, "dec_B", JSON.stringify({ modules: ["packages/storages"], productLines: [] }));
    insertDecision(db, "dec_BAD", "invalid unrelated JSON");
    assert.deepEqual(prefixes(db), [
      "packages/daemon/src=dec_A",
      "packages/storage=dec_A",
      "packages/storages=dec_B",
      "tools/gates=dec_A",
    ]);
    db.prepare("UPDATE decision SET applies_json = ? WHERE decision_id = 'dec_A'").run(
      JSON.stringify({ modules: ["apps/web"], productLines: [] }),
    );
    db.prepare("DELETE FROM decision WHERE decision_id = 'dec_B'").run();
    assert.deepEqual(prefixes(db), ["apps/web=dec_A"]);
    assert.match(
      plan(
        db,
        "SELECT decision_id FROM decision_applies_module WHERE module_prefix IN (SELECT value FROM json_each(?))",
        "[]",
      ),
      /SEARCH decision_applies_module USING (?:PRIMARY KEY|COVERING INDEX)/u,
    );
  } finally {
    db.close();
  }
});

test("a projection that predates the prefix triggers is backfilled once by the schema mount", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createDecisionProjectionTables(db);
    db.exec(`DROP TRIGGER decision_applies_module_insert; DROP TRIGGER decision_applies_module_update;
      DROP TRIGGER decision_applies_module_delete; DROP TABLE decision_applies_module;`);
    insertDecision(db, "dec_OLD", JSON.stringify({ modules: ["packages/kernel/"], productLines: [] }));
    insertDecision(db, "dec_OLD_BAD", "invalid unrelated JSON");
    createDecisionProjectionTables(db);
    assert.deepEqual(prefixes(db), ["packages/kernel=dec_OLD"]);
    createDecisionProjectionTables(db);
    assert.deepEqual(prefixes(db), ["packages/kernel=dec_OLD"], "a second mount neither duplicates nor rescans");
  } finally {
    db.close();
  }
});

test("trace lookups on normalized executions and facts use expression indexes and skip malformed JSON fixtures", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(TASK_INDEX_TABLES_SQL);
    db.exec(ENTITY_PROJECTION_INDEX_SQL);
    createFactProjectionTables(db);
    createRelationGraphProjectionTables(db);
    db.exec(
      "CREATE TABLE IF NOT EXISTS document (path TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, value_json TEXT NOT NULL)",
    );
    const taskPlan = plan(
      db,
      `SELECT task_id FROM task_snapshot WHERE ${TASK_TRACE_COMMIT_MATCH_SQL}`,
      "[]",
      "[]",
      "[]",
    );
    assert.match(taskPlan, /USING COVERING INDEX entity_projection_execution_commit/u);
    assert.match(taskPlan, /USING (?:COVERING )?INDEX task_snapshot_external_commit/u);
    assert.doesNotMatch(taskPlan, /SCAN task_snapshot|SCAN entity_projection/u);
    assert.match(
      plan(
        db,
        `SELECT fact_id FROM fact WHERE ${factObservedCommitSql("fact.row_json")} IN (SELECT value FROM json_each(?))`,
        "[]",
      ),
      /USING INDEX fact_observed_commit/u,
    );
    const evidencePlan = plan(
      db,
      "SELECT fact_id FROM fact WHERE (fact.evidence_source = ? OR (fact.evidence_source >= ? AND fact.evidence_source < ?))",
      "a.ts",
      "a.ts:",
      "a.ts;",
    );
    assert.match(evidencePlan, /fact_evidence_source/u);
    assert.doesNotMatch(evidencePlan, /SCAN fact(?! USING)/u);

    const shaRound1 = "a".repeat(40),
      shaSuperseded = "b".repeat(40),
      shaRound2 = "c".repeat(40),
      shaExternal = "e".repeat(40);
    db.prepare(
      "INSERT INTO task_snapshot(task_id, workspace_revision, snapshot_json, status, updated_at) VALUES (?, 1, ?, 'active', '2026-11-19T00:00:00.000Z')",
    ).run("task_rework", validTaskSnapshot("task_rework", shaExternal));
    db.prepare(
      "INSERT INTO task_snapshot(task_id, workspace_revision, snapshot_json, status, updated_at) VALUES (?, 2, ?, 'active', '2026-11-19T00:00:00.000Z')",
    ).run("task_replaced", validTaskSnapshot("task_replaced"));
    const insertExec = db.prepare(
      "INSERT INTO entity_projection(entity_kind, entity_id, task_id, workspace_revision, freshness, current_version, value_json) VALUES ('execution', ?, ?, ?, 'current', ?, ?)",
    );
    insertExec.run(
      "exe_rework_0",
      "task_rework",
      1,
      1,
      JSON.stringify({ iteration: 0, claimedAt: "2026-11-19T00:00:00.000Z", submission: { commitSha: shaRound1 } }),
    );
    insertExec.run(
      "exe_rework_1",
      "task_rework",
      2,
      2,
      JSON.stringify({ iteration: 1, claimedAt: "2026-11-19T00:01:00.000Z", submission: null }),
    );
    insertExec.run(
      "exe_replaced_0",
      "task_replaced",
      3,
      3,
      JSON.stringify({ iteration: 0, claimedAt: "2026-11-19T00:00:00.000Z", submission: { commitSha: shaSuperseded } }),
    );
    insertExec.run(
      "exe_replaced_1",
      "task_replaced",
      4,
      4,
      JSON.stringify({ iteration: 1, claimedAt: "2026-11-19T00:01:00.000Z", submission: { commitSha: shaRound2 } }),
    );
    insertExec.run("exe_corrupt", "task_corrupt", 5, 5, "invalid unrelated JSON");

    const keys = db
      .prepare(
        `SELECT ${latestTaskSubmissionCommitSql("task_snapshot.task_id")} AS submitted, ${TASK_EXTERNAL_COMMIT_SQL} AS external FROM task_snapshot WHERE task_id = 'task_rework'`,
      )
      .get();
    assert.deepEqual(
      { submitted: keys?.submitted, external: keys?.external },
      { submitted: shaRound1, external: shaExternal },
      "the rework tail without a submission falls back to the previous submitted cut",
    );
    assert.deepEqual(
      readTaskIndexRows(db, { submissionCommitShas: [shaRound1] }).rows.map((row) => [
        row.taskId,
        row.submissionCommitShas,
      ]),
      [["task_rework", [shaRound1, shaExternal]]],
    );
    assert.deepEqual(
      readTaskIndexRows(db, { submissionCommitShas: [shaSuperseded] }).rows,
      [],
      "a superseded round-0 submission SHA no longer matches once round 1 submits a new SHA",
    );
    assert.deepEqual(
      readTaskIndexRows(db, { submissionCommitShas: [shaRound2] }).rows.map((row) => [
        row.taskId,
        row.submissionCommitShas,
      ]),
      [["task_replaced", [shaRound2]]],
    );

    const insertFact = db.prepare(
      "INSERT INTO fact(task_id,fact_id,ref,statement,evidence_source,observed_at,confidence,memory_class,op_id,workspace_revision,row_json) VALUES(NULL,?,?,?,'src/a.ts','2026-11-19T00:00:00.000Z','high','semantic',?,1,?)",
    );
    insertFact.run("F-00000001", "fact/F-00000001", "bad", "op-1", "invalid unrelated JSON");
    insertFact.run(
      "F-00000002",
      "fact/F-00000002",
      "good",
      "op-2",
      JSON.stringify({
        schema: "fact-row/v1",
        ref: "fact/F-00000002",
        factId: "F-00000002",
        statement: "good",
        evidenceSource: "src/a.ts",
        observedAt: "2026-11-19T00:00:00.000Z",
        observedCommit: shaRound1,
        memoryClass: "semantic",
        confidence: "high",
      }),
    );
    assert.deepEqual(
      searchFactRowsPage(db, { observedCommits: [shaRound1] }).rows.map((row) => row.factId),
      ["F-00000002"],
    );
  } finally {
    db.close();
  }
});
