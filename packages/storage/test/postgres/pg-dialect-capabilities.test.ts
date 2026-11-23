// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";
import {
  STANDARD_POSTGRES_DIALECT_CAPABILITIES,
  capabilitiesFromProbeRow,
  dialectAddColumnIfNotExistsSql,
  dialectCompatibilityPreludeStatements,
  dialectCreateTriggerStatements,
  dialectCurrentSettingSql,
  dialectCurrentWalLsnSql,
  dialectLsnSyncFunctionSignature,
  dialectRuntimeRoleUnsafeQuery,
  dialectUpsertDoNothingSql,
  dialectUpsertSelectSql,
  dialectUpsertValuesSql,
  ensurePoolDialectCapabilities,
  type PgDialectCapabilities,
} from "../../src/postgres/dialect.ts";
import { postgresEventLedgerSchemaStatements } from "../../src/postgres/event-ledger-schema.ts";
import {
  postgresScopeRlsStatements,
  postgresScopeWriteGuardFunctionStatements,
} from "../../src/postgres/scope-schema.ts";
import { postgresStorageMigrationSchema } from "../../src/migration/postgres-schema.ts";
import { projectionDdl } from "../../src/pg/pg-projection-schema.ts";
import { readPgProjectionStoredRows } from "../../src/pg/pg-projection-stored-rows.ts";

const STANDARD_PG16_PROBE = {
  version_text: "PostgreSQL 16.4 on x86_64-pc-linux-gnu",
  server_version: "16.4",
  server_version_num: "160004",
  sql_compatibility: null,
  has_pg_lsn: true,
  has_xid8: true,
  has_wal_flush_lsn: true,
  has_xlog_location: false,
  has_current_setting_2arg: true,
  has_gen_random_uuid: true,
  has_starts_with: true,
  has_cardinality: true,
  has_to_regclass: true,
  has_row_security_active: true,
  has_jsonb_to_recordset: true,
  has_jsonb_build_object: true,
  has_jsonb_set: true,
  has_transaction_timeout: false,
  has_rolbypassrls: true,
  has_stat_rep_flush_lsn: true,
  has_stat_rep_receiver_flush: false,
  has_pg_policies: true,
  has_pg_rlspolicies: false,
} as const;

const OPENGAUSS_503_PG_PROBE = {
  version_text: "PostgreSQL 9.2.4 (openGauss-lite 5.0.3 build 89d144c2) compiled at 2024-08-01",
  server_version: "9.2.4",
  server_version_num: "90204",
  sql_compatibility: "PG",
  has_pg_lsn: false,
  has_xid8: false,
  has_wal_flush_lsn: false,
  has_xlog_location: true,
  has_current_setting_2arg: false,
  has_gen_random_uuid: false,
  has_starts_with: false,
  has_cardinality: false,
  has_to_regclass: false,
  has_row_security_active: false,
  has_jsonb_to_recordset: false,
  has_jsonb_build_object: false,
  has_jsonb_set: false,
  has_transaction_timeout: false,
  has_rolbypassrls: false,
  has_stat_rep_flush_lsn: false,
  has_stat_rep_receiver_flush: true,
  has_pg_policies: false,
  has_pg_rlspolicies: true,
} as const;

test("capabilitiesFromProbeRow classifies PostgreSQL 16+ without extra compatibility prelude", () => {
  const caps = capabilitiesFromProbeRow(STANDARD_PG16_PROBE);
  assert.equal(caps.engine, "postgresql");
  assert.equal(caps.supportsOnConflict, true);
  assert.equal(caps.supportsRlsWithCheck, true);
  assert.equal(caps.supportsForceRls, true);
  assert.equal(caps.supportsWalLsn, true);
  assert.equal(caps.supportsStoredComputedColumns, true);
  assert.equal(caps.supportsLateralJoin, true);
  assert.equal(caps.supportsWithOrdinality, true);
  assert.equal(caps.supportsParallelSafe, true);
  assert.equal(caps.supportsIdentityColumns, true);
  assert.equal(caps.supportsTriggerTransitionTables, true);
  assert.equal(caps.supportsRoleBypassRls, true);
  assert.equal(caps.supportsPgPoliciesView, true);
  assert.equal(caps.supportsExtendedJsonb, true);
  assert.deepEqual(dialectCompatibilityPreludeStatements(caps), []);
  assert.deepEqual(postgresScopeWriteGuardFunctionStatements(caps), []);
  assert.equal(dialectCurrentSettingSql(caps, "ha.tenant_id"), "current_setting('ha.tenant_id', true)");
  assert.equal(dialectCurrentWalLsnSql(caps), "pg_current_wal_flush_lsn()");
  assert.equal(dialectLsnSyncFunctionSignature(caps), "ha_is_lsn_sync_confirmed(pg_lsn)");
});

test("capabilitiesFromProbeRow classifies openGauss 5.0.3 PG-compatibility mode accurately", () => {
  const caps = capabilitiesFromProbeRow(OPENGAUSS_503_PG_PROBE);
  assert.equal(caps.engine, "opengauss");
  assert.equal(caps.sqlCompatibility, "PG");
  assert.equal(caps.supportsOnConflict, false);
  assert.equal(caps.supportsRlsWithCheck, false);
  assert.equal(caps.supportsForceRls, true);
  assert.equal(caps.supportsWalLsn, false);
  assert.equal(caps.supportsXlogLocation, true);
  assert.equal(caps.supportsStoredComputedColumns, true);
  assert.equal(caps.supportsLateralJoin, false);
  assert.equal(caps.supportsWithOrdinality, false);
  assert.equal(caps.supportsParallelSafe, false);
  assert.equal(caps.supportsIdentityColumns, false);
  assert.equal(caps.supportsTriggerTransitionTables, false);
  assert.equal(caps.supportsTransactionDurationGuc, false);
  assert.equal(caps.supportsRoleBypassRls, false);
  assert.equal(caps.supportsPgPoliciesView, false);
  assert.equal(caps.supportsExtendedJsonb, false);
  assert.equal(dialectCurrentSettingSql(caps, "ha.tenant_id"), "public.ha_current_setting('ha.tenant_id')");
  assert.equal(dialectCurrentWalLsnSql(caps), "pg_current_xlog_location()");
  assert.equal(dialectLsnSyncFunctionSignature(caps), "ha_is_lsn_sync_confirmed(text)");
  assert.match(dialectRuntimeRoleUnsafeQuery(caps), /r\.rolsystemadmin/u);
  assert.doesNotMatch(dialectRuntimeRoleUnsafeQuery(caps), /rolbypassrls/u);
});

test("capabilitiesFromProbeRow fails closed on non-PG openGauss sql_compatibility and missing primitives", () => {
  for (const mode of ["A", "B", "C", "", null] as const) {
    assert.throws(
      () => capabilitiesFromProbeRow({ ...OPENGAUSS_503_PG_PROBE, sql_compatibility: mode }),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === "pg_dialect_incompatible" &&
        /DBCOMPATIBILITY 'PG'/u.test(error.message),
      `expected openGauss sql_compatibility=${String(mode)} to fail closed`,
    );
  }
  assert.equal(capabilitiesFromProbeRow({ ...OPENGAUSS_503_PG_PROBE, sql_compatibility: "pg" }).engine, "opengauss");
  assert.throws(
    () =>
      capabilitiesFromProbeRow({
        ...OPENGAUSS_503_PG_PROBE,
        has_pg_policies: false,
        has_pg_rlspolicies: false,
      }),
    (error: unknown) => (error as { code?: string }).code === "pg_dialect_incompatible",
  );
  assert.throws(
    () =>
      capabilitiesFromProbeRow({
        ...OPENGAUSS_503_PG_PROBE,
        has_wal_flush_lsn: false,
        has_xlog_location: false,
      }),
    (error: unknown) => (error as { code?: string }).code === "pg_dialect_incompatible",
  );
});

test("SQL builders generate PG 16+ vs openGauss-compatible upsert, column, trigger and RLS DDL", () => {
  const og = capabilitiesFromProbeRow(OPENGAUSS_503_PG_PROBE);
  assert.equal(dialectUpsertDoNothingSql(STANDARD_POSTGRES_DIALECT_CAPABILITIES), "ON CONFLICT DO NOTHING");
  assert.equal(dialectUpsertDoNothingSql(og), "ON DUPLICATE KEY UPDATE NOTHING");

  const ogMerge = dialectUpsertValuesSql(og, {
    table: "ha_facts",
    columns: [
      { name: "tenant_id", valueSql: "$1::text" },
      { name: "fact_id", valueSql: "$2::text" },
      { name: "workspace_revision", valueSql: "$3::bigint" },
      { name: "value", valueSql: "$4::jsonb" },
    ],
    conflictColumns: ["tenant_id", "fact_id"],
    updates: [
      { column: "tenant_id", valueSql: "excluded.tenant_id" },
      { column: "workspace_revision", valueSql: "excluded.workspace_revision" },
      { column: "value", valueSql: "excluded.value" },
    ],
    whereSql: "ha_facts.workspace_revision < excluded.workspace_revision",
  });
  assert.match(ogMerge, /^MERGE INTO ha_facts AS ha_tgt USING /u);
  assert.match(
    ogMerge,
    /WHEN MATCHED THEN UPDATE SET workspace_revision = ha_src\.workspace_revision, value = ha_src\.value WHERE ha_tgt\.workspace_revision < ha_src\.workspace_revision/u,
  );
  assert.doesNotMatch(ogMerge, /SET tenant_id/u);
  assert.doesNotMatch(ogMerge, /ON DUPLICATE KEY/u);

  const ogMergeSelect = dialectUpsertSelectSql(og, {
    table: "ha_event_summary_state",
    columns: ["tenant_id", "repo_id", "ready"],
    selectSql: "SELECT $1::text AS tenant_id, $2::text AS repo_id, true AS ready",
    conflictColumns: ["tenant_id", "repo_id"],
    updates: [{ column: "ready", valueSql: "EXCLUDED.ready" }],
  });
  assert.match(ogMergeSelect, /^MERGE INTO ha_event_summary_state AS ha_tgt USING /u);

  const ogAddCol = dialectAddColumnIfNotExistsSql(og, "ha_events", "summary_json", "text");
  assert.match(ogAddCol, /DO \$col\$/u);
  assert.doesNotMatch(ogAddCol, /ADD COLUMN IF NOT EXISTS/u);

  const ogTriggers = dialectCreateTriggerStatements(og, {
    triggerName: "ha_test_trg",
    tableName: "ha_events",
    timingAndEvent: "BEFORE INSERT",
    functionCall: "ha_test_fn()",
  });
  assert.equal(ogTriggers.length, 2);
  assert.match(ogTriggers[0]!, /^DROP TRIGGER IF EXISTS ha_test_trg ON ha_events$/u);
  assert.match(ogTriggers[1]!, /EXECUTE PROCEDURE ha_test_fn\(\)$/u);

  const pgRls = postgresScopeRlsStatements("ha_facts", {
    ifNotExists: true,
    capabilities: STANDARD_POSTGRES_DIALECT_CAPABILITIES,
  }).join("\n");
  assert.match(pgRls, /CREATE POLICY "ha_facts_scope_policy"/u);
  assert.match(pgRls, /WITH CHECK/u);
  assert.doesNotMatch(pgRls, /ha_enforce_scope_write_check/u);

  const ogRls = postgresScopeRlsStatements("ha_facts", { ifNotExists: true, capabilities: og }).join("\n");
  assert.match(ogRls, /CREATE ROW LEVEL SECURITY POLICY "ha_facts_scope_policy"/u);
  assert.doesNotMatch(ogRls, /WITH CHECK/u);
  assert.match(ogRls, /pg_rlspolicies/u);
  assert.match(ogRls, /ha_facts_scope_write_check/u);
  assert.match(ogRls, /EXECUTE PROCEDURE public\.ha_enforce_scope_write_check\(\)/u);

  const guardFn = postgresScopeWriteGuardFunctionStatements(og).join("\n");
  assert.match(guardFn, /session_user/u);
  assert.match(guardFn, /rolsystemadmin/u);
  assert.match(guardFn, /ERRCODE = '42501'/u);
});

test("openGauss event-ledger and projection DDL omit unsupported PG 10-16 syntax and support generated-column fallback", () => {
  const og = capabilitiesFromProbeRow(OPENGAUSS_503_PG_PROBE);
  const ledgerDdl = postgresEventLedgerSchemaStatements(og).join("\n;\n");
  assert.doesNotMatch(ledgerDdl, /\bON CONFLICT\b/u);
  assert.doesNotMatch(ledgerDdl, /\bADD COLUMN IF NOT EXISTS\b/u);
  assert.doesNotMatch(ledgerDdl, /\bCREATE OR REPLACE TRIGGER\b/u);
  assert.doesNotMatch(ledgerDdl, /\bEXECUTE FUNCTION\b/u);
  assert.doesNotMatch(ledgerDdl, /\bpg_current_wal_flush_lsn\b/u);
  assert.match(ledgerDdl, /ha_is_lsn_sync_confirmed\(target_lsn text\)/u);
  assert.match(ledgerDdl, /pg_xlog_location_diff/u);

  const projDdl = projectionDdl(og).join("\n;\n");
  assert.doesNotMatch(projDdl, /\bON CONFLICT\b/u);
  assert.doesNotMatch(projDdl, /\bADD COLUMN IF NOT EXISTS\b/u);
  assert.doesNotMatch(projDdl, /\bCREATE OR REPLACE TRIGGER\b/u);
  assert.doesNotMatch(projDdl, /\bEXECUTE FUNCTION\b/u);
  assert.doesNotMatch(projDdl, /\bPARALLEL SAFE\b/u);
  assert.doesNotMatch(projDdl, /\bWITH ORDINALITY\b/u);
  assert.doesNotMatch(projDdl, /\bGENERATED ALWAYS AS IDENTITY\b/u);
  assert.doesNotMatch(projDdl, /\bxid8\b/u);
  assert.doesNotMatch(projDdl, /ha_decision_list_summary[\s\S]{0,200}json_build_object/u);
  assert.match(projDdl, /memory_class text GENERATED ALWAYS AS \(value->>'memoryClass'\) STORED/u);
  assert.match(projDdl, /CREATE INDEX IF NOT EXISTS ha_facts_memory_class/u);

  const ogNoGenCol: PgDialectCapabilities = { ...og, supportsStoredComputedColumns: false };
  const projFallbackDdl = projectionDdl(ogNoGenCol).join("\n;\n");
  assert.doesNotMatch(projFallbackDdl, /GENERATED ALWAYS AS/u);
  assert.match(projFallbackDdl, /ha_facts_memory_class_sync/u);
  assert.match(projFallbackDdl, /CREATE INDEX IF NOT EXISTS ha_facts_memory_class/u);
});

test("ensurePoolDialectCapabilities skips SQL probe on non-socket mock or PGlite clients", async () => {
  const queries: string[] = [];
  const mockClient = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const mockPool = {} as Pool;
  const caps = await ensurePoolDialectCapabilities(mockPool, mockClient);
  assert.equal(caps, STANDARD_POSTGRES_DIALECT_CAPABILITIES);
  assert.deepEqual(queries, []);
});

test("migration schema installs authority-first share lock helper only on non-ON-CONFLICT dialects", () => {
  const pgSchema = postgresStorageMigrationSchema(STANDARD_POSTGRES_DIALECT_CAPABILITIES).join("\n");
  assert.doesNotMatch(pgSchema, /ha_acquire_repo_writer_epoch_share/u);

  const og = capabilitiesFromProbeRow(OPENGAUSS_503_PG_PROBE);
  const ogSchema = postgresStorageMigrationSchema(og).join("\n");
  assert.match(ogSchema, /DROP FUNCTION IF EXISTS public\.ha_acquire_repo_writer_epoch_share\(text\)/u);
  assert.match(ogSchema, /CREATE OR REPLACE FUNCTION public\.ha_acquire_repo_writer_epoch_share\(/u);
  assert.match(ogSchema, /target_tenant_id text/u);
  assert.match(ogSchema, /target_project_id text/u);
  assert.match(ogSchema, /target_policy_epoch bigint/u);
  assert.match(ogSchema, /target_repo_id text/u);
  assert.doesNotMatch(ogSchema, /LANGUAGE plpgsql STRICT SECURITY DEFINER/u);
  assert.match(ogSchema, /has_table_privilege\(session_user, 'public\.ha_repo_heads', 'INSERT'\)/u);
  assert.match(ogSchema, /r\.rolsuper OR r\.rolsystemadmin/u);
  assert.match(ogSchema, /public\.ha_current_setting\('ha\.tenant_id'\)/u);
  assert.match(ogSchema, /public\.ha_current_setting\('ha\.project_id'\)/u);
  assert.match(ogSchema, /public\.ha_current_setting\('ha\.policy_epoch'\)/u);
  assert.match(ogSchema, /ERRCODE = '42501'/u);
  assert.match(ogSchema, /FROM public\.ha_repo_writer_epochs WHERE repo_id = target_repo_id FOR SHARE/u);
  assert.match(
    ogSchema,
    /GRANT EXECUTE ON FUNCTION public\.ha_acquire_repo_writer_epoch_share\(text, text, bigint, text\) TO PUBLIC/u,
  );
});

test("readPgProjectionStoredRows uses row_to_json on openGauss and strips/resolves columns identically", async () => {
  const og = capabilitiesFromProbeRow(OPENGAUSS_503_PG_PROBE);
  const executed: string[] = [];
  const scope = { tenantId: "t1", projectId: "p1", policyEpoch: 1 };
  const mockClient = {
    async query(sql: string) {
      executed.push(sql);
      if (sql.includes("ha_decision_read_status")) {
        return {
          rows: [
            {
              row_value: {
                tenant_id: "t1",
                decision_id: "d1",
                generation: "v1",
                updated_at: "2026-11-23T00:00:00Z",
              },
            },
          ],
        };
      }
      if (sql.includes("ha_decision_positions")) {
        return {
          rows: [
            {
              row_value: { tenant_id: "t1", term_slot: 7, position: 2 },
              resolved_term: "alpha",
            },
            {
              row_value: { tenant_id: "t1", term_slot: 3, position: 1 },
              resolved_term: null,
            },
          ],
        };
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;

  const statusRows = await readPgProjectionStoredRows(mockClient, "ha_decision_read_status", scope, {
    capabilities: og,
    excludeColumns: ["updated_at", "state_digest"],
  });
  assert.deepEqual(statusRows, [{ tenant_id: "t1", decision_id: "d1" }]);

  const posRows = await readPgProjectionStoredRows(mockClient, "ha_decision_positions", scope, {
    capabilities: og,
    excludeColumns: ["tenant_id"],
    readers: [],
    orderBy: "declaration_head_or_row",
  });
  assert.deepEqual(posRows, [
    { position: 1, term: null },
    { position: 2, term: "alpha" },
  ]);

  for (const sql of executed) {
    assert.match(sql, /row_to_json\(projection\)/u);
    assert.doesNotMatch(sql, /\bto_jsonb\b|\bjsonb_build_object\b/u);
  }
});
