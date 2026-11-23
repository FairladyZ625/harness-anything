import {
  STANDARD_POSTGRES_DIALECT_CAPABILITIES,
  dialectAddColumnIfNotExistsSql,
  dialectCreateTriggerStatements,
  dialectCurrentSettingSql,
  dialectUpsertDoNothingSql,
  type PgDialectCapabilities,
} from "../postgres/dialect.ts";
import { POSTGRES_SCOPE_SCHEMA_CONTRACT } from "../postgres/scope-schema.ts";

/** Management-only DDL. The repository epoch row also fences head creation, not just existing tuples. */
export function postgresStorageMigrationSchema(
  capabilities: PgDialectCapabilities = STANDARD_POSTGRES_DIALECT_CAPABILITIES,
): readonly string[] {
  const setting = (name: string) => dialectCurrentSettingSql(capabilities, name),
    bypassCheck = capabilities.supportsRoleBypassRls
      ? "r.rolsuper OR r.rolbypassrls"
      : "r.rolsuper OR r.rolsystemadmin";
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
          "DROP FUNCTION IF EXISTS public.ha_acquire_repo_writer_epoch_share(text)",
          // Dialects without ON CONFLICT use MERGE INTO for ha_repo_heads, which skips row triggers
          // when the head already exists. Provide a narrow authority-first SHARE lock entrypoint
          // gated by both INSERT privilege on ha_repo_heads and the exact transaction scope guard
          // matching ha_enforce_scope_write_check so unscoped or mismatched-scope sessions fail
          // closed with SQLSTATE 42501 before touching ha_repo_writer_epochs.
          `CREATE OR REPLACE FUNCTION public.ha_acquire_repo_writer_epoch_share(
              target_tenant_id text,
              target_project_id text,
              target_policy_epoch bigint,
              target_repo_id text
            ) RETURNS void
            LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp AS $fence$
            DECLARE
              expected_tenant text;
              expected_project text;
              expected_epoch bigint;
              bypass boolean;
            BEGIN
              IF NOT pg_catalog.has_table_privilege(session_user, 'public.ha_repo_heads', 'INSERT') THEN
                RAISE EXCEPTION 'permission denied for table ha_repo_heads' USING ERRCODE = '42501';
              END IF;
              SELECT COALESCE(${bypassCheck}, false) INTO bypass
                FROM pg_catalog.pg_roles r WHERE r.rolname = session_user;
              IF NOT bypass THEN
                expected_tenant := NULLIF(${setting(POSTGRES_SCOPE_SCHEMA_CONTRACT.claims.tenantId)}, '');
                expected_project := NULLIF(${setting(POSTGRES_SCOPE_SCHEMA_CONTRACT.claims.projectId)}, '');
                expected_epoch := NULLIF(${setting(POSTGRES_SCOPE_SCHEMA_CONTRACT.claims.policyEpoch)}, '')::bigint;
                IF expected_tenant IS NULL OR expected_project IS NULL OR expected_epoch IS NULL
                   OR target_tenant_id IS DISTINCT FROM expected_tenant
                   OR target_project_id IS DISTINCT FROM expected_project
                   OR target_policy_epoch IS DISTINCT FROM expected_epoch THEN
                  RAISE EXCEPTION 'new row violates row-level security policy for table "ha_repo_heads"'
                    USING ERRCODE = '42501';
                END IF;
              END IF;
              IF target_tenant_id IS NULL OR btrim(target_tenant_id) = ''
                 OR target_project_id IS NULL OR btrim(target_project_id) = ''
                 OR target_policy_epoch IS NULL
                 OR target_repo_id IS NULL OR btrim(target_repo_id) = '' THEN
                RAISE EXCEPTION 'new row violates row-level security policy for table "ha_repo_heads"'
                  USING ERRCODE = '42501';
              END IF;
              INSERT INTO public.ha_repo_writer_epochs(repo_id) VALUES(target_repo_id) ${dialectUpsertDoNothingSql(capabilities)};
              PERFORM 1 FROM public.ha_repo_writer_epochs WHERE repo_id = target_repo_id FOR SHARE;
            END $fence$`,
          "GRANT EXECUTE ON FUNCTION public.ha_acquire_repo_writer_epoch_share(text, text, bigint, text) TO PUBLIC",
        ]),
  ];
}

export const POSTGRES_STORAGE_MIGRATION_SCHEMA = Object.freeze(postgresStorageMigrationSchema());
