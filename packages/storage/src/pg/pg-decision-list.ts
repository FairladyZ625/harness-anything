import { DEFAULT_DECISION_LIST_PAGE_SIZE } from "@harness-anything/kernel/internal/ports/decision-projection-model.ts";
import type { PoolClient } from "pg";
import type { DecisionProjectionListRead } from "@harness-anything/kernel/internal/ports/projection-reads.ts";
import type {
  DecisionListFilters,
  DecisionListSummaryRow,
  DecisionProjectionRow,
} from "@harness-anything/kernel/internal/ports/decision-projection-model.ts";
import { decisionIdSortKey, decisionLegacyId, decisionLegacyNumber } from "../projection/decision-projection-reads.ts";
import { decodePageCursor, encodePageCursor } from "../projection/task-query-projection.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import { checkedPageLimit } from "./pg-query-page.ts";
import { assertPgDecisionIndexReady } from "./pg-decision-index-migration.ts";
import { PgDecisionBackfillPendingError } from "./pg-decision-read-status.ts";
import { readPgDecisionRows, type PgDecisionReviewSummary } from "./pg-decision-reads.ts";
import { searchPgDecisionIds } from "./pg-decision-search.ts";

/** Stored order is shared with SQLite, including historical E-number blocks and case weights. */
export async function listPgDecisionRows(
  client: PoolClient,
  scope: PgProjectionScope,
  repoId: string,
  filters: DecisionListFilters,
  selection: "summary",
): Promise<DecisionPage<DecisionListSummaryRow>>;
export async function listPgDecisionRows(
  client: PoolClient,
  scope: PgProjectionScope,
  repoId: string,
  filters: DecisionListFilters,
  selection?: "review",
): Promise<DecisionPage<DecisionProjectionRow>>;
export async function listPgDecisionRows(
  client: PoolClient,
  scope: PgProjectionScope,
  repoId: string,
  filters: DecisionListFilters,
  selection?: "summary" | "review",
): Promise<DecisionPage<DecisionListSummaryRow>> {
  const summary = selection === "summary",
    readers = [...(scope.readers ?? [])],
    values: unknown[] = [scope.tenantId, scope.projectId, scope.policyEpoch, readers],
    scopeSql = "tenant_id=$1 AND project_id=$2 AND policy_epoch=$3",
    where = [scopeSql, "(cardinality($4::text[])=0 OR readers && $4::text[])"];
  if (!summary) await assertPgDecisionIndexReady(client, scope);
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  if (filters.state) where.push(`decision_state=${bind(filters.state)}`);
  // Older rows may still use the prior full-row filter during the additive backfill.
  // Summary readers require the new cut before returning any result.
  const filterValue = summary ? "COALESCE(list_summary,value)" : "value";
  if (filters.module) where.push(`${filterValue}->'appliesTo'->'modules' ? ${bind(filters.module)}`);
  // Generated, normalized prefix set (pg-trace-index.ts); overlap is not leakproof, so under forced
  // RLS it filters the decision_state index range rather than probing the GIN.
  if (filters.modulePrefixes !== undefined)
    where.push(`applies_modules && ${bind([...filters.modulePrefixes])}::text[]`);
  if (filters.productLine) where.push(`${filterValue}->'appliesTo'->'productLines' ? ${bind(filters.productLine)}`);
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
    limit =
      filters.limit === undefined ? (paged ? DEFAULT_DECISION_LIST_PAGE_SIZE : null) : checkedPageLimit(filters.limit),
    limitSql = limit === null ? "" : ` LIMIT ${bind(limit + 1)}`,
    order = 'ORDER BY legacy_group,legacy_number,decision_sort_key,decision_id COLLATE "C"',
    projection = summary
      ? "list_summary AS value,legacy_group,legacy_number,decision_sort_key"
      : selection === "review"
        ? "value,review_summary"
        : "value",
    pageSql = `SELECT decision_id,workspace_revision,${projection}
      FROM ha_decisions WHERE ${where.join(" AND ")} ${order}${limitSql}`,
    result = await client.query<{
      decision_id: string | null;
      workspace_revision: string;
      value: Record<string, unknown>;
      review_summary?: PgDecisionReviewSummary | null;
      ready?: boolean;
    }>(
      summary
        ? `SELECT page.decision_id,page.workspace_revision,page.value,status.ready
          FROM (SELECT COALESCE(
            (SELECT scalar_pending IS NOT DISTINCT FROM 0 FROM ha_decision_read_status WHERE ${scopeSql}),
            NOT EXISTS(SELECT 1 FROM ha_decisions WHERE ${scopeSql} LIMIT 1)) AS ready) status
          LEFT JOIN LATERAL (${pageSql}) page ON status.ready ${order}`
        : pageSql,
      values,
    );
  if (summary && result.rows[0]?.ready !== true) throw new PgDecisionBackfillPendingError("scalar");
  const rows = result.rows.filter((row): row is typeof row & { decision_id: string } => row.decision_id !== null),
    selected = limit === null ? rows : rows.slice(0, limit),
    decisions: readonly DecisionListSummaryRow[] = summary
      ? selected.map(({ decision_id: id, workspace_revision: revision, value }) => {
          if (!value) throw new PgDecisionBackfillPendingError("summary");
          const { appliesTo: _appliesTo, ...summary } = value,
            legacyId = decisionLegacyId(id);
          return {
            ...(summary as Omit<DecisionListSummaryRow, "decisionId" | "path" | "workspaceRevision">),
            decisionId: id,
            ...(legacyId ? { legacyId } : {}),
            path: `decisions/decision-${id}/decision.md`,
            workspaceRevision: Number(revision),
          };
        })
      : await readPgDecisionRows(client, scope, repoId, selected, selection !== "review" && filters.withBody === true);
  const last = decisions.at(-1);
  return {
    decisions,
    ...(limit === null
      ? {}
      : {
          page: {
            limit,
            cursor: filters.cursor ?? null,
            nextCursor: rows.length > limit && last ? encodePageCursor([last.decisionId]) : null,
          },
        }),
  };
}

type DecisionPage<Row> = Pick<DecisionProjectionListRead<Row>, "decisions" | "page">;
