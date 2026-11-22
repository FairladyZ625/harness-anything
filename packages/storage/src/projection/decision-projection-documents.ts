import type { DatabaseSync } from "node:sqlite";
import {
  decisionAcceptReviewReadiness,
  decisionDocumentProse,
  decisionReviewContentDigest,
  type DecisionDocumentState,
} from "@harness-anything/kernel/internal/domain/decision-event.ts";
import type { DecisionListReview } from "@harness-anything/kernel/internal/ports/decision-projection-model.ts";
import type { DocumentState } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import type { PersistedCanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import {
  canonicalDocumentClaims,
  canonicalDocumentRetirements,
} from "@harness-anything/kernel/internal/ports/canonical-document-claims.ts";
import type { DecisionBodyRow } from "@harness-anything/kernel";
import { prepareQuery } from "./rebuildable-task-projection-sql.ts";

export const decisionDocumentPattern = /^decisions\/decision-(dec_[A-Za-z0-9_-]+)\/decision\.md$/u;

export function changedDecisionDocuments(event: PersistedCanonicalEventV1): Set<string> {
  const owners = new Set<string>();
  if (event.schema === "decision-event/v1") owners.add(event.decisionId);
  else if (event.schema === "migration-import-event/v1" && event.payload.entity.kind === "decision")
    owners.add(event.payload.entity.decision.decisionId);
  for (const { path } of [...canonicalDocumentClaims(event), ...canonicalDocumentRetirements(event)]) {
    const id = path.match(decisionDocumentPattern)?.[1];
    if (id) owners.add(id);
  }
  return owners;
}

export function changedDecisionEvidenceRelations(event: PersistedCanonicalEventV1): readonly string[] {
  if (event.schema === "relation-event/v1")
    return event.type === "relation_replaced"
      ? [event.relationId, event.payload.previousRelationId]
      : [event.relationId];
  if (event.schema === "migration-import-event/v1" && event.payload.entity.kind === "relation")
    return [event.payload.entity.relation.relation_id];
  return [];
}

/** The content verdict stays valid across settings changes. Only the requirement is applied on read. */
export function projectDecisionListReview(state: DecisionDocumentState, prose: string): DecisionListReview {
  const readiness = state.state === "proposed" ? decisionAcceptReviewReadiness(state, prose, "off") : null;
  return {
    digest: readiness?.currentDigest ?? decisionReviewContentDigest(state, prose),
    readiness,
  };
}

export function readDecisionBody(db: DatabaseSync, decisionId: string): DecisionBodyRow | null {
  const path = `decisions/decision-${decisionId}/decision.md`,
    row = prepareQuery(
      db,
      "SELECT value_json FROM document WHERE path=? UNION ALL SELECT value_json FROM document_history WHERE path=? LIMIT 1",
    ).get(path, path) as { readonly value_json: string } | undefined;
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
