// harness-test-tier: integration
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createDecisionProjectionTables, listDecisionRows } from "../../src/projection/decision-event-projection.ts";
import { createFactProjectionTables, readFactGraphRows, searchFactRows, type FactProjectionRow } from "../../src/projection/fact-event-projection.ts";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";

test("100k Fact FTS exact searches stay indexed with p95 below 10ms", (context) => {
  const db = new DatabaseSync(":memory:");
  try {
    createRelationGraphProjectionTables(db); createFactProjectionTables(db); createDecisionProjectionTables(db);
    const insertFact = db.prepare("INSERT INTO fact(task_id, fact_id, ref, statement, evidence_source, observed_at, confidence, memory_class, op_id, workspace_revision, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertFts = db.prepare("INSERT INTO fact_fts(task_id, fact_id, statement, evidence_source) VALUES (?, ?, ?, ?)");
    db.exec("BEGIN");
    for (let index = 0; index < 100_000; index += 1) {
      const taskId = `task-${index % 100}`, factId = `F-${String(index).padStart(8, "0")}`, statement = `Indexed observation token${index}`;
      const row: Omit<FactProjectionRow, "state"> = { schema: "fact-row/v1", ref: `fact/${taskId}/${factId}`, taskId, factId, statement,
        evidenceSource: "performance fixture", observedAt: "2026-08-13T00:00:00.000Z", confidence: "high", memoryClass: "semantic", memoryTags: [],
        provenance: [{ runtime: "human", sessionId: "performance", boundAt: "2026-08-13T00:00:00.000Z" }],
        actor: { principal: { personId: "performance" }, executor: null }, source: "local", occurredAt: "2026-08-13T00:00:00.000Z", workspaceRevision: index + 1 };
      insertFact.run(taskId, factId, row.ref, statement, row.evidenceSource, row.observedAt, row.confidence, row.memoryClass, `op-${index}`, index + 1, JSON.stringify(row));
      insertFts.run(taskId, factId, statement, row.evidenceSource);
    }
    db.exec("COMMIT");

    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT rowid FROM fact_fts WHERE fact_fts MATCH ?").all('"token99999"') as unknown as readonly { readonly detail: string }[];
    assert.equal(plan.some(({ detail }) => /VIRTUAL TABLE INDEX/u.test(detail)), true, JSON.stringify(plan));
    searchFactRows(db, { query: "token99999", taskId: "task-99" });
    const samples: number[] = [];
    for (let index = 0; index < 200; index += 1) {
      const target = 99_800 + index, startedAt = performance.now();
      const rows = searchFactRows(db, { query: `token${target}`, taskId: `task-${target % 100}` });
      samples.push(performance.now() - startedAt);
      assert.equal(rows[0]?.factId, `F-${String(target).padStart(8, "0")}`);
    }
    samples.sort((left, right) => left - right);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
    context.diagnostic(`fact-fts rows=100000 samples=200 p95=${p95.toFixed(3)}ms`);
    assert.ok(p95 < 10, `100k Fact FTS p95 ${p95.toFixed(3)}ms exceeded 10ms`);
    assert.equal(readFactGraphRows(db).facts.length, 100_000, "triadic Fact rows must not inherit the 100-result search limit");
    assert.equal(searchFactRows(db, { taskId: "task-0" }).length, 1_000, "fact search must return every match instead of silently truncating");
  } finally {
    db.close();
  }
});

test("10k Decision FTS searches stay indexed after refresh with p95 below 10ms", (context) => {
  const db = new DatabaseSync(":memory:");
  try {
    createRelationGraphProjectionTables(db); createFactProjectionTables(db); createDecisionProjectionTables(db); db.exec("CREATE TABLE document(path TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, value_json TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO decision(decision_id,state,title,question,risk_tier,urgency,vertical,preset,decision_class,applies_json,proposer_json,arbiter_json,proposed_at,decided_at,workspace_revision) VALUES (?, 'proposed', ?, ?, 'high', 'medium', 'performance', 'default', 'ordinary', ?, ?, NULL, ?, NULL, ?)");
    const insertFts = db.prepare("INSERT INTO decision_fts(decision_id,title,question,option_text,claim_text,body) VALUES (?, ?, ?, '', '', '')"), applies = JSON.stringify({ modules: ["kernel"], productLines: [] }), proposer = JSON.stringify({ principal: { personId: "performance" }, executor: null });
    db.exec("BEGIN");
    for (let index = 0; index < 10_000; index += 1) { const id = `dec_PERF_${String(index).padStart(5, "0")}`, title = `Indexed Decision token${index}`, question = `Should token${index} ship?`; insert.run(id, title, question, applies, proposer, "2026-08-13T00:00:00.000Z", index + 1); insertFts.run(id, title, question); }
    db.exec("COMMIT");
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT decision_id FROM decision_fts WHERE decision_fts MATCH ?").all('"token9999"') as unknown as readonly { readonly detail: string }[];
    assert.equal(plan.some(({ detail }) => /VIRTUAL TABLE INDEX/u.test(detail)), true, JSON.stringify(plan));
    db.prepare("DELETE FROM decision_fts WHERE decision_id='dec_PERF_00000'").run(); db.prepare("INSERT INTO decision_fts VALUES ('dec_PERF_00000','Refreshed token0','Should token0 ship?','','','')").run();
    assert.equal(listDecisionRows(db, { search: "token0" })[0]?.decisionId, "dec_PERF_00000");
    assert.equal(listDecisionRows(db, {}).length, 10_000, "decision list must return every row instead of silently truncating");
    const samples: number[] = [];
    for (let index = 0; index < 200; index += 1) { const target = 9_800 + index, startedAt = performance.now(), rows = listDecisionRows(db, { search: `token${target}` }); samples.push(performance.now() - startedAt); assert.equal(rows[0]?.decisionId, `dec_PERF_${String(target).padStart(5, "0")}`); }
    samples.sort((left, right) => left - right); const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
    context.diagnostic(`decision-fts rows=10000 samples=200 p95=${p95.toFixed(3)}ms`);
    assert.ok(p95 < 10, `10k Decision FTS p95 ${p95.toFixed(3)}ms exceeded 10ms`);
  } finally { db.close(); }
});
