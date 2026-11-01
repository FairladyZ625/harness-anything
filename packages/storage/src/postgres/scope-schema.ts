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
  columns: Object.freeze({ tenantId: "tenant_id", projectId: "project_id", policyEpoch: "policy_epoch" }),
  claims: Object.freeze({
    tenantId: "ha.tenant_id",
    projectId: "ha.project_id",
    policyEpoch: "ha.policy_epoch",
  }),
  policyEpochComparison: "row.policy_epoch = claim.ha.policy_epoch",
});

export const POSTGRES_SCOPE_COLUMNS_SQL =
  "tenant_id text NOT NULL, project_id text NOT NULL, policy_epoch bigint NOT NULL";

const scopePredicate = [
  `tenant_id = NULLIF(current_setting('${POSTGRES_SCOPE_SCHEMA_CONTRACT.claims.tenantId}', true), '')`,
  `project_id = NULLIF(current_setting('${POSTGRES_SCOPE_SCHEMA_CONTRACT.claims.projectId}', true), '')`,
  `policy_epoch = NULLIF(current_setting('${POSTGRES_SCOPE_SCHEMA_CONTRACT.claims.policyEpoch}', true), '')::bigint`,
].join(" AND ");

/** One RLS predicate for every tenant/project scoped table; missing or stale claims match no rows. */
export function postgresScopeRlsStatements(tableName: string): readonly string[] {
  const table = quoteIdentifier(tableName),
    policy = quoteIdentifier(`${tableName}_scope_policy`);
  return [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY ${policy} ON ${table} USING (${scopePredicate}) WITH CHECK (${scopePredicate})`,
  ];
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(identifier))
    throw new TypeError(`invalid PostgreSQL scope identifier: ${identifier}`);
  return `"${identifier}"`;
}
