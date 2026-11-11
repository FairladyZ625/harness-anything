import type { DatabaseSync } from "node:sqlite";
import type { DecisionState, DecisionEventV1 } from "@harness-anything/kernel/internal/domain/decision-event.ts";
import { FactProjectionError } from "@harness-anything/kernel/internal/domain/fact-admission.ts";
import {
  assertDecisionAdmissionAtCut,
  type DecisionAdmissionState,
} from "@harness-anything/kernel/internal/domain/decision-admission.ts";
import { readDecisionDocumentState } from "./decision-projection-reads.ts";
import { prepareQuery } from "./rebuildable-task-projection-sql.ts";

export function assertDecisionAdmission(db: DatabaseSync, event: DecisionEventV1): void {
  const document = readDecisionDocumentState(db, event.decisionId);
  const relations = document
    ? (prepareQuery(
        db,
        "SELECT relation_id, source_ref, target_ref FROM relation_edge WHERE state='active' AND (source_ref GLOB ? OR target_ref GLOB ?) ORDER BY relation_id",
      ).all(
        `decision/${event.decisionId}/*`,
        `decision/${event.decisionId}/*`,
      ) as unknown as DecisionAdmissionState["relations"])
    : [];
  assertDecisionAdmissionAtCut(
    { document, relations, hasSupersedes: hasActiveSupersedesRelation(db, event.decisionId) },
    event,
  );
}

function hasActiveSupersedesRelation(db: DatabaseSync, decisionId: string): boolean {
  return Boolean(
    prepareQuery(
      db,
      "SELECT 1 FROM relation_edge WHERE target_ref=? AND relation_type='supersedes' AND state='active' " +
        "AND source_ref GLOB 'decision/*' AND source_ref<>? AND source_ref NOT GLOB ? LIMIT 1",
    ).get(`decision/${decisionId}`, `decision/${decisionId}`, `decision/${decisionId}/*`),
  );
}

export function decisionState(
  db: DatabaseSync,
  id: string,
): { readonly state: DecisionState; readonly proposer_json: string } | undefined {
  return prepareQuery(db, "SELECT state,proposer_json FROM decision WHERE decision_id=?").get(id) as
    | { readonly state: DecisionState; readonly proposer_json: string }
    | undefined;
}

export function fail(code: FactProjectionError["code"], message: string): never {
  throw new FactProjectionError(code, message);
}
