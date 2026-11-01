import type { PoolClient } from "pg";
import type { DecisionProjectionRow } from "@harness-anything/kernel/internal/ports/decision-projection-model.ts";
import type { EntityRelationRecord } from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import { decisionDocumentProse } from "@harness-anything/kernel/internal/domain/decision-event.ts";
import { relationOwnerRef } from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import {
  decisionCapabilities,
  decisionClaimsOpen,
} from "@harness-anything/kernel/internal/domain/decision-board-projection.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import { decisionLegacyId } from "../projection/decision-projection-reads.ts";

/** Batch body and relation metadata at the caller's transaction cut. */
export async function readPgDecisionRows(
  client: PoolClient,
  scope: PgProjectionScope,
  repoId: string,
  rows: readonly { readonly decision_id: string; readonly value: Record<string, unknown> }[],
  withBody: boolean,
): Promise<readonly DecisionProjectionRow[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.decision_id),
    readers = [...(scope.readers ?? [])],
    relations = await client.query<{ value: Record<string, unknown> }>(
      `SELECT value FROM ha_relations WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
       AND split_part(source_ref, '/', 1)='decision' AND split_part(source_ref, '/', 2)=ANY($4::text[])
       AND (cardinality($5::text[])=0 OR readers && $5::text[]) ORDER BY relation_id`,
      [scope.tenantId, scope.projectId, scope.policyEpoch, ids, readers],
    ),
    documents = withBody
      ? await client.query<{
          path: string;
          sha256: string;
          size: string;
          revision: string;
          body: Buffer;
        }>(
          `SELECT head.path, head.sha256, head.size::text, head.revision::text, blob.body
       FROM ha_document_heads head JOIN ha_content_blobs blob
         ON blob.tenant_id=head.tenant_id AND blob.project_id=head.project_id AND blob.sha256=head.sha256
       WHERE head.tenant_id=$1 AND head.project_id=$2 AND head.repo_id=$3 AND head.policy_epoch=$4
         AND head.path=ANY($5::text[])
         AND (cardinality($6::text[])=0 OR (head.readers && $6::text[] AND blob.readers && $6::text[]))`,
          [
            scope.tenantId,
            scope.projectId,
            repoId,
            scope.policyEpoch,
            ids.map((id) => `decisions/decision-${id}/decision.md`),
            readers,
          ],
        )
      : { rows: [] };
  const bodyByPath = new Map(
    documents.rows.map((row) => [
      row.path,
      {
        path: row.path,
        blobSha256: row.sha256,
        size: Number(row.size),
        mediaType: "text/markdown",
        body: decisionDocumentProse(row.body.toString("utf8")),
        workspaceRevision: Number(row.revision),
      },
    ]),
  );
  return rows.map(({ decision_id, value }) => {
    const row = decisionProjectionRow(decision_id, value);
    return {
      ...row,
      body: bodyByPath.get(row.path) ?? null,
      relations: relations.rows
        .filter(({ value: relation }) => relationOwnerRef(String(relation.source)) === `decision/${decision_id}`)
        .map(
          ({ value: relation }) =>
            ({
              relation_id: relation.id,
              source: relation.source,
              target: relation.target,
              type: relation.type,
              direction: relation.direction,
              strength: relation.strength,
              origin: relation.origin,
              rationale: relation.rationale,
              state: relation.state,
            }) as EntityRelationRecord,
        ),
    };
  });
}

type DecisionDocumentShape = Record<string, unknown>;

function decisionProjectionRow(decisionId: string, raw: Record<string, unknown>): DecisionProjectionRow {
  const value = raw as Partial<DecisionDocumentShape>;
  const legacyId = decisionLegacyId(decisionId);
  return {
    schema: "decision-row/v1",
    decisionId,
    ...(legacyId ? { legacyId } : {}),
    path: `decisions/decision-${decisionId}/decision.md`,
    state: String(value.state ?? "proposed") as DecisionProjectionRow["state"],
    title: String(value.title ?? ""),
    question: String(value.question ?? ""),
    riskTier: String(value.riskTier ?? "medium") as DecisionProjectionRow["riskTier"],
    urgency: String(value.urgency ?? "medium") as DecisionProjectionRow["urgency"],
    vertical: String(value.vertical ?? ""),
    preset: String(value.preset ?? ""),
    decisionClass: String(value.decisionClass ?? "ordinary") as DecisionProjectionRow["decisionClass"],
    appliesTo: (value.appliesTo as DecisionProjectionRow["appliesTo"]) ?? { modules: [], productLines: [] },
    proposer: value.proposer as DecisionProjectionRow["proposer"],
    arbiter: (value.arbiter as DecisionProjectionRow["arbiter"]) ?? null,
    proposedAt: String(value.proposedAt ?? ""),
    decidedAt: (value.decidedAt as string | null) ?? null,
    workspaceRevision: Number(value.workspaceRevision ?? 0),
    chosen: (value.chosen as DecisionProjectionRow["chosen"]) ?? [],
    rejected: (value.rejected as DecisionProjectionRow["rejected"]) ?? [],
    claims: (value.claims as DecisionProjectionRow["claims"]) ?? [],
    provenance: (value.provenance as DecisionProjectionRow["provenance"]) ?? [],
    judgmentConsents: (value.judgmentConsents as DecisionProjectionRow["judgmentConsents"]) ?? [],
    reviews: (value.reviews as DecisionProjectionRow["reviews"]) ?? [],
    reviewResponses: (value.reviewResponses as DecisionProjectionRow["reviewResponses"]) ?? [],
    reviewOverrides: (value.reviewOverrides as DecisionProjectionRow["reviewOverrides"]) ?? [],
    relations: [],
    ...(Array.isArray(value.amendments) && value.amendments.length
      ? { amendments: value.amendments as DecisionProjectionRow["amendments"] }
      : {}),
    ...(Array.isArray(value.contentPins) && value.contentPins.length
      ? { contentPins: value.contentPins as DecisionProjectionRow["contentPins"] }
      : {}),
    body: null,
    capabilities: decisionCapabilities(String(value.state ?? "proposed") as never),
    claimsOpen: decisionClaimsOpen(String(value.state ?? "proposed") as never),
  };
}
