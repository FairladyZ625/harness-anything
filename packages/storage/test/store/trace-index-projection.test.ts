// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createDecisionProjectionTables } from "../../src/projection/decision-projection-schema.ts";
import { createFactProjectionTables } from "../../src/projection/fact-event-projection.ts";
import {
  TASK_EXTERNAL_COMMIT_SQL,
  TASK_INDEX_TABLES_SQL,
  TASK_SUBMISSION_COMMIT_SQL,
} from "../../src/projection/projection-tables.ts";

function insertDecision(db: DatabaseSync, decisionId: string, modules: readonly unknown[]): void {
  db.prepare(
    `INSERT INTO decision(decision_id, legacy_number, decision_sort_key, state, title, question, risk_tier, urgency,
       vertical, preset, decision_class, applies_json, proposer_json, proposed_at, workspace_revision)
     VALUES (?, NULL, ?, 'in_effect', 't', 'q', 'low', 'low', 'v', 'p', 'ordinary', ?, '{}', '2026-11-19T00:00:00.000Z', 1)`,
  ).run(decisionId, decisionId, JSON.stringify({ modules, productLines: [] }));
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

test("decision_applies_module triggers normalize, refresh and delete module prefixes for every writer", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createDecisionProjectionTables(db);
    insertDecision(db, "dec_A", ["packages/storage/", ".\\tools\\gates", "", 7, "packages/daemon/src"]);
    insertDecision(db, "dec_B", ["packages/storages"]);
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
    insertDecision(db, "dec_OLD", ["packages/kernel/"]);
    createDecisionProjectionTables(db);
    assert.deepEqual(prefixes(db), ["packages/kernel=dec_OLD"]);
    createDecisionProjectionTables(db);
    assert.deepEqual(prefixes(db), ["packages/kernel=dec_OLD"], "a second mount neither duplicates nor rescans");
  } finally {
    db.close();
  }
});

test("trace lookups on tasks and facts are expression-index searches, never table scans", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(TASK_INDEX_TABLES_SQL);
    createFactProjectionTables(db);
    const taskPlan = plan(
      db,
      `SELECT task_id FROM task_snapshot WHERE ${TASK_SUBMISSION_COMMIT_SQL} IN (SELECT value FROM json_each(?))
       UNION SELECT task_id FROM task_snapshot WHERE ${TASK_EXTERNAL_COMMIT_SQL} IN (SELECT value FROM json_each(?))`,
      "[]",
      "[]",
    );
    assert.match(taskPlan, /USING INDEX task_snapshot_submission_commit/u);
    assert.match(taskPlan, /USING INDEX task_snapshot_external_commit/u);
    assert.doesNotMatch(taskPlan, /SCAN task_snapshot/u);
    assert.match(
      plan(
        db,
        "SELECT fact_id FROM fact WHERE json_extract(fact.row_json, '$.observedCommit') IN (SELECT value FROM json_each(?))",
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
    db.prepare("INSERT INTO task_snapshot(task_id, workspace_revision, snapshot_json) VALUES (?, 1, ?)").run(
      "task_rework",
      JSON.stringify({
        task: { pinned: false },
        executions: [{ submission: { commitSha: "a".repeat(40) } }, { submission: null }],
        externalResolution: { commitSha: "e".repeat(40) },
      }),
    );
    const keys = db
      .prepare(
        `SELECT ${TASK_SUBMISSION_COMMIT_SQL} AS submitted, ${TASK_EXTERNAL_COMMIT_SQL} AS external FROM task_snapshot`,
      )
      .get();
    assert.deepEqual(
      { submitted: keys?.submitted, external: keys?.external },
      { submitted: "a".repeat(40), external: "e".repeat(40) },
      "the rework tail without a submission falls back to the previous submitted cut",
    );
  } finally {
    db.close();
  }
});
