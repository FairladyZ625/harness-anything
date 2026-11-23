import type { PoolClient } from "pg";
import { postgresStorageMigrationSchema } from "../migration/postgres-schema.ts";
import { pgOccurredAtEpochMsSql } from "../projection/iso-timestamp-sql.ts";
import {
  STANDARD_POSTGRES_DIALECT_CAPABILITIES,
  detectPgDialectCapabilities,
  dialectAddColumnIfNotExistsSql,
  dialectCompatibilityPreludeStatements,
  dialectCreateTriggerStatements,
  dialectCurrentSettingSql,
  dialectCurrentWalLsnSql,
  dialectLsnSyncFunctionSignature,
  type PgDialectCapabilities,
} from "./dialect.ts";
import { postgresScopeRlsStatements, postgresScopeWriteGuardFunctionStatements } from "./scope-schema.ts";

export const POSTGRES_EVENT_LEDGER_TABLES = Object.freeze([
  "ha_repo_heads",
  "ha_events",
  "ha_event_entity_refs",
  "ha_command_outcomes",
  "ha_content_blobs",
  "ha_document_heads",
  "ha_replication_positions",
  "ha_replication_slots",
  "ha_repo_sync_watermarks",
] as const);

/** Shared by cold ledger creation and the existing schema-owner read-index upgrade. */
export const POSTGRES_EVENT_REF_INDEX_SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
  /* @gate-identity state-store/task.source.storage.src.postgres.event-ledger-schema.postgres-database */ `CREATE TABLE IF NOT EXISTS ha_event_entity_refs (
    tenant_id text NOT NULL, project_id text NOT NULL, repo_id text NOT NULL,
    ${scopeColumns()}, entity_ref text COLLATE "C" NOT NULL, revision bigint NOT NULL,
    PRIMARY KEY (tenant_id,project_id,policy_epoch,repo_id,entity_ref,revision),
    FOREIGN KEY (tenant_id,project_id,repo_id,revision)
      REFERENCES ha_events(tenant_id,project_id,repo_id,revision) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS ha_event_entity_refs_revision ON ha_event_entity_refs
    (tenant_id,project_id,repo_id,revision)`,
]);

/** Sentinel stored in occurred_at_ms for synthetic non-ISO occurred_at values (< MIN_JS_EPOCH_MS) so backfill converges. */
export const PG_OCCURRED_AT_MS_INVALID_SENTINEL = "-9000000000000000";

/** Shared by cold ledger creation and the existing schema-owner read-index upgrade (`ensurePgProjectionSchema`).
 * Adds a nullable scalar `occurred_at_ms` column with zero table rewrite, maintains it via a shared trigger
 * for both previous and current writers, and indexes `(occurred_at_ms, revision)` under RLS. */
export function postgresEventOccurredMsSchemaStatements(
  capabilities: PgDialectCapabilities = STANDARD_POSTGRES_DIALECT_CAPABILITIES,
): readonly string[] {
  return [
    dialectAddColumnIfNotExistsSql(capabilities, "ha_events", "occurred_at_ms", "bigint"),
    `CREATE OR REPLACE FUNCTION ha_occurred_at_epoch_ms(value text) RETURNS bigint
      LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $function$
      SELECT ${pgOccurredAtEpochMsSql("value")}
    $function$`,
    `CREATE OR REPLACE FUNCTION ha_event_occurred_at_ms_sync() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      BEGIN
        NEW.occurred_at_ms := COALESCE(ha_occurred_at_epoch_ms(NEW.occurred_at), ${PG_OCCURRED_AT_MS_INVALID_SENTINEL}::bigint);
        RETURN NEW;
      END
    $function$`,
    ...dialectCreateTriggerStatements(capabilities, {
      triggerName: "ha_event_occurred_at_ms_sync",
      tableName: "ha_events",
      timingAndEvent: "BEFORE INSERT OR UPDATE OF occurred_at",
      functionCall: "ha_event_occurred_at_ms_sync()",
    }),
    `CREATE INDEX IF NOT EXISTS ha_events_occurred_ms_revision
      ON ha_events (tenant_id, project_id, policy_epoch, repo_id, occurred_at_ms, revision)`,
    `CREATE INDEX IF NOT EXISTS ha_events_occurred_ms_pending
      ON ha_events (tenant_id, project_id, policy_epoch, repo_id, revision) WHERE occurred_at_ms IS NULL`,
  ];
}

export const POSTGRES_EVENT_OCCURRED_MS_SCHEMA_STATEMENTS: readonly string[] = Object.freeze(
  postgresEventOccurredMsSchemaStatements(),
);

function lsnSyncConfirmationStatements(capabilities: PgDialectCapabilities): readonly string[] {
  const signature = dialectLsnSyncFunctionSignature(capabilities),
    syncFunction = capabilities.supportsWalLsn
      ? `CREATE OR REPLACE FUNCTION ha_is_lsn_sync_confirmed(target_lsn pg_lsn) RETURNS boolean
          LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
            SELECT CASE WHEN current_setting('synchronous_standby_names', true) = '' THEN true
              ELSE EXISTS (SELECT 1 FROM pg_catalog.pg_stat_replication
                WHERE state='streaming' AND sync_state IN ('sync','quorum') AND flush_lsn >= target_lsn)
              END
          $$`
      : `CREATE OR REPLACE FUNCTION ha_is_lsn_sync_confirmed(target_lsn text) RETURNS boolean
          LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp AS $$
            SELECT CASE
              WHEN COALESCE(${dialectCurrentSettingSql(capabilities, "synchronous_standby_names")}, '') = '' THEN true
              WHEN COALESCE(${dialectCurrentSettingSql(capabilities, "replconninfo1")}, '') = ''
                AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_replication) THEN true
              ELSE EXISTS (SELECT 1 FROM pg_catalog.pg_stat_replication
                WHERE lower(state)='streaming' AND lower(sync_state) IN ('sync','quorum')
                  AND pg_catalog.pg_xlog_location_diff(receiver_flush_location, target_lsn) >= 0)
            END
          $$`;
  return [
    syncFunction,
    `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`,
    // Embedded and isolated schema fixtures need not create both login roles.
    `DO $$ DECLARE role_name text; BEGIN
      FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('ha_runtime','ha_migrator') LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION ${signature} TO %I', role_name);
      END LOOP;
    END $$`,
  ];
}

/** DDL owned by the event-ledger adapter; callers run it as the schema owner before runtime access. */
export function postgresEventLedgerSchemaStatements(
  capabilities: PgDialectCapabilities = STANDARD_POSTGRES_DIALECT_CAPABILITIES,
): readonly string[] {
  const defaultHistorySql = capabilities.supportsGenRandomUuid
    ? "gen_random_uuid()::text"
    : "public.ha_gen_random_uuid()";
  const watermarkTableSql = capabilities.supportsUnloggedTables
    ? /* @gate-identity state-store/task.source.storage.src.postgres.event-ledger-schema.postgres-database */ `CREATE UNLOGGED TABLE IF NOT EXISTS ha_repo_sync_watermarks (
    tenant_id text NOT NULL, project_id text NOT NULL, repo_id text NOT NULL,
    replication_history text NOT NULL,
    confirmed_revision bigint NOT NULL CHECK (confirmed_revision >= 0),
    confirmed_sequence bigint NOT NULL CHECK (confirmed_sequence >= 0),
    ${scopeColumns()}, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,project_id,repo_id)
  )`
    : /* @gate-identity state-store/task.source.storage.src.postgres.event-ledger-schema.postgres-database */ `CREATE TABLE IF NOT EXISTS ha_repo_sync_watermarks (
    tenant_id text NOT NULL, project_id text NOT NULL, repo_id text NOT NULL,
    replication_history text NOT NULL,
    confirmed_revision bigint NOT NULL CHECK (confirmed_revision >= 0),
    confirmed_sequence bigint NOT NULL CHECK (confirmed_sequence >= 0),
    ${scopeColumns()}, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,project_id,repo_id)
  )`;
  return [
    ...dialectCompatibilityPreludeStatements(capabilities),
    ...postgresScopeWriteGuardFunctionStatements(capabilities),
    /* @gate-identity state-store/task.source.storage.src.postgres.event-ledger-schema.postgres-database */ `CREATE TABLE IF NOT EXISTS ha_repo_heads (
    tenant_id text NOT NULL,
    project_id text NOT NULL,
    repo_id text NOT NULL,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    replication_history text NOT NULL DEFAULT ${defaultHistorySql},
    head_op_id text,
    head_event_digest text,
    head_digest text,
    writer_holder_id text,
    writer_epoch bigint NOT NULL DEFAULT 0 CHECK (writer_epoch >= 0),
    ${scopeColumns()},
    migration_control jsonb,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, project_id, repo_id),
    CHECK ((revision = 0 AND head_op_id IS NULL AND head_event_digest IS NULL AND head_digest IS NULL)
        OR (revision > 0 AND head_op_id IS NOT NULL AND head_event_digest IS NOT NULL AND head_digest IS NOT NULL))
  )`,
    /* @gate-identity state-store/task.source.storage.src.postgres.event-ledger-schema.postgres-database */ `CREATE TABLE IF NOT EXISTS ha_events (
    tenant_id text NOT NULL,
    project_id text NOT NULL,
    repo_id text NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    op_id text NOT NULL,
    event_id text NOT NULL,
    event_type text NOT NULL,
    event_json text NOT NULL,
    summary_json text,
    event_digest text NOT NULL,
    occurred_at text NOT NULL,
    actor_refs text[] NOT NULL DEFAULT '{}',
    entity_refs text[] NOT NULL DEFAULT '{}',
    ${scopeColumns()},
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, project_id, repo_id, revision),
    UNIQUE (tenant_id, project_id, repo_id, op_id),
    FOREIGN KEY (tenant_id, project_id, repo_id)
      REFERENCES ha_repo_heads (tenant_id, project_id, repo_id)
  )`,
    dialectAddColumnIfNotExistsSql(capabilities, "ha_events", "summary_json", "text"),
    `CREATE INDEX IF NOT EXISTS ha_events_type_revision_idx
    ON ha_events (tenant_id, project_id, repo_id, event_type, revision DESC)`,
    `CREATE INDEX IF NOT EXISTS ha_events_occurred_at_idx
    ON ha_events (tenant_id, project_id, repo_id, occurred_at, revision DESC)`,
    ...postgresEventOccurredMsSchemaStatements(capabilities),
    `CREATE INDEX IF NOT EXISTS ha_events_actor_refs_gin_idx ON ha_events USING gin (actor_refs)`,
    `CREATE INDEX IF NOT EXISTS ha_events_entity_refs_gin_idx ON ha_events USING gin (entity_refs)`,
    // Derived ledger index: survives task-projection rebuilds and is maintained by the event
    // read-index trigger, including writes from the previous binary during the upgrade window.
    ...POSTGRES_EVENT_REF_INDEX_SCHEMA_STATEMENTS,
    /* @gate-identity state-store/task.source.storage.src.postgres.event-ledger-schema.postgres-database */ `CREATE TABLE IF NOT EXISTS ha_command_outcomes (
    tenant_id text NOT NULL,
    project_id text NOT NULL,
    repo_id text NOT NULL,
    op_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('accepted_durable', 'rejected')),
    first_revision bigint,
    last_revision bigint,
    intent_digest text NOT NULL,
    intent_summary text NOT NULL,
    rejection_code text,
    recorded_at timestamptz NOT NULL,
    member_op_ids text[] NOT NULL,
    ${scopeColumns()},
    PRIMARY KEY (tenant_id, project_id, repo_id, op_id),
    FOREIGN KEY (tenant_id, project_id, repo_id)
      REFERENCES ha_repo_heads (tenant_id, project_id, repo_id),
    CHECK ((status = 'accepted_durable' AND rejection_code IS NULL)
        OR (status = 'rejected' AND rejection_code IS NOT NULL))
  )`,
    `CREATE INDEX IF NOT EXISTS ha_command_outcomes_members_gin_idx
    ON ha_command_outcomes USING gin (member_op_ids)`,
    dialectAddColumnIfNotExistsSql(
      capabilities,
      "ha_command_outcomes",
      "replication_sequence",
      "bigint CHECK (replication_sequence IS NULL OR replication_sequence >= 0)",
    ),
    `CREATE INDEX IF NOT EXISTS ha_command_outcomes_null_seq_idx
    ON ha_command_outcomes (tenant_id,project_id,repo_id) WHERE replication_sequence IS NULL`,
    /* @gate-identity state-store/task.source.storage.src.postgres.event-ledger-schema.postgres-database */ `CREATE TABLE IF NOT EXISTS ha_content_blobs (
    tenant_id text NOT NULL,
    project_id text NOT NULL,
    sha256 text NOT NULL,
    size bigint NOT NULL CHECK (size >= 0),
    body bytea NOT NULL,
    ${scopeColumns()},
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, project_id, sha256),
    CHECK (octet_length(body) = size)
  )`,
    /* @gate-identity state-store/task.source.storage.src.postgres.event-ledger-schema.postgres-database */ `CREATE TABLE IF NOT EXISTS ha_document_heads (
    tenant_id text NOT NULL,
    project_id text NOT NULL,
    repo_id text NOT NULL,
    path text NOT NULL,
    sha256 text,
    size bigint,
    node_kind text,
    revision bigint NOT NULL CHECK (revision > 0),
    ${scopeColumns()},
    PRIMARY KEY (tenant_id, project_id, repo_id, path),
    FOREIGN KEY (tenant_id, project_id, repo_id)
      REFERENCES ha_repo_heads (tenant_id, project_id, repo_id),
    CHECK ((sha256 IS NULL AND size IS NULL AND node_kind IS NULL)
        OR (sha256 IS NOT NULL AND size IS NOT NULL AND size >= 0 AND node_kind IS NOT NULL AND node_kind IN ('file', 'symbolic-link')))
  )`,
    /* @gate-identity state-store/task.source.storage.src.postgres.event-ledger-schema.postgres-database */ `CREATE TABLE IF NOT EXISTS ha_replication_positions (
    tenant_id text NOT NULL,
    project_id text NOT NULL,
    repo_id text NOT NULL,
    history text NOT NULL,
    sequence bigint NOT NULL CHECK (sequence > 0),
    revision bigint NOT NULL CHECK (revision >= 0),
    last_op_id text,
    head_digest text NOT NULL,
    writer_holder_id text NOT NULL,
    writer_epoch bigint NOT NULL CHECK (writer_epoch >= 0),
    ${scopeColumns()},
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, project_id, repo_id, sequence),
    FOREIGN KEY (tenant_id, project_id, repo_id)
      REFERENCES ha_repo_heads (tenant_id, project_id, repo_id)
  )`,
    ...postgresStorageMigrationSchema(capabilities),
    // dec_659E15CF expansion: retain the previous writer through the next schema contract step.
    `CREATE OR REPLACE FUNCTION ha_stamp_outcome_replication_sequence() RETURNS trigger
    LANGUAGE plpgsql SET search_path = public, pg_catalog, pg_temp AS $$ BEGIN
      UPDATE ha_command_outcomes SET replication_sequence=NEW.sequence
      WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND repo_id=NEW.repo_id
        AND op_id=NEW.last_op_id AND replication_sequence IS NULL;
      RETURN NEW;
    END $$`,
    "DROP TRIGGER IF EXISTS trg_ha_stamp_outcome_replication_sequence ON ha_replication_positions",
    `CREATE TRIGGER trg_ha_stamp_outcome_replication_sequence AFTER INSERT ON ha_replication_positions
    FOR EACH ROW EXECUTE ${capabilities.supportsCreateOrReplaceTrigger ? "FUNCTION" : "PROCEDURE"} ha_stamp_outcome_replication_sequence()`,
    watermarkTableSql,
    ...lsnSyncConfirmationStatements(capabilities),
    /* @gate-identity state-store/task.source.storage.src.postgres.event-ledger-schema.postgres-database */ `CREATE TABLE IF NOT EXISTS ha_replication_slots (
    tenant_id text NOT NULL, project_id text NOT NULL, repo_id text NOT NULL, node_id text NOT NULL,
    fence bigint NOT NULL, history text NOT NULL, ack text, acked_at text,
    ${scopeColumns()}, PRIMARY KEY(tenant_id,project_id,repo_id,node_id)
  )`,
    ...POSTGRES_EVENT_LEDGER_TABLES.flatMap((tableName) => postgresScopeRlsStatements(tableName, { capabilities })),
    // Expansion also covers pre-trigger outcomes. Unknown pruned positions require a WAL proof.
    `UPDATE ha_command_outcomes o SET replication_sequence=p.sequence FROM ha_replication_positions p
    WHERE o.tenant_id=p.tenant_id AND o.project_id=p.project_id AND o.repo_id=p.repo_id
      AND o.op_id=p.last_op_id AND o.replication_sequence IS NULL`,
    `WITH proof AS MATERIALIZED (SELECT ha_is_lsn_sync_confirmed(${dialectCurrentWalLsnSql(capabilities)}) AS confirmed)
    UPDATE ha_command_outcomes SET replication_sequence=0
    WHERE replication_sequence IS NULL AND (SELECT confirmed FROM proof)`,
  ];
}

/** Detect the target dialect once and apply the event-ledger schema statements in order. */
export async function ensurePostgresEventLedgerSchema(
  client: PoolClient,
  capabilities?: PgDialectCapabilities,
): Promise<PgDialectCapabilities> {
  const detected = capabilities ?? (await detectPgDialectCapabilities(client));
  for (const statement of postgresEventLedgerSchemaStatements(detected)) await client.query(statement);
  return detected;
}

export const POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS: readonly string[] = Object.freeze(
  postgresEventLedgerSchemaStatements(),
);

function scopeColumns(): string {
  return "readers text[] NOT NULL DEFAULT '{}', policy_epoch bigint NOT NULL";
}
