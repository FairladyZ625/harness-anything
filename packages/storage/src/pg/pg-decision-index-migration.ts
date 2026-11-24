import { assertPgDecisionReadReady } from "./pg-decision-read-status.ts";
import type { PoolClient } from "pg";
import {
  STANDARD_POSTGRES_DIALECT_CAPABILITIES,
  dialectAddColumnIfNotExistsSql,
  dialectCreateTriggerStatements,
  type PgDialectCapabilities,
} from "../postgres/dialect.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import { decisionIdSortKey } from "../projection/iso-timestamp-sql.ts";

/** Additive v5 expansion. Keep the previous-writer trigger through 2026-11-19.
 * Current writers also use it; the bounded backfill is removable after that window.
 */
export function decisionIndexDdl(
  capabilities: PgDialectCapabilities = STANDARD_POSTGRES_DIALECT_CAPABILITIES,
): readonly string[] {
  const alphabet = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz",
    primary = [...alphabet].map((c) => decisionIdSortKey(c).split(" ")[0]).join(""),
    secondary = [...alphabet].map((c) => decisionIdSortKey(c).split(" ")[1]).join("");
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`,
    addCol = (col: string, def: string) => dialectAddColumnIfNotExistsSql(capabilities, "ha_decisions", col, def),
    listSummarySql = capabilities.supportsExtendedJsonb
      ? `SELECT jsonb_build_object(
          'title',value->'title','question',value->'question','state',value->'state',
          'riskTier',value->'riskTier','urgency',value->'urgency','proposedAt',value->'proposedAt',
          'appliesTo',value->'appliesTo','chosen',value->'chosen','rejected',value->'rejected')`
      : `SELECT (
          '{' ||
          '"title":' || COALESCE((value->'title')::text, 'null') ||
          ',"question":' || COALESCE((value->'question')::text, 'null') ||
          ',"state":' || COALESCE((value->'state')::text, 'null') ||
          ',"riskTier":' || COALESCE((value->'riskTier')::text, 'null') ||
          ',"urgency":' || COALESCE((value->'urgency')::text, 'null') ||
          ',"proposedAt":' || COALESCE((value->'proposedAt')::text, 'null') ||
          ',"appliesTo":' || COALESCE((value->'appliesTo')::text, 'null') ||
          ',"chosen":' || COALESCE((value->'chosen')::text, 'null') ||
          ',"rejected":' || COALESCE((value->'rejected')::text, 'null') ||
          '}'
        )::jsonb`;
  return [
    addCol("decision_state", "text"),
    addCol("legacy_group", "smallint"),
    addCol("legacy_number", "double precision"),
    addCol("decision_sort_key", 'text COLLATE "C"'),
    addCol("list_summary", "jsonb"),
    addCol("review_summary", "jsonb"),
    `CREATE OR REPLACE FUNCTION ha_decision_list_summary(value jsonb) RETURNS jsonb
      LANGUAGE sql IMMUTABLE AS $function$
        ${listSummarySql}
      $function$`,
    `CREATE OR REPLACE FUNCTION ha_decision_index_fields() RETURNS trigger
      LANGUAGE plpgsql AS $function$
      DECLARE legacy text;
      BEGIN
        legacy := substring(NEW.decision_id from '(?:^|_)E([1-9][0-9]*)(?:_|$)');
        NEW.legacy_group := CASE WHEN legacy IS NULL THEN 1 ELSE 0 END;
        NEW.legacy_number := COALESCE(legacy::double precision,0);
        NEW.decision_state := NEW.value->>'state';
        NEW.decision_sort_key := translate(NEW.decision_id,${literal(alphabet)},${literal(primary)})
          || ' ' || translate(NEW.decision_id,${literal(alphabet)},${literal(secondary)});
        RETURN NEW;
      END $function$`,
    ...dialectCreateTriggerStatements(capabilities, {
      triggerName: "ha_decision_index_fields",
      tableName: "ha_decisions",
      timingAndEvent: "BEFORE INSERT OR UPDATE OF value,decision_id",
      functionCall: "ha_decision_index_fields()",
    }),
    `CREATE OR REPLACE FUNCTION ha_decision_list_fields_v1() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      BEGIN
        NEW.list_summary := ha_decision_list_summary(NEW.value);
        NEW.review_summary := NULL;
        RETURN NEW;
      END $function$`,
    ...dialectCreateTriggerStatements(capabilities, {
      triggerName: "ha_decision_list_fields_v1",
      tableName: "ha_decisions",
      timingAndEvent: "BEFORE INSERT OR UPDATE OF value",
      functionCall: "ha_decision_list_fields_v1()",
    }),
    `CREATE INDEX IF NOT EXISTS ha_decisions_page ON ha_decisions
      (tenant_id,project_id,policy_epoch,legacy_group,legacy_number,decision_sort_key,decision_id COLLATE "C")`,
    `CREATE INDEX IF NOT EXISTS ha_decisions_state_order ON ha_decisions
      (tenant_id,project_id,policy_epoch,decision_state,legacy_group,legacy_number,decision_sort_key,decision_id COLLATE "C")`,
    `CREATE INDEX IF NOT EXISTS ha_decisions_state_id ON ha_decisions
      (tenant_id,project_id,policy_epoch,decision_state,decision_id COLLATE "C")`,
    `CREATE INDEX IF NOT EXISTS ha_decisions_index_pending ON ha_decisions
      (tenant_id,project_id,policy_epoch,decision_id) WHERE decision_sort_key IS NULL`,
    `CREATE OR REPLACE FUNCTION ha_backfill_decision_indexes(tenant text,project text,epoch bigint)
      RETURNS integer LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      DECLARE processed integer;
      BEGIN
        WITH batch AS (
          SELECT tenant_id,project_id,policy_epoch,decision_id FROM ha_decisions
          WHERE tenant_id=tenant AND project_id=project AND policy_epoch=epoch AND decision_sort_key IS NULL
          ORDER BY decision_id LIMIT 64 FOR UPDATE
        ), filled AS (
          UPDATE ha_decisions d SET value=d.value FROM batch b
          WHERE (d.tenant_id,d.project_id,d.policy_epoch,d.decision_id)
            = (b.tenant_id,b.project_id,b.policy_epoch,b.decision_id) RETURNING 1
        ) SELECT count(*)::integer INTO processed FROM filled;
        RETURN processed;
      END $function$`,
  ];
}

/** New readers must not treat an unfilled scalar index as an empty ready result. */
export async function assertPgDecisionIndexReady(client: PoolClient, scope: PgProjectionScope): Promise<void> {
  await assertPgDecisionReadReady(client, scope, "scalar");
}
