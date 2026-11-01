import { postgresScopeRlsStatements } from "./scope-schema.ts";

export const POSTGRES_EVENT_LEDGER_TABLES = Object.freeze([
  "ha_repo_heads",
  "ha_events",
  "ha_command_outcomes",
  "ha_content_blobs",
  "ha_replication_positions",
] as const);

/** DDL owned by the event-ledger adapter; callers run it as the schema owner before runtime access. */
export const POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ha_repo_heads (
    tenant_id text NOT NULL,
    project_id text NOT NULL,
    repo_id text NOT NULL,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    head_op_id text,
    head_event_digest text,
    head_digest text,
    writer_holder_id text,
    writer_epoch bigint NOT NULL DEFAULT 0 CHECK (writer_epoch >= 0),
    ${scopeColumns()},
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, project_id, repo_id),
    CHECK ((revision = 0 AND head_op_id IS NULL AND head_event_digest IS NULL AND head_digest IS NULL)
        OR (revision > 0 AND head_op_id IS NOT NULL AND head_event_digest IS NOT NULL AND head_digest IS NOT NULL))
  )`,
  `CREATE TABLE IF NOT EXISTS ha_events (
    tenant_id text NOT NULL,
    project_id text NOT NULL,
    repo_id text NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    op_id text NOT NULL,
    event_id text NOT NULL,
    event_type text NOT NULL,
    event_json text NOT NULL,
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
  `CREATE INDEX IF NOT EXISTS ha_events_type_revision_idx
    ON ha_events (tenant_id, project_id, repo_id, event_type, revision DESC)`,
  `CREATE INDEX IF NOT EXISTS ha_events_occurred_at_idx
    ON ha_events (tenant_id, project_id, repo_id, occurred_at, revision DESC)`,
  `CREATE INDEX IF NOT EXISTS ha_events_actor_refs_gin_idx ON ha_events USING gin (actor_refs)`,
  `CREATE INDEX IF NOT EXISTS ha_events_entity_refs_gin_idx ON ha_events USING gin (entity_refs)`,
  `CREATE TABLE IF NOT EXISTS ha_command_outcomes (
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
  `CREATE TABLE IF NOT EXISTS ha_content_blobs (
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
  `CREATE TABLE IF NOT EXISTS ha_replication_positions (
    tenant_id text NOT NULL,
    project_id text NOT NULL,
    repo_id text NOT NULL,
    sequence bigint NOT NULL CHECK (sequence >= 0),
    revision bigint NOT NULL CHECK (revision >= 0),
    last_op_id text,
    head_digest text NOT NULL,
    writer_holder_id text NOT NULL,
    writer_epoch bigint NOT NULL CHECK (writer_epoch >= 0),
    ${scopeColumns()},
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, project_id, repo_id),
    FOREIGN KEY (tenant_id, project_id, repo_id)
      REFERENCES ha_repo_heads (tenant_id, project_id, repo_id)
  )`,
  ...POSTGRES_EVENT_LEDGER_TABLES.flatMap((tableName) => postgresScopeRlsStatements(tableName)),
]);

function scopeColumns(): string {
  return "readers text[] NOT NULL DEFAULT '{}', policy_epoch bigint NOT NULL";
}
