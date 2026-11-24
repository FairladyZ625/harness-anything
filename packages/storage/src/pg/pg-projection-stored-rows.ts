import type { PoolClient } from "pg";
import { getClientDialectCapabilities, type PgDialectCapabilities } from "../postgres/dialect.ts";
import { canonicalJson } from "../projection/canonical-json.ts";

/** A dictionary slot is an allocation address. Digests and replay audits compare the
 * exact word it addresses, preserving every posting column and exposing dangling slots.
 * Unreferenced dictionary addresses have no search meaning and are excluded, like free index pages.
 */
export function pgProjectionStoredRows(table: string): { readonly from: string; readonly row: string } {
  if (table === "ha_decision_read_status")
    return { from: `${table} projection`, row: "to_jsonb(projection)-'generation'" };
  if (table === "ha_search_terms")
    return {
      from: `(SELECT DISTINCT word.tenant_id,word.project_id,word.policy_epoch,word.readers,word.term_key,word.term
        FROM ha_search_terms word WHERE EXISTS (SELECT 1 FROM ha_decision_positions position
          WHERE (position.tenant_id,position.project_id,position.policy_epoch,position.term_slot,position.term_key)
            =(word.tenant_id,word.project_id,word.policy_epoch,word.term_slot,word.term_key))) projection`,
      row: "to_jsonb(projection)",
    };
  if (table === "ha_decision_positions")
    return {
      from: `ha_decision_positions projection LEFT JOIN ha_search_terms dictionary
      ON (dictionary.tenant_id,dictionary.project_id,dictionary.policy_epoch,dictionary.term_slot)
        =(projection.tenant_id,projection.project_id,projection.policy_epoch,projection.term_slot)`,
      row: "(to_jsonb(projection)-'term_slot')||jsonb_build_object('term',dictionary.term)",
    };
  return { from: `${table} projection`, row: "to_jsonb(projection)" };
}

function normalizeStoredRow(
  table: string,
  raw: Record<string, unknown>,
  excludeColumns: readonly string[],
  resolvedTerm?: string | null,
): Record<string, unknown> {
  const excluded = new Set(excludeColumns),
    next: Record<string, unknown> = {};
  if (table === "ha_decision_read_status") excluded.add("generation");
  if (table === "ha_decision_positions") excluded.add("term_slot");
  for (const [key, value] of Object.entries(raw)) {
    if (!excluded.has(key)) next[key] = value;
  }
  if (table === "ha_decision_positions") next.term = resolvedTerm ?? null;
  return next;
}

/**
 * Read complete stored projection rows in a dialect-compatible JSON representation.
 * Standard PostgreSQL uses native `to_jsonb` / JSONB subtraction; dialects lacking those operators
 * (such as openGauss 5.0+) use `row_to_json` and apply the same column stripping deterministically.
 */
export async function readPgProjectionStoredRows(
  client: PoolClient,
  table: string,
  scope: { readonly tenantId: string; readonly projectId: string; readonly policyEpoch: number },
  options: {
    readonly excludeColumns: readonly string[];
    readonly readers?: readonly string[];
    readonly orderBy?: "declaration_head_or_row";
    readonly capabilities?: PgDialectCapabilities;
  },
): Promise<Record<string, unknown>[]> {
  const capabilities = options.capabilities ?? getClientDialectCapabilities(client),
    stored = pgProjectionStoredRows(table),
    hasReaders = options.readers !== undefined,
    params: unknown[] = hasReaders
      ? [scope.tenantId, scope.projectId, scope.policyEpoch, options.readers]
      : [scope.tenantId, scope.projectId, scope.policyEpoch],
    whereSql = hasReaders
      ? "projection.tenant_id=$1 AND projection.project_id=$2 AND projection.policy_epoch=$3 AND (cardinality($4::text[])=0 OR projection.readers && $4::text[])"
      : "projection.tenant_id=$1 AND projection.project_id=$2 AND projection.policy_epoch=$3";

  if (capabilities.supportsExtendedJsonb) {
    const subtractSql =
        options.excludeColumns.length === 0
          ? stored.row
          : !hasReaders
            ? `(${stored.row})-${options.excludeColumns.map((col) => `'${col}'`).join("-")}`
            : `(${stored.row}) - ARRAY[${options.excludeColumns.map((col) => `'${col}'`).join(",")}]`,
      orderSql =
        options.orderBy === "declaration_head_or_row"
          ? ` ORDER BY ${table === "ha_entity_declaration_heads" ? "entity_kind,entity_id" : `(${subtractSql})::text`}`
          : "";
    const result = await client.query<{ row_value: Record<string, unknown> }>(
      `SELECT ${subtractSql} AS row_value FROM ${stored.from} WHERE ${whereSql}${orderSql}`,
      params,
    );
    return result.rows.map((row) => row.row_value);
  }

  const extraSelect = table === "ha_decision_positions" ? ", dictionary.term AS resolved_term" : "",
    orderSql =
      options.orderBy === "declaration_head_or_row" && table === "ha_entity_declaration_heads"
        ? " ORDER BY projection.entity_kind, projection.entity_id"
        : "";
  const result = await client.query<{ row_value: Record<string, unknown>; resolved_term?: string | null }>(
    `SELECT row_to_json(projection) AS row_value${extraSelect} FROM ${stored.from} WHERE ${whereSql}${orderSql}`,
    params,
  );
  const normalized = result.rows.map((row) =>
    normalizeStoredRow(table, row.row_value, options.excludeColumns, row.resolved_term),
  );
  if (options.orderBy === "declaration_head_or_row" && table !== "ha_entity_declaration_heads") {
    normalized.sort((left, right) => {
      const a = canonicalJson(left),
        b = canonicalJson(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }
  return normalized;
}
