import type { PoolClient } from "pg";
import { readPgRelationCycleAudit } from "./pg-relation-cycle-audit.ts";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import {
  readRelationsInTransaction,
  readEntityVersionWitnesses,
  readVersionedRelationsInTransaction,
  type PgRelationQuery,
} from "./pg-relation-queries.ts";
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
    readTaskRelationsByTargets: (refs, relationType, narrow = false) =>
      read(async (client) => {
        checkedRefs(refs, "relation target batch");
        // Aggregate readers take one indexed seek per endpoint: a batched ANY list lets the
        // planner scan every relation that targets an unrelated ref. Default callers keep the
        // batch shape.
        const rows = [];
        if (narrow)
          for (const ref of refs)
            rows.push(...(await readRelationsInTransaction(client, scope, readers, { target: ref, relationType })));
        else rows.push(...(await readRelationsInTransaction(client, scope, readers, { targets: refs, relationType })));
        return {
          ...(await readCutInTransaction(client, scope, readers, options.repoId)),
          rows,
        };
      }),
    readTaskRelationsBySources: (refs, relationType, narrow = false) =>
      read(async (client) => {
        checkedRefs(refs, "relation source batch");
        const rows = [];
        if (narrow)
          for (const ref of refs)
            rows.push(...(await readRelationsInTransaction(client, scope, readers, { source: ref, relationType })));
        else rows.push(...(await readRelationsInTransaction(client, scope, readers, { sources: refs, relationType })));
        return {
          ...(await readCutInTransaction(client, scope, readers, options.repoId)),
          rows,
        };
      }),
    readEntityVersionWitness: (ref) =>
      read(async (client) => (await readEntityVersionWitnesses(client, scope, readers, [ref])).get(ref)!),
    readRelationEdge: (id) =>
      read(
        async (client) =>
          (await readVersionedRelationsInTransaction(client, scope, readers, { relationId: id }))[0] ?? null,
      ),
    readRelationQuery: (query = {}) =>
      read(async (client) => {
        const paged = query.limit !== undefined || query.cursor !== undefined,
          limit = query.limit === undefined ? (paged ? 100 : null) : checkedPageLimit(query.limit),
          cursor = query.cursor === undefined ? undefined : decodePageCursor(query.cursor, 1)[0],
          filtered = await readRelationsInTransaction(client, scope, readers, {
            ...query,
            ...(cursor === undefined ? {} : { afterRelationId: cursor }),
            ...(limit === null ? { limit: undefined } : { limit: limit + 1 }),
          }),
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
      read(async (client) => ({
        ...(await readCutInTransaction(client, scope, readers, options.repoId)),
        ...(await readPgRelationCycleAudit(client, scope)),
      })),
  };
}

function checkedRefs(refs: readonly string[], label: string): void {
  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string" || ref.length === 0))
    throw new Error(`${label} requires non-empty string refs`);
}
