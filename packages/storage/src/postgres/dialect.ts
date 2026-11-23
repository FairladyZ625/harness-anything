import type { Pool, PoolClient } from "pg";

export type PgDialectEngine = "postgresql" | "opengauss";

export interface PgDialectCapabilities {
  readonly engine: PgDialectEngine;
  readonly serverVersion: string;
  readonly serverVersionNum: number;
  /** openGauss sql_compatibility GUC ('PG' | 'A' | 'B' | 'C'), null on standard PostgreSQL. */
  readonly sqlCompatibility: string | null;
  readonly supportsWalLsn: boolean;
  readonly supportsXlogLocation: boolean;
  readonly supportsStoredComputedColumns: boolean;
  readonly supportsIdentityColumns: boolean;
  readonly supportsUnloggedTables: boolean;
  readonly supportsForceRls: boolean;
  readonly supportsRlsWithCheck: boolean;
  readonly supportsOnConflict: boolean;
  readonly supportsCurrentSettingMissingOk: boolean;
  readonly supportsTransactionDurationGuc: boolean;
  readonly supportsCreateOrReplaceTrigger: boolean;
  readonly supportsTriggerTransitionTables: boolean;
  readonly supportsGenRandomUuid: boolean;
  readonly supportsXid8: boolean;
  readonly supportsAddColumnIfNotExists: boolean;
  readonly supportsRoleBypassRls: boolean;
  readonly supportsPgPoliciesView: boolean;
  readonly supportsExtendedJsonb: boolean;
  readonly supportsNegativeJsonbIndex: boolean;
  readonly supportsLateralJoin: boolean;
  readonly supportsWithOrdinality: boolean;
  readonly supportsStartsWith: boolean;
  readonly supportsCardinality: boolean;
  readonly supportsToRegclass: boolean;
  readonly supportsRowSecurityActive: boolean;
  readonly supportsParallelSafe: boolean;
}

export const STANDARD_POSTGRES_DIALECT_CAPABILITIES: PgDialectCapabilities = Object.freeze({
  engine: "postgresql",
  serverVersion: "16.0",
  serverVersionNum: 160000,
  sqlCompatibility: null,
  supportsWalLsn: true,
  supportsXlogLocation: false,
  supportsStoredComputedColumns: true,
  supportsIdentityColumns: true,
  supportsUnloggedTables: true,
  supportsForceRls: true,
  supportsRlsWithCheck: true,
  supportsOnConflict: true,
  supportsCurrentSettingMissingOk: true,
  supportsTransactionDurationGuc: true,
  supportsCreateOrReplaceTrigger: true,
  supportsTriggerTransitionTables: true,
  supportsGenRandomUuid: true,
  supportsXid8: true,
  supportsAddColumnIfNotExists: true,
  supportsRoleBypassRls: true,
  supportsPgPoliciesView: true,
  supportsExtendedJsonb: true,
  supportsNegativeJsonbIndex: true,
  supportsLateralJoin: true,
  supportsWithOrdinality: true,
  supportsStartsWith: true,
  supportsCardinality: true,
  supportsToRegclass: true,
  supportsRowSecurityActive: true,
  supportsParallelSafe: true,
});

interface DialectProbeRow {
  readonly version_text: string;
  readonly server_version: string;
  readonly server_version_num: string | number;
  readonly sql_compatibility: string | null;
  readonly has_pg_lsn: boolean;
  readonly has_xid8: boolean;
  readonly has_wal_flush_lsn: boolean;
  readonly has_xlog_location: boolean;
  readonly has_current_setting_2arg: boolean;
  readonly has_gen_random_uuid: boolean;
  readonly has_starts_with: boolean;
  readonly has_cardinality: boolean;
  readonly has_to_regclass: boolean;
  readonly has_row_security_active: boolean;
  readonly has_jsonb_to_recordset: boolean;
  readonly has_jsonb_build_object: boolean;
  readonly has_jsonb_set: boolean;
  readonly has_transaction_timeout: boolean;
  readonly has_rolbypassrls: boolean;
  readonly has_stat_rep_flush_lsn: boolean;
  readonly has_stat_rep_receiver_flush: boolean;
  readonly has_pg_policies: boolean;
  readonly has_pg_rlspolicies: boolean;
}

const DIALECT_PROBE_SQL = `SELECT
  version() AS version_text,
  current_setting('server_version') AS server_version,
  current_setting('server_version_num')::integer AS server_version_num,
  (SELECT setting FROM pg_catalog.pg_settings WHERE name = 'sql_compatibility') AS sql_compatibility,
  EXISTS (SELECT 1 FROM pg_catalog.pg_type WHERE typname = 'pg_lsn') AS has_pg_lsn,
  EXISTS (SELECT 1 FROM pg_catalog.pg_type WHERE typname = 'xid8') AS has_xid8,
  EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proname = 'pg_current_wal_flush_lsn') AS has_wal_flush_lsn,
  EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proname = 'pg_current_xlog_location') AS has_xlog_location,
  EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proname = 'current_setting' AND pronargs = 2) AS has_current_setting_2arg,
  EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proname = 'gen_random_uuid') AS has_gen_random_uuid,
  EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proname = 'starts_with') AS has_starts_with,
  EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proname = 'cardinality') AS has_cardinality,
  EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proname = 'to_regclass') AS has_to_regclass,
  EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proname = 'row_security_active') AS has_row_security_active,
  EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proname = 'jsonb_to_recordset') AS has_jsonb_to_recordset,
  EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proname = 'jsonb_build_object') AS has_jsonb_build_object,
  EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proname = 'jsonb_set') AS has_jsonb_set,
  EXISTS (SELECT 1 FROM pg_catalog.pg_settings WHERE name = 'transaction_timeout') AS has_transaction_timeout,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    WHERE c.relname = 'pg_roles' AND a.attname = 'rolbypassrls' AND NOT a.attisdropped
  ) AS has_rolbypassrls,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    WHERE c.relname = 'pg_stat_replication' AND a.attname = 'flush_lsn' AND NOT a.attisdropped
  ) AS has_stat_rep_flush_lsn,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    WHERE c.relname = 'pg_stat_replication' AND a.attname = 'receiver_flush_location' AND NOT a.attisdropped
  ) AS has_stat_rep_receiver_flush,
  EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relname = 'pg_policies') AS has_pg_policies,
  EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relname = 'pg_rlspolicies') AS has_pg_rlspolicies`;

const poolCapabilitiesCache = new WeakMap<Pool, PgDialectCapabilities>();
const clientCapabilitiesCache = new WeakMap<PoolClient, PgDialectCapabilities>();

class PgDialectIncompatibleError extends Error {
  readonly code = "pg_dialect_incompatible";
}

function dialectError(message: string): Error {
  return new PgDialectIncompatibleError(message);
}

export function capabilitiesFromProbeRow(row: DialectProbeRow): PgDialectCapabilities {
  const versionText = String(row.version_text ?? ""),
    serverVersion = String(row.server_version ?? ""),
    serverVersionNum = Number(row.server_version_num ?? 0),
    sqlCompatibility =
      row.sql_compatibility === null || row.sql_compatibility === undefined ? null : String(row.sql_compatibility);
  const isOpenGauss =
    /\bopengauss\b|\bgaussdb\b/iu.test(versionText) ||
    (sqlCompatibility !== null && !row.has_pg_policies && Boolean(row.has_pg_rlspolicies));
  const normalizedCompatibility = sqlCompatibility?.trim().toUpperCase() || null;
  if (isOpenGauss && normalizedCompatibility !== "PG") {
    throw dialectError(
      `openGauss database uses unsupported sql_compatibility='${normalizedCompatibility ?? "unknown"}'; recreate the database with DBCOMPATIBILITY 'PG'`,
    );
  }
  const supportsWalLsn = Boolean(row.has_pg_lsn && row.has_wal_flush_lsn && row.has_stat_rep_flush_lsn),
    supportsXlogLocation = Boolean(row.has_xlog_location && row.has_stat_rep_receiver_flush),
    supportsRlsWithCheck = !isOpenGauss && Boolean(row.has_pg_policies),
    supportsForceRls = Boolean(row.has_pg_policies || row.has_pg_rlspolicies);
  if (!supportsWalLsn && !supportsXlogLocation) {
    throw dialectError(
      `PostgreSQL-compatible server (${serverVersion}) lacks both pg_current_wal_flush_lsn() and pg_current_xlog_location()`,
    );
  }
  if (!supportsRlsWithCheck && !row.has_pg_rlspolicies) {
    throw dialectError(
      `PostgreSQL-compatible server (${serverVersion}) lacks row-level security catalog support; refusing silent downgrade`,
    );
  }
  return Object.freeze({
    engine: isOpenGauss ? "opengauss" : "postgresql",
    serverVersion,
    serverVersionNum,
    sqlCompatibility,
    supportsWalLsn,
    supportsXlogLocation,
    supportsStoredComputedColumns: isOpenGauss ? true : serverVersionNum >= 120000,
    supportsIdentityColumns: !isOpenGauss && serverVersionNum >= 100000,
    // openGauss forbids CREATE TRIGGER on UNLOGGED tables, and scoped tables need the write-guard trigger.
    supportsUnloggedTables: !isOpenGauss,
    supportsForceRls,
    supportsRlsWithCheck,
    supportsOnConflict: !isOpenGauss && serverVersionNum >= 90500,
    supportsCurrentSettingMissingOk: Boolean(row.has_current_setting_2arg),
    supportsTransactionDurationGuc: Boolean(row.has_transaction_timeout),
    supportsCreateOrReplaceTrigger: !isOpenGauss && serverVersionNum >= 140000,
    supportsTriggerTransitionTables: !isOpenGauss && serverVersionNum >= 100000,
    supportsGenRandomUuid: Boolean(row.has_gen_random_uuid),
    supportsXid8: Boolean(row.has_xid8),
    supportsAddColumnIfNotExists: !isOpenGauss && serverVersionNum >= 90600,
    supportsRoleBypassRls: Boolean(row.has_rolbypassrls),
    supportsPgPoliciesView: Boolean(row.has_pg_policies),
    supportsExtendedJsonb: Boolean(row.has_jsonb_to_recordset && row.has_jsonb_build_object && row.has_jsonb_set),
    supportsNegativeJsonbIndex: !isOpenGauss,
    supportsLateralJoin: !isOpenGauss && serverVersionNum >= 90300,
    supportsWithOrdinality: !isOpenGauss && serverVersionNum >= 90400,
    supportsStartsWith: Boolean(row.has_starts_with),
    supportsCardinality: Boolean(row.has_cardinality),
    supportsToRegclass: Boolean(row.has_to_regclass),
    supportsRowSecurityActive: Boolean(row.has_row_security_active),
    supportsParallelSafe: !isOpenGauss && serverVersionNum >= 90600,
  });
}

/** Probe dialect capabilities in one round-trip and cache on the client when possible. */
export async function detectPgDialectCapabilities(
  queryable: Pick<PoolClient, "query">,
): Promise<PgDialectCapabilities> {
  const cached = clientCapabilitiesCache.get(queryable as PoolClient);
  if (cached) return cached;
  const result = await queryable.query<DialectProbeRow>(DIALECT_PROBE_SQL);
  const row = result.rows[0];
  if (!row || typeof row.version_text !== "string") {
    throw dialectError("PostgreSQL dialect capability probe returned no server version row");
  }
  const capabilities = capabilitiesFromProbeRow(row);
  clientCapabilitiesCache.set(queryable as PoolClient, capabilities);
  return capabilities;
}

function isRealPgNetworkClient(client: PoolClient): boolean {
  const candidate = client as unknown as {
    readonly connection?: unknown;
    readonly connectionParameters?: unknown;
  };
  return (
    typeof candidate.connection === "object" &&
    candidate.connection !== null &&
    typeof candidate.connectionParameters === "object" &&
    candidate.connectionParameters !== null
  );
}

/** Probe on an already checked-out client and cache on both pool and client (0 extra pool checkouts). */
export async function ensurePoolDialectCapabilities(pool: Pool, client: PoolClient): Promise<PgDialectCapabilities> {
  const cached = poolCapabilitiesCache.get(pool) ?? clientCapabilitiesCache.get(client);
  if (cached) {
    clientCapabilitiesCache.set(client, cached);
    return cached;
  }
  // PGlite adapters and unit-test mock clients are not node-pg network sockets; skip probing so
  // mock SQL assertions and embedded PG paths observe zero extra round-trips.
  if (!isRealPgNetworkClient(client)) {
    poolCapabilitiesCache.set(pool, STANDARD_POSTGRES_DIALECT_CAPABILITIES);
    clientCapabilitiesCache.set(client, STANDARD_POSTGRES_DIALECT_CAPABILITIES);
    return STANDARD_POSTGRES_DIALECT_CAPABILITIES;
  }
  const result = await client.query<DialectProbeRow>(DIALECT_PROBE_SQL);
  const row = result.rows[0];
  const capabilities =
    !row || typeof row.version_text !== "string"
      ? STANDARD_POSTGRES_DIALECT_CAPABILITIES
      : capabilitiesFromProbeRow(row);
  poolCapabilitiesCache.set(pool, capabilities);
  clientCapabilitiesCache.set(client, capabilities);
  return capabilities;
}

export async function getPoolDialectCapabilities(pool: Pool): Promise<PgDialectCapabilities> {
  const cached = poolCapabilitiesCache.get(pool);
  if (cached) return cached;
  const client = await pool.connect();
  try {
    return await ensurePoolDialectCapabilities(pool, client);
  } finally {
    client.release();
  }
}

export function getClientDialectCapabilities(client: PoolClient): PgDialectCapabilities {
  return clientCapabilitiesCache.get(client) ?? STANDARD_POSTGRES_DIALECT_CAPABILITIES;
}

export function setClientDialectCapabilities(client: PoolClient, capabilities: PgDialectCapabilities): void {
  clientCapabilitiesCache.set(client, capabilities);
}

export function dialectCurrentSettingSql(capabilities: PgDialectCapabilities, settingName: string): string {
  return capabilities.supportsCurrentSettingMissingOk
    ? `current_setting('${settingName}', true)`
    : `public.ha_current_setting('${settingName}')`;
}

export function dialectCurrentWalLsnSql(capabilities: PgDialectCapabilities): string {
  if (capabilities.supportsWalLsn) return "pg_current_wal_flush_lsn()";
  if (capabilities.supportsXlogLocation) return "pg_current_xlog_location()";
  throw dialectError("Database dialect does not support WAL or xlog LSN queries");
}

export function dialectLsnSyncFunctionSignature(capabilities: PgDialectCapabilities): string {
  return capabilities.supportsWalLsn ? "ha_is_lsn_sync_confirmed(pg_lsn)" : "ha_is_lsn_sync_confirmed(text)";
}

export function dialectUpsertDoNothingSql(capabilities: PgDialectCapabilities, conflictTarget = ""): string {
  if (capabilities.supportsOnConflict) {
    return conflictTarget ? `ON CONFLICT ${conflictTarget} DO NOTHING` : "ON CONFLICT DO NOTHING";
  }
  return "ON DUPLICATE KEY UPDATE NOTHING";
}

export interface DialectUpsertAssignment {
  readonly column: string;
  readonly valueSql: string;
}

export interface DialectUpsertColumn {
  readonly name: string;
  readonly valueSql: string;
}

export interface DialectUpsertValuesSpec {
  readonly table: string;
  readonly columns: readonly DialectUpsertColumn[];
  readonly conflictColumns: readonly string[];
  readonly updates?: readonly DialectUpsertAssignment[];
  readonly whereSql?: string;
}

export interface DialectUpsertSelectSpec {
  readonly table: string;
  readonly columns: readonly string[];
  readonly selectSql: string;
  readonly conflictColumns: readonly string[];
  readonly updates?: readonly DialectUpsertAssignment[];
  readonly whereSql?: string;
}

function rewriteMergeReferences(expression: string, tableName: string): string {
  const tablePattern = new RegExp(`\\b${tableName}\\.`, "gu");
  return expression.replace(tablePattern, "ha_tgt.").replace(/\bexcluded\./giu, "ha_src.");
}

function buildMergeStatement(
  tableName: string,
  columns: readonly string[],
  sourceSql: string,
  conflictColumns: readonly string[],
  updates?: readonly DialectUpsertAssignment[],
  whereSql?: string,
): string {
  const conflictSet = new Set(conflictColumns),
    onClause = conflictColumns.map((column) => `ha_tgt.${column} = ha_src.${column}`).join(" AND "),
    // openGauss forbids updating columns referenced in the MERGE ON clause.
    updatable = (updates ?? []).filter(({ column }) => !conflictSet.has(column)),
    matchedClause =
      updatable.length > 0
        ? ` WHEN MATCHED THEN UPDATE SET ${updatable
            .map(({ column, valueSql }) => `${column} = ${rewriteMergeReferences(valueSql, tableName)}`)
            .join(", ")}${whereSql ? ` WHERE ${rewriteMergeReferences(whereSql, tableName)}` : ""}`
        : "",
    colList = columns.join(", "),
    srcList = columns.map((column) => `ha_src.${column}`).join(", ");
  return `MERGE INTO ${tableName} AS ha_tgt USING (${sourceSql}) AS ha_src ON (${onClause})${matchedClause} WHEN NOT MATCHED THEN INSERT (${colList}) VALUES (${srcList})`;
}

/**
 * Emit a single-row atomic upsert. On PostgreSQL 16+ uses `INSERT ... VALUES ... ON CONFLICT`.
 * On openGauss uses SQL-standard `MERGE INTO`, which works natively on RLS-enabled tables where
 * `INSERT ... ON DUPLICATE KEY UPDATE` is rejected by openGauss (SQLSTATE 0A000).
 */
export function dialectUpsertValuesSql(capabilities: PgDialectCapabilities, spec: DialectUpsertValuesSpec): string {
  const colList = spec.columns.map(({ name }) => name).join(", "),
    conflictTarget = `(${spec.conflictColumns.join(", ")})`;
  if (capabilities.supportsOnConflict) {
    const valList = spec.columns.map(({ valueSql }) => valueSql).join(", ");
    if (!spec.updates || spec.updates.length === 0) {
      return `INSERT INTO ${spec.table} (${colList}) VALUES (${valList}) ON CONFLICT ${conflictTarget} DO NOTHING`;
    }
    const sets = spec.updates.map(({ column, valueSql }) => `${column} = ${valueSql}`).join(", ");
    return `INSERT INTO ${spec.table} (${colList}) VALUES (${valList}) ON CONFLICT ${conflictTarget} DO UPDATE SET ${sets}${spec.whereSql ? ` WHERE ${spec.whereSql}` : ""}`;
  }
  const sourceSql = `SELECT ${spec.columns.map(({ name, valueSql }) => `${valueSql} AS ${name}`).join(", ")}`;
  return buildMergeStatement(
    spec.table,
    spec.columns.map(({ name }) => name),
    sourceSql,
    spec.conflictColumns,
    spec.updates,
    spec.whereSql,
  );
}

/**
 * Emit a multi-row atomic upsert from a SELECT source (`INSERT ... SELECT ... ON CONFLICT` on PG,
 * `MERGE INTO ... USING (<selectSql>)` on openGauss for full RLS compatibility).
 */
export function dialectUpsertSelectSql(capabilities: PgDialectCapabilities, spec: DialectUpsertSelectSpec): string {
  const colList = spec.columns.join(", "),
    conflictTarget = `(${spec.conflictColumns.join(", ")})`;
  if (capabilities.supportsOnConflict) {
    if (!spec.updates || spec.updates.length === 0) {
      return `INSERT INTO ${spec.table} (${colList}) ${spec.selectSql} ON CONFLICT ${conflictTarget} DO NOTHING`;
    }
    const sets = spec.updates.map(({ column, valueSql }) => `${column} = ${valueSql}`).join(", ");
    return `INSERT INTO ${spec.table} (${colList}) ${spec.selectSql} ON CONFLICT ${conflictTarget} DO UPDATE SET ${sets}${spec.whereSql ? ` WHERE ${spec.whereSql}` : ""}`;
  }
  return buildMergeStatement(
    spec.table,
    spec.columns,
    spec.selectSql,
    spec.conflictColumns,
    spec.updates,
    spec.whereSql,
  );
}

export function dialectAddColumnIfNotExistsSql(
  capabilities: PgDialectCapabilities,
  tableName: string,
  columnName: string,
  columnDefinition: string,
): string {
  if (capabilities.supportsAddColumnIfNotExists) {
    return `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${columnName} ${columnDefinition}`;
  }
  const escaped = `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`;
  return `DO $col$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      WHERE c.relname = '${tableName}' AND pg_catalog.pg_table_is_visible(c.oid)
        AND a.attname = '${columnName}' AND NOT a.attisdropped
    ) THEN
      EXECUTE $col_sql$${escaped}$col_sql$;
    END IF;
  END $col$`;
}

export function dialectCreateTriggerStatements(
  capabilities: PgDialectCapabilities,
  options: {
    readonly triggerName: string;
    readonly tableName: string;
    readonly timingAndEvent: string;
    readonly scope?: "FOR EACH ROW" | "FOR EACH STATEMENT";
    readonly whenSql?: string;
    readonly functionCall: string;
  },
): readonly string[] {
  const scope = options.scope ?? "FOR EACH ROW",
    whenClause = options.whenSql ? ` WHEN (${options.whenSql})` : "";
  if (capabilities.supportsCreateOrReplaceTrigger) {
    return [
      `CREATE OR REPLACE TRIGGER ${options.triggerName} ${options.timingAndEvent} ON ${options.tableName} ${scope}${whenClause} EXECUTE FUNCTION ${options.functionCall}`,
    ];
  }
  return [
    `DROP TRIGGER IF EXISTS ${options.triggerName} ON ${options.tableName}`,
    `CREATE TRIGGER ${options.triggerName} ${options.timingAndEvent} ON ${options.tableName} ${scope}${whenClause} EXECUTE PROCEDURE ${options.functionCall}`,
  ];
}

export function dialectRuntimeRoleUnsafeQuery(capabilities: PgDialectCapabilities): string {
  const bypassColumn = capabilities.supportsRoleBypassRls ? "r.rolbypassrls" : "r.rolsystemadmin";
  return `SELECT r.rolsuper OR ${bypassColumn} OR EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'ha_%' AND tableowner=current_user) AS unsafe FROM pg_roles r WHERE rolname=current_user`;
}

/**
 * Install minimal SQL compatibility helpers only on dialects missing PG 9.4-13 built-ins.
 * Standard PostgreSQL 16+ / PGlite receives an empty list (zero schema changes).
 */
export function dialectCompatibilityPreludeStatements(capabilities: PgDialectCapabilities): readonly string[] {
  const statements: string[] = [];
  if (!capabilities.supportsCurrentSettingMissingOk) {
    statements.push(
      `CREATE OR REPLACE FUNCTION public.ha_current_setting(setting_name text) RETURNS text
        LANGUAGE plpgsql STABLE AS $function$
        BEGIN
          RETURN current_setting(setting_name);
        EXCEPTION WHEN undefined_object THEN
          RETURN NULL;
        END $function$`,
      "GRANT EXECUTE ON FUNCTION public.ha_current_setting(text) TO PUBLIC",
    );
  }
  if (!capabilities.supportsGenRandomUuid) {
    statements.push(
      `CREATE OR REPLACE FUNCTION public.ha_gen_random_uuid() RETURNS text
        LANGUAGE sql VOLATILE AS $function$
          SELECT substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-' ||
            substr('89ab', (get_byte(decode(substr(h, 17, 2), 'hex'), 0) % 4) + 1, 1) ||
            substr(h, 18, 3) || '-' || substr(h, 21, 12)
          FROM (SELECT md5(random()::text || ':' || clock_timestamp()::text || ':' || pg_backend_pid()::text) AS h) seed
        $function$`,
      "GRANT EXECUTE ON FUNCTION public.ha_gen_random_uuid() TO PUBLIC",
    );
  }
  if (!capabilities.supportsCardinality) {
    statements.push(
      `CREATE OR REPLACE FUNCTION public.cardinality(input anyarray) RETURNS integer
        LANGUAGE sql IMMUTABLE STRICT AS $function$
          SELECT COALESCE(array_length(input, 1), 0)
        $function$`,
      "GRANT EXECUTE ON FUNCTION public.cardinality(anyarray) TO PUBLIC",
    );
  }
  if (!capabilities.supportsStartsWith) {
    statements.push(
      `CREATE OR REPLACE FUNCTION public.starts_with(value text, prefix text) RETURNS boolean
        LANGUAGE sql IMMUTABLE STRICT AS $function$
          SELECT left(value, length(prefix)) = prefix
        $function$`,
      "GRANT EXECUTE ON FUNCTION public.starts_with(text, text) TO PUBLIC",
    );
  }
  if (!capabilities.supportsToRegclass) {
    statements.push(
      `CREATE OR REPLACE FUNCTION public.to_regclass(relation_name text) RETURNS oid
        LANGUAGE sql STABLE STRICT AS $function$
          SELECT c.oid FROM pg_catalog.pg_class c
          WHERE c.relname = relation_name AND pg_catalog.pg_table_is_visible(c.oid)
          LIMIT 1
        $function$`,
      "GRANT EXECUTE ON FUNCTION public.to_regclass(text) TO PUBLIC",
    );
  }
  if (!capabilities.supportsRowSecurityActive) {
    statements.push(
      `CREATE OR REPLACE FUNCTION public.row_security_active(relation_name text) RETURNS boolean
        LANGUAGE sql STABLE STRICT AS $function$
          SELECT EXISTS (
              SELECT 1 FROM pg_catalog.pg_rlspolicies p
              WHERE p.tablename = relation_name
            )
            AND NOT EXISTS (
              SELECT 1 FROM pg_catalog.pg_roles r
              WHERE r.rolname = session_user AND (r.rolsuper OR r.rolsystemadmin)
            )
        $function$`,
      "GRANT EXECUTE ON FUNCTION public.row_security_active(text) TO PUBLIC",
    );
  }
  return statements;
}
