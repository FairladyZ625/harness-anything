import {
  STANDARD_POSTGRES_DIALECT_CAPABILITIES,
  dialectAddColumnIfNotExistsSql,
  dialectCreateTriggerStatements,
  dialectUpsertDoNothingSql,
  type PgDialectCapabilities,
} from "../postgres/dialect.ts";

/** Management-only DDL. The repository epoch row also fences head creation, not just existing tuples. */
export function postgresStorageMigrationSchema(
  capabilities: PgDialectCapabilities = STANDARD_POSTGRES_DIALECT_CAPABILITIES,
): readonly string[] {
  return [
    dialectAddColumnIfNotExistsSql(capabilities, "ha_repo_heads", "migration_control", "jsonb"),
    dialectAddColumnIfNotExistsSql(capabilities, "ha_events", "recorded_at_text", "text"),
    dialectAddColumnIfNotExistsSql(capabilities, "ha_command_outcomes", "recorded_at_text", "text"),
    /* @gate-identity state-store/migration.source.storage.src.migration.postgres-schema.postgres-database */ `CREATE TABLE IF NOT EXISTS ha_repo_writer_epochs (
      repo_id text PRIMARY KEY,
      writer_epoch bigint NOT NULL DEFAULT 0 CHECK (writer_epoch >= 0),
      writer_holder_id text,
      writer_issued_at text,
      migration_control jsonb,
      activation_markers jsonb NOT NULL DEFAULT '{}'::jsonb
    )`,
    dialectAddColumnIfNotExistsSql(capabilities, "ha_repo_writer_epochs", "writer_issued_at", "text"),
    "REVOKE ALL ON ha_repo_writer_epochs FROM PUBLIC",
    // All append/rejection transactions first INSERT ... ON CONFLICT / ON DUPLICATE KEY on their scoped head.
    // A trigger runs even on conflict, before that head's row lock. Its shared repository lock lasts until commit;
    // management takes the same row FOR UPDATE before inspecting cuts or changing the writer epoch.
    // Runtime roles cannot read/write the management table or invoke this trigger function directly.
    `CREATE OR REPLACE FUNCTION public.ha_inherit_repo_writer_epoch() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fence$
      DECLARE authority public.ha_repo_writer_epochs%ROWTYPE;
      BEGIN
        INSERT INTO public.ha_repo_writer_epochs(repo_id) VALUES(NEW.repo_id) ${dialectUpsertDoNothingSql(capabilities)};
        SELECT * INTO STRICT authority FROM public.ha_repo_writer_epochs WHERE repo_id=NEW.repo_id FOR SHARE;
        NEW.migration_control := authority.migration_control;
        IF NEW.writer_epoch < authority.writer_epoch THEN
          NEW.writer_epoch := authority.writer_epoch;
          NEW.writer_holder_id := authority.writer_holder_id;
        END IF;
        RETURN NEW;
      END $fence$`,
    "REVOKE ALL ON FUNCTION public.ha_inherit_repo_writer_epoch() FROM PUBLIC",
    ...dialectCreateTriggerStatements(capabilities, {
      triggerName: "ha_repo_writer_epoch",
      tableName: "ha_repo_heads",
      timingAndEvent: "BEFORE INSERT OR UPDATE",
      functionCall: "public.ha_inherit_repo_writer_epoch()",
    }),
    ...(capabilities.supportsOnConflict
      ? []
      : [
          // Dialects without ON CONFLICT use MERGE INTO for ha_repo_heads, which skips row triggers
          // when the head already exists. Provide a narrow authority-first SHARE lock entrypoint
          // gated by INSERT privilege on ha_repo_heads (matching the trigger's exact privilege boundary).
          `CREATE OR REPLACE FUNCTION public.ha_acquire_repo_writer_epoch_share(target_repo_id text) RETURNS void
            LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp AS $fence$
            BEGIN
              IF NOT pg_catalog.has_table_privilege(session_user, 'public.ha_repo_heads', 'INSERT') THEN
                RAISE EXCEPTION 'permission denied for table ha_repo_heads' USING ERRCODE = '42501';
              END IF;
              INSERT INTO public.ha_repo_writer_epochs(repo_id) VALUES(target_repo_id) ${dialectUpsertDoNothingSql(capabilities)};
              PERFORM 1 FROM public.ha_repo_writer_epochs WHERE repo_id = target_repo_id FOR SHARE;
            END $fence$`,
          "GRANT EXECUTE ON FUNCTION public.ha_acquire_repo_writer_epoch_share(text) TO PUBLIC",
        ]),
  ];
}

export const POSTGRES_STORAGE_MIGRATION_SCHEMA = Object.freeze(postgresStorageMigrationSchema());
