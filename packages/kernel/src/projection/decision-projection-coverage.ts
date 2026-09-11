import type { DatabaseSync } from "node:sqlite";
import { coverageOf } from "../domain/decision-coverage.ts";
import type { DecisionFulfillmentMode } from "../domain/decision-event.ts";
import type { DecisionCoverageRow } from "./decision-projection-model.ts";
import { projectionTables, queryRow, queryRows } from "./rebuildable-task-projection-sql.ts";
import { relationProjectionRowsAtCut } from "./relation-entity-projection.ts";

// The active edges coverageOf can consult for the requested decisions: those leaving each decision
// root (refuted-by, derives), and those leaving every decision anchor that a load-bearing claim
// reaches through active edges into other decision anchors (the evidence walk). Unary + keeps the
// state filter off its own index, which holds every active edge in the repository.
const COVERAGE_EDGES_SQL = [
  "WITH RECURSIVE requested(decision_id) AS (SELECT value FROM json_each(?)),",
  "reach(ref) AS (SELECT 'decision/' || decision_id || '/' || claim_id FROM decision_claim",
  "WHERE decision_id IN (SELECT decision_id FROM requested) AND load_bearing = 1",
  "UNION SELECT edge.target_ref FROM reach JOIN relation_edge AS edge",
  "ON edge.source_ref = reach.ref AND +edge.state = 'active' WHERE substr(edge.target_ref, 1, 9) = 'decision/')",
  "SELECT row_json FROM relation_edge WHERE +state = 'active' AND source_ref IN",
  "(SELECT ref FROM reach UNION SELECT 'decision/' || decision_id FROM requested) ORDER BY relation_id",
].join(" ");

/** Coverage of the requested decisions, computed from only the rows coverageOf consults for them. */
export function decisionCoverage(db: DatabaseSync, decisionIds: readonly string[]): readonly DecisionCoverageRow[] {
  const requested = JSON.stringify(decisionIds),
    basisRevision = Number(
      queryRow<{ readonly watermark: number }>(db, "SELECT watermark FROM projection_meta WHERE singleton=1")!
        .watermark,
    ),
    decisions = queryRows<{
      readonly decision_id: string;
      readonly state: string;
      readonly decision_class: string;
      readonly applies_json: string;
    }>(
      db,
      "SELECT decision_id,state,decision_class,applies_json FROM decision " +
        "WHERE decision_id IN (SELECT value FROM json_each(?)) ORDER BY decision_id",
      requested,
    ),
    claims = queryRows<{
      readonly decision_id: string;
      readonly claim_id: string;
      readonly load_bearing: number;
      readonly fulfillment: DecisionFulfillmentMode | null;
    }>(
      db,
      "SELECT decision_id,claim_id,load_bearing,fulfillment FROM decision_claim " +
        "WHERE decision_id IN (SELECT value FROM json_each(?)) ORDER BY decision_id,claim_id",
      requested,
    ),
    edges = relationProjectionRowsAtCut(
      db,
      queryRows<{ readonly row_json: string }>(db, COVERAGE_EDGES_SQL, requested),
    ),
    targets = (kind: "fact/" | "task/") => [
      ...new Set(edges.flatMap(({ targetRef }) => (targetRef.startsWith(kind) ? [targetRef] : []))),
    ],
    factRefs = JSON.stringify(targets("fact/")),
    facts = queryRows<{ readonly ref: string }>(
      db,
      "SELECT ref FROM fact WHERE ref IN (SELECT value FROM json_each(?)) ORDER BY ref",
      factRefs,
    ),
    // A superseded Fact no longer covers; its supersedes-fact edge starts at the newer Fact.
    livenessEdges = relationProjectionRowsAtCut(
      db,
      queryRows<{ readonly row_json: string }>(
        db,
        "SELECT row_json FROM relation_edge WHERE target_ref IN (SELECT value FROM json_each(?)) " +
          "AND +relation_type = 'supersedes-fact' AND +state = 'active' ORDER BY relation_id",
        factRefs,
      ),
    ),
    tasks = projectionTables(db).has("task_snapshot")
      ? queryRows<{
          readonly task_id: string;
          readonly status: string;
        }>(
          db,
          "SELECT task_id,json_extract(snapshot_json,'$.task.status') AS status FROM task_snapshot " +
            "WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY task_id",
          JSON.stringify(targets("task/").map((ref) => ref.slice("task/".length))),
        )
      : [];
  const claimsByDecision = new Map<string, typeof claims>();
  for (const claim of claims)
    claimsByDecision.set(claim.decision_id, [...(claimsByDecision.get(claim.decision_id) ?? []), claim]);
  return coverageOf(
    decisions.map((decision) => {
      const ref = `decision/${decision.decision_id}`;
      return {
        ref,
        state: decision.state,
        decisionClass: decision.decision_class,
        appliesTo: JSON.parse(decision.applies_json) as {
          readonly modules: readonly string[];
          readonly productLines: readonly string[];
        },
        claims: (claimsByDecision.get(decision.decision_id) ?? []).map((claim) => ({
          ref: `${ref}/${claim.claim_id}`,
          loadBearing: claim.load_bearing === 1,
          fulfillment: claim.fulfillment,
        })),
      };
    }),
    facts,
    tasks.map((task) => ({ ref: `task/${task.task_id}`, status: task.status })),
    [...edges, ...livenessEdges],
  ).map((row) => ({
    ...row,
    fulfillment: row.fulfillment === "standing-policy" ? "standing_policy" : row.fulfillment,
    basisRevision,
  }));
}
