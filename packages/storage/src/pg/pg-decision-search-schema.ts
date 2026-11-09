import { POSTGRES_SCOPE_COLUMNS_SQL } from "../postgres/scope-schema.ts";

/** A digest is only a bounded dictionary bucket; exact terms and collision slots are retained.
 * PostgreSQL B-tree keys cannot hold every legal Unicode61 term. Positions are unrestricted integers.
 */
export function decisionSearchDdl(): readonly string[] {
  return [
    /* @gate-identity state-store/task.projection.ha_search_terms */ `CREATE TABLE IF NOT EXISTS ha_search_terms (
      ${POSTGRES_SCOPE_COLUMNS_SQL},readers text[] NOT NULL DEFAULT '{}',
      term_key text NOT NULL,term text NOT NULL,term_slot bigint GENERATED ALWAYS AS IDENTITY,
      PRIMARY KEY(tenant_id,project_id,policy_epoch,term_slot))`,
    `CREATE INDEX IF NOT EXISTS ha_search_terms_lookup ON ha_search_terms
      (tenant_id,project_id,policy_epoch,term_key)`,
    /* @gate-identity state-store/task.projection.ha_decision_positions */ `CREATE TABLE IF NOT EXISTS ha_decision_positions (
      ${POSTGRES_SCOPE_COLUMNS_SQL},readers text[] NOT NULL DEFAULT '{}',
      term_key text NOT NULL,term_slot bigint NOT NULL,decision_id text NOT NULL,
      column_id smallint NOT NULL,position integer NOT NULL,repo_id text NOT NULL DEFAULT '',
      head_readers text[] NOT NULL DEFAULT '{}',blob_readers text[] NOT NULL DEFAULT '{}',
      PRIMARY KEY(tenant_id,project_id,policy_epoch,term_key,term_slot,decision_id,repo_id,column_id,position))`,
    `CREATE INDEX IF NOT EXISTS ha_decision_positions_owner ON ha_decision_positions
      (tenant_id,project_id,policy_epoch,decision_id)`,
    `ALTER TABLE ha_decisions ADD COLUMN IF NOT EXISTS search_ready boolean NOT NULL DEFAULT false`,
    `CREATE INDEX IF NOT EXISTS ha_decisions_search_pending ON ha_decisions
      (tenant_id,project_id,policy_epoch,decision_id) WHERE NOT search_ready`,
    `CREATE OR REPLACE FUNCTION ha_decision_search_invalidate() RETURNS trigger
      LANGUAGE plpgsql AS $function$ BEGIN NEW.search_ready := false; RETURN NEW; END $function$`,
    `CREATE OR REPLACE TRIGGER ha_decision_search_invalidate BEFORE INSERT OR UPDATE OF value,readers
      ON ha_decisions FOR EACH ROW EXECUTE FUNCTION ha_decision_search_invalidate()`,
    // Previous writers invalidate the same row. Backfill/tokenization is owned by current
    // projection catch-up; readers surface projection_pending until its transaction commits.
    `CREATE OR REPLACE FUNCTION ha_decision_document_search_invalidate() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$ BEGIN
        UPDATE ha_decisions SET search_ready=false
        WHERE tenant_id=COALESCE(NEW.tenant_id,OLD.tenant_id) AND project_id=COALESCE(NEW.project_id,OLD.project_id) AND policy_epoch=COALESCE(NEW.policy_epoch,OLD.policy_epoch)
          AND decision_id=substring(COALESCE(NEW.entity_id,OLD.entity_id) from '^decisions/decision-(.*)/decision[.]md$');
        RETURN NULL;
      END $function$`,
    `CREATE OR REPLACE TRIGGER ha_decision_document_search_invalidate AFTER INSERT OR UPDATE OF value,readers
      ON ha_projection_values FOR EACH ROW WHEN (NEW.model='document')
      EXECUTE FUNCTION ha_decision_document_search_invalidate()`,
    `CREATE OR REPLACE TRIGGER ha_decision_document_search_delete AFTER DELETE
      ON ha_projection_values FOR EACH ROW WHEN (OLD.model='document')
      EXECUTE FUNCTION ha_decision_document_search_invalidate()`,
  ];
}
