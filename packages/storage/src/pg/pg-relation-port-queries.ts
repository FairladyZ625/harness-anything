import type { PoolClient } from "pg";
import type { VersionedRelationProjectionRow } from "@harness-anything/kernel/internal/ports/projection-contracts.ts";
import type { RelationEntity } from "@harness-anything/kernel/internal/domain/relation-event.ts";
import { findRelationCycleWitnesses } from "@harness-anything/kernel/internal/domain/relation-cycle.ts";
import { relationProjectionRowFromWitnesses } from "../projection/relation-entity-projection.ts";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import { readRelationsInTransaction, readEntityVersionWitnesses, type PgRelationQuery } from "./pg-relation-queries.ts";
import { readCutInTransaction } from "./pg-event-queries.ts";
import { checkedPageLimit } from "./pg-query-page.ts";
import type { PgTaskProjectionSourceOptions } from "./pg-task-source.ts";
import type { AsyncQueries } from "./pg-runtime-dispatch-queries.ts";
import { decodePageCursor, encodePageCursor } from "../projection/task-query-projection.ts";

export type PgRelationPortQueries = AsyncQueries<
  | "readTaskRelations"
  | "readTaskRelationsByTargets"
  | "readTaskRelationsBySources"
  | "readEntityVersionWitness"
  | "readRelationEdge"
  | "readRelationQuery"
  | "readRelationCycleAudit"
>;
export function pgRelationPortQueries(options: PgTaskProjectionSourceOptions): PgRelationPortQueries {
  const { scope } = options,
    readers = [...(scope.readers ?? [])];
  const read = <Result>(operation: (client: PoolClient) => Promise<Result>) =>
    withPostgresTransaction(options.pool, operation, scope, { isolationLevel: "repeatable read" });
  const relationRead = (query: PgRelationQuery) =>
    read(async (client) => ({
      ...(await readCutInTransaction(client, scope, readers, options.repoId)),
      rows: await readRelationsInTransaction(client, scope, readers, query),
    }));
  return {
    readTaskRelations: () => relationRead({ taskOwned: true }),
    readTaskRelationsByTargets: (refs, relationType) =>
      read(async (client) => {
        checkedRefs(refs, "relation target batch");
        const rows = await readRelationsInTransaction(client, scope, readers, { targets: refs, relationType });
        return {
          ...(await readCutInTransaction(client, scope, readers, options.repoId)),
          rows: refs.flatMap((ref) => rows.filter(({ targetRef }) => targetRef === ref)),
        };
      }),
    readTaskRelationsBySources: (refs, relationType) =>
      read(async (client) => {
        checkedRefs(refs, "relation source batch");
        const rows = await readRelationsInTransaction(client, scope, readers, { sources: refs, relationType });
        return {
          ...(await readCutInTransaction(client, scope, readers, options.repoId)),
          rows: refs.flatMap((ref) => rows.filter(({ sourceRef }) => sourceRef === ref)),
        };
      }),
    readEntityVersionWitness: (ref) =>
      read(async (client) => (await readEntityVersionWitnesses(client, scope, readers, [ref])).get(ref)!),
    readRelationEdge: (id) =>
      read(async (client) => {
        const result = await client.query<{
          value: RelationEntity & { sourcePath: string; recordIndex: number; sourceObservedVersion?: number };
        }>(
          `SELECT value FROM ha_relations WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND relation_id=$4
         AND (cardinality($5::text[])=0 OR readers && $5::text[])`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, id, readers],
        );
        if (!result.rows[0]) return null;
        const {
            sourcePath,
            recordIndex: _recordIndex,
            sourceObservedVersion: _sourceObservedVersion,
            ...entity
          } = result.rows[0].value,
          witnesses = await readEntityVersionWitnesses(client, scope, readers, [entity.source, entity.target]);
        return relationProjectionRowFromWitnesses(
          entity,
          sourcePath,
          witnesses.get(entity.target)!,
          witnesses.get(entity.source)!,
        ) satisfies VersionedRelationProjectionRow;
      }),
    readRelationQuery: (query = {}) =>
      read(async (client) => {
        const paged = query.limit !== undefined || query.cursor !== undefined,
          limit = query.limit === undefined ? (paged ? 100 : null) : checkedPageLimit(query.limit),
          cursor = query.cursor === undefined ? undefined : decodePageCursor(query.cursor, 1)[0],
          selected = await readRelationsInTransaction(client, scope, readers, {
            ...query,
            ...(cursor === undefined ? {} : { afterRelationId: cursor }),
            ...(limit === null || query.freshness !== undefined ? { limit: undefined } : { limit: limit + 1 }),
          }),
          filtered =
            query.freshness === undefined
              ? selected
              : selected.filter(({ freshness }) => freshness === query.freshness),
          rows = limit === null ? filtered : filtered.slice(0, limit),
          last = rows.at(-1);
        return {
          ...(await readCutInTransaction(client, scope, readers, options.repoId)),
          rows,
          ...(limit === null
            ? {}
            : {
                page: {
                  limit,
                  cursor: query.cursor ?? null,
                  nextCursor: filtered.length > limit && last ? encodePageCursor([last.relationId]) : null,
                },
              }),
        };
      }),
    readRelationCycleAudit: () =>
      read(async (client) => {
        const rows = await readRelationsInTransaction(client, scope, readers, {});
        return {
          ...(await readCutInTransaction(client, scope, readers, options.repoId)),
          scannedEdges: rows.length,
          issues: findRelationCycleWitnesses(rows).map((witness) => ({
            code: "relation_cycle_detected" as const,
            ...witness,
          })),
        };
      }),
  };
}

function checkedRefs(refs: readonly string[], label: string): void {
  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string" || ref.length === 0))
    throw new Error(`${label} requires non-empty string refs`);
}
