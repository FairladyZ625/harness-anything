import { POSTGRES_STORAGE_MIGRATION_SCHEMA } from "../migration/postgres-schema.ts";
import { postgresScopeRlsStatements } from "./scope-schema.ts";

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

/** DDL owned by the event-ledger adapter; callers run it as the schema owner before runtime access. */
export const POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
  /* @gate-identity state-store/task.source.storage.src.postgres.event-ledger-schema.postgres-database */ `CREATE TABLE IF NOT EXISTS ha_repo_heads (
    tenant_id text NOT NULL,
    project_id text NOT NULL,
    repo_id text NOT NULL,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    replication_history text NOT NULL DEFAULT gen_random_uuid()::text,
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
  "ALTER TABLE ha_events ADD COLUMN IF NOT EXISTS summary_json text",
  `CREATE INDEX IF NOT EXISTS ha_events_type_revision_idx
    ON ha_events (tenant_id, project_id, repo_id, event_type, revision DESC)`,
  `CREATE INDEX IF NOT EXISTS ha_events_occurred_at_idx
    ON ha_events (tenant_id, project_id, repo_id, occurred_at, revision DESC)`,
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
  `ALTER TABLE ha_command_outcomes ADD COLUMN IF NOT EXISTS replication_sequence bigint
    CHECK (replication_sequence IS NULL OR replication_sequence >= 0)`,
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
  ...POSTGRES_STORAGE_MIGRATION_SCHEMA,
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
    FOR EACH ROW EXECUTE FUNCTION ha_stamp_outcome_replication_sequence()`,
  /* @gate-identity state-store/task.source.storage.src.postgres.event-ledger-schema.postgres-database */ `CREATE UNLOGGED TABLE IF NOT EXISTS ha_repo_sync_watermarks (
    tenant_id text NOT NULL, project_id text NOT NULL, repo_id text NOT NULL,
    replication_history text NOT NULL,
    confirmed_revision bigint NOT NULL CHECK (confirmed_revision >= 0),
    confirmed_sequence bigint NOT NULL CHECK (confirmed_sequence >= 0),
    ${scopeColumns()}, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,project_id,repo_id)
  )`,
  `CREATE OR REPLACE FUNCTION ha_is_lsn_sync_confirmed(target_lsn pg_lsn) RETURNS boolean
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
      SELECT CASE WHEN current_setting('synchronous_standby_names', true) = '' THEN true
        ELSE EXISTS (SELECT 1 FROM pg_catalog.pg_stat_replication
          WHERE state='streaming' AND sync_state IN ('sync','quorum') AND flush_lsn >= target_lsn)
        END
    $$`,
  "REVOKE ALL ON FUNCTION ha_is_lsn_sync_confirmed(pg_lsn) FROM PUBLIC",
  // Embedded and isolated schema fixtures need not create both login roles.
  `DO $$ DECLARE role_name text; BEGIN
    FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('ha_runtime','ha_migrator') LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION ha_is_lsn_sync_confirmed(pg_lsn) TO %I', role_name);
    END LOOP;
  END $$`,
  /* @gate-identity state-store/task.source.storage.src.postgres.event-ledger-schema.postgres-database */ `CREATE TABLE IF NOT EXISTS ha_replication_slots (
    tenant_id text NOT NULL, project_id text NOT NULL, repo_id text NOT NULL, node_id text NOT NULL,
    fence bigint NOT NULL, history text NOT NULL, ack text, acked_at text,
    ${scopeColumns()}, PRIMARY KEY(tenant_id,project_id,repo_id,node_id)
  )`,
  ...POSTGRES_EVENT_LEDGER_TABLES.flatMap((tableName) => postgresScopeRlsStatements(tableName)),
  // Expansion also covers pre-trigger outcomes. Unknown pruned positions require a WAL proof.
  `UPDATE ha_command_outcomes o SET replication_sequence=p.sequence FROM ha_replication_positions p
    WHERE o.tenant_id=p.tenant_id AND o.project_id=p.project_id AND o.repo_id=p.repo_id
      AND o.op_id=p.last_op_id AND o.replication_sequence IS NULL`,
  `WITH proof AS MATERIALIZED (SELECT ha_is_lsn_sync_confirmed(pg_current_wal_flush_lsn()) AS confirmed)
    UPDATE ha_command_outcomes SET replication_sequence=0
    WHERE replication_sequence IS NULL AND (SELECT confirmed FROM proof)`,
]);

function scopeColumns(): string {
  return "readers text[] NOT NULL DEFAULT '{}', policy_epoch bigint NOT NULL";
}
