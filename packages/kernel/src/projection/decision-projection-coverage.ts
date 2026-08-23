import type { DatabaseSync } from "node:sqlite";
import { coverageOf } from "../domain/decision-coverage.ts";
import type { DecisionFulfillmentMode } from "../domain/decision-event.ts";
import type { DecisionCoverageRow, DecisionRelationEdgeRow } from "./decision-projection-model.ts";
export function decisionCoverage(
  db: DatabaseSync,
  edges: readonly DecisionRelationEdgeRow[],
): readonly DecisionCoverageRow[] {
  const basisRevision = Number(
      (db.prepare("SELECT watermark FROM projection_meta WHERE singleton=1").get() as { readonly watermark: number })
        .watermark,
    ),
    decisions = db
      .prepare("SELECT decision_id,state,decision_class,applies_json FROM decision ORDER BY decision_id")
      .all() as unknown as readonly {
      readonly decision_id: string;
      readonly state: string;
      readonly decision_class: string;
      readonly applies_json: string;
    }[],
    claims = db
      .prepare("SELECT decision_id,claim_id,load_bearing,fulfillment FROM decision_claim ORDER BY decision_id,claim_id")
      .all() as unknown as readonly {
      readonly decision_id: string;
      readonly claim_id: string;
      readonly load_bearing: number;
      readonly fulfillment: DecisionFulfillmentMode | null;
    }[],
    facts = db.prepare("SELECT ref FROM fact ORDER BY ref").all() as unknown as readonly { readonly ref: string }[],
    hasTasks = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_snapshot'").get()),
    tasks = hasTasks
      ? (db
          .prepare(
            "SELECT task_id,json_extract(snapshot_json,'$.task.status') AS status FROM task_snapshot ORDER BY task_id",
          )
          .all() as unknown as readonly {
          readonly task_id: string;
          readonly status: string;
        }[])
      : [];
  const claimsByDecision = new Map<string, typeof claims>();
  for (const claim of claims)
    claimsByDecision.set(claim.decision_id, [...(claimsByDecision.get(claim.decision_id) ?? []), claim]);
  const livenessEdges = db
    .prepare(
      [
        "SELECT relation_id AS relationId, source_ref AS sourceRef, target_ref AS targetRef,",
        "relation_type AS relationType, state FROM relation_edge",
        "WHERE relation_type='supersedes-fact' ORDER BY relation_id",
      ].join(" "),
    )
    .all() as unknown as readonly {
    readonly relationId: string;
    readonly sourceRef: string;
    readonly targetRef: string;
    readonly relationType: string;
    readonly state: string;
  }[];
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
