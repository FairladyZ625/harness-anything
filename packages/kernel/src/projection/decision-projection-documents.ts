import type { DatabaseSync } from "node:sqlite";
import { decisionDocumentProse, type DecisionDocumentState } from "../domain/decision-event.ts";
import type { DocumentState } from "../domain/doc-sync.contract.ts";
import type { DecisionBodyRow, DecisionRelationEdgeRow } from "./decision-projection-model.ts";
import { readDecisionRow } from "./decision-projection-reads.ts";
import { queryRows } from "./rebuildable-task-projection-sql.ts";

export function readDecisionBody(db: DatabaseSync, decisionId: string): DecisionBodyRow | null {
  const path = `decisions/decision-${decisionId}/decision.md`,
    row = db.prepare("SELECT value_json FROM document WHERE path=?").get(path) as
      | { readonly value_json: string }
      | undefined;
  return row ? decisionBodyFromDocument(decisionId, row.value_json) : null;
}

export function decisionBodyFromDocument(decisionId: string, valueJson: string): DecisionBodyRow {
  const path = `decisions/decision-${decisionId}/decision.md`,
    document = JSON.parse(valueJson) as DocumentState;
  return {
    path,
    blobSha256: document.blobSha256,
    size: document.size,
    mediaType: document.mediaType,
    body: decisionDocumentProse(document.body),
    workspaceRevision: document.workspaceRevision,
  };
}

export function readDecisionDocumentState(db: DatabaseSync, decisionId: string): DecisionDocumentState | null {
  const row = readDecisionRow(db, decisionId);
  if (!row) return null;
  const { body: _body, ...decision } = row,
    relations = queryRows<{ readonly row_json: string }>(
      db,
      "SELECT row_json FROM relation_edge WHERE owner_ref=? ORDER BY relation_id",
      `decision/${decisionId}`,
    )
      .map((entry) => JSON.parse(entry.row_json) as DecisionRelationEdgeRow)
      .map((edge) => ({
        relation_id: edge.relationId,
        source: edge.sourceRef,
        target: edge.targetRef,
        type: edge.relationType,
        direction: edge.direction,
        strength: edge.strength,
        origin: edge.origin,
        rationale: edge.rationale,
        state: edge.state,
      }));
  return { ...decision, relations };
}
