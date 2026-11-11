import type { PoolClient } from "pg";
import type { FactProjectionSearchRead, FactProjectionRow } from "@harness-anything/kernel";
import type { FactSearchFilters } from "@harness-anything/kernel/internal/ports/projection-contracts.ts";
import { factInvalidated, factLiveness } from "@harness-anything/kernel/internal/domain/fact-liveness.ts";
import { readCutInTransaction } from "./pg-event-queries.ts";
import { checkedPageLimit } from "./pg-query-page.ts";
import { filterLiteralTextRows } from "./pg-text-search.ts";
import type { PgTaskProjectionSourceOptions } from "./pg-task-source.ts";

/** The search and graph ports share one physical query, on the caller's committed snapshot. */
export async function readPgFactsInTransaction(
  client: PoolClient,
  options: PgTaskProjectionSourceOptions,
  filters: FactSearchFilters,
): Promise<FactProjectionSearchRead> {
  const claims = options.scope,
    readers = [...(claims.readers ?? [])],
    repoId = options.repoId;
  const cut = await readCutInTransaction(client, claims, readers, repoId),
    values: unknown[] = [claims.tenantId, claims.projectId, claims.policyEpoch, readers],
    where = [
      "tenant_id = $1",
      "project_id = $2",
      "policy_epoch = $3",
      "(cardinality($4::text[]) = 0 OR readers && $4::text[])",
    ];
  for (const [field, value] of [
    ["value->>'taskId'", filters.taskId],
    ["value->>'confidence'", filters.confidence],
    ["memory_class", filters.memoryClass],
  ] as const)
    if (value !== undefined) {
      values.push(value);
      where.push(`${field} = $${values.length}`);
    }
  if (filters.refs !== undefined) {
    values.push(filters.refs);
    where.push(`value->>'ref' = ANY($${values.length}::text[])`);
  }
  if (filters.domainType !== undefined) {
    values.push(filters.domainType);
    where.push(`value->'domainTypes' ? $${values.length}`);
  }
  if (filters.observedAfter !== undefined) {
    values.push(filters.observedAfter);
    where.push(`(value->>'observedAt')::timestamptz >= $${values.length}::timestamptz`);
  }
  if (filters.observedBefore !== undefined) {
    values.push(filters.observedBefore);
    where.push(`(value->>'observedAt')::timestamptz <= $${values.length}::timestamptz`);
  }
  if (filters.cursor !== undefined) {
    const cursor = decodeFactCursor(filters.cursor);
    values.push(cursor[0], cursor[0], cursor[1]);
    where.push(
      `((value->>'observedAt') < $${values.length - 2} OR ((value->>'observedAt') = $${values.length - 1} AND fact_id > $${values.length}))`,
    );
  }
  const paged = filters.limit !== undefined || filters.cursor !== undefined,
    limit = filters.limit === undefined ? (paged ? 100 : null) : checkedPageLimit(filters.limit, 500),
    search = filters.query?.trim(),
    sqlLimit = search ? null : limit;
  if (sqlLimit !== null) values.push(sqlLimit + 1);
  const result = await client.query<{ value: FactProjectionRow }>(
    `SELECT value FROM ha_facts WHERE ${where.join(" AND ")} ORDER BY (value->>'observedAt') DESC, fact_id${sqlLimit === null ? "" : ` LIMIT $${values.length}`}`,
    values,
  );
  const matched = search
      ? filterLiteralTextRows(result.rows, search, ({ value }) => [value.statement, value.evidenceSource])
      : result.rows,
    selected = limit === null ? matched : matched.slice(0, limit),
    facts = await projectPgFactLiveness(
      client,
      options,
      selected.map(({ value }) => value),
    );
  const last = facts.at(-1);
  return {
    status: cut.status,
    facts,
    watermark: cut.watermark,
    sourceRevision: cut.sourceRevision,
    ...(limit === null
      ? {}
      : {
          page: {
            limit,
            cursor: filters.cursor ?? null,
            nextCursor: matched.length > limit && last ? encodeFactCursor([last.observedAt, last.factId]) : null,
          },
        }),
  };
}

/** The list, search and graph readers share the same Fact-liveness hydration at their transaction cut. */
export async function projectPgFactLiveness(
  client: PoolClient,
  options: PgTaskProjectionSourceOptions,
  rows: readonly FactProjectionRow[],
): Promise<readonly FactProjectionRow[]> {
  if (rows.length === 0) return [];
  const claims = options.scope,
    readers = [...(claims.readers ?? [])],
    relationResult = await client.query<{ target_ref: string; relation_state: string }>(
      `SELECT target_ref, relation_state FROM ha_relations WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND relation_type='supersedes-fact' AND target_ref = ANY($4::text[]) AND (cardinality($5::text[])=0 OR readers && $5::text[])`,
      [claims.tenantId, claims.projectId, claims.policyEpoch, rows.map((row) => row.ref), readers],
    );
  const liveness = relationResult.rows.map((row) => ({
    targetRef: row.target_ref,
    relationType: "supersedes-fact",
    state: row.relation_state,
  }));
  return rows.map((fact) => {
    const state = factLiveness(fact, liveness);
    return { ...fact, state, invalidated: factInvalidated(state), archived: fact.archived === true };
  });
}

function encodeFactCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

function decodeFactCursor(value: string): readonly [string, string] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("fact query cursor is invalid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    parsed.some((part) => typeof part !== "string" || part.length === 0)
  )
    throw new Error("fact query cursor is invalid");
  return [parsed[0] as string, parsed[1] as string];
}
