import type { PoolClient } from "pg";
import type {
  DecisionListFilters,
  DecisionProjectionRow,
} from "@harness-anything/kernel/internal/ports/decision-projection-model.ts";
import { decisionIdSortKey, decisionLegacyId, decisionLegacyNumber } from "../projection/decision-projection-reads.ts";
import { decodePageCursor, encodePageCursor } from "../projection/task-query-projection.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import { checkedPageLimit } from "./pg-query-page.ts";
import { assertPgDecisionIndexReady } from "./pg-decision-index-migration.ts";
import { readPgDecisionRows } from "./pg-decision-reads.ts";
import { searchPgDecisionIds } from "./pg-decision-search.ts";

/** Stored order is shared with SQLite, including historical E-number blocks and case weights. */
export async function listPgDecisionRows(
  client: PoolClient,
  scope: PgProjectionScope,
  repoId: string,
  filters: DecisionListFilters,
) {
  const readers = [...(scope.readers ?? [])],
    values: unknown[] = [scope.tenantId, scope.projectId, scope.policyEpoch, readers],
    where = [
      "tenant_id=$1",
      "project_id=$2",
      "policy_epoch=$3",
      "(cardinality($4::text[])=0 OR readers && $4::text[])",
    ];
  await assertPgDecisionIndexReady(client, scope);
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  if (filters.state) where.push(`decision_state=${bind(filters.state)}`);
  if (filters.module) where.push(`value->'appliesTo'->'modules' ? ${bind(filters.module)}`);
  if (filters.productLine) where.push(`value->'appliesTo'->'productLines' ? ${bind(filters.productLine)}`);
  if (filters.legacyId) {
    const match = /^E([1-9][0-9]*)$/u.exec(filters.legacyId);
    where.push(
      match && decisionLegacyId(`dec_${filters.legacyId}`) === filters.legacyId
        ? `legacy_group=0 AND legacy_number=${bind(Number(match[1]))}`
        : "false",
    );
  }
  if (filters.legacyRange)
    where.push(
      `legacy_group=0 AND legacy_number BETWEEN ${bind(filters.legacyRange.start)} AND ${bind(filters.legacyRange.end)}`,
    );
  if (filters.cursor !== undefined) {
    const id = decodePageCursor(filters.cursor, 1)[0]!,
      legacy = decisionLegacyNumber(id);
    where.push(
      `(legacy_group,legacy_number,decision_sort_key,decision_id COLLATE "C") > (${bind(legacy === null ? 1 : 0)},${bind(legacy ?? 0)},${bind(decisionIdSortKey(id))},${bind(id)})`,
    );
  }
  const search = filters.search?.trim();
  if (search) where.push(`decision_id=ANY(${bind(await searchPgDecisionIds(client, scope, search, repoId))}::text[])`);
  const paged = filters.limit !== undefined || filters.cursor !== undefined,
    limit = filters.limit === undefined ? (paged ? 100 : null) : checkedPageLimit(filters.limit),
    limitSql = limit === null ? "" : ` LIMIT ${bind(limit + 1)}`,
    result = await client.query<{ decision_id: string; value: Record<string, unknown> }>(
      `SELECT decision_id,value FROM ha_decisions WHERE ${where.join(" AND ")}
       ORDER BY legacy_group,legacy_number,decision_sort_key,decision_id COLLATE "C"${limitSql}`,
      values,
    ),
    selected = limit === null ? result.rows : result.rows.slice(0, limit),
    decisions: readonly DecisionProjectionRow[] = await readPgDecisionRows(
      client,
      scope,
      repoId,
      selected,
      filters.withBody === true,
    );
  const last = decisions.at(-1);
  return {
    decisions,
    ...(limit === null
      ? {}
      : {
          page: {
            limit,
            cursor: filters.cursor ?? null,
            nextCursor: result.rows.length > limit && last ? encodePageCursor([last.decisionId]) : null,
          },
        }),
  };
}
