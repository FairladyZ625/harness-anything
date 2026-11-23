import {
  STANDARD_POSTGRES_DIALECT_CAPABILITIES,
  dialectCurrentSettingSql,
  type PgDialectCapabilities,
} from "./dialect.ts";

const epochColumn = "policy_epoch";
export const POSTGRES_SCOPE_SCHEMA_CONTRACT = Object.freeze({
  schemaVersion: 1,
  roles: Object.freeze({
    schemaOwner: "ha_schema_owner",
    runtime: "ha_runtime",
    migration: "ha_migrator",
  }),
  roleAttributes: Object.freeze({
    schemaOwner: "NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS",
    runtime: "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS",
    migration: "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS",
  }),
  columns: Object.freeze({ tenantId: "tenant_id", projectId: "project_id", policyEpoch: epochColumn }),
  claims: Object.freeze({
    tenantId: "ha.tenant_id",
    projectId: "ha.project_id",
    policyEpoch: `ha.${epochColumn}`,
  }),
});

export const POSTGRES_SCOPE_COLUMNS_SQL =
  "tenant_id text NOT NULL, project_id text NOT NULL, policy_epoch bigint NOT NULL";

function scopePredicateFor(capabilities: PgDialectCapabilities): string {
  const setting = (name: string) => dialectCurrentSettingSql(capabilities, name);
  return [
    `tenant_id = NULLIF(${setting(POSTGRES_SCOPE_SCHEMA_CONTRACT.claims.tenantId)}, '')`,
    `project_id = NULLIF(${setting(POSTGRES_SCOPE_SCHEMA_CONTRACT.claims.projectId)}, '')`,
    `policy_epoch = NULLIF(${setting(POSTGRES_SCOPE_SCHEMA_CONTRACT.claims.policyEpoch)}, '')::bigint`,
  ].join(" AND ");
}

/**
 * Dialects without `CREATE POLICY ... WITH CHECK` (e.g. openGauss) only apply RLS `USING` predicates
 * to SELECT/UPDATE/DELETE visibility and allow cross-tenant INSERT unless guarded by a BEFORE trigger.
 * Note: openGauss triggers run as their owner, so bypass checks must inspect `session_user`.
 */
export function postgresScopeWriteGuardFunctionStatements(
  capabilities: PgDialectCapabilities = STANDARD_POSTGRES_DIALECT_CAPABILITIES,
): readonly string[] {
  if (capabilities.supportsRlsWithCheck) return [];
  const setting = (name: string) => dialectCurrentSettingSql(capabilities, name),
    bypassCheck = capabilities.supportsRoleBypassRls
      ? "r.rolsuper OR r.rolbypassrls"
      : "r.rolsuper OR r.rolsystemadmin";
  return [
    `CREATE OR REPLACE FUNCTION public.ha_enforce_scope_write_check() RETURNS trigger
      LANGUAGE plpgsql AS $function$
      DECLARE
        expected_tenant text;
        expected_project text;
        expected_epoch bigint;
        bypass boolean;
      BEGIN
        SELECT COALESCE(${bypassCheck}, false) INTO bypass
          FROM pg_catalog.pg_roles r WHERE r.rolname = session_user;
        IF bypass THEN RETURN NEW; END IF;
        expected_tenant := NULLIF(${setting(POSTGRES_SCOPE_SCHEMA_CONTRACT.claims.tenantId)}, '');
        expected_project := NULLIF(${setting(POSTGRES_SCOPE_SCHEMA_CONTRACT.claims.projectId)}, '');
        expected_epoch := NULLIF(${setting(POSTGRES_SCOPE_SCHEMA_CONTRACT.claims.policyEpoch)}, '')::bigint;
        IF expected_tenant IS NULL OR expected_project IS NULL OR expected_epoch IS NULL
           OR NEW.tenant_id IS DISTINCT FROM expected_tenant
           OR NEW.project_id IS DISTINCT FROM expected_project
           OR NEW.policy_epoch IS DISTINCT FROM expected_epoch THEN
          RAISE EXCEPTION 'new row violates row-level security policy for table "%"', TG_TABLE_NAME
            USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
      END $function$`,
    "GRANT EXECUTE ON FUNCTION public.ha_enforce_scope_write_check() TO PUBLIC",
  ];
}

/** One RLS predicate for every tenant/project scoped table; missing or stale claims match no rows. */
export function postgresScopeRlsStatements(
  tableName: string,
  options: { readonly ifNotExists?: boolean; readonly capabilities?: PgDialectCapabilities } = {},
): readonly string[] {
  const capabilities = options.capabilities ?? STANDARD_POSTGRES_DIALECT_CAPABILITIES,
    table = quoteIdentifier(tableName),
    policyName = `${tableName}_scope_policy`,
    policy = quoteIdentifier(policyName),
    predicate = scopePredicateFor(capabilities);
  if (capabilities.supportsRlsWithCheck) {
    const createPolicy = `CREATE POLICY ${policy} ON ${table} USING (${predicate}) WITH CHECK (${predicate})`;
    return [
      `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
      options.ifNotExists
        ? `DO $policy$ BEGIN
             IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = '${tableName}' AND policyname = '${policyName}') THEN
               EXECUTE $policy_sql$${createPolicy}$policy_sql$;
             END IF;
           END $policy$`
        : createPolicy,
    ];
  }
  const createPolicy = `CREATE ROW LEVEL SECURITY POLICY ${policy} ON ${table} USING (${predicate})`,
    policyCatalog = capabilities.supportsPgPoliciesView ? "pg_policies" : "pg_rlspolicies",
    guardTrigger = quoteIdentifier(`${tableName}_scope_write_check`);
  return [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    ...(capabilities.supportsForceRls ? [`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`] : []),
    options.ifNotExists
      ? `DO $policy$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM ${policyCatalog} WHERE schemaname = current_schema() AND tablename = '${tableName}' AND policyname = '${policyName}') THEN
             EXECUTE $policy_sql$${createPolicy}$policy_sql$;
           END IF;
         END $policy$`
      : `DO $policy$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM ${policyCatalog} WHERE schemaname = current_schema() AND tablename = '${tableName}' AND policyname = '${policyName}') THEN
             EXECUTE $policy_sql$${createPolicy}$policy_sql$;
           END IF;
         END $policy$`,
    `DROP TRIGGER IF EXISTS ${guardTrigger} ON ${table}`,
    `CREATE TRIGGER ${guardTrigger} BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE PROCEDURE public.ha_enforce_scope_write_check()`,
  ];
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(identifier))
    throw new TypeError(`invalid PostgreSQL scope identifier: ${identifier}`);
  return `"${identifier}"`;
}
