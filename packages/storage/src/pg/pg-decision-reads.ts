import type { PoolClient } from "pg";
import type { DecisionProjectionRow } from "@harness-anything/kernel/internal/ports/decision-projection-model.ts";
import type { EntityRelationRecord } from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import { decisionDocumentProse } from "@harness-anything/kernel/internal/domain/decision-event.ts";
import {
  relationOwnerRef,
  terminalDecisionMaterializationStates,
} from "@harness-anything/kernel/internal/domain/entity-relation.ts";
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
  _repoId: string,
  rows: readonly { readonly decision_id: string; readonly value: Record<string, unknown> }[],
  withBody: boolean,
): Promise<readonly DecisionProjectionRow[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.decision_id),
    readers = [...(scope.readers ?? [])],
    relations = await client.query<{ value: Record<string, unknown> }>(
      `SELECT edge.value FROM unnest($4::text[]) AS requested(root)
       CROSS JOIN LATERAL (
         SELECT relation_id,value FROM ha_relations WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
           AND source_ref=requested.root AND (cardinality($5::text[])=0 OR readers && $5::text[])
         UNION ALL
         SELECT relation_id,value FROM ha_relations WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
           AND source_ref COLLATE "C" >= (requested.root || '/') COLLATE "C"
           AND source_ref COLLATE "C" < (requested.root || '0') COLLATE "C"
           AND (cardinality($5::text[])=0 OR readers && $5::text[])
       ) edge ORDER BY edge.relation_id`,
      [scope.tenantId, scope.projectId, scope.policyEpoch, ids.map((id) => `decision/${id}`), readers],
    ),
    documents = await client.query<{ entity_id: string; model: string; value: string }>(
      `SELECT entity_id,model,${withBody ? "value" : "'{}' AS value"} FROM ha_projection_values
       WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND owner_id=''
         AND model=ANY($4::text[]) AND entity_id=ANY($5::text[])
         AND (cardinality($6::text[])=0 OR readers && $6::text[])`,
      [
        scope.tenantId,
        scope.projectId,
        scope.policyEpoch,
        withBody ? ["document", "document-history"] : ["document"],
        ids.map((id) => `decisions/decision-${id}/decision.md`),
        readers,
      ],
    );
  const activePaths = new Set(
      documents.rows.filter(({ model }) => model === "document").map(({ entity_id }) => entity_id),
    ),
    bodyByPath = new Map<string, DecisionProjectionRow["body"]>();
  if (withBody)
    for (const { entity_id, model, value } of documents.rows) {
      if (model === "document-history" && activePaths.has(entity_id)) continue;
      const document = JSON.parse(value) as NonNullable<DecisionProjectionRow["body"]>;
      bodyByPath.set(entity_id, { ...document, body: decisionDocumentProse(document.body) });
    }
  const relationsByOwner = new Map<string, EntityRelationRecord[]>();
  for (const { value: relation } of relations.rows) {
    const owner = relationOwnerRef(String(relation.source)),
      bucket = relationsByOwner.get(owner) ?? [];
    bucket.push({
      relation_id: relation.id,
      source: relation.source,
      target: relation.target,
      type: relation.type,
      direction: relation.direction,
      strength: relation.strength,
      origin: relation.origin,
      rationale: relation.rationale,
      state: relation.state,
    } as EntityRelationRecord);
    relationsByOwner.set(owner, bucket);
  }
  return rows.map(({ decision_id, value }) => {
    const row = decisionProjectionRow(decision_id, value);
    return {
      ...row,
      materializationState:
        (terminalDecisionMaterializationStates as readonly string[]).includes(row.state) && !activePaths.has(row.path)
          ? "dematerialized_terminal"
          : "materialized",
      body: bodyByPath.get(row.path) ?? null,
      relations: relationsByOwner.get(`decision/${decision_id}`) ?? [],
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
