// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createFactProjectionTables, readDecisionGraphRows, readFactGraphRows, searchFactRows, type FactProjectionRow } from "../../src/projection/fact-event-projection.ts";

// Counts statement executions so the assertions describe query shape, not wall-clock time:
// an N+1 regression changes the count deterministically on any machine, under any load.
function countingDatabase(): { readonly db: DatabaseSync; readonly executions: () => number } {
  const db = new DatabaseSync(":memory:"), prepare = db.prepare.bind(db);
  let executions = 0;
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    for (const method of ["all", "get"] as const) {
      const original = statement[method].bind(statement);
      statement[method] = ((...args: readonly unknown[]) => { executions += 1; return original(...args); }) as typeof statement[typeof method];
    }
    return statement;
  }) as typeof db.prepare;
  return { db, executions: () => executions };
}

function seed(db: DatabaseSync, decisions: number, facts: number): void {
  createFactProjectionTables(db);
  db.exec("CREATE TABLE projection_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), watermark INTEGER NOT NULL, scan_cursor TEXT, scanned_revision INTEGER NOT NULL)");
  db.exec("INSERT INTO projection_meta VALUES (1, 1, NULL, 1)");
  const applies = JSON.stringify({ modules: ["kernel"], productLines: [] }), proposer = JSON.stringify({ principal: { personId: "shape" }, executor: null });
  const insertDecision = db.prepare("INSERT INTO decision(decision_id,state,title,question,risk_tier,urgency,vertical,preset,decision_class,applies_json,proposer_json,arbiter_json,proposed_at,decided_at,workspace_revision) VALUES (?, 'active', ?, ?, 'high', 'medium', 'shape', 'default', 'ordinary', ?, ?, NULL, '2026-08-16T00:00:00.000Z', NULL, ?)");
  const insertOption = db.prepare("INSERT INTO decision_option VALUES (?, 'chosen', ?, ?, NULL, ?)");
  const insertClaim = db.prepare("INSERT INTO decision_claim VALUES (?, ?, ?, 1, 'evidenced', ?, NULL)");
  const insertFact = db.prepare("INSERT INTO fact(task_id, fact_id, ref, statement, evidence_source, observed_at, confidence, memory_class, op_id, workspace_revision, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertEdge = db.prepare("INSERT INTO relation_edge VALUES (?, ?, ?, 'evidenced-by', 'active', ?, ?, ?)");
  db.exec("BEGIN");
  for (let index = 0; index < facts; index += 1) {
    const taskId = `task-${index}`, factId = `F-${String(index).padStart(8, "0")}`, ref = `fact/${taskId}/${factId}`;
    const row: Omit<FactProjectionRow, "state"> = { schema: "fact-row/v1", ref, taskId, factId, statement: `observation ${index}`,
      evidenceSource: "shape fixture", observedAt: `2026-08-16T00:00:${String(index % 60).padStart(2, "0")}.000Z`, confidence: "high", memoryClass: "semantic", memoryTags: [],
      provenance: [{ runtime: "human", sessionId: "shape", boundAt: "2026-08-16T00:00:00.000Z" }],
      actor: { principal: { personId: "shape" }, executor: null }, source: "local", occurredAt: "2026-08-16T00:00:00.000Z", workspaceRevision: index + 1 };
    insertFact.run(taskId, factId, ref, row.statement, row.evidenceSource, row.observedAt, row.confidence, row.memoryClass, `op-fact-${index}`, index + 1, JSON.stringify(row));
  }
  for (let index = 0; index < decisions; index += 1) {
    const decisionId = `dec_SHAPE_${String(index).padStart(5, "0")}`, root = `decision/${decisionId}`, claimRef = `${root}/C1`;
    insertDecision.run(decisionId, `Decision ${index}`, `Should ${index} ship?`, applies, proposer, index + 1);
    insertOption.run(decisionId, "O1", `option ${index}`, index + 1);
    insertClaim.run(decisionId, "C1", `claim ${index}`, index + 1);
    // Every claim reaches a live Fact, so the coverage walk does real work rather than exiting early.
    const targetRef = `fact/task-${index % Math.max(facts, 1)}/F-${String(index % Math.max(facts, 1)).padStart(8, "0")}`;
    insertEdge.run(`rel_shape_${index}`, claimRef, targetRef, root, index + 1, JSON.stringify({ relationId: `rel_shape_${index}`, sourceRef: claimRef, targetRef, relationType: "evidenced-by", direction: "directed", strength: "strong", origin: "authored", state: "active", rationale: "shape fixture", ownerRef: root, sourcePath: `event:op-${index}`, recordIndex: index }));
  }
  db.exec("COMMIT");
}

// The projection layer's cost must follow result size, not entity count. Doubling the corpus must not
// add a single statement execution: a per-entity query would double these counts instead.
for (const [label, read] of [
  ["readDecisionGraphRows", (db: DatabaseSync) => { readDecisionGraphRows(db); }],
  ["readFactGraphRows", (db: DatabaseSync) => { readFactGraphRows(db); }],
  ["searchFactRows", (db: DatabaseSync) => { searchFactRows(db, {}); }]
] as const) {
  test(`${label} issues a constant number of SQL statements as the corpus grows`, (context) => {
    const small = countingDatabase(), large = countingDatabase();
    try {
      seed(small.db, 25, 25);
      seed(large.db, 50, 50);
      read(small.db);
      read(large.db);
      context.diagnostic(`${label}: 25 entities -> ${small.executions()} statements; 50 entities -> ${large.executions()} statements`);
      assert.equal(large.executions(), small.executions(), `${label} issued ${large.executions()} statements at 50 entities but ${small.executions()} at 25; the read scales per entity instead of per result set`);
      assert.ok(small.executions() < 25, `${label} issued ${small.executions()} statements for 25 entities; a bounded read must not approach one statement per entity`);
    } finally { small.db.close(); large.db.close(); }
  });
}

test("readDecisionGraphRows still resolves evidenced coverage through the batched reads", () => {
  const { db } = countingDatabase();
  try {
    seed(db, 3, 3);
    const graph = readDecisionGraphRows(db);
    assert.equal(graph.decisionAnchors.length, 3);
    // Anchor refs stay sorted and carry the decision root plus its option and claim anchors.
    assert.deepEqual(graph.decisionAnchors[0]?.anchorRefs, ["decision/dec_SHAPE_00000", "decision/dec_SHAPE_00000/C1", "decision/dec_SHAPE_00000/O1"]);
    assert.equal(graph.coverageRows.length, 3);
    assert.equal(graph.coverageRows[0]?.status, "covered");
    assert.deepEqual(graph.coverageRows[0]?.relationPath, ["rel_shape_0"]);
    assert.equal(graph.coverageRows[0]?.coveringFactRef, "fact/task-0/F-00000000");
  } finally { db.close(); }
});
