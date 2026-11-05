import { readPgFactsInTransaction } from "./pg-fact-reads.ts";
import { pgEventReadSource } from "./pg-event-read-index-migration.ts";
import type { PoolClient } from "pg";
import type {
  TaskProjectionQueries,
  VersionedRelationProjectionRow,
  FactProjectionRow,
} from "@harness-anything/kernel";
import type { FactAnchorRow } from "@harness-anything/kernel/internal/ports/projection-contracts.ts";
import { relationIsCurrent } from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import { coverageOf, type CoverageDecision } from "@harness-anything/kernel/internal/domain/decision-coverage.ts";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import { readCutInTransaction } from "./pg-event-queries.ts";
import { readVersionedRelationsInTransaction } from "./pg-relation-queries.ts";
import { pgProjectionReadSource } from "./pg-read-index-migration.ts";
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
  source: Pick<PgTaskProjectionSource, "readDecision">,
): PgKnowledgeQueries {
  const { scope, repoId } = options,
    readers = [...(scope.readers ?? [])],
    parameters = [scope.tenantId, scope.projectId, scope.policyEpoch, readers];
  const read = <Result>(operation: (client: PoolClient) => Promise<Result>) =>
    withPostgresTransaction(options.pool, operation, scope, { isolationLevel: "repeatable read" });
  const anchors = async (client: PoolClient, refs?: readonly string[]): Promise<readonly FactAnchorRow[]> => {
    const events = await pgEventReadSource(client, scope, repoId);
    const rows = await client.query<{ value: FactProjectionRow; op_id: string }>(
      `SELECT f.value,(SELECT e.op_id FROM ${events} e WHERE e.tenant_id=f.tenant_id AND e.project_id=f.project_id AND e.policy_epoch=f.policy_epoch AND e.repo_id=$5
        AND (cardinality($4::text[])=0 OR e.readers && $4::text[]) AND
        e.fact_anchor_id=f.fact_id
        ORDER BY e.revision LIMIT 1) AS op_id FROM ha_facts f WHERE f.tenant_id=$1 AND f.project_id=$2 AND f.policy_epoch=$3
        AND (cardinality($4::text[])=0 OR f.readers && $4::text[])${refs === undefined ? "" : " AND f.fact_id=ANY($6::text[])"} ORDER BY f.fact_id`,
      [
        ...parameters,
        repoId,
        ...(refs === undefined ? [] : [refs.filter((ref) => ref.startsWith("fact/")).map((ref) => ref.slice(5))]),
      ],
    );
    return rows.rows.map(({ value, op_id }) => ({
      factRef: value.ref,
      factId: value.factId,
      ...(value.taskId ? { taskId: value.taskId } : {}),
      sourcePath: `event:${op_id}`,
    }));
  };
  const decisions = async (client: PoolClient, ids?: readonly string[]) =>
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
        `SELECT decision_id,value FROM ha_decisions WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND (cardinality($4::text[])=0 OR readers && $4::text[]) ${ids === undefined ? "" : "AND decision_id=ANY($5::text[])"} ORDER BY decision_id`,
        [...parameters, ...(ids === undefined ? [] : [ids])],
      )
    ).rows;
  const coverage = async (client: PoolClient, ids: readonly string[], basisRevision: number) => {
    const selected = await decisions(client, ids),
      edges: VersionedRelationProjectionRow[] = [],
      seen = new Set<string>();
    let frontier = selected.flatMap(({ decision_id, value }) => [
      `decision/${decision_id}`,
      ...value.claims.map(({ id }) => `decision/${decision_id}/${id}`),
    ]);
    // Each source is expanded once. The empty frontier, rather than a cursor, ends the closure.
    while (frontier.length) {
      const sources = [...new Set(frontier)].filter((ref) => !seen.has(ref));
      if (!sources.length) break;
      for (const ref of sources) seen.add(ref);
      const next = await readVersionedRelationsInTransaction(client, scope, readers, { sources });
      edges.push(...next);
      frontier = next
        .filter(relationIsCurrent)
        .map((edge) => edge.targetRef)
        .filter((ref) => ref.startsWith("decision/") && !seen.has(ref));
    }
    const factRefs = [...new Set(edges.map((edge) => edge.targetRef).filter((ref) => ref.startsWith("fact/")))],
      taskIds = [
        ...new Set(
          edges
            .map((edge) => edge.targetRef)
            .filter((ref) => ref.startsWith("task/"))
            .map((ref) => ref.slice(5)),
        ),
      ];
    if (factRefs.length)
      edges.push(
        ...(await readVersionedRelationsInTransaction(client, scope, readers, {
          targets: factRefs,
          relationType: "supersedes-fact",
        })),
      );
    edges.sort((a, b) => (a.relationId < b.relationId ? -1 : a.relationId > b.relationId ? 1 : 0));
    const facts = await client.query<{ ref: string }>(
        `SELECT value->>'ref' AS ref FROM ha_facts WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
        AND (cardinality($4::text[])=0 OR readers && $4::text[]) AND fact_id=ANY($5::text[]) ORDER BY fact_id`,
        [...parameters, factRefs.map((ref) => ref.slice(5))],
      ),
      tasks = await client.query<{ ref: string; status: string }>(
        `SELECT 'task/' || task_id AS ref,snapshot#>>'{task,status}' AS status FROM ha_task_snapshots
        WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND (cardinality($4::text[])=0 OR readers && $4::text[])
        AND task_id=ANY($5::text[]) ORDER BY task_id`,
        [...parameters, taskIds],
      );
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
      const row = (await source.readDecision(id, false)).decision;
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
          edges: await readVersionedRelationsInTransaction(client, scope, readers, { excludeFactOwned: true }),
          coverageRows: await coverage(
            client,
            rows.map(({ decision_id }) => decision_id),
            cut.watermark,
          ),
        };
      }),
    readDecisionIncomingRelations: (id) =>
      read((client) =>
        readVersionedRelationsInTransaction(client, scope, readers, {
          excludeFactOwned: true,
          targetRoot: `decision/${id}`,
        }),
      ),
    readFactAnchors: (refs) =>
      read(async (client) => ({
        ...(await readCutInTransaction(client, scope, readers, repoId)),
        rows: await anchors(client, refs),
      })),
    readFactGraph: () =>
      read(async (client) => {
        const source = await pgProjectionReadSource(client, scope, "relation-write");
        const result = await client.query<{ value: string }>(
          `SELECT value FROM ${source} AS ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
          AND model='relation-write' AND fact_edge AND (cardinality($4::text[])=0 OR readers && $4::text[])
          ORDER BY entity_id,owner_id`,
          parameters,
        );
        return {
          ...(await readCutInTransaction(client, scope, readers, repoId)),
          edges: result.rows.map(
            ({ value }) => JSON.parse(value) as VersionedRelationProjectionRow,
          ) as unknown as ReturnType<TaskProjectionQueries["readFactGraph"]>["edges"],
          factAnchors: await anchors(client),
          facts: (await readPgFactsInTransaction(client, options, {})).facts,
        };
      }),
  };
}
