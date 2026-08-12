// harness-test-tier: integration
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createFactProjectionTables, readFactGraphRows, searchFactRows, type FactProjectionRow } from "../../src/projection/fact-event-projection.ts";

test("100k Fact FTS exact searches stay indexed with p95 below 10ms", (context) => {
  const db = new DatabaseSync(":memory:");
  try {
    createFactProjectionTables(db);
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
  } finally {
    db.close();
  }
});
