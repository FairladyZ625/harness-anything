import type { PoolClient } from "pg";
import { entityDeclarationDdlStatements } from "./pg-entity-declarations.ts";
import {
  contractPgEventSummaryIndex,
  eventReadIndexDdl,
  eventRefIndexGrantDdl,
} from "./pg-event-read-index-migration.ts";
import { readIndexDdl } from "./pg-read-index-migration.ts";
import { taskParentIndexDdl } from "./pg-task-parent-index.ts";
import { traceIndexDdl } from "./pg-trace-index.ts";
import { decisionReadStatusDdl } from "./pg-decision-read-status.ts";
import { decisionSearchDdl } from "./pg-decision-search-schema.ts";
import { decisionIndexDdl } from "./pg-decision-index-migration.ts";
import { artifactTimelineDdl } from "./pg-artifact-timeline.ts";
import { documentMetadataDdl } from "./pg-document-metadata-migration.ts";
import { relationFreshnessDdl } from "./pg-relation-freshness.ts";
import { PG_RELATION_CYCLE_TABLES, relationCycleAuditDdl } from "./pg-relation-cycle-audit.ts";
import { relationReaderIndexDdl } from "./pg-relation-queries.ts";
import {
  POSTGRES_SCOPE_COLUMNS_SQL,
  POSTGRES_SCOPE_SCHEMA_CONTRACT,
  postgresScopeRlsStatements,
  postgresScopeWriteGuardFunctionStatements,
} from "../postgres/scope-schema.ts";
import {
  STANDARD_POSTGRES_DIALECT_CAPABILITIES,
  detectPgDialectCapabilities,
  dialectAddColumnIfNotExistsSql,
  dialectCompatibilityPreludeStatements,
  dialectCreateTriggerStatements,
  dialectUpsertSelectSql,
  dialectUpsertValuesSql,
  type PgDialectCapabilities,
} from "../postgres/dialect.ts";

/** Tables populated by projection replay over the canonical event stream. */
export const PG_REBUILDABLE_PROJECTION_TABLES = Object.freeze([
  "ha_task_snapshots",
  "ha_decisions",
  "ha_decision_read_status",
  "ha_search_terms",
  "ha_decision_positions",
  "ha_facts",
  "ha_relations",
  "ha_relation_reader_keys",
  "ha_agents",
  "ha_squads",
  "ha_projection_meta",
  "ha_projection_values",
  "ha_runtime_session_tasks",
  "ha_runtime_unsettled",
  "ha_event_summary_state",
  "ha_entity_declaration_heads",
  "ha_artifact_documents",
  "ha_artifact_counts",
  "ha_relation_freshness_dirty",
  ...PG_RELATION_CYCLE_TABLES,
] as const);

/** Include event-maintained read indexes in the projection's grants and scope policies. */
export const PG_PROJECTION_TABLES = Object.freeze([
  ...PG_REBUILDABLE_PROJECTION_TABLES,
  "ha_fleet_node_tasks",
] as const);

/** Read/digest tables compared with the other backend. The current-set projection is derived
 * from ha_projection_values and is maintained by triggers, so it is not part of the replay audit
 * even though it shares the projection's RLS and grants. */
export const PG_PROJECTION_AUDIT_TABLES = Object.freeze(
  PG_REBUILDABLE_PROJECTION_TABLES.filter(
    (table) =>
      table !== "ha_runtime_unsettled" &&
      table !== "ha_event_summary_state" &&
      table !== "ha_relation_freshness_dirty" &&
      table !== "ha_relation_reader_keys" &&
      !(PG_RELATION_CYCLE_TABLES as readonly string[]).includes(table),
  ),
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
  options: {
    readonly indexBuild?: "concurrent" | "isolated";
    readonly capabilities?: PgDialectCapabilities;
  } = {},
): Promise<void> {
  const capabilities = options.capabilities ?? (await detectPgDialectCapabilities(client));
  for (const statement of projectionDdl(capabilities)) {
    if (options.indexBuild !== "isolated" && statement.startsWith("DROP INDEX IF EXISTS ha_task_snapshots_")) {
      await client.query(statement.replace("DROP INDEX IF EXISTS", "DROP INDEX CONCURRENTLY IF EXISTS"));
      continue;
    }
    const index = /^CREATE INDEX IF NOT EXISTS ([a-z0-9_]+)/u.exec(statement);
    if (index?.[1] === "ha_events_summary_pending" && (await contractPgEventSummaryIndex(client, options))) continue;
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
  for (const table of PG_REBUILDABLE_PROJECTION_TABLES) {
    for (const statement of postgresScopeRlsStatements(table, { ifNotExists: true, capabilities })) {
      await client.query(statement);
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
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${PG_PROJECTION_TABLES.map((table) => `"${table}"`).join(", ")} TO "${roles.runtime}", "${roles.migration}"`,
  );
  for (const statement of eventRefIndexGrantDdl()) await client.query(statement);
}

export function projectionDdl(
  capabilities: PgDialectCapabilities = STANDARD_POSTGRES_DIALECT_CAPABILITIES,
): readonly string[] {
  const unsettledRowUpsert = dialectUpsertValuesSql(capabilities, {
      table: "ha_runtime_unsettled",
      columns: [
        { name: "tenant_id", valueSql: "NEW.tenant_id" },
        { name: "project_id", valueSql: "NEW.project_id" },
        { name: "policy_epoch", valueSql: "NEW.policy_epoch" },
        { name: "readers", valueSql: "NEW.readers" },
        { name: "entity_id", valueSql: "NEW.entity_id" },
        { name: "value", valueSql: "NEW.value" },
      ],
      conflictColumns: ["tenant_id", "project_id", "policy_epoch", "entity_id"],
      updates: [
        { column: "readers", valueSql: "EXCLUDED.readers" },
        { column: "value", valueSql: "EXCLUDED.value" },
      ],
    }),
    unsettledMigrationUpsert = dialectUpsertSelectSql(capabilities, {
      table: "ha_runtime_unsettled",
      columns: ["tenant_id", "project_id", "policy_epoch", "readers", "entity_id", "value"],
      selectSql: `SELECT tenant_id,project_id,policy_epoch,readers,entity_id,value FROM ha_projection_values
          WHERE model='runtime-session' AND owner_id='' AND runtime_outcome IS NULL`,
      conflictColumns: ["tenant_id", "project_id", "policy_epoch", "entity_id"],
      updates: [
        { column: "readers", valueSql: "EXCLUDED.readers" },
        { column: "value", valueSql: "EXCLUDED.value" },
      ],
    }),
    memoryClassColumnSql = capabilities.supportsStoredComputedColumns
      ? "memory_class text GENERATED ALWAYS AS (value->>'memoryClass') STORED"
      : "memory_class text",
    memoryClassMigrationStatements = capabilities.supportsStoredComputedColumns
      ? [
          dialectAddColumnIfNotExistsSql(
            capabilities,
            "ha_facts",
            "memory_class",
            "text GENERATED ALWAYS AS (value->>'memoryClass') STORED",
          ),
        ]
      : [
          dialectAddColumnIfNotExistsSql(capabilities, "ha_facts", "memory_class", "text"),
          `CREATE OR REPLACE FUNCTION ha_facts_memory_class_sync() RETURNS trigger
            LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
            BEGIN
              NEW.memory_class := NEW.value->>'memoryClass';
              RETURN NEW;
            END $function$`,
          ...dialectCreateTriggerStatements(capabilities, {
            triggerName: "ha_facts_memory_class_sync",
            tableName: "ha_facts",
            timingAndEvent: "BEFORE INSERT OR UPDATE OF value",
            functionCall: "ha_facts_memory_class_sync()",
          }),
          "UPDATE ha_facts SET memory_class = value->>'memoryClass' WHERE memory_class IS DISTINCT FROM (value->>'memoryClass')",
        ];
  return [
    ...dialectCompatibilityPreludeStatements(capabilities),
    ...postgresScopeWriteGuardFunctionStatements(capabilities),
    /* @gate-identity state-store/task.projection.ha_projection_values */ `CREATE TABLE IF NOT EXISTS ha_projection_values (
      ${POSTGRES_SCOPE_COLUMNS_SQL}, readers text[] NOT NULL DEFAULT '{}',
      model text NOT NULL, entity_id text NOT NULL, owner_id text NOT NULL DEFAULT '',
      workspace_revision bigint NOT NULL, value text NOT NULL,
      PRIMARY KEY (tenant_id,project_id,policy_epoch,model,owner_id,entity_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ha_projection_values_ordered ON ha_projection_values (tenant_id,project_id,policy_epoch,model,entity_id,owner_id)`,
    `CREATE INDEX IF NOT EXISTS ha_projection_values_latest ON ha_projection_values (tenant_id,project_id,policy_epoch,model,entity_id,workspace_revision DESC)`,
    `CREATE INDEX IF NOT EXISTS ha_projection_values_lookup ON ha_projection_values (tenant_id,project_id,policy_epoch,model,entity_id)`,
    ...documentMetadataDdl(capabilities),
    ...readIndexDdl(capabilities),
    // Current-set projection for the home "in flight" read. A partial index over a mutable
    // outcome column accumulates dead entries between autovacuum runs (the G38 fixture measures
    // immediately after seeding), so an aggregate read must not depend on it. This table holds
    // only unsettled sessions and is maintained by the same write transaction; its size is the
    // current in-flight count, not session history.
    /* @gate-identity state-store/task.projection.ha_event_summary_state */ `CREATE TABLE IF NOT EXISTS ha_event_summary_state (
      tenant_id text NOT NULL,
      project_id text NOT NULL,
      policy_epoch bigint NOT NULL,
      repo_id text NOT NULL,
      ready boolean NOT NULL DEFAULT false,
      PRIMARY KEY(tenant_id,project_id,policy_epoch,repo_id)
    )`,
    /* @gate-identity state-store/task.projection.ha_runtime_unsettled */ `CREATE TABLE IF NOT EXISTS ha_runtime_unsettled (
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
            ${unsettledRowUpsert};
          ELSE
            DELETE FROM ha_runtime_unsettled WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id
              AND policy_epoch=NEW.policy_epoch AND entity_id=NEW.entity_id;
          END IF;
        END IF;
        RETURN NEW;
      END $function$`,
    ...dialectCreateTriggerStatements(capabilities, {
      triggerName: "ha_runtime_unsettled_sync",
      tableName: "ha_projection_values",
      timingAndEvent: "AFTER INSERT OR UPDATE OF value, runtime_outcome",
      whenSql: "NEW.model = 'runtime-session' AND NEW.owner_id = ''",
      functionCall: "ha_runtime_unsettled_sync()",
    }),
    ...dialectCreateTriggerStatements(capabilities, {
      triggerName: "ha_runtime_unsettled_delete",
      tableName: "ha_projection_values",
      timingAndEvent: "AFTER DELETE",
      whenSql: "OLD.model = 'runtime-session' AND OLD.owner_id = ''",
      functionCall: "ha_runtime_unsettled_sync()",
    }),
    `DO $migration$
      BEGIN
        IF to_regclass('ha_projection_meta') IS NOT NULL THEN
          ${unsettledMigrationUpsert};
        END IF;
      END $migration$`,
    ...artifactTimelineDdl(capabilities),
    ...eventReadIndexDdl(capabilities),
    // Workspace scope event windows seek the explicit canonical task id.  The generic
    // task-index expression also covers runtime ownership, but it cannot serve this
    // predicate for task bootstrap/progress events without scanning unrelated history.
    // Keep the index on the ledger row and let the existing event readers apply the
    // reader visibility predicate and revision cut.
    `CREATE INDEX IF NOT EXISTS ha_events_canonical_task_revision ON ha_events
      (tenant_id,project_id,policy_epoch,repo_id,canonical_task_id,revision DESC)
      WHERE event_type <> 'ci_run_observed'`,
    // Retire only the disposable nonunique expression index after its scalar replacement exists.
    // It rejects valid opaque provider bytes and cannot serve runtime RLS's outcome predicate.
    // No table, column, identity key or canonical value is removed.
    `DROP INDEX IF EXISTS ha_projection_values_runtime_unsettled`,
    `CREATE INDEX IF NOT EXISTS ha_projection_document_revision ON ha_projection_values
      (tenant_id,project_id,policy_epoch,workspace_revision,entity_id)
      WHERE model IN ('document','document-history') AND owner_id=''`,
    `CREATE INDEX IF NOT EXISTS ha_projection_document_path ON ha_projection_values
      (tenant_id,project_id,policy_epoch,entity_id COLLATE "C") WHERE model='document' AND owner_id=''`,
    /* @gate-identity state-store/task.projection.ha_task_snapshots */ `CREATE TABLE IF NOT EXISTS ha_task_snapshots (
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
    /* @gate-identity state-store/task.projection.ha_decisions */ `CREATE TABLE IF NOT EXISTS ha_decisions (
      ${POSTGRES_SCOPE_COLUMNS_SQL},
      readers text[] NOT NULL DEFAULT '{}',
      decision_id text NOT NULL,
      workspace_revision bigint NOT NULL,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, project_id, policy_epoch, decision_id)
    )`,
    ...decisionIndexDdl(capabilities),
    /* @gate-identity state-store/task.projection.ha_facts */ `CREATE TABLE IF NOT EXISTS ha_facts (
      ${POSTGRES_SCOPE_COLUMNS_SQL},
      readers text[] NOT NULL DEFAULT '{}',
      fact_id text NOT NULL,
      workspace_revision bigint NOT NULL,
      value jsonb NOT NULL,
      ${memoryClassColumnSql},
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, project_id, policy_epoch, fact_id)
    )`,
    /* @gate-identity state-store/task.projection.ha_relations */ `CREATE TABLE IF NOT EXISTS ha_relations (
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
    /* @gate-identity state-store/task.projection.ha_agents */ `CREATE TABLE IF NOT EXISTS ha_agents (
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
    /* @gate-identity state-store/task.projection.ha_squads */ `CREATE TABLE IF NOT EXISTS ha_squads (
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
    /* @gate-identity state-store/task.projection.ha_projection_meta */ `CREATE TABLE IF NOT EXISTS ha_projection_meta (
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
    ...relationFreshnessDdl(capabilities),
    ...relationCycleAuditDdl(capabilities),
    ...relationReaderIndexDdl(capabilities),
    ...entityDeclarationDdlStatements(capabilities),
    ...decisionSearchDdl(capabilities),
    ...decisionReadStatusDdl(capabilities),
    `CREATE INDEX IF NOT EXISTS ha_document_heads_search_owner ON ha_document_heads
      (tenant_id,project_id,policy_epoch,path,repo_id)`,
    ...PG_REBUILDABLE_PROJECTION_TABLES.map((table) =>
      dialectAddColumnIfNotExistsSql(capabilities, table, "readers", "text[] NOT NULL DEFAULT '{}'"),
    ),
    dialectAddColumnIfNotExistsSql(capabilities, "ha_task_snapshots", "raw_lease", "jsonb"),
    dialectAddColumnIfNotExistsSql(capabilities, "ha_task_snapshots", "package_path", "text"),
    // Old binary wrote projections before the artifact timeline index existed; the version asks
    // the embedded upgrade path to backfill once. Fresh inserts declare themselves complete.
    dialectAddColumnIfNotExistsSql(
      capabilities,
      "ha_projection_meta",
      "artifact_index_version",
      "smallint NOT NULL DEFAULT 0",
    ),
    // Same contract for the dispatch lifecycle model: an older meta row reads pending until the
    // lifecycle backfill refolds it; fresh inserts declare the current model version.
    dialectAddColumnIfNotExistsSql(
      capabilities,
      "ha_projection_meta",
      "dispatch_lifecycle_version",
      "smallint NOT NULL DEFAULT 0",
    ),
    // Same contract for the canonical Inbox model.
    dialectAddColumnIfNotExistsSql(capabilities, "ha_projection_meta", "inbox_version", "smallint NOT NULL DEFAULT 0"),
    // Same contract for the PeerRequestV1 model.
    dialectAddColumnIfNotExistsSql(
      capabilities,
      "ha_projection_meta",
      "peer_request_version",
      "smallint NOT NULL DEFAULT 0",
    ),
    // Same contract for the shared KB document model.
    dialectAddColumnIfNotExistsSql(
      capabilities,
      "ha_projection_meta",
      "kb_document_version",
      "smallint NOT NULL DEFAULT 0",
    ),
    dialectAddColumnIfNotExistsSql(capabilities, "ha_task_snapshots", "generation", "text NOT NULL DEFAULT 'v1'"),
    dialectAddColumnIfNotExistsSql(capabilities, "ha_task_snapshots", "created_at", "timestamptz"),
    dialectAddColumnIfNotExistsSql(capabilities, "ha_task_snapshots", "completed_at", "timestamptz"),
    ...memoryClassMigrationStatements,
    "CREATE INDEX IF NOT EXISTS ha_task_snapshots_package_path ON ha_task_snapshots (tenant_id,project_id,policy_epoch,package_path)",
    // A lifecycle-status page (home "done in the last 24h", fleet "active leases") is an index
    // range, not a scan of every task the repository ever had.
    "CREATE INDEX IF NOT EXISTS ha_task_snapshots_scope_revision ON ha_task_snapshots (tenant_id, project_id, workspace_revision DESC)",
    ...taskParentIndexDdl(capabilities),
    ...traceIndexDdl(capabilities),
    "CREATE INDEX IF NOT EXISTS ha_task_snapshots_status_updated_v2 ON ha_task_snapshots (tenant_id,project_id,policy_epoch,task_status,updated_at DESC,task_id)",
    "DROP INDEX IF EXISTS ha_task_snapshots_status_updated",
    ...PG_REBUILDABLE_PROJECTION_TABLES.map(
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
