// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createFactProjectionTables, listDecisionAgendaRowsPage, readDecisionGraphRows, readFactGraphRows, searchFactRows, type FactProjectionRow } from "../../src/projection/fact-event-projection.ts";
import { listTaskRowsNarrow, readTaskStatusRows } from "../../src/projection/task-query-projection.ts";

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
  const insertOption = db.prepare("INSERT INTO decision_option VALUES (?, 'chosen', ?, 0, ?, NULL, ?)");
  const insertClaim = db.prepare("INSERT INTO decision_claim VALUES (?, ?, 0, ?, 1, 'evidenced', ?, NULL)");
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

test("agenda source pages use covering keyset indexes and fetch only limit plus one rows", (context) => {
  const db = new DatabaseSync(":memory:");
  try {
    createFactProjectionTables(db);
    db.exec(`
      CREATE TABLE task_snapshot (task_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
        status TEXT, pinned INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN json_extract(snapshot_json, '$.task.pinned') = 1 THEN 1 ELSE 0 END) STORED,
        updated_at TEXT NOT NULL DEFAULT '');
      CREATE TABLE task_package (task_id TEXT PRIMARY KEY, package_path TEXT NOT NULL UNIQUE);
      CREATE TABLE task_generation (task_id TEXT PRIMARY KEY, generation TEXT NOT NULL);
      CREATE INDEX task_snapshot_agenda_status_pin ON task_snapshot(status, pinned DESC, task_id ASC);
    `);
    const insert = db.prepare("INSERT INTO task_snapshot(task_id, workspace_revision, snapshot_json, status, updated_at) VALUES (?, ?, ?, 'planned', '2026-08-21T00:00:00.000Z')");
    for (let index = 0; index < 2_000; index += 1) insert.run(`task_${String(index).padStart(5, "0")}`, index + 1, JSON.stringify({ task: { pinned: index === 1_999 } }));
    seed(db, 2_000, 1); db.exec("UPDATE decision SET state='proposed'");
    const tasks = listTaskRowsNarrow(db, { status: "planned", pinnedFirst: true, limit: 5 }), decisions = listDecisionAgendaRowsPage(db, { state: "proposed", limit: 5 });
    assert.equal(tasks.rows.length, 5); assert.equal(tasks.rows[0]?.task_id, "task_01999"); assert.ok(tasks.page?.nextCursor);
    assert.equal(decisions.rows.length, 5); assert.ok(decisions.page.nextCursor);
    const taskPlan = (db.prepare("EXPLAIN QUERY PLAN SELECT task_id FROM task_snapshot WHERE status = 'planned' ORDER BY pinned DESC, task_id LIMIT 6").all() as unknown as { detail: string }[]).map(({ detail }) => detail).join("\n"), decisionPlan = (db.prepare("EXPLAIN QUERY PLAN SELECT decision_id, title, risk_tier, urgency, proposed_at FROM decision WHERE state = 'proposed' ORDER BY decision_id LIMIT 6").all() as unknown as { detail: string }[]).map(({ detail }) => detail).join("\n");
    context.diagnostic(`task agenda plan: ${taskPlan}`); context.diagnostic(`decision agenda plan: ${decisionPlan}`);
    assert.match(taskPlan, /task_snapshot_agenda_status_pin/u); assert.match(decisionPlan, /decision_state_page/u);
  } finally { db.close(); }
});

test("agenda dependency status lookup stays narrow above SQLite's bind limit", (context) => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE task_snapshot (task_id TEXT PRIMARY KEY, status TEXT)");
    const insert = db.prepare("INSERT INTO task_snapshot(task_id, status) VALUES (?, 'planned')");
    for (let index = 0; index < 2_000; index += 1) insert.run(`task_${String(index).padStart(5, "0")}`);
    const requested = Array.from({ length: 1_200 }, (_, index) => `task_${String(index * 2).padStart(5, "0")}`);
    const rows = readTaskStatusRows(db, requested);
    assert.equal(rows.length, 1_000);
    assert.equal(rows[0]?.taskId, "task_00000");
    assert.equal(rows.at(-1)?.taskId, "task_01998");
    const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT task_id, status FROM task_snapshot WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY task_id").all(JSON.stringify(requested)) as unknown as { detail: string }[]).map(({ detail }) => detail).join("\n");
    context.diagnostic(`task status agenda plan: ${plan}`);
    assert.match(plan, /task_snapshot.*task_id/u);
  } finally { db.close(); }
});
