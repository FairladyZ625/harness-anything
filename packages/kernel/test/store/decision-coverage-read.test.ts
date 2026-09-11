// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { coverageOf } from "../../src/domain/decision-coverage.ts";
import {
  createDecisionProjectionTables,
  decisionCoverage,
  readDecisionGraphRows,
} from "../../src/projection/decision-event-projection.ts";
import { createFactProjectionTables } from "../../src/projection/fact-event-projection.ts";
import { readRelationProjectionRows } from "../../src/projection/relation-entity-projection.ts";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";

// A projection holding only the tables decision coverage reads, written row by row so each test
// states exactly which decisions, claims, facts, tasks and edges exist. Every statement is recorded
// with the rows it returned, the same count G1's sqlRowsRead takes.
function ledger() {
  const db = new DatabaseSync(":memory:"),
    versions = new Map<string, number>(),
    reads: { readonly sql: string; readonly args: readonly unknown[]; rows: number }[] = [],
    prepare = db.prepare.bind(db);
  createRelationGraphProjectionTables(db);
  createFactProjectionTables(db);
  createDecisionProjectionTables(db);
  db.exec(
    "CREATE TABLE projection_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), watermark INTEGER NOT NULL); " +
      "INSERT INTO projection_meta VALUES (1, 1); " +
      "CREATE TABLE task_snapshot (task_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, " +
      "snapshot_json TEXT NOT NULL, status TEXT)",
  );
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    for (const method of ["all", "get"] as const) {
      const original = statement[method].bind(statement);
      statement[method] = ((...args: readonly unknown[]) => {
        const result = original(...args);
        reads.push({ sql, args, rows: Array.isArray(result) ? result.length : result === undefined ? 0 : 1 });
        return result;
      }) as (typeof statement)[typeof method];
    }
    return statement;
  }) as typeof db.prepare;
  let revision = 1;
  const next = (ref: string) => {
    revision += 1;
    versions.set(ref, revision);
    db.prepare("UPDATE projection_meta SET watermark=?").run(revision);
    return revision;
  };
  return {
    db,
    reads,
    decision(
      decisionId: string,
      claims: readonly { readonly id: string; readonly fulfillment: string | null; readonly loadBearing?: boolean }[],
      options: { readonly state?: string; readonly decisionClass?: string } = {},
    ) {
      const version = next(`decision/${decisionId}`);
      db.prepare(
        "INSERT INTO decision(decision_id,state,title,question,risk_tier,urgency,vertical,preset,decision_class," +
          "applies_json,proposer_json,arbiter_json,proposed_at,decided_at,workspace_revision) " +
          "VALUES (?, ?, 'title', 'question', 'high', 'medium', 'coverage', 'default', ?, ?, ?, NULL, " +
          "'2026-09-11T00:00:00.000Z', NULL, ?)",
      ).run(
        decisionId,
        options.state ?? "in_effect",
        options.decisionClass ?? "ordinary",
        JSON.stringify({ modules: ["kernel"], productLines: [] }),
        JSON.stringify({ principal: { personId: "coverage" }, executor: null }),
        version,
      );
      for (const [position, claim] of claims.entries())
        db.prepare("INSERT INTO decision_claim VALUES (?, ?, ?, 'claim', ?, ?, ?, NULL)").run(
          decisionId,
          claim.id,
          position,
          claim.loadBearing === false ? 0 : 1,
          claim.fulfillment,
          version,
        );
    },
    fact(factId: string) {
      const ref = `fact/${factId}`,
        version = next(ref);
      db.prepare(
        "INSERT INTO fact(task_id, fact_id, ref, statement, evidence_source, observed_at, confidence, memory_class, " +
          "op_id, workspace_revision, row_json) VALUES ('task-coverage', ?, ?, 'observation', 'coverage fixture', " +
          "'2026-09-11T00:00:00.000Z', 'high', 'semantic', ?, ?, '{}')",
      ).run(factId, ref, `op-${factId}`, version);
    },
    /** A later Fact version the edges recorded earlier have not observed. */
    restate(factId: string) {
      db.prepare("UPDATE fact SET workspace_revision=? WHERE fact_id=?").run(next(`fact/${factId}`), factId);
    },
    task(taskId: string, status: string) {
      const version = next(`task/${taskId}`);
      db.prepare("INSERT INTO task_snapshot VALUES (?, ?, ?, ?)").run(
        taskId,
        version,
        JSON.stringify({ task: { taskId, status } }),
        status,
      );
    },
    edge(relationId: string, source: string, target: string, type: string, state = "active") {
      const entity = (ref: string) => (ref.startsWith("decision/") ? ref.split("/").slice(0, 2).join("/") : ref),
        version = next(`relation/${relationId}`),
        observed = versions.get(entity(target)) ?? null;
      db.prepare("INSERT INTO relation_edge VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        relationId,
        source,
        target,
        type,
        state,
        observed,
        entity(source),
        version,
        JSON.stringify({
          schema: "relation-projection/v1",
          entity: {
            kind: "relation",
            id: relationId,
            revision: version,
            source,
            target,
            type,
            direction: "directed",
            strength: "strong",
            origin: "declared",
            state,
            rationale: "coverage fixture",
            targetObservedVersion: observed,
          },
          sourcePath: `event:op-${relationId}`,
        }),
      );
    },
  };
}

type Ledger = ReturnType<typeof ledger>;

// dec_TARGET exercises every branch of coverageOf; dec_PEER, dec_ROOTED and dec_REFUTED sit on its
// walks, dec_STANDING covers by policy.
function coverageScenario(fixture: Ledger): void {
  for (const factId of [
    "F-LIVE0001",
    "F-PEER0001",
    "F-ROOT0001",
    "F-OLD00001",
    "F-NEW00001",
    "F-REFUTE01",
    "F-REFOLD01",
    "F-REFNEW01",
    "F-STALE001",
    "F-RETIRED1",
  ])
    fixture.fact(factId);
  fixture.task("task-done", "done");
  fixture.task("task-open", "active");
  fixture.decision("dec_TARGET", [
    { id: "C1", fulfillment: "evidenced" },
    { id: "C2", fulfillment: "evidenced" },
    { id: "C3", fulfillment: "evidenced" },
    { id: "C4", fulfillment: "delivered" },
    { id: "C5", fulfillment: "evidenced" },
    { id: "C6", fulfillment: "evidenced" },
    { id: "C7", fulfillment: "evidenced" },
    { id: "C8", fulfillment: "evidenced" },
    { id: "C9", fulfillment: "evidenced" },
    { id: "C10", fulfillment: "evidenced", loadBearing: false },
    { id: "C11", fulfillment: null },
  ]);
  fixture.decision("dec_PEER", [{ id: "C1", fulfillment: "evidenced" }]);
  fixture.decision("dec_ROOTED", [], { state: "proposed" });
  fixture.decision("dec_REFUTED", [{ id: "C1", fulfillment: "evidenced" }]);
  fixture.decision("dec_STANDING", [{ id: "C1", fulfillment: "standing_policy" }], {
    decisionClass: "standing_policy",
  });
  const t = "decision/dec_TARGET";
  fixture.edge("rel_t1_live", `${t}/C1`, "fact/F-LIVE0001", "evidenced-by");
  // Two hops into another decision's claim, which walks back into this one: the walk must stop.
  fixture.edge("rel_t2_peer", `${t}/C2`, "decision/dec_PEER/C1", "refines");
  fixture.edge("rel_peer_back", "decision/dec_PEER/C1", `${t}/C2`, "relates");
  fixture.edge("rel_peer_fact", "decision/dec_PEER/C1", "fact/F-PEER0001", "evidenced-by");
  fixture.edge("rel_t3_old", `${t}/C3`, "fact/F-OLD00001", "evidenced-by");
  fixture.edge("rel_supersede", "fact/F-NEW00001", "fact/F-OLD00001", "supersedes-fact");
  fixture.edge("rel_root_done", t, "task/task-done", "derives");
  fixture.edge("rel_t4_open", `${t}/C4`, "task/task-open", "derives");
  // A claim reaching another decision's root reads the edges that root carries.
  fixture.edge("rel_t5_rooted", `${t}/C5`, "decision/dec_ROOTED", "narrows");
  fixture.edge("rel_rooted_fact", "decision/dec_ROOTED", "fact/F-ROOT0001", "evidenced-by");
  fixture.edge("rel_t6_live", `${t}/C6`, "fact/F-LIVE0001", "evidenced-by");
  fixture.edge("rel_t6_refute", `${t}/C6`, "fact/F-REFUTE01", "refuted-by");
  fixture.edge("rel_t7_stale", `${t}/C7`, "fact/F-STALE001", "evidenced-by");
  fixture.restate("F-STALE001");
  fixture.edge("rel_t8_retired", `${t}/C8`, "fact/F-RETIRED1", "evidenced-by", "retired");
  // A refuter that was itself superseded no longer refutes.
  fixture.edge("rel_t9_live", `${t}/C9`, "fact/F-LIVE0001", "evidenced-by");
  fixture.edge("rel_t9_refute", `${t}/C9`, "fact/F-REFOLD01", "refuted-by");
  fixture.edge("rel_refute_supersede", "fact/F-REFNEW01", "fact/F-REFOLD01", "supersedes-fact");
  fixture.edge("rel_t10_live", `${t}/C10`, "fact/F-LIVE0001", "evidenced-by");
  // A root refuter refutes every claim of its decision.
  fixture.edge("rel_refuted_live", "decision/dec_REFUTED/C1", "fact/F-LIVE0001", "evidenced-by");
  fixture.edge("rel_refuted_root", "decision/dec_REFUTED", "fact/F-REFUTE01", "refuted-by");
}

// `count` decisions with the same shape as the scenario but no edge into it: each claim is evidenced
// by its own Fact, chained to the previous decision's claim, and its root derives its own Task.
function unrelated(fixture: Ledger, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const id = String(index).padStart(5, "0"),
      root = `decision/dec_NOISE${id}`;
    fixture.fact(`F-N${id}A`);
    fixture.fact(`F-N${id}B`);
    fixture.task(`task-noise-${id}`, index % 2 === 0 ? "done" : "active");
    fixture.decision(`dec_NOISE${id}`, [{ id: "C1", fulfillment: index % 2 === 0 ? "evidenced" : "delivered" }]);
    fixture.edge(`rel_noise_${id}_fact`, `${root}/C1`, `fact/F-N${id}A`, "evidenced-by");
    fixture.edge(`rel_noise_${id}_task`, root, `task/task-noise-${id}`, "derives");
    fixture.edge(`rel_noise_${id}_supersede`, `fact/F-N${id}B`, `fact/F-N${id}A`, "supersedes-fact");
    if (index > 0)
      fixture.edge(
        `rel_noise_${id}_chain`,
        `${root}/C1`,
        `decision/dec_NOISE${String(index - 1).padStart(5, "0")}/C1`,
        "refines",
      );
  }
}

// coverageOf fed every row the projection holds. Coverage read for any set of decisions must equal
// these rows for those decisions: reading less may not change a verdict, a path or an order.
function coverageOfEveryRow(db: DatabaseSync) {
  const decisions = db
      .prepare("SELECT decision_id, state, decision_class, applies_json FROM decision ORDER BY decision_id")
      .all() as { decision_id: string; state: string; decision_class: string; applies_json: string }[],
    claims = db
      .prepare(
        "SELECT decision_id, claim_id, load_bearing, fulfillment FROM decision_claim ORDER BY decision_id, claim_id",
      )
      .all() as { decision_id: string; claim_id: string; load_bearing: number; fulfillment: "evidenced" | null }[],
    facts = db.prepare("SELECT ref FROM fact").all() as { ref: string }[],
    tasks = db.prepare("SELECT task_id, status FROM task_snapshot").all() as { task_id: string; status: string }[],
    basisRevision = (db.prepare("SELECT watermark FROM projection_meta").get() as { watermark: number }).watermark;
  return coverageOf(
    decisions.map((decision) => ({
      ref: `decision/${decision.decision_id}`,
      state: decision.state,
      decisionClass: decision.decision_class,
      appliesTo: JSON.parse(decision.applies_json) as { modules: string[]; productLines: string[] },
      claims: claims
        .filter((claim) => claim.decision_id === decision.decision_id)
        .map((claim) => ({
          ref: `decision/${decision.decision_id}/${claim.claim_id}`,
          loadBearing: claim.load_bearing === 1,
          fulfillment: claim.fulfillment,
        })),
    })),
    facts,
    tasks.map((task) => ({ ref: `task/${task.task_id}`, status: task.status })),
    readRelationProjectionRows(db),
  ).map((row) => ({
    ...row,
    fulfillment: row.fulfillment === "standing-policy" ? "standing_policy" : row.fulfillment,
    basisRevision,
  }));
}

test("a claim evidenced only by a superseded Fact is not covered", () => {
  const fixture = ledger();
  try {
    fixture.fact("F-OLD00001");
    fixture.fact("F-NEW00001");
    fixture.decision("dec_LIVENESS", [{ id: "C1", fulfillment: "evidenced" }]);
    fixture.edge("rel_evidence", "decision/dec_LIVENESS/C1", "fact/F-OLD00001", "evidenced-by");
    const covered = readDecisionGraphRows(fixture.db).coverageRows;
    assert.equal(covered[0]?.status, "covered");
    assert.equal(covered[0]?.coveringFactRef, "fact/F-OLD00001");

    // `ha fact record --supersedes` writes the edge on the newer Fact, so the Fact owns it.
    fixture.edge("rel_supersede", "fact/F-NEW00001", "fact/F-OLD00001", "supersedes-fact");
    const [row] = readDecisionGraphRows(fixture.db).coverageRows;
    assert.equal(row?.status, "uncovered", JSON.stringify(row));
    assert.equal(row?.coveringFactRef, undefined);
    assert.deepEqual(row?.relationPath, []);
  } finally {
    fixture.db.close();
  }
});

test("each decision's coverage equals coverageOf over every projected row", () => {
  const fixture = ledger();
  try {
    coverageScenario(fixture);
    unrelated(fixture, 5);
    const everyRow = coverageOfEveryRow(fixture.db),
      decisionIds = (
        fixture.db.prepare("SELECT decision_id FROM decision ORDER BY decision_id").all() as { decision_id: string }[]
      ).map(({ decision_id }) => decision_id);
    for (const decisionId of decisionIds)
      assert.deepEqual(
        decisionCoverage(fixture.db, [decisionId]),
        everyRow.filter((row) => row.decisionRef === `decision/${decisionId}`),
        decisionId,
      );
    assert.deepEqual(readDecisionGraphRows(fixture.db).coverageRows, everyRow);

    // The scenario reaches every verdict the judgment can give, so the equality above is not vacuous.
    const target = new Map(
      decisionCoverage(fixture.db, ["dec_TARGET"]).map((row) => [row.claimRef.split("/").at(-1), row]),
    );
    assert.deepEqual([...target.keys()], ["C1", "C11", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9"]);
    assert.deepEqual(Object.fromEntries([...target].map(([claim, row]) => [claim, row.status])), {
      C1: "covered",
      C11: "uncovered",
      C2: "covered",
      C3: "uncovered",
      C4: "covered",
      C5: "covered",
      C6: "uncovered",
      C7: "uncovered",
      C8: "uncovered",
      C9: "covered",
    });
    assert.deepEqual(target.get("C2")?.relationPath, ["rel_t2_peer", "rel_peer_fact"]);
    assert.deepEqual(target.get("C4")?.relationPath, ["rel_root_done"]);
    assert.equal(target.get("C5")?.coveringFactRef, "fact/F-ROOT0001");
    assert.deepEqual(target.get("C6")?.refutingFactRefs, ["fact/F-REFUTE01"]);
    assert.deepEqual(target.get("C9")?.refutingFactRefs, []);
    assert.equal(decisionCoverage(fixture.db, ["dec_REFUTED"])[0]?.status, "uncovered");
    assert.equal(decisionCoverage(fixture.db, ["dec_STANDING"])[0]?.fulfillment, "standing_policy");
    assert.equal(decisionCoverage(fixture.db, ["dec_STANDING"])[0]?.status, "covered");
    assert.deepEqual(decisionCoverage(fixture.db, ["dec_MISSING"]), []);
  } finally {
    fixture.db.close();
  }
});

test("one decision's coverage reads the same rows however many unrelated decisions, facts, tasks and edges exist", (context) => {
  const measure = (noise: number) => {
    const fixture = ledger();
    try {
      coverageScenario(fixture);
      unrelated(fixture, noise);
      fixture.reads.length = 0;
      const rows = decisionCoverage(fixture.db, ["dec_TARGET"]),
        reads = [...fixture.reads];
      return {
        rows,
        statements: reads.length,
        rowsRead: reads.reduce((sum, read) => sum + read.rows, 0),
        plans: reads.map((read) => queryPlan(fixture.db, read)),
      };
    } finally {
      fixture.db.close();
    }
  };
  const small = measure(200),
    large = measure(2_000);
  context.diagnostic(`200 unrelated decisions: ${small.statements} statements, ${small.rowsRead} rows read`);
  context.diagnostic(`2000 unrelated decisions: ${large.statements} statements, ${large.rowsRead} rows read`);
  assert.deepEqual(
    large.rows,
    small.rows.map((row) => ({ ...row, basisRevision: large.rows[0]!.basisRevision })),
  );
  assert.equal(large.statements, small.statements);
  assert.equal(large.rowsRead, small.rowsRead, "the coverage read grew with rows that are not this decision's");
  // Row counts cannot see rows SQLite visits and filters out, so every table read must be searched by
  // an identity or an edge endpoint. A search on state or relation type alone visits every such edge.
  for (const plan of large.plans) {
    context.diagnostic(plan.replaceAll("\n", " | "));
    for (const [, scanned] of plan.matchAll(/SCAN (\S+)/gu))
      assert.ok(["json_each", "reach", "requested", "sqlite_master"].includes(scanned!), plan);
    for (const [, constraint] of plan.matchAll(/SEARCH \S+ USING (?:COVERING )?INDEX \S+ \((\w+)/gu))
      assert.ok(
        ["rowid", "decision_id", "source_ref", "target_ref", "ref", "task_id", "fact_id", "relation_id"].includes(
          constraint!,
        ),
        plan,
      );
  }
});

function queryPlan(db: DatabaseSync, read: { readonly sql: string; readonly args: readonly unknown[] }): string {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).all(...read.args) as unknown as readonly { readonly detail: string }[]
  )
    .map(({ detail }) => detail)
    .join("\n");
}
