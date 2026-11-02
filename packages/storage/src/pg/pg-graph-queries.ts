import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import { readCutInTransaction } from "./pg-event-queries.ts";
import { readRelationsInTransaction } from "./pg-relation-queries.ts";
import type { PgTaskProjectionSourceOptions } from "./pg-task-source.ts";
import type { AsyncQueries } from "./pg-runtime-dispatch-queries.ts";

export type PgGraphQueries = AsyncQueries<"readTaskRelationNeighborhood" | "readTaskDependencyClosure">;
export function pgGraphQueries(options: PgTaskProjectionSourceOptions): PgGraphQueries {
  const { scope, repoId } = options,
    readers = [...(scope.readers ?? [])],
    parameters = [scope.tenantId, scope.projectId, scope.policyEpoch, readers];
  const read = <Result>(operation: (client: PoolClient) => Promise<Result>) =>
    withPostgresTransaction(options.pool, operation, scope, { isolationLevel: "repeatable read" });
  const visible = `SELECT * FROM ha_relations WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND (cardinality($4::text[])=0 OR readers && $4::text[])`;
  return {
    readTaskRelationNeighborhood: (query) =>
      read(async (client) => {
        checkedRefs([query.seed], "relation neighborhood seed");
        if (query.relationTypes.length === 0) throw new Error("relation neighborhood types requires at least one ref");
        checkedRefs(query.relationTypes, "relation neighborhood types");
        if (!Number.isSafeInteger(query.maxDepth) || query.maxDepth < 1 || query.maxDepth > 4096)
          throw new Error("relation neighborhood depth limit must be an integer between 1 and 4096");
        if (!Number.isSafeInteger(query.maxNodes) || query.maxNodes < 1 || query.maxNodes > 10_000)
          throw new Error("relation neighborhood node budget must be an integer between 1 and 10000");
        const outgoing = query.direction === "outgoing" || query.direction === "both",
          incoming = query.direction === "incoming" || query.direction === "both";
        if (!outgoing && !incoming) throw new Error("relation neighborhood direction is invalid");
        const edge = [outgoing ? "edge.source_ref=walk.ref" : "", incoming ? "edge.target_ref=walk.ref" : ""]
            .filter(Boolean)
            .join(" OR "),
          next =
            outgoing && incoming
              ? "CASE WHEN edge.source_ref=walk.ref THEN edge.target_ref ELSE edge.source_ref END"
              : outgoing
                ? "edge.target_ref"
                : "edge.source_ref",
          result = await client.query<{ ids: string[] | null; node_count: string; truncated: boolean }>(
            `WITH RECURSIVE visible AS (${visible} AND relation_type=ANY($6::text[]) AND ($7::text IS NULL OR relation_state=$7)),
           walk(ref,depth,visited,relation_id) AS (
             SELECT $5::text,0,ARRAY[$5::text],NULL::text UNION ALL
             SELECT ${next},walk.depth+1,walk.visited || (${next}),edge.relation_id
             FROM walk JOIN visible edge ON (${edge}) WHERE walk.depth<$8 AND NOT (${next})=ANY(walk.visited)
           ) SELECT array_agg(DISTINCT relation_id) FILTER (WHERE relation_id IS NOT NULL) AS ids,
             count(DISTINCT ref)::text AS node_count,
             EXISTS(SELECT 1 FROM walk JOIN visible edge ON (${edge}) WHERE walk.depth=$8 AND NOT (${next})=ANY(walk.visited)) AS truncated FROM walk`,
            [...parameters, query.seed, query.relationTypes, query.state ?? null, query.maxDepth],
          ),
          row = result.rows[0]!;
        if (Number(row.node_count) > query.maxNodes)
          throw new Error(`relation neighborhood node budget ${query.maxNodes} exceeded`);
        if (row.truncated && query.allowTruncation !== true)
          throw new Error(`relation neighborhood depth limit ${query.maxDepth} exceeded`);
        return {
          ...(await readCutInTransaction(client, scope, readers, repoId)),
          truncated: row.truncated,
          rows: (await readRelationsInTransaction(client, scope, readers, { relationIds: row.ids ?? [] })).map(
            (row) => ({ ...row, workspaceRevision: null }),
          ),
        };
      }),
    readTaskDependencyClosure: (refs, maxDepth = 256) =>
      read(async (client) => {
        checkedRefs(refs, "dependency closure");
        if (refs.length === 0) return { ...(await readCutInTransaction(client, scope, readers, repoId)), rows: [] };
        if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 4096)
          throw new Error("dependency closure depth limit must be an integer between 1 and 4096");
        const result = await client.query<{ ids: string[]; overflow: boolean }>(
          `WITH RECURSIVE visible AS (${visible} AND relation_type='depends-on'),
         walk(seed_order,ref,depth,visited) AS (
           SELECT ordinal::int,ref,0,ARRAY[ref] FROM unnest($5::text[]) WITH ORDINALITY AS seed(ref,ordinal) UNION ALL
           SELECT walk.seed_order,edge.target_ref,walk.depth+1,walk.visited || edge.target_ref FROM walk JOIN visible edge ON edge.source_ref=walk.ref
           WHERE walk.depth<$6 AND NOT edge.target_ref=ANY(walk.visited)
         ), found AS (SELECT edge.relation_id,walk.depth,walk.seed_order,array_to_string(walk.visited,chr(31)) AS visited_path
           FROM walk JOIN visible edge ON edge.source_ref=walk.ref)
         SELECT ARRAY(SELECT relation_id FROM found ORDER BY depth,seed_order,visited_path,relation_id) AS ids,
           EXISTS(SELECT 1 FROM walk JOIN visible edge ON edge.source_ref=walk.ref WHERE walk.depth=$6 AND NOT edge.target_ref=ANY(walk.visited)) AS overflow`,
          [...parameters, refs, maxDepth],
        );
        if (result.rows[0]!.overflow) throw new Error(`dependency closure depth limit ${maxDepth} exceeded`);
        const ids = [...new Set(result.rows[0]!.ids)],
          rows = await readRelationsInTransaction(client, scope, readers, { relationIds: ids }),
          byId = new Map(rows.map((row) => [row.relationId, row]));
        return {
          ...(await readCutInTransaction(client, scope, readers, repoId)),
          rows: ids.map((id) => ({ ...byId.get(id)!, workspaceRevision: null })),
        };
      }),
  };
}
function checkedRefs(refs: readonly string[], label: string): void {
  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string" || ref.length === 0))
    throw new Error(`${label} requires non-empty string refs`);
}
