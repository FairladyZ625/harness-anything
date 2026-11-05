import type { PoolClient } from "pg";
import { entityDeclarationDdl } from "./pg-entity-declarations.ts";
import { eventReadIndexDdl } from "./pg-event-read-index-migration.ts";
import { readIndexDdl } from "./pg-read-index-migration.ts";
import { taskParentIndexDdl } from "./pg-task-parent-index.ts";
import { decisionReadStatusDdl } from "./pg-decision-read-status.ts";
import { decisionSearchDdl } from "./pg-decision-search-schema.ts";
import { decisionIndexDdl } from "./pg-decision-index-migration.ts";
import { documentMetadataDdl } from "./pg-document-metadata-migration.ts";
import {
  POSTGRES_SCOPE_COLUMNS_SQL,
  POSTGRES_SCOPE_SCHEMA_CONTRACT,
  postgresScopeRlsStatements,
} from "../postgres/scope-schema.ts";

/** Tables owned by the PG projection adapter. The canonical event ledger remains A2's schema. */
export const PG_PROJECTION_TABLES = Object.freeze([
  "ha_task_snapshots",
  "ha_decisions",
  "ha_decision_read_status",
  "ha_search_terms",
  "ha_decision_positions",
  "ha_facts",
  "ha_relations",
  "ha_agents",
  "ha_squads",
  "ha_projection_meta",
  "ha_projection_values",
  "ha_runtime_session_tasks",
  "ha_runtime_unsettled",
  "ha_event_summary_state",
  "ha_entity_declaration_heads",
] as const);

/** Read/digest tables compared with the other backend. The current-set projection is derived
 * from ha_projection_values and is maintained by triggers, so it is not part of the replay audit
 * even though it shares the projection's RLS and grants. */
export const PG_PROJECTION_AUDIT_TABLES = Object.freeze(
  PG_PROJECTION_TABLES.filter((table) => table !== "ha_runtime_unsettled" && table !== "ha_event_summary_state"),
);

// Metadata is an additive expansion of v5; retain the generation understood by previous binaries.
export const PG_PROJECTION_SCHEMA_VERSION = 5;

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
 * policies; they must not run this function. A2's ledger schema must already exist: its derived read-index
 * columns extend immutable event bytes. Projection tables can still be dropped and rebuilt from that stream.
 */
export async function ensurePgProjectionSchema(
  client: PoolClient,
  options: { readonly indexBuild?: "concurrent" | "isolated" } = {},
): Promise<void> {
  for (const statement of projectionDdl()) {
    const index = /^CREATE INDEX IF NOT EXISTS ([a-z0-9_]+)/u.exec(statement);
    if (index && options.indexBuild !== "isolated") {
      // An interrupted concurrent build leaves an invalid index. IF NOT EXISTS alone
      // would silently keep it forever. Only disposable, invalid indexes are removed.
      const existing = await client.query<{ indisvalid: boolean }>(
        "SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass($1)",
        [index[1]],
      );
      if (existing.rows[0]?.indisvalid === false) await client.query(`DROP INDEX CONCURRENTLY ${index[1]}`);
      await client.query(statement.replace("CREATE INDEX IF NOT EXISTS", "CREATE INDEX CONCURRENTLY IF NOT EXISTS"));
    } else await client.query(statement);
  }
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
    `GRANT USAGE ON SEQUENCE ha_search_terms_term_slot_seq TO "${roles.runtime}", "${roles.migration}"`,
  );
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${PG_PROJECTION_TABLES.map((table) => `"${table}"`).join(", ")}, ha_event_summary_state TO "${roles.runtime}", "${roles.migration}"`,
  );
}

export function projectionDdl(): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ha_projection_values (
      ${POSTGRES_SCOPE_COLUMNS_SQL}, readers text[] NOT NULL DEFAULT '{}',
      model text NOT NULL, entity_id text NOT NULL, owner_id text NOT NULL DEFAULT '',
      workspace_revision bigint NOT NULL, value text NOT NULL,
      PRIMARY KEY (tenant_id,project_id,policy_epoch,model,owner_id,entity_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ha_projection_values_ordered ON ha_projection_values (tenant_id,project_id,policy_epoch,model,entity_id,owner_id)`,
    `CREATE INDEX IF NOT EXISTS ha_projection_values_latest ON ha_projection_values (tenant_id,project_id,policy_epoch,model,entity_id,workspace_revision DESC)`,
    `CREATE INDEX IF NOT EXISTS ha_projection_values_lookup ON ha_projection_values (tenant_id,project_id,policy_epoch,model,entity_id)`,
    ...documentMetadataDdl(),
    ...readIndexDdl(),
    // Current-set projection for the home "in flight" read. A partial index over a mutable
    // outcome column accumulates dead entries between autovacuum runs (the G38 fixture measures
    // immediately after seeding), so an aggregate read must not depend on it. This table holds
    // only unsettled sessions and is maintained by the same write transaction; its size is the
    // current in-flight count, not session history.
    `CREATE TABLE IF NOT EXISTS ha_event_summary_state (
      tenant_id text NOT NULL,
      project_id text NOT NULL,
      policy_epoch bigint NOT NULL,
      repo_id text NOT NULL,
      ready boolean NOT NULL DEFAULT false,
      PRIMARY KEY(tenant_id,project_id,policy_epoch,repo_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ha_runtime_unsettled (
      tenant_id text NOT NULL,
      project_id text NOT NULL,
      policy_epoch bigint NOT NULL,
      readers text[] NOT NULL DEFAULT '{}',
      entity_id text NOT NULL,
      value text NOT NULL,
      PRIMARY KEY(tenant_id,project_id,policy_epoch,entity_id)
    )`,
    `CREATE OR REPLACE FUNCTION ha_runtime_unsettled_sync() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      BEGIN
        IF TG_OP='DELETE' THEN
          DELETE FROM ha_runtime_unsettled WHERE tenant_id=OLD.tenant_id AND project_id=OLD.project_id
            AND policy_epoch=OLD.policy_epoch AND entity_id=OLD.entity_id;
          RETURN OLD;
        END IF;
        IF NEW.model='runtime-session' AND NEW.owner_id='' THEN
          IF NEW.runtime_outcome IS NULL THEN
            INSERT INTO ha_runtime_unsettled(tenant_id,project_id,policy_epoch,readers,entity_id,value)
            VALUES (NEW.tenant_id,NEW.project_id,NEW.policy_epoch,NEW.readers,NEW.entity_id,NEW.value)
            ON CONFLICT (tenant_id,project_id,policy_epoch,entity_id)
            DO UPDATE SET readers=EXCLUDED.readers, value=EXCLUDED.value;
          ELSE
            DELETE FROM ha_runtime_unsettled WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id
              AND policy_epoch=NEW.policy_epoch AND entity_id=NEW.entity_id;
          END IF;
        END IF;
        RETURN NEW;
      END $function$`,
    `CREATE OR REPLACE TRIGGER ha_runtime_unsettled_sync AFTER INSERT OR UPDATE OF value, runtime_outcome
      ON ha_projection_values FOR EACH ROW
      WHEN (NEW.model = 'runtime-session' AND NEW.owner_id = '')
      EXECUTE FUNCTION ha_runtime_unsettled_sync()`,
    `CREATE OR REPLACE TRIGGER ha_runtime_unsettled_delete AFTER DELETE ON ha_projection_values
      FOR EACH ROW
      WHEN (OLD.model = 'runtime-session' AND OLD.owner_id = '')
      EXECUTE FUNCTION ha_runtime_unsettled_sync()`,
    `DO $migration$
      BEGIN
        IF to_regclass('ha_projection_meta') IS NOT NULL THEN
          INSERT INTO ha_runtime_unsettled(tenant_id,project_id,policy_epoch,readers,entity_id,value)
          SELECT tenant_id,project_id,policy_epoch,readers,entity_id,value FROM ha_projection_values
          WHERE model='runtime-session' AND owner_id='' AND runtime_outcome IS NULL
          ON CONFLICT (tenant_id,project_id,policy_epoch,entity_id)
          DO UPDATE SET readers=EXCLUDED.readers, value=EXCLUDED.value;
        END IF;
      END $migration$`,
    ...eventReadIndexDdl(),
    // Retire only the disposable nonunique expression index after its scalar replacement exists.
    // It rejects valid opaque provider bytes and cannot serve runtime RLS's outcome predicate.
    // No table, column, identity key or canonical value is removed.
    `DROP INDEX IF EXISTS ha_projection_values_runtime_unsettled`,
    `CREATE INDEX IF NOT EXISTS ha_projection_document_path ON ha_projection_values
      (tenant_id,project_id,policy_epoch,entity_id COLLATE "C") WHERE model='document' AND owner_id=''`,
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
    ...decisionIndexDdl(),
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
    ...entityDeclarationDdl,
    ...decisionSearchDdl(),
    ...decisionReadStatusDdl(),
    `CREATE INDEX IF NOT EXISTS ha_document_heads_search_owner ON ha_document_heads
      (tenant_id,project_id,policy_epoch,path,repo_id)`,
    ...PG_PROJECTION_TABLES.map(
      (table) => `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS readers text[] NOT NULL DEFAULT '{}'`,
    ),
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS raw_lease jsonb",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS package_path text",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS generation text NOT NULL DEFAULT 'v1'",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS created_at timestamptz",
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS completed_at timestamptz",
    "ALTER TABLE ha_facts ADD COLUMN IF NOT EXISTS memory_class text GENERATED ALWAYS AS (value->>'memoryClass') STORED",
    "CREATE INDEX IF NOT EXISTS ha_task_snapshots_package_path ON ha_task_snapshots (tenant_id,project_id,policy_epoch,package_path)",
    // A lifecycle-status page (home "done in the last 24h", fleet "active leases") is an index
    // range, not a scan of every task the repository ever had.
    "CREATE INDEX IF NOT EXISTS ha_task_snapshots_lease_active ON ha_task_snapshots (tenant_id, project_id, policy_epoch, task_id) WHERE (snapshot #>> '{task,status}') = 'active' AND raw_lease IS NOT NULL AND raw_lease->>'phase' <> 'released'",
    "CREATE INDEX IF NOT EXISTS ha_task_snapshots_status_updated ON ha_task_snapshots (tenant_id,project_id,policy_epoch,(snapshot #>> '{task,status}'),updated_at DESC,task_id)",
    "CREATE INDEX IF NOT EXISTS ha_task_snapshots_scope_revision ON ha_task_snapshots (tenant_id, project_id, workspace_revision DESC)",
    ...taskParentIndexDdl(),
    ...PG_PROJECTION_TABLES.map(
      (table) => `CREATE INDEX IF NOT EXISTS ${table}_readers_gin ON ${table} USING gin (readers)`,
    ),
    "CREATE INDEX IF NOT EXISTS ha_decisions_value_gin ON ha_decisions USING gin (value)",
    "CREATE INDEX IF NOT EXISTS ha_facts_value_gin ON ha_facts USING gin (value)",
    // JSONB extraction/containment is not leakproof. A stored scalar allows the runtime's
    // equality predicate to use this index below the forced RLS barrier.
    "CREATE INDEX IF NOT EXISTS ha_facts_memory_class ON ha_facts (tenant_id, project_id, policy_epoch, memory_class)",
    'CREATE INDEX IF NOT EXISTS ha_relations_source_scope ON ha_relations (tenant_id,project_id,policy_epoch,source_ref COLLATE "C",relation_id)',
    'CREATE INDEX IF NOT EXISTS ha_relations_target_scope ON ha_relations (tenant_id,project_id,policy_epoch,target_ref COLLATE "C",relation_id)',
    "CREATE INDEX IF NOT EXISTS ha_relations_source ON ha_relations (tenant_id, project_id, source_ref, relation_type)",
    "CREATE INDEX IF NOT EXISTS ha_relations_target ON ha_relations (tenant_id, project_id, target_ref, relation_type)",
    "CREATE INDEX IF NOT EXISTS ha_relations_value_gin ON ha_relations USING gin (value)",
    "CREATE INDEX IF NOT EXISTS ha_agents_value_gin ON ha_agents USING gin (declaration)",
    "CREATE INDEX IF NOT EXISTS ha_squads_value_gin ON ha_squads USING gin (declaration)",
  ];
}
