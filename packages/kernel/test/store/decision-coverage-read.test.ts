// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createDecisionProjectionTables,
  readDecisionGraphRows,
} from "../../src/projection/decision-event-projection.ts";
import { createFactProjectionTables } from "../../src/projection/fact-event-projection.ts";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";

// A projection holding only the tables decision coverage reads, written row by row so each test
// states exactly which decisions, claims, facts, tasks and edges exist.
function ledger() {
  const db = new DatabaseSync(":memory:"),
    versions = new Map<string, number>();
  createRelationGraphProjectionTables(db);
  createFactProjectionTables(db);
  createDecisionProjectionTables(db);
  db.exec(
    "CREATE TABLE projection_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), watermark INTEGER NOT NULL); " +
      "INSERT INTO projection_meta VALUES (1, 1); " +
      "CREATE TABLE task_snapshot (task_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, " +
      "snapshot_json TEXT NOT NULL, status TEXT)",
  );
  let revision = 1;
  const next = (ref: string) => {
    revision += 1;
    versions.set(ref, revision);
    db.prepare("UPDATE projection_meta SET watermark=?").run(revision);
    return revision;
  };
  return {
    db,
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
      const version = next(`relation/${relationId}`),
        observed = versions.get(target) ?? null,
        owner = source.startsWith("decision/") ? source.split("/").slice(0, 2).join("/") : source;
      db.prepare("INSERT INTO relation_edge VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        relationId,
        source,
        target,
        type,
        state,
        observed,
        owner,
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
