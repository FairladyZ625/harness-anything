// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { factLiveness } from "../../src/domain/fact-liveness.ts";
import { buildColdCoverage, type ColdRebuildSource } from "../../src/projection/cold-rebuild-source.ts";
import { createDecisionProjectionTables, readDecisionGraphRows } from "../../src/projection/decision-event-projection.ts";
import { createFactProjectionTables, readFactGraphRows } from "../../src/projection/fact-event-projection.ts";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";
import type { RelationFactRow, RelationGraphEdgeRow } from "../../src/projection/relation-graph-projection.ts";

test("warm event projection and cold coverage adapter agree on the same replay inputs", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createRelationGraphProjectionTables(db);
    createFactProjectionTables(db);
    createDecisionProjectionTables(db);
    db.exec("CREATE TABLE projection_meta (singleton INTEGER PRIMARY KEY, watermark INTEGER NOT NULL); INSERT INTO projection_meta VALUES (1, 9); CREATE TABLE task_snapshot (task_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL)");
    db.prepare("INSERT INTO task_snapshot VALUES (?,?)").run("done", JSON.stringify({ task: { status: "done" } }));
    const applies = JSON.stringify({ modules: [], productLines: [] }), proposer = JSON.stringify({ principal: { personId: "fixture" }, executor: null });
    db.prepare("INSERT INTO decision VALUES ('dec_EQ','active','Equivalent','Q?','medium','medium','software/coding','default','ordinary',?,?,NULL,'2026-08-18T00:00:00.000Z',NULL,'[]',1)").run(applies, proposer);
    db.prepare("INSERT INTO decision_claim VALUES ('dec_EQ','C0',0,'Undeclared fulfillment stays uncovered',1,NULL,1,NULL),('dec_EQ','C1',1,'Evidence must be live',1,'evidenced',1,NULL),('dec_EQ','C2',2,'Delivery must be done',1,'delivered',1,NULL)").run();
    const facts = [fact("F-old"), fact("F-new")];
    for (const row of facts) db.prepare("INSERT INTO fact VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(row.taskId, row.factId, row.ref, row.statement, row.source, row.observedAt, row.confidence, row.memoryClass, `op-${row.factId}`, 1, JSON.stringify({ schema: "fact-row/v1", ref: row.ref, taskId: row.taskId, factId: row.factId, statement: row.statement, evidenceSource: row.source, observedAt: row.observedAt, confidence: row.confidence, memoryClass: row.memoryClass, memoryTags: [], provenance: [], actor: { principal: { personId: "fixture" }, executor: null }, source: "local", occurredAt: row.observedAt, workspaceRevision: 1 }));
    const edges = [edge("null-evidence", "decision/dec_EQ/C0", facts[1]!.ref, "evidenced-by", "decision/dec_EQ"), edge("evidence", "decision/dec_EQ/C1", facts[0]!.ref, "evidenced-by", "decision/dec_EQ"), edge("delivery", "decision/dec_EQ/C2", "task/done", "derives", "decision/dec_EQ"), edge("retire", facts[1]!.ref, facts[0]!.ref, "supersedes-fact", facts[1]!.ref)];
    for (const row of edges) db.prepare("INSERT INTO relation_edge VALUES (?,?,?,?,?,?,?,?)").run(row.relationId, row.sourceRef, row.targetRef, row.relationType, row.state, row.ownerRef, 1, JSON.stringify(row));
    const warm = readDecisionGraphRows(db).coverageRows.map(({ basisRevision: _basis, ...row }) => ({ ...row, refutingFactRefs: row.refutingFactRefs ?? [] }));
    const source = { decisions: [{ decisionId: "dec_EQ", state: "active", title: "Equivalent", question: "Q?", chosen: [], rejected: [], chosenRecords: [], rejectedRecords: [], claimRecords: [{ id: "C0", text: "Undeclared fulfillment stays uncovered", loadBearing: true, fulfillment: null }, { id: "C1", text: "Evidence must be live", loadBearing: true, fulfillment: "evidenced" }, { id: "C2", text: "Delivery must be done", loadBearing: true, fulfillment: "delivered" }], body: "", path: "decision.md", moduleKeys: [], productLineKeys: [], decisionClass: "ordinary" }], facts, tasks: [{ ref: "task/done", status: "done" }], truth: { factAnchors: [], decisionAnchors: [], edges, coverageRows: [] }, knownFactRefs: new Set(facts.map(({ ref }) => ref)), issues: [], complete: true } satisfies ColdRebuildSource;
    const cold = buildColdCoverage(source, edges).map((row) => ({ ...row, fulfillment: row.fulfillment === "standing-policy" ? "standing_policy" as const : row.fulfillment, refutingFactRefs: row.refutingFactRefs ?? [] }));
    assert.deepEqual(cold, warm);
    assert.deepEqual(cold.find(({ claimRef }) => claimRef.endsWith("/C0")), { decisionRef: "decision/dec_EQ", claimRef: "decision/dec_EQ/C0", status: "uncovered", fulfillment: null, refutingFactRefs: [], relationPath: [] });
    assert.deepEqual(readFactGraphRows(db).facts.map(({ ref, state }) => ({ ref, state })).sort(byRef), facts.map((row) => ({ ref: row.ref, state: factLiveness(row, edges) })).sort(byRef));
  } finally { db.close(); }
});

function fact(factId: string): RelationFactRow { return { schema: "task-fact-row/v1", ref: `fact/task/${factId}`, taskId: "task", factId, statement: factId, source: "fixture", observedAt: "2026-08-18T00:00:00.000Z", confidence: "high", memoryClass: "semantic", memoryTags: [], provenance: [], liveness: "standing" }; }
function edge(relationId: string, sourceRef: string, targetRef: string, relationType: RelationGraphEdgeRow["relationType"], ownerRef: string): RelationGraphEdgeRow { return { relationId, sourceRef, targetRef, relationType, direction: "directed", strength: "strong", origin: "declared", state: "active", rationale: relationId, ownerRef, sourcePath: "fixture", recordIndex: 0 }; }
function byRef(left: { readonly ref: string }, right: { readonly ref: string }): number { return left.ref.localeCompare(right.ref); }
