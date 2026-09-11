// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import {
  createDecisionProjectionTables,
  listDecisionAgendaRowsPage,
  listDecisionRowsPage,
  readDecisionGraphRows,
  readDecisionRows,
} from "../../src/projection/decision-event-projection.ts";
import {
  createFactProjectionTables,
  readFactGraphRows,
  searchFactRows,
  type FactProjectionRow,
} from "../../src/projection/fact-event-projection.ts";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";
import {
  createTaskRelationProjectionTable,
  listTaskRowsNarrow,
  readTaskChildCounts,
  readTaskDependencyClosureRows,
  readTaskIndexRows,
  readTaskRelationPage,
  readTaskRelationsByTargets,
  readTaskStatusRows,
} from "../../src/projection/task-query-projection.ts";

test("filtered task index parses only the returned page", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE task_snapshot (task_id TEXT PRIMARY KEY, status TEXT, updated_at TEXT NOT NULL, snapshot_json TEXT NOT NULL); " +
        "CREATE TABLE task_package (task_id TEXT PRIMARY KEY, package_path TEXT)",
    );
    const insert = db.prepare("INSERT INTO task_snapshot VALUES (?, ?, ?, ?)"),
      task = (taskId: string) =>
        JSON.stringify({
          task: {
            schema: "task/v2",
            taskId,
            title: `Match ${taskId}`,
            taskClass: "standard",
            status: "active",
            graph: REPLAY_TASK_GRAPH,
            currentNode: "implementation",
            iteration: 0,
            pinned: false,
            createdBy: { principal: { personId: "person-fixture" }, executor: null },
            completionGateIds: [],
            presetSnapshotDigest: null,
            packageDisposition: "active",
          },
        });
    insert.run("task_001", "active", "2026-09-10T00:00:00.000Z", task("task_001"));
    insert.run("task_002", "active", "2026-09-10T00:00:00.000Z", task("task_002"));
    for (let index = 3; index <= 1_000; index += 1)
      insert.run(`task_${String(index).padStart(3, "0")}`, "done", "2026-09-10T00:00:00.000Z", "invalid");

    const page = readTaskIndexRows(db, { status: "active", limit: 1 });
    assert.deepEqual(
      page.rows.map(({ taskId }) => taskId),
      ["task_001"],
    );
    assert.ok(page.page?.nextCursor);
    assert.throws(() => readTaskIndexRows(db), /projection snapshot mismatch for task task_003/u);
  } finally {
    db.close();
  }
});

// Counts statement executions so the assertions describe query shape, not wall-clock time:
// an N+1 regression changes the count deterministically on any machine, under any load.
function countingDatabase(): {
  readonly db: DatabaseSync;
  readonly executions: () => number;
  readonly reads: () => readonly { readonly sql: string; readonly args: readonly unknown[] }[];
} {
  const db = new DatabaseSync(":memory:"),
    prepare = db.prepare.bind(db);
  let executions = 0;
  const reads: { sql: string; args: readonly unknown[] }[] = [];
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    for (const method of ["all", "get"] as const) {
      const original = statement[method].bind(statement);
      statement[method] = ((...args: readonly unknown[]) => {
        executions += 1;
        reads.push({ sql, args });
        return original(...args);
      }) as (typeof statement)[typeof method];
    }
    return statement;
  }) as typeof db.prepare;
  return { db, executions: () => executions, reads: () => reads };
}

function seed(db: DatabaseSync, decisions: number, facts: number): void {
  createRelationGraphProjectionTables(db);
  createFactProjectionTables(db);
  createDecisionProjectionTables(db);
  db.exec(
    "CREATE TABLE projection_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), watermark INTEGER NOT NULL, scan_cursor TEXT, scanned_revision INTEGER NOT NULL); CREATE TABLE document (path TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, value_json TEXT NOT NULL)",
  );
  db.exec("INSERT INTO projection_meta VALUES (1, 1, NULL, 1)");
  const applies = JSON.stringify({ modules: ["kernel"], productLines: [] }),
    proposer = JSON.stringify({ principal: { personId: "shape" }, executor: null });
  const insertDecision = db.prepare(
    "INSERT INTO decision(decision_id,state,title,question,risk_tier,urgency,vertical,preset,decision_class,applies_json,proposer_json,arbiter_json,proposed_at,decided_at,workspace_revision) VALUES (?, 'active', ?, ?, 'high', 'medium', 'shape', 'default', 'ordinary', ?, ?, NULL, '2026-08-16T00:00:00.000Z', NULL, ?)",
  );
  const insertOption = db.prepare("INSERT INTO decision_option VALUES (?, 'chosen', ?, 0, ?, NULL, ?)");
  const insertClaim = db.prepare("INSERT INTO decision_claim VALUES (?, ?, 0, ?, 1, 'evidenced', ?, NULL)");
  const insertFact = db.prepare(
    "INSERT INTO fact(task_id, fact_id, ref, statement, evidence_source, observed_at, confidence, memory_class, op_id, workspace_revision, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertEdge = db.prepare("INSERT INTO relation_edge VALUES (?, ?, ?, 'evidenced-by', 'active', ?, ?, ?, ?)");
  db.exec("BEGIN");
  for (let index = 0; index < facts; index += 1) {
    const taskId = `task-${index}`,
      factId = `F-${String(index).padStart(8, "0")}`,
      ref = `fact/${factId}`;
    const row: Omit<FactProjectionRow, "state"> = {
      schema: "fact-row/v1",
      ref,
      taskId,
      factId,
      statement: `observation ${index}`,
      evidenceSource: "shape fixture",
      observedAt: `2026-08-16T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      confidence: "high",
      memoryClass: "semantic",
      memoryTags: [],
      provenance: [{ runtime: "human", sessionId: "shape", boundAt: "2026-08-16T00:00:00.000Z" }],
      actor: { principal: { personId: "shape" }, executor: null },
      source: "local",
      occurredAt: "2026-08-16T00:00:00.000Z",
      workspaceRevision: index + 1,
    };
    insertFact.run(
      taskId,
      factId,
      ref,
      row.statement,
      row.evidenceSource,
      row.observedAt,
      row.confidence,
      row.memoryClass,
      `op-fact-${index}`,
      index + 1,
      JSON.stringify(row),
    );
  }
  for (let index = 0; index < decisions; index += 1) {
    const decisionId = `dec_SHAPE_${String(index).padStart(5, "0")}`,
      root = `decision/${decisionId}`,
      claimRef = `${root}/C1`;
    insertDecision.run(decisionId, `Decision ${index}`, `Should ${index} ship?`, applies, proposer, index + 1);
    insertOption.run(decisionId, "O1", `option ${index}`, index + 1);
    insertClaim.run(decisionId, "C1", `claim ${index}`, index + 1);
    // Every claim reaches a live Fact, so the coverage walk does real work rather than exiting early.
    const targetIndex = index % Math.max(facts, 1),
      targetRef = `fact/F-${String(targetIndex).padStart(8, "0")}`,
      targetVersion = targetIndex + 1;
    insertEdge.run(
      `rel_shape_${index}`,
      claimRef,
      targetRef,
      targetVersion,
      root,
      index + 1,
      JSON.stringify({
        schema: "relation-projection/v1",
        entity: {
          kind: "relation",
          id: `rel_shape_${index}`,
          revision: index + 1,
          source: claimRef,
          target: targetRef,
          type: "evidenced-by",
          direction: "directed",
          strength: "strong",
          origin: "declared",
          state: "active",
          rationale: "shape fixture",
          targetObservedVersion: targetVersion,
        },
        sourcePath: `event:op-${index}`,
      }),
    );
  }
  db.exec("COMMIT");
}

// The projection layer's cost must follow result size, not entity count. Doubling the corpus must not
// add a single statement execution: a per-entity query would double these counts instead.
for (const [label, read] of [
  [
    "readDecisionGraphRows",
    (db: DatabaseSync) => {
      readDecisionGraphRows(db);
    },
  ],
  [
    "readFactGraphRows",
    (db: DatabaseSync) => {
      readFactGraphRows(db);
    },
  ],
  [
    "searchFactRows",
    (db: DatabaseSync) => {
      searchFactRows(db, {});
    },
  ],
] as const) {
  test(`${label} issues a constant number of SQL statements as the corpus grows`, (context) => {
    const small = countingDatabase(),
      large = countingDatabase();
    try {
      seed(small.db, 25, 25);
      seed(large.db, 50, 50);
      read(small.db);
      read(large.db);
      context.diagnostic(
        `${label}: 25 entities -> ${small.executions()} statements; 50 entities -> ${large.executions()} statements`,
      );
      assert.equal(
        large.executions(),
        small.executions(),
        `${label} issued ${large.executions()} statements at 50 entities but ${small.executions()} at 25; the read scales per entity instead of per result set`,
      );
      assert.ok(
        small.executions() < 25,
        `${label} issued ${small.executions()} statements for 25 entities; a bounded read must not approach one statement per entity`,
      );
    } finally {
      small.db.close();
      large.db.close();
    }
  });
}

test("fact liveness target reads use the target-leading relation index", () => {
  const counted = countingDatabase(),
    { db } = counted;
  try {
    seed(db, 1, 1);
    db.prepare("INSERT INTO relation_edge VALUES (?, ?, ?, 'supersedes-fact', 'active', NULL, ?, ?, ?)").run(
      "rel_supersedes",
      "fact/F-00000001",
      "fact/F-00000000",
      "fact/F-00000000",
      99,
      JSON.stringify({}),
    );
    searchFactRows(db, { refs: ["fact/F-00000000"] });
    const read = counted.reads().find(({ sql }) => sql.includes("requested_targets"));
    assert.ok(read, "expected target-scoped liveness query");
    const plan = queryPlan(db, read!);
    assert.match(plan, /SEARCH relation_edge USING INDEX relation_edge_target/u);
    assert.doesNotMatch(plan, /relation_edge_state_page \(state=\?\)/u);
  } finally {
    db.close();
  }
});

test("decision list reads every match without paging parameters and a constant number of statements per page", (context) => {
  const counted = countingDatabase(),
    { db } = counted;
  try {
    seed(db, 7, 1);
    const unpaged = listDecisionRowsPage(db, {});
    assert.equal(unpaged.rows.length, 7);
    // Unparameterized reads still return every match; the GUI board and readiness read the whole corpus.
    assert.equal(unpaged.page, undefined);

    const first = listDecisionRowsPage(db, { limit: 3 });
    assert.deepEqual(
      first.rows.map(({ decisionId }) => decisionId),
      ["dec_SHAPE_00000", "dec_SHAPE_00001", "dec_SHAPE_00002"],
    );
    assert.equal(first.page?.limit, 3);
    assert.equal(first.page?.cursor, null);
    assert.ok(first.page?.nextCursor);

    // Walk with the cursor: limit=2 across 7 rows visits every id exactly once, no overlap.
    const visited: string[] = [];
    let cursor: string | undefined;
    do {
      const page = listDecisionRowsPage(db, { limit: 2, ...(cursor ? { cursor } : {}) });
      visited.push(...page.rows.map(({ decisionId }) => decisionId));
      cursor = page.page?.nextCursor ?? undefined;
    } while (cursor !== undefined);
    assert.deepEqual(
      visited,
      unpaged.rows.map(({ decisionId }) => decisionId),
    );

    // A cursor naming an id that no longer exists still resumes strictly after it.
    const resumed = listDecisionRowsPage(db, {
      limit: 2,
      cursor: Buffer.from(JSON.stringify(["dec_SHAPE_00002"]), "utf8").toString("base64url"),
    });
    assert.deepEqual(
      resumed.rows.map(({ decisionId }) => decisionId),
      ["dec_SHAPE_00003", "dec_SHAPE_00004"],
    );

    // The last page has no further cursor.
    const last = listDecisionRowsPage(db, { limit: 10 });
    assert.equal(last.rows.length, 7);
    assert.equal(last.page?.nextCursor, null);

    // Filters compose with paging: state narrows before the slice.
    const narrowed = listDecisionRowsPage(db, { state: "active", limit: 2 });
    assert.deepEqual(
      narrowed.rows.map(({ decisionId }) => decisionId),
      ["dec_SHAPE_00000", "dec_SHAPE_00001"],
    );
    assert.ok(narrowed.page?.nextCursor);

    assert.throws(() => listDecisionRowsPage(db, { limit: 0 }), /between 1 and 500/u);
    assert.throws(() => listDecisionRowsPage(db, { limit: 501 }), /between 1 and 500/u);
    assert.throws(() => listDecisionRowsPage(db, { cursor: "not-a-cursor" }), /cursor is invalid/u);

    // One id scan plus one batched row read: the statement count must not grow with the corpus.
    const before = counted.executions();
    listDecisionRowsPage(db, { limit: 4 });
    const four = counted.executions() - before;
    listDecisionRowsPage(db, { limit: 7 });
    const seven = counted.executions() - four - before;
    context.diagnostic(`decision list page statements: 4 rows -> ${four}; 7 rows -> ${seven}`);
    assert.equal(seven, four, "the decision list read scales per page instead of per row set");
  } finally {
    db.close();
  }
});

test("readDecisionGraphRows still resolves evidenced coverage through the batched reads", () => {
  const { db } = countingDatabase();
  try {
    seed(db, 3, 3);
    const graph = readDecisionGraphRows(db);
    assert.equal(graph.decisionAnchors.length, 3);
    // Anchor refs stay sorted and carry the decision root plus its option and claim anchors.
    assert.deepEqual(graph.decisionAnchors[0]?.anchorRefs, [
      "decision/dec_SHAPE_00000",
      "decision/dec_SHAPE_00000/C1",
      "decision/dec_SHAPE_00000/O1",
    ]);
    assert.equal(graph.coverageRows.length, 3);
    assert.equal(graph.coverageRows[0]?.status, "covered");
    assert.deepEqual(graph.coverageRows[0]?.relationPath, ["rel_shape_0"]);
    assert.equal(graph.coverageRows[0]?.coveringFactRef, "fact/F-00000000");
  } finally {
    db.close();
  }
});

test("agenda source pages use covering keyset indexes and fetch only limit plus one rows", (context) => {
  const db = new DatabaseSync(":memory:");
  try {
    createRelationGraphProjectionTables(db);
    createFactProjectionTables(db);
    createDecisionProjectionTables(db);
    db.exec(`
      CREATE TABLE task_snapshot (task_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
        status TEXT, pinned INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN json_extract(snapshot_json, '$.task.pinned') = 1 THEN 1 ELSE 0 END) STORED,
        updated_at TEXT NOT NULL DEFAULT '');
      CREATE TABLE task_package (task_id TEXT PRIMARY KEY, package_path TEXT NOT NULL UNIQUE);
      CREATE TABLE task_generation (task_id TEXT PRIMARY KEY, generation TEXT NOT NULL);
      CREATE TABLE event_index (workspace_revision INTEGER PRIMARY KEY, task_id TEXT NOT NULL, event_json TEXT NOT NULL);
      CREATE INDEX event_index_task_id ON event_index(task_id, workspace_revision);
      CREATE INDEX task_snapshot_revision_task ON task_snapshot(workspace_revision, task_id ASC);
      CREATE INDEX task_snapshot_agenda_status_pin ON task_snapshot(status, pinned DESC, task_id ASC);
    `);
    const insert = db.prepare(
      "INSERT INTO task_snapshot(task_id, workspace_revision, snapshot_json, status, updated_at) VALUES (?, ?, ?, 'planned', '2026-08-21T00:00:00.000Z')",
    );
    for (let index = 0; index < 2_000; index += 1)
      insert.run(
        `task_${String(index).padStart(5, "0")}`,
        index + 1,
        JSON.stringify({ task: { pinned: index === 1_999 } }),
      );
    seed(db, 2_000, 1);
    db.exec("UPDATE decision SET state='proposed'");
    const tasks = listTaskRowsNarrow(db, { status: "planned", pinnedFirst: true, limit: 5 }),
      changed = listTaskRowsNarrow(db, { changedAfterRevision: 1_990, limit: 5 }),
      decisions = listDecisionAgendaRowsPage(db, { state: "proposed", limit: 5 });
    assert.equal(tasks.rows.length, 5);
    assert.equal(tasks.rows[0]?.task_id, "task_01999");
    assert.ok(tasks.page?.nextCursor);
    assert.deepEqual(
      changed.rows.map(({ task_id }) => task_id),
      ["task_01990", "task_01991", "task_01992", "task_01993", "task_01994"],
    );
    assert.ok(changed.page?.nextCursor);
    assert.equal(decisions.rows.length, 5);
    assert.ok(decisions.page.nextCursor);
    const taskPlan = (
        db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT task_id FROM task_snapshot WHERE status = 'planned' ORDER BY pinned DESC, task_id LIMIT 6",
          )
          .all() as unknown as { detail: string }[]
      )
        .map(({ detail }) => detail)
        .join("\n"),
      revisionPlan = (
        db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT task_id FROM task_snapshot WHERE workspace_revision > 1990 ORDER BY task_id LIMIT 6",
          )
          .all() as unknown as { detail: string }[]
      )
        .map(({ detail }) => detail)
        .join("\n"),
      decisionPlan = (
        db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT decision_id, title, risk_tier, urgency, proposed_at FROM decision WHERE state = 'proposed' ORDER BY decision_id LIMIT 6",
          )
          .all() as unknown as { detail: string }[]
      )
        .map(({ detail }) => detail)
        .join("\n");
    context.diagnostic(`task agenda plan: ${taskPlan}`);
    context.diagnostic(`task revision plan: ${revisionPlan}`);
    context.diagnostic(`decision agenda plan: ${decisionPlan}`);
    assert.match(taskPlan, /task_snapshot_agenda_status_pin/u);
    assert.match(revisionPlan, /task_snapshot_revision_task/u);
    assert.match(decisionPlan, /decision_state_page/u);
  } finally {
    db.close();
  }
});

test("task creation time comes from the earliest canonical event and preserves unknown time", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE task_snapshot (task_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
        status TEXT, pinned INTEGER NOT NULL GENERATED ALWAYS AS (0) STORED, updated_at TEXT NOT NULL DEFAULT '');
      CREATE TABLE task_package (task_id TEXT PRIMARY KEY, package_path TEXT NOT NULL UNIQUE);
      CREATE TABLE task_generation (task_id TEXT PRIMARY KEY, generation TEXT NOT NULL);
      CREATE TABLE event_index (workspace_revision INTEGER PRIMARY KEY, task_id TEXT NOT NULL, event_json TEXT NOT NULL);
      INSERT INTO task_snapshot(task_id, workspace_revision, snapshot_json, status, updated_at) VALUES
        ('task_explicit', 4, '{}', 'planned', '2026-08-21T00:00:00.000Z'),
        ('task_fallback', 5, '{}', 'planned', '2026-08-21T00:00:00.000Z'),
        ('task_unknown', 6, '{}', 'planned', '2026-08-21T00:00:00.000Z');
      INSERT INTO event_index VALUES
        (1, 'task_explicit', '{"schema":"migration-import-event/v1","occurredAt":"2026-02-01T00:00:00.000Z","payload":{"createdAt":"2026-01-01T00:00:00.000Z"}}'),
        (2, 'task_explicit', '{"occurredAt":"2025-12-01T00:00:00.000Z"}'),
        (3, 'task_fallback', '{"occurredAt":"2026-03-01T00:00:00.000Z"}'),
        (4, 'task_unknown', '{}');
    `);
    const rows = new Map(listTaskRowsNarrow(db, {}).rows.map((row) => [row.task_id, row.created_at]));
    assert.equal(rows.get("task_explicit"), "2026-01-01T00:00:00.000Z");
    assert.equal(rows.get("task_fallback"), "2026-03-01T00:00:00.000Z");
    assert.equal(rows.get("task_unknown"), null);
  } finally {
    db.close();
  }
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
    const plan = (
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT task_id, status FROM task_snapshot WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY task_id",
        )
        .all(JSON.stringify(requested)) as unknown as { detail: string }[]
    )
      .map(({ detail }) => detail)
      .join("\n");
    context.diagnostic(`task status agenda plan: ${plan}`);
    assert.match(plan, /task_snapshot.*task_id/u);
  } finally {
    db.close();
  }
});

test("task context collection reads stay indexed, bounded, and constant in statement count", (context) => {
  const counted = countingDatabase(),
    { db } = counted;
  try {
    createRelationGraphProjectionTables(db);
    createFactProjectionTables(db);
    createDecisionProjectionTables(db);
    createTaskRelationProjectionTable(db);
    const insertTask = db.prepare(
      "INSERT INTO task_relation VALUES (?, ?, ?, ?, 'depends-on', 'directed', 'strong', 'declared', 'active', 'fixture', ?, 'fixture', 0, 1, '2026-08-21T00:00:00.000Z')",
    );
    for (const [relationId, source, target] of [
      ["rel_ab", "task/a", "task/b"],
      ["rel_ba", "task/b", "task/a"],
      ["rel_bc", "task/b", "task/c"],
    ] as const)
      insertTask.run(relationId, source.slice(5), source, target, source);
    db.prepare("INSERT INTO relation_edge VALUES (?, ?, ?, 'derives', 'active', NULL, ?, 1, ?)").run(
      "rel_decision_a",
      "decision/dec_A/CH1",
      "task/a",
      "decision/dec_A",
      JSON.stringify({
        relationId: "rel_decision_a",
        sourceRef: "decision/dec_A/CH1",
        targetRef: "task/a",
        relationType: "derives",
        direction: "directed",
        strength: "strong",
        origin: "declared",
        state: "active",
        rationale: "fixture",
        ownerRef: "decision/dec_A",
        sourcePath: "event:fixture",
        recordIndex: 0,
      }),
    );
    const before = counted.executions(),
      closure = readTaskDependencyClosureRows(db, ["task/a"], 5),
      afterClosure = counted.executions(),
      derives = readTaskRelationsByTargets(db, ["task/a"], "derives"),
      afterTargets = counted.executions();
    assert.deepEqual(closure.map(({ relationId }) => relationId).sort(), ["rel_ab", "rel_ba", "rel_bc"]);
    assert.deepEqual(
      derives.map(({ relationId }) => relationId),
      ["rel_decision_a"],
    );
    assert.equal(afterClosure - before, 3);
    assert.equal(afterTargets - afterClosure, 3);
    assert.throws(() => readTaskDependencyClosureRows(db, ["task/a"], 1), /depth limit/u);
    const closureRead = counted.reads().find(({ sql }) => sql.includes("WITH RECURSIVE dependency_walk"))!,
      targetRead = counted.reads().find(({ sql }) => sql.includes("requested_targets"))!;
    const closurePlan = queryPlan(db, closureRead),
      targetPlan = queryPlan(db, targetRead);
    context.diagnostic(`dependency closure plan: ${closurePlan}`);
    context.diagnostic(`relation targets plan: ${targetPlan}`);
    assert.match(closurePlan, /SEARCH task_relation USING INDEX task_relation_source/u);
    assert.match(closurePlan, /SEARCH relation_edge USING INDEX relation_edge_source/u);
    assert.match(targetPlan, /SEARCH task_relation USING INDEX task_relation_target/u);
    assert.match(targetPlan, /SEARCH relation_edge USING INDEX relation_edge_target/u);
    assert.doesNotMatch(`${closurePlan}\n${targetPlan}`, /SCAN (?:task_relation|relation_edge)(?:\s|$)/u);
  } finally {
    db.close();
  }
});

test("relation pages fetch limit plus one rows from each keyed source before merging", (context) => {
  const counted = countingDatabase(),
    { db } = counted;
  try {
    createRelationGraphProjectionTables(db);
    createTaskRelationProjectionTable(db);
    db.exec("CREATE TABLE event_index (workspace_revision INTEGER PRIMARY KEY, event_json TEXT NOT NULL)");
    const insertTask = db.prepare(
        "INSERT INTO task_relation VALUES (?, ?, ?, ?, 'depends-on', 'directed', 'strong', 'declared', 'active', 'fixture', ?, 'fixture', 0, ?, '2026-08-21T00:00:00.000Z')",
      ),
      insertEdge = db.prepare("INSERT INTO relation_edge VALUES (?, ?, ?, 'derives', 'active', NULL, ?, ?, ?)"),
      insertEvent = db.prepare("INSERT INTO event_index VALUES (?, ?)");
    for (let index = 0; index < 100; index += 1) {
      const relationId = `rel_${String(index * 2).padStart(3, "0")}`;
      insertTask.run(relationId, `task_${index}`, `task/${index}`, `fact/F-${index}`, `task/${index}`, index + 1);
      insertEvent.run(index + 1, JSON.stringify({ occurredAt: "2026-08-21T00:00:00.000Z" }));
      const edgeId = `rel_${String(index * 2 + 1).padStart(3, "0")}`;
      insertEdge.run(
        edgeId,
        `decision/dec_${index}/C1`,
        `fact/F-${index}`,
        `decision/dec_${index}`,
        index + 1,
        JSON.stringify({
          direction: "directed",
          strength: "strong",
          origin: "declared",
          rationale: "fixture",
          sourcePath: "fixture",
          recordIndex: 0,
        }),
      );
    }
    const page = readTaskRelationPage(db, { limit: 5 }),
      read = counted.reads().find(({ sql }) => sql.includes("SELECT * FROM ( SELECT * FROM"))!;
    assert.deepEqual(
      page.rows.map(({ relationId }) => relationId),
      ["rel_000", "rel_001", "rel_002", "rel_003", "rel_004"],
    );
    assert.equal(page.page?.nextCursor !== null, true);
    assert.deepEqual(read.args, ["", 6, "", 6, 6]);
    const plan = queryPlan(db, read);
    context.diagnostic(`relation page plan: ${plan}`);
    assert.match(plan, /SEARCH task_relation USING INDEX sqlite_autoindex_task_relation_1/u);
    assert.match(plan, /SEARCH relation_edge USING INDEX sqlite_autoindex_relation_edge_1/u);
    assert.doesNotMatch(plan, /SCAN (?:task_relation|relation_edge)(?:\s|$)/u);
  } finally {
    db.close();
  }
});

test("decision collection read uses one statement and indexed owner lookups", (context) => {
  const counted = countingDatabase(),
    { db } = counted;
  try {
    seed(db, 50, 1);
    const ids = Array.from({ length: 50 }, (_, index) => `dec_SHAPE_${String(index).padStart(5, "0")}`),
      before = counted.executions(),
      decisions = readDecisionRows(db, ids),
      after = counted.executions();
    assert.equal(after - before, 1);
    assert.equal(decisions.length, 50);
    assert.equal(decisions[0]?.chosen[0]?.text, "option 0");
    assert.equal(decisions[49]?.claims[0]?.text, "claim 49");
    const read = counted.reads().find(({ sql }) => sql.includes("requested_decisions"))!,
      plan = queryPlan(db, read);
    context.diagnostic(`decision collection plan: ${plan}`);
    for (const index of [
      "sqlite_autoindex_decision_1",
      "sqlite_autoindex_decision_option_1",
      "sqlite_autoindex_decision_claim_1",
      "decision_judgment_consent_owner",
      "decision_amendment_owner",
      "decision_content_pin_owner",
      "sqlite_autoindex_document_1",
    ])
      assert.match(plan, new RegExp(index, "u"));
    assert.doesNotMatch(
      plan,
      /SCAN (?:decision|decision_option|decision_claim|decision_judgment_consent|decision_amendment|decision_content_pin|document)(?:\s|$)/u,
    );
  } finally {
    db.close();
  }
});

test("task relation refresh deletes through the task index instead of scanning the table", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createTaskRelationProjectionTable(db);
    const plan = queryPlan(db, { sql: "DELETE FROM task_relation WHERE task_id = ?", args: ["task_a"] });
    assert.match(plan, /SEARCH task_relation USING (?:COVERING )?INDEX task_relation_task/u);
    assert.doesNotMatch(plan, /SCAN task_relation(?:\s|$)/u);
  } finally {
    db.close();
  }
});

test("task child counts search the parent expression index instead of scanning task_snapshot", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE task_snapshot (task_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
        status TEXT, updated_at TEXT NOT NULL DEFAULT '');
      CREATE INDEX task_snapshot_parent ON task_snapshot(json_extract(snapshot_json, '$.task.metadata.parentTaskId'));
    `);
    const insert = db.prepare("INSERT INTO task_snapshot(task_id, workspace_revision, snapshot_json) VALUES (?, ?, ?)");
    for (let index = 0; index < 200; index += 1)
      insert.run(
        `task_${String(index).padStart(5, "0")}`,
        index + 1,
        JSON.stringify({ task: { metadata: { parentTaskId: index % 3 === 0 ? "task_00000" : "task_00001" } } }),
      );
    // Mirrors the statement readTaskChildCounts issues; the expression must match the index expression verbatim.
    const parent = "json_extract(snapshot_json, '$.task.metadata.parentTaskId')",
      sql =
        `SELECT ${parent} AS parent_task_id, COUNT(*) AS child_count FROM task_snapshot ` +
        "WHERE COALESCE(json_extract(snapshot_json, '$.task.packageDisposition'), 'active') = 'active' " +
        `AND ${parent} IN (SELECT value FROM json_each(?)) GROUP BY parent_task_id`,
      plan = queryPlan(db, { sql, args: [JSON.stringify(["task_00000"])] });
    assert.match(plan, /SEARCH task_snapshot USING INDEX task_snapshot_parent/u);
    assert.doesNotMatch(plan, /SCAN task_snapshot(?:\s|$)/u);
    assert.deepEqual(readTaskChildCounts(db, ["task_00000", "task_00001"]), { task_00000: 67, task_00001: 133 });
  } finally {
    db.close();
  }
});

function queryPlan(db: DatabaseSync, read: { readonly sql: string; readonly args: readonly unknown[] }): string {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).all(...read.args) as unknown as readonly { readonly detail: string }[]
  )
    .map(({ detail }) => detail)
    .join("\n");
}
