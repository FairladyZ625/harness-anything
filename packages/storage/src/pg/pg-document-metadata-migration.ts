/**
 * Additive v5 expansion. Remove the previous-writer trigger, extractor and backfill function
 * on 2026-11-18, after pre-metadata binaries have drained; the column and current writes remain.
 * Run each backfill call in its own management transaction with the target scope's RLS claims.
 */
export function documentMetadataDdl(): readonly string[] {
  return [
    "ALTER TABLE ha_projection_values ADD COLUMN IF NOT EXISTS document_metadata text",
    // DocumentState is a flat, canonical JSON object: body is string|null, followed by metadata.
    // PostgreSQL JSON operators reject legal NUL/unpaired-surrogate body escapes. Remove that
    // one serialized field without decoding any strings; current writers supply metadata directly.
    String.raw`CREATE OR REPLACE FUNCTION ha_document_metadata_from_value(serialized text)
      RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $function$
        SELECT regexp_replace(serialized, $pattern$"body":("(?:[^"\\]|\\.)*"|null),$pattern$, '')
      $function$`,
    `CREATE OR REPLACE FUNCTION ha_document_metadata_previous_writer()
      RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      BEGIN
        IF NEW.document_metadata IS NULL OR
           (TG_OP = 'UPDATE' AND NEW.document_metadata IS NOT DISTINCT FROM OLD.document_metadata) THEN
          NEW.document_metadata := ha_document_metadata_from_value(NEW.value);
        END IF;
        RETURN NEW;
      END $function$`,
    `CREATE OR REPLACE TRIGGER ha_document_metadata_previous_writer
      BEFORE INSERT OR UPDATE OF value ON ha_projection_values
      FOR EACH ROW WHEN (NEW.model = 'document')
      EXECUTE FUNCTION ha_document_metadata_previous_writer()`,
    `CREATE OR REPLACE FUNCTION ha_backfill_document_metadata(
        tenant text, project text, epoch bigint, after_owner text DEFAULT '', after_entity text DEFAULT '')
      RETURNS TABLE(processed integer, next_owner text, next_entity text)
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      BEGIN
        WITH batch AS (
          SELECT tenant_id,project_id,policy_epoch,model,owner_id,entity_id
          FROM ha_projection_values
          WHERE tenant_id=tenant AND project_id=project AND policy_epoch=epoch
            AND model='document' AND (owner_id,entity_id) > (after_owner,after_entity)
          ORDER BY owner_id,entity_id LIMIT 64 FOR UPDATE
        )
        , filled AS (
          UPDATE ha_projection_values p
          SET document_metadata=ha_document_metadata_from_value(p.value)
          FROM batch b
          WHERE (p.tenant_id,p.project_id,p.policy_epoch,p.model,p.owner_id,p.entity_id)
              = (b.tenant_id,b.project_id,b.policy_epoch,b.model,b.owner_id,b.entity_id)
            AND p.document_metadata IS NULL
          RETURNING p.entity_id
        )
        SELECT count(*)::integer,
          (SELECT owner_id FROM batch ORDER BY owner_id DESC,entity_id DESC LIMIT 1),
          (SELECT entity_id FROM batch ORDER BY owner_id DESC,entity_id DESC LIMIT 1)
        INTO processed,next_owner,next_entity FROM batch;
        RETURN NEXT;
      END $function$`,
  ];
}
