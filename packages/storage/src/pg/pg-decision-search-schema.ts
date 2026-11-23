import {
  STANDARD_POSTGRES_DIALECT_CAPABILITIES,
  dialectAddColumnIfNotExistsSql,
  dialectCreateTriggerStatements,
  type PgDialectCapabilities,
} from "../postgres/dialect.ts";
import { POSTGRES_SCOPE_COLUMNS_SQL } from "../postgres/scope-schema.ts";

/** A digest is only a bounded dictionary bucket; exact terms and collision slots are retained.
 * PostgreSQL B-tree keys cannot hold every legal Unicode61 term. Positions are unrestricted integers.
 */
export function decisionSearchDdl(
  capabilities: PgDialectCapabilities = STANDARD_POSTGRES_DIALECT_CAPABILITIES,
): readonly string[] {
  const termSlotColumn = capabilities.supportsIdentityColumns
    ? "term_slot bigint GENERATED ALWAYS AS IDENTITY"
    : "term_slot bigserial";
  return [
    /* @gate-identity state-store/task.projection.ha_search_terms */ `CREATE TABLE IF NOT EXISTS ha_search_terms (
      ${POSTGRES_SCOPE_COLUMNS_SQL},readers text[] NOT NULL DEFAULT '{}',
      term_key text NOT NULL,term text NOT NULL,${termSlotColumn},
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
    dialectAddColumnIfNotExistsSql(capabilities, "ha_decisions", "search_ready", "boolean NOT NULL DEFAULT false"),
    `CREATE INDEX IF NOT EXISTS ha_decisions_search_pending ON ha_decisions
      (tenant_id,project_id,policy_epoch,decision_id) WHERE NOT search_ready`,
    `CREATE INDEX IF NOT EXISTS ha_decisions_list_pending ON ha_decisions
      (tenant_id,project_id,policy_epoch,decision_id) WHERE NOT search_ready OR review_summary IS NULL OR list_summary IS NULL`,
    `CREATE OR REPLACE FUNCTION ha_decision_search_invalidate() RETURNS trigger
      LANGUAGE plpgsql AS $function$ BEGIN NEW.search_ready := false; RETURN NEW; END $function$`,
    ...dialectCreateTriggerStatements(capabilities, {
      triggerName: "ha_decision_search_invalidate",
      tableName: "ha_decisions",
      timingAndEvent: "BEFORE INSERT OR UPDATE OF value,readers",
      functionCall: "ha_decision_search_invalidate()",
    }),
    // Previous writers invalidate the same row. Backfill/tokenization is owned by current
    // projection catch-up; readers surface projection_pending until its transaction commits.
    `CREATE OR REPLACE FUNCTION ha_decision_document_search_invalidate() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      DECLARE
        v_tenant_id text;
        v_project_id text;
        v_policy_epoch bigint;
        v_entity_id text;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          v_tenant_id := OLD.tenant_id;
          v_project_id := OLD.project_id;
          v_policy_epoch := OLD.policy_epoch;
          v_entity_id := OLD.entity_id;
        ELSE
          v_tenant_id := NEW.tenant_id;
          v_project_id := NEW.project_id;
          v_policy_epoch := NEW.policy_epoch;
          v_entity_id := NEW.entity_id;
        END IF;
        UPDATE ha_decisions SET search_ready=false
        WHERE tenant_id=v_tenant_id AND project_id=v_project_id AND policy_epoch=v_policy_epoch
          AND decision_id=substring(v_entity_id from '^decisions/decision-(.*)/decision[.]md$');
        RETURN NULL;
      END $function$`,
    ...dialectCreateTriggerStatements(capabilities, {
      triggerName: "ha_decision_document_search_invalidate",
      tableName: "ha_projection_values",
      timingAndEvent: "AFTER INSERT OR UPDATE OF value,readers",
      whenSql: "NEW.model='document'",
      functionCall: "ha_decision_document_search_invalidate()",
    }),
    ...dialectCreateTriggerStatements(capabilities, {
      triggerName: "ha_decision_document_search_delete",
      tableName: "ha_projection_values",
      timingAndEvent: "AFTER DELETE",
      whenSql: "OLD.model='document'",
      functionCall: "ha_decision_document_search_invalidate()",
    }),
    // Install independent triggers so an N-1 writer uses the same expansion. Moving an
    // identical document between active and history preserves the review bytes.
    `CREATE OR REPLACE FUNCTION ha_decision_document_review_invalidate() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$ BEGIN
        UPDATE ha_decisions SET review_summary=NULL
        WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND policy_epoch=NEW.policy_epoch
          AND decision_id=substring(NEW.entity_id from '^decisions/decision-(.*)/decision[.]md$')
          AND (review_summary->>'blobSha256') IS DISTINCT FROM ((NEW.document_metadata::jsonb)->>'blobSha256')
          AND review_summary IS NOT NULL;
        RETURN NULL;
      END $function$`,
    ...dialectCreateTriggerStatements(capabilities, {
      triggerName: "ha_decision_document_review_invalidate",
      tableName: "ha_projection_values",
      timingAndEvent: "AFTER INSERT OR UPDATE OF value",
      whenSql: "NEW.model IN ('document','document-history') AND NEW.entity_id LIKE 'decisions/decision-%/decision.md'",
      functionCall: "ha_decision_document_review_invalidate()",
    }),
    `CREATE OR REPLACE FUNCTION ha_decision_evidence_review_invalidate() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$ BEGIN
        UPDATE ha_decisions SET review_summary=NULL
        WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND policy_epoch=NEW.policy_epoch
          AND decision_id=split_part(NEW.source_ref,'/',2) AND review_summary IS NOT NULL;
        RETURN NULL;
      END $function$`,
    ...dialectCreateTriggerStatements(capabilities, {
      triggerName: "ha_decision_evidence_review_invalidate",
      tableName: "ha_relations",
      timingAndEvent: "AFTER INSERT OR UPDATE OF value,readers",
      whenSql: "NEW.source_ref LIKE 'decision/%' AND NEW.relation_type IN ('evidenced-by','refuted-by')",
      functionCall: "ha_decision_evidence_review_invalidate()",
    }),
  ];
}
