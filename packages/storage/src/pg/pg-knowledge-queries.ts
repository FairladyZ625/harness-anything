import type { PoolClient } from "pg";
import type {
  TaskProjectionQueries,
  VersionedRelationProjectionRow,
  FactProjectionRow,
} from "@harness-anything/kernel";
import type { FactAnchorRow } from "@harness-anything/kernel/internal/ports/projection-contracts.ts";
import { coverageOf, type CoverageDecision } from "@harness-anything/kernel/internal/domain/decision-coverage.ts";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import { readCutInTransaction } from "./pg-event-queries.ts";
import { readVersionedRelationsInTransaction } from "./pg-relation-queries.ts";
import { listPgProjectionValues } from "./pg-projection-values.ts";
import type { PgTaskProjectionSourceOptions, PgTaskProjectionSource } from "./pg-task-source.ts";
import type { AsyncQueries } from "./pg-runtime-dispatch-queries.ts";

export type PgKnowledgeQueries = AsyncQueries<
  | "readDecisionDocumentState"
  | "readDecisionCoverage"
  | "readDecisionGraph"
  | "readDecisionIncomingRelations"
  | "readFactAnchors"
  | "readFactGraph"
>;
export function pgKnowledgeQueries(
  options: PgTaskProjectionSourceOptions,
  source: Pick<PgTaskProjectionSource, "readDecision" | "searchFacts">,
): PgKnowledgeQueries {
  const { scope, repoId } = options,
    readers = [...(scope.readers ?? [])],
    parameters = [scope.tenantId, scope.projectId, scope.policyEpoch, readers];
  const read = <Result>(operation: (client: PoolClient) => Promise<Result>) =>
    withPostgresTransaction(options.pool, operation, scope, { isolationLevel: "repeatable read" });
  const anchors = async (client: PoolClient, refs?: readonly string[]): Promise<readonly FactAnchorRow[]> => {
    const rows = await client.query<{ value: FactProjectionRow; op_id: string }>(
      `SELECT f.value,(SELECT e.op_id FROM ha_events e WHERE e.tenant_id=f.tenant_id AND e.project_id=f.project_id AND e.policy_epoch=f.policy_epoch AND e.repo_id=$5
        AND (cardinality($4::text[])=0 OR e.readers && $4::text[]) AND
        ((e.event_type='fact_recorded' AND e.event_json::jsonb->>'factId'=f.fact_id)
         OR (e.event_type='entity_migrated' AND e.event_json::jsonb#>>'{payload,entity,fact,factId}'=f.fact_id))
        ORDER BY e.revision LIMIT 1) AS op_id FROM ha_facts f WHERE f.tenant_id=$1 AND f.project_id=$2 AND f.policy_epoch=$3
        AND (cardinality($4::text[])=0 OR f.readers && $4::text[])${refs === undefined ? "" : " AND f.value->>'ref'=ANY($6::text[])"} ORDER BY f.value->>'ref'`,
      [...parameters, repoId, ...(refs === undefined ? [] : [refs])],
    );
    return rows.rows.map(({ value, op_id }) => ({
      factRef: value.ref,
      factId: value.factId,
      ...(value.taskId ? { taskId: value.taskId } : {}),
      sourcePath: `event:${op_id}`,
    }));
  };
  const decisions = async (client: PoolClient) =>
    (
      await client.query<{
        decision_id: string;
        value: Omit<CoverageDecision, "claims" | "ref"> & {
          chosen: readonly { id: string }[];
          rejected: readonly { id: string }[];
          claims: readonly {
            id: string;
            loadBearing: boolean;
            fulfillment?: "evidenced" | "delivered" | "standing-policy" | "standing_policy" | null;
          }[];
        };
      }>(
        `SELECT decision_id,value FROM ha_decisions WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND (cardinality($4::text[])=0 OR readers && $4::text[]) ORDER BY decision_id`,
        parameters,
      )
    ).rows;
  const coverage = async (client: PoolClient, ids: readonly string[], basisRevision: number) => {
    const selected = (await decisions(client)).filter(({ decision_id }) => ids.includes(decision_id)),
      facts = await client.query<{ ref: string }>(
        `SELECT value->>'ref' AS ref FROM ha_facts WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND (cardinality($4::text[])=0 OR readers && $4::text[]) ORDER BY fact_id`,
        parameters,
      ),
      tasks = await client.query<{ ref: string; status: string }>(
        `SELECT 'task/' || task_id AS ref,snapshot#>>'{task,status}' AS status FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND (cardinality($4::text[])=0 OR readers && $4::text[]) ORDER BY task_id`,
        parameters,
      ),
      edges = await readVersionedRelationsInTransaction(client, scope, readers, {});
    return coverageOf(
      selected.map(({ decision_id, value }) => ({
        ref: `decision/${decision_id}`,
        state: value.state,
        decisionClass: value.decisionClass,
        appliesTo: value.appliesTo,
        claims: value.claims.map((claim) => ({
          ref: `decision/${decision_id}/${claim.id}`,
          loadBearing: claim.loadBearing,
          fulfillment: claim.fulfillment ?? null,
        })),
      })),
      facts.rows,
      tasks.rows,
      edges,
    ).map((row) => ({
      ...row,
      fulfillment: row.fulfillment === "standing-policy" ? ("standing_policy" as const) : row.fulfillment,
      basisRevision,
    }));
  };
  return {
    readDecisionDocumentState: async (id) => {
      const row = (await source.readDecision(id)).decision;
      if (!row) return null;
      const { body: _body, ...state } = row;
      return state;
    },
    readDecisionCoverage: (ids) =>
      read(async (client) => {
        const cut = await readCutInTransaction(client, scope, readers, repoId);
        return { ...cut, coverageRows: await coverage(client, ids, cut.watermark) };
      }),
    readDecisionGraph: () =>
      read(async (client) => {
        const cut = await readCutInTransaction(client, scope, readers, repoId),
          rows = await decisions(client),
          decisionAnchors = rows.map(({ decision_id, value }) => ({
            decisionId: decision_id,
            decisionRef: `decision/${decision_id}`,
            anchorRefs: [
              `decision/${decision_id}`,
              ...[...(value.chosen ?? []), ...(value.rejected ?? []), ...value.claims].map(
                ({ id }) => `decision/${decision_id}/${id}`,
              ),
            ].sort(),
            sourcePath: `event:decision/${decision_id}`,
          }));
        return {
          ...cut,
          decisionAnchors,
          edges: (await readVersionedRelationsInTransaction(client, scope, readers, {})).filter(
            ({ ownerRef }) => !ownerRef.startsWith("fact/"),
          ),
          coverageRows: await coverage(
            client,
            rows.map(({ decision_id }) => decision_id),
            cut.watermark,
          ),
        };
      }),
    readDecisionIncomingRelations: (id) =>
      read(async (client) =>
        (await readVersionedRelationsInTransaction(client, scope, readers, {})).filter(
          ({ ownerRef, targetRef }) =>
            !ownerRef.startsWith("fact/") &&
            (targetRef === `decision/${id}` || targetRef.startsWith(`decision/${id}/`)),
        ),
      ),
    readFactAnchors: (refs) =>
      read(async (client) => ({
        ...(await readCutInTransaction(client, scope, readers, repoId)),
        rows: await anchors(client, refs),
      })),
    readFactGraph: () =>
      read(async (client) => ({
        ...(await readCutInTransaction(client, scope, readers, repoId)),
        edges: (await listPgProjectionValues<VersionedRelationProjectionRow>(client, scope, "relation-write")).filter(
          ({ ownerRef, targetRef }) => ownerRef.startsWith("fact/") || targetRef.startsWith("fact/"),
        ) as unknown as ReturnType<TaskProjectionQueries["readFactGraph"]>["edges"],
        factAnchors: await anchors(client),
        facts: (await source.searchFacts({})).facts,
      })),
  };
}
