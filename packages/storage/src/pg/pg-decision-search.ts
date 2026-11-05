import { assertPgDecisionReadReady, finishPgDecisionReadBackfill } from "./pg-decision-read-status.ts";
import type { PoolClient } from "pg";
import type { DecisionDocumentState } from "@harness-anything/kernel/internal/domain/decision-event.ts";
import { decisionDocumentProse } from "@harness-anything/kernel/internal/domain/decision-event.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import { unicode61Positions, phraseMatches } from "./pg-text-search.ts";

/** Called only by projection writes/management backfill, inside their existing transaction. */
export async function refreshPgDecisionSearch(client: PoolClient, scope: PgProjectionScope, id: string): Promise<void> {
  const keys = [scope.tenantId, scope.projectId, scope.policyEpoch],
    decision = (
      await client.query<{ value: DecisionDocumentState; readers: string[] }>(
        "SELECT value,readers FROM ha_decisions WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND decision_id=$4 FOR UPDATE",
        [...keys, id],
      )
    ).rows[0];
  if (!decision) return;
  const body = (
      await client.query<{ body: Buffer; repo_id: string; head_readers: string[]; blob_readers: string[] }>(
        `SELECT blob.body,head.repo_id,head.readers AS head_readers,blob.readers AS blob_readers FROM ha_document_heads head
      JOIN ha_content_blobs blob ON blob.tenant_id=head.tenant_id AND blob.project_id=head.project_id AND blob.sha256=head.sha256
      WHERE head.tenant_id=$1 AND head.project_id=$2 AND head.policy_epoch=$3 AND head.path=$4`,
        [...keys, `decisions/decision-${id}/decision.md`],
      )
    ).rows,
    value = decision.value,
    positions = [
      ...unicode61Positions([
        value.title,
        value.question,
        [...value.chosen, ...value.rejected].map((v) => v.text).join(" "),
        value.claims.map((v) => v.text).join(" "),
      ]).map((p) => ({ ...p, repo: "", head: [], blob: [] })),
      ...body.flatMap((doc) =>
        unicode61Positions([decisionDocumentProse(doc.body.toString("utf8"))]).map((p) => ({
          ...p,
          column: 4,
          repo: doc.repo_id,
          head: doc.head_readers,
          blob: doc.blob_readers,
        })),
      ),
    ];
  await client.query(
    "DELETE FROM ha_decision_positions WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND decision_id=$4",
    [...keys, id],
  );
  if (positions.length) {
    const serialized = JSON.stringify(positions);
    // Tokens are identified by surrogate slots, not the digest. Concurrent initial
    // insertion may leave two equivalent dictionary entries; both remain valid and
    // readers union their postings. No shared hot-word row is locked or rewritten.
    await client.query(
      `INSERT INTO ha_search_terms(tenant_id,project_id,policy_epoch,term_key,term)
      SELECT $1,$2,$3,md5(word),word FROM (SELECT DISTINCT v->>'term' AS word FROM jsonb_array_elements($4::jsonb) v) words
      WHERE NOT EXISTS (SELECT 1 FROM ha_search_terms d WHERE d.tenant_id=$1 AND d.project_id=$2
        AND d.policy_epoch=$3 AND d.term_key=md5(word) AND d.term=word)`,
      [...keys, serialized],
    );
    await client.query(
      `INSERT INTO ha_decision_positions
      (tenant_id,project_id,policy_epoch,readers,term_key,term_slot,decision_id,column_id,position,repo_id,head_readers,blob_readers)
      SELECT $1,$2,$3,$4::text[],d.term_key,d.term_slot,$5,(v->>'column')::smallint,(v->>'offset')::integer,v->>'repo',
        ARRAY(SELECT jsonb_array_elements_text(v->'head')),ARRAY(SELECT jsonb_array_elements_text(v->'blob'))
      FROM jsonb_array_elements($6::jsonb) v CROSS JOIN LATERAL (
        SELECT term_key,term_slot FROM ha_search_terms WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
          AND term_key=md5(v->>'term') AND term=v->>'term' ORDER BY term_slot LIMIT 1
      ) d`,
      [...keys, decision.readers, id, serialized],
    );
  }
  await client.query(
    "UPDATE ha_decisions SET search_ready=true WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND decision_id=$4",
    [...keys, id],
  );
}

/** Each transaction locks at most 64 owners; processed=0 is the termination signal. */
export async function backfillPgDecisionSearchPage(
  client: PoolClient,
  scope: PgProjectionScope,
): Promise<{ readonly processed: number; readonly done: boolean }> {
  const pending = await client.query<{ decision_id: string }>(
    `SELECT decision_id FROM ha_decisions WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND NOT search_ready
      ORDER BY decision_id LIMIT 64 FOR UPDATE`,
    [scope.tenantId, scope.projectId, scope.policyEpoch],
  );
  for (const row of pending.rows) await refreshPgDecisionSearch(client, scope, row.decision_id);
  return {
    processed: pending.rows.length,
    done: pending.rows.length === 0 && (await finishPgDecisionReadBackfill(client, scope)),
  };
}

export async function searchPgDecisionIds(
  client: PoolClient,
  scope: PgProjectionScope,
  query: string,
  repoId: string,
): Promise<readonly string[]> {
  await assertPgDecisionReadReady(client, scope, "search");
  const keys = [scope.tenantId, scope.projectId, scope.policyEpoch],
    readers = [...(scope.readers ?? [])];
  const terms = unicode61Positions([query]).map((p) => p.term);
  if (terms.length === 0) return [];
  const result = await client.query<{ id: string; term: string; column: number; offset: number }>(
    `WITH requested AS MATERIALIZED (SELECT DISTINCT unnest($4::text[]) AS term),
      words AS MATERIALIZED (
        SELECT r.term,d.term_key,d.term_slot AS slot FROM requested r JOIN ha_search_terms d
          ON d.tenant_id=$1 AND d.project_id=$2 AND d.policy_epoch=$3 AND d.term_key=md5(r.term) AND d.term=r.term)
      SELECT p.decision_id AS id,w.term,p.column_id AS column,p.position AS offset
      FROM words w JOIN ha_decision_positions p ON p.tenant_id=$1 AND p.project_id=$2 AND p.policy_epoch=$3
        AND p.term_key=w.term_key AND p.term_slot=w.slot
      WHERE (p.column_id<>4 OR p.repo_id=$6) AND (cardinality($5::text[])=0 OR (p.readers && $5::text[]
        AND (p.column_id<>4 OR (p.head_readers && $5::text[] AND p.blob_readers && $5::text[]))))`,
    [...keys, [...new Set(terms)], readers, repoId],
  );
  return phraseMatches(terms, result.rows);
}
