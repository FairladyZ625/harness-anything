import type { PoolClient } from "pg";
import {
  decisionDocumentProse,
  type DecisionDocumentState,
} from "@harness-anything/kernel/internal/domain/decision-event.ts";
import type { DocumentState } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { projectDecisionListReview } from "../projection/decision-projection-documents.ts";
import { pgDecisionRelation, type PgDecisionReviewSummary } from "./pg-decision-reads.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";

export async function projectPgDecisionListReview(
  client: PoolClient,
  scope: PgProjectionScope,
  id: string,
  decision: DecisionDocumentState,
): Promise<PgDecisionReviewSummary> {
  const keys = [scope.tenantId, scope.projectId, scope.policyEpoch];
  const documentRow = (
    await client.query<{ readonly value: string }>(
      `SELECT value FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
        AND model IN ('document','document-history') AND owner_id='' AND entity_id=$4 ORDER BY model LIMIT 1`,
      [...keys, `decisions/decision-${id}/decision.md`],
    )
  ).rows[0];
  if (!documentRow) return { review: null, blobSha256: null, evidenceCount: 0 };
  const document = JSON.parse(documentRow.value) as DocumentState,
    root = `decision/${id}`,
    edges = await client.query<{ readonly value: Record<string, unknown> }>(
      `SELECT value FROM ha_relations WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
          AND relation_type IN ('evidenced-by','refuted-by')
          AND (source_ref=$4 OR (source_ref COLLATE "C">=$5 AND source_ref COLLATE "C"<$6)) ORDER BY relation_id`,
      [...keys, root, `${root}/`, `${root}0`],
    ),
    relations = edges.rows.map(({ value }) => pgDecisionRelation(value));
  return {
    review: projectDecisionListReview({ ...decision, relations }, decisionDocumentProse(document.body)),
    blobSha256: document.blobSha256,
    evidenceCount: relations.length,
  };
}
