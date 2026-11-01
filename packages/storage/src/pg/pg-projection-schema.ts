import type { PoolClient } from "pg";
import {
  POSTGRES_SCOPE_COLUMNS_SQL,
  POSTGRES_SCOPE_SCHEMA_CONTRACT,
  postgresScopeRlsStatements,
} from "../postgres/scope-schema.ts";

/** Tables owned by the PG projection adapter. The canonical event ledger remains A2's schema. */
export const PG_PROJECTION_TABLES = Object.freeze([
  "ha_task_snapshots",
  "ha_decisions",
  "ha_facts",
  "ha_relations",
  "ha_agents",
  "ha_squads",
  "ha_projection_meta",
  "ha_projection_values",
] as const);

export const PG_PROJECTION_SCHEMA_VERSION = 3;

/** Rebuildable cache generations are admitted before either reads or incremental writes. */
export function assertPgProjectionSchemaVersion(version: number | undefined): void {
  if (version !== undefined && version !== PG_PROJECTION_SCHEMA_VERSION)
    throw Object.assign(
      new Error(
        `kernel projection schema ${version} does not match supported schema ${PG_PROJECTION_SCHEMA_VERSION}; writer recovery must publish a compatible generation`,
      ),
      { code: "kernel_schema_mismatch" },
    );
}

/**
 * Create the projection tables as the shared schema owner. Runtime callers only need the grants and RLS
 * policies; they must not run this function. The DDL is deliberately independent from A2's ledger tables so a
 * projection can be dropped and rebuilt from the canonical stream.
 */
export async function ensurePgProjectionSchema(client: PoolClient): Promise<void> {
  for (const statement of projectionDdl()) await client.query(statement);
  for (const table of PG_PROJECTION_TABLES) {
    for (const statement of postgresScopeRlsStatements(table)) {
      if (statement.startsWith("CREATE POLICY ")) {
        const policy = `${table}_scope_policy`;
        await client.query(
          `DO $policy$ BEGIN
             IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = '${table}' AND policyname = '${policy}') THEN
               EXECUTE $policy_sql$${statement}$policy_sql$;
             END IF;
           END $policy$`,
        );
      } else {
        await client.query(statement);
      }
    }
  }
}

/** Grant the runtime and migration roles access without granting either role schema ownership or BYPASSRLS. */
export async function grantPgProjectionRuntimeAccess(client: PoolClient): Promise<void> {
  const roles = POSTGRES_SCOPE_SCHEMA_CONTRACT.roles;
  await client.query(`GRANT USAGE ON SCHEMA public TO "${roles.runtime}", "${roles.migration}"`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${PG_PROJECTION_TABLES.map((table) => `"${table}"`).join(", ")} TO "${roles.runtime}", "${roles.migration}"`,
  );
}

export function projectionDdl(): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ha_projection_values (
      ${POSTGRES_SCOPE_COLUMNS_SQL}, readers text[] NOT NULL DEFAULT '{}',
      model text NOT NULL, entity_id text NOT NULL, owner_id text NOT NULL DEFAULT '',
      workspace_revision bigint NOT NULL, value jsonb NOT NULL,
      PRIMARY KEY (tenant_id,project_id,policy_epoch,model,owner_id,entity_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ha_projection_values_lookup ON ha_projection_values (tenant_id,project_id,policy_epoch,model,entity_id)`,
    `CREATE INDEX IF NOT EXISTS ha_projection_values_value_gin ON ha_projection_values USING gin(value)`,
    `CREATE TABLE IF NOT EXISTS ha_task_snapshots (
      ${POSTGRES_SCOPE_COLUMNS_SQL},
      readers text[] NOT NULL DEFAULT '{}',
      task_id text NOT NULL,
      workspace_revision bigint NOT NULL,
      snapshot jsonb NOT NULL,
      raw_lease jsonb,
      package_path text,
      generation text NOT NULL DEFAULT 'v1',
      created_at timestamptz,
      completed_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, project_id, policy_epoch, task_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ha_decisions (
      ${POSTGRES_SCOPE_COLUMNS_SQL},
      readers text[] NOT NULL DEFAULT '{}',
      decision_id text NOT NULL,
      workspace_revision bigint NOT NULL,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, project_id, policy_epoch, decision_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ha_facts (
      ${POSTGRES_SCOPE_COLUMNS_SQL},
      readers text[] NOT NULL DEFAULT '{}',
      fact_id text NOT NULL,
      workspace_revision bigint NOT NULL,
      value jsonb NOT NULL,
      memory_class text GENERATED ALWAYS AS (value->>'memoryClass') STORED,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, project_id, policy_epoch, fact_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ha_relations (
      ${POSTGRES_SCOPE_COLUMNS_SQL},
      readers text[] NOT NULL DEFAULT '{}',
      relation_id text NOT NULL,
      source_ref text NOT NULL,
      target_ref text NOT NULL,
      relation_type text NOT NULL,
      relation_state text NOT NULL,
      workspace_revision bigint NOT NULL,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, project_id, policy_epoch, relation_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ha_agents (
      ${POSTGRES_SCOPE_COLUMNS_SQL},
      readers text[] NOT NULL DEFAULT '{}',
      agent_id text NOT NULL,
      workspace_revision bigint NOT NULL,
      declaration_revision bigint NOT NULL,
      declaration jsonb NOT NULL,
      document_path text,
      document_sha256 text,
      extension_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, project_id, policy_epoch, agent_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ha_squads (
      ${POSTGRES_SCOPE_COLUMNS_SQL},
      readers text[] NOT NULL DEFAULT '{}',
      squad_id text NOT NULL,
      workspace_revision bigint NOT NULL,
      declaration_revision bigint NOT NULL,
      declaration jsonb NOT NULL,
      document_path text,
      document_sha256 text,
      extension_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, project_id, policy_epoch, squad_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ha_projection_meta (
      ${POSTGRES_SCOPE_COLUMNS_SQL},
      readers text[] NOT NULL DEFAULT '{}',
      projection_name text NOT NULL DEFAULT 'task/v1',
      schema_version integer NOT NULL,
      watermark bigint NOT NULL DEFAULT 0,
      source_revision bigint NOT NULL DEFAULT 0,
      state_digest text,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, project_id, policy_epoch, projection_name)
    )`,
    ...PG_PROJECTION_TABLES.map(
      (table) => `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS readers text[] NOT NULL DEFAULT '{}'`,
    ),
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS raw_lease jsonb",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS package_path text",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS generation text NOT NULL DEFAULT 'v1'",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS created_at timestamptz",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS completed_at timestamptz",
    "ALTER TABLE ha_facts ADD COLUMN IF NOT EXISTS memory_class text GENERATED ALWAYS AS (value->>'memoryClass') STORED",
    "CREATE INDEX IF NOT EXISTS ha_task_snapshots_scope_revision ON ha_task_snapshots (tenant_id, project_id, workspace_revision DESC)",
    ...PG_PROJECTION_TABLES.map(
      (table) => `CREATE INDEX IF NOT EXISTS ${table}_readers_gin ON ${table} USING gin (readers)`,
    ),
    "CREATE INDEX IF NOT EXISTS ha_decisions_value_gin ON ha_decisions USING gin (value)",
    "CREATE INDEX IF NOT EXISTS ha_facts_value_gin ON ha_facts USING gin (value)",
    // JSONB extraction/containment is not leakproof. A stored scalar allows the runtime's
    // equality predicate to use this index below the forced RLS barrier.
    "CREATE INDEX IF NOT EXISTS ha_facts_memory_class ON ha_facts (tenant_id, project_id, policy_epoch, memory_class)",
    "CREATE INDEX IF NOT EXISTS ha_relations_source ON ha_relations (tenant_id, project_id, source_ref, relation_type)",
    "CREATE INDEX IF NOT EXISTS ha_relations_target ON ha_relations (tenant_id, project_id, target_ref, relation_type)",
    "CREATE INDEX IF NOT EXISTS ha_relations_value_gin ON ha_relations USING gin (value)",
    "CREATE INDEX IF NOT EXISTS ha_agents_value_gin ON ha_agents USING gin (declaration)",
    "CREATE INDEX IF NOT EXISTS ha_squads_value_gin ON ha_squads USING gin (declaration)",
  ];
}
