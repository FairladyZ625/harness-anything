import { decisionIdSortKey } from "../projection/decision-projection-reads.ts";

/** Additive v5 expansion. Keep the previous-writer trigger through 2026-11-19.
 * Current writers also use it; the bounded backfill is removable after that window.
 */
export function decisionIndexDdl(): readonly string[] {
  return [
    "ALTER TABLE ha_decisions ADD COLUMN IF NOT EXISTS decision_state text",
    "ALTER TABLE ha_decisions ADD COLUMN IF NOT EXISTS legacy_group smallint",
    "ALTER TABLE ha_decisions ADD COLUMN IF NOT EXISTS legacy_number double precision",
    'ALTER TABLE ha_decisions ADD COLUMN IF NOT EXISTS decision_sort_key text COLLATE "C"',
    `CREATE OR REPLACE FUNCTION ha_decision_index_fields() RETURNS trigger
      LANGUAGE plpgsql AS $function$
      DECLARE legacy text;
      BEGIN
        legacy := substring(NEW.decision_id from '(?:^|_)E([1-9][0-9]*)(?:_|$)');
        NEW.legacy_group := CASE WHEN legacy IS NULL THEN 1 ELSE 0 END;
        NEW.legacy_number := COALESCE(legacy::double precision,0);
        NEW.decision_state := NEW.value->>'state';
        NEW.decision_sort_key := ${decisionSortSql("NEW.decision_id")};
        RETURN NEW;
      END $function$`,
    `CREATE OR REPLACE TRIGGER ha_decision_index_fields BEFORE INSERT OR UPDATE OF value,decision_id
      ON ha_decisions FOR EACH ROW EXECUTE FUNCTION ha_decision_index_fields()`,
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

function decisionSortSql(column: string): string {
  const alphabet = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz",
    primary = [...alphabet].map((c) => decisionIdSortKey(c).split(" ")[0]).join(""),
    secondary = [...alphabet].map((c) => decisionIdSortKey(c).split(" ")[1]).join("");
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return `translate(${column},${literal(alphabet)},${literal(primary)}) || ' ' || translate(${column},${literal(alphabet)},${literal(secondary)})`;
}
