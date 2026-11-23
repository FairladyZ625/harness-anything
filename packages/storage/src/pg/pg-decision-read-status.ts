import type { PoolClient } from "pg";
import {
  STANDARD_POSTGRES_DIALECT_CAPABILITIES,
  dialectCreateTriggerStatements,
  dialectUpsertSelectSql,
  dialectUpsertValuesSql,
  getClientDialectCapabilities,
  type PgDialectCapabilities,
} from "../postgres/dialect.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import {
  POSTGRES_SCOPE_COLUMNS_SQL,
  POSTGRES_SCOPE_SCHEMA_CONTRACT,
  postgresScopeRlsStatements,
} from "../postgres/scope-schema.ts";

export class PgDecisionBackfillPendingError extends Error {
  readonly code = "projection_pending";

  constructor(kind: "scalar" | "summary" | "review summary") {
    super(`Decision ${kind} backfill is pending`);
  }
}

/** A nullable count means an older scope has not completed management backfill. */
export function decisionReadStatusDdl(
  capabilities: PgDialectCapabilities = STANDARD_POSTGRES_DIALECT_CAPABILITIES,
): readonly string[] {
  const scope = "tenant_id,project_id,policy_epoch",
    added = `SELECT ${scope},(decision_sort_key IS NULL)::integer AS scalar_delta,(NOT search_ready)::integer AS search_delta FROM new_rows`,
    removed = `SELECT ${scope},-(decision_sort_key IS NULL)::integer AS scalar_delta,-(NOT search_ready)::integer AS search_delta FROM old_rows`,
    rls = capabilities.supportsRlsWithCheck
      ? postgresScopeRlsStatements("ha_decision_read_status", { capabilities }).map((sql) =>
          sql.startsWith("CREATE POLICY ")
            ? `DO $policy$ BEGIN ${sql}; EXCEPTION WHEN duplicate_object THEN NULL; END $policy$`
            : sql,
        )
      : postgresScopeRlsStatements("ha_decision_read_status", { ifNotExists: true, capabilities });
  const triggerStatements = capabilities.supportsTriggerTransitionTables
    ? [
        // Transition tables charge aggregation to this statement's write set. A bulk
        // backfill updates each scope once, instead of leaving one counter version per owner.
        `CREATE OR REPLACE FUNCTION ha_decision_read_status_delta() RETURNS trigger
          LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
          DECLARE changed record; changes text;
          BEGIN
            changes := CASE TG_OP WHEN 'INSERT' THEN '${added}' WHEN 'DELETE' THEN '${removed}'
              ELSE '${added} UNION ALL ${removed}' END;
            FOR changed IN EXECUTE 'SELECT ${scope},sum(scalar_delta) AS scalar_delta,sum(search_delta) AS search_delta
              FROM (' || changes || ') delta GROUP BY ${scope} HAVING sum(scalar_delta)<>0 OR sum(search_delta)<>0' LOOP
              INSERT INTO ha_decision_read_status(tenant_id,project_id,policy_epoch)
                VALUES(changed.tenant_id,changed.project_id,changed.policy_epoch) ON CONFLICT DO NOTHING;
              UPDATE ha_decision_read_status SET scalar_pending=scalar_pending+changed.scalar_delta,
                search_pending=search_pending+changed.search_delta,generation=generation+1
              WHERE tenant_id=changed.tenant_id AND project_id=changed.project_id AND policy_epoch=changed.policy_epoch;
            END LOOP;
            RETURN NULL;
          END $function$`,
        `CREATE OR REPLACE TRIGGER ha_decision_read_status_insert AFTER INSERT ON ha_decisions
          REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION ha_decision_read_status_delta()`,
        `CREATE OR REPLACE TRIGGER ha_decision_read_status_update AFTER UPDATE ON ha_decisions
          REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION ha_decision_read_status_delta()`,
        `CREATE OR REPLACE TRIGGER ha_decision_read_status_delete AFTER DELETE ON ha_decisions
          REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION ha_decision_read_status_delta()`,
      ]
    : [
        `CREATE OR REPLACE FUNCTION ha_decision_read_status_delta() RETURNS trigger
          LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
          DECLARE
            scalar_delta integer := 0;
            search_delta integer := 0;
            target_tenant text;
            target_project text;
            target_epoch bigint;
          BEGIN
            IF TG_OP = 'INSERT' THEN
              target_tenant := NEW.tenant_id; target_project := NEW.project_id; target_epoch := NEW.policy_epoch;
              scalar_delta := CASE WHEN NEW.decision_sort_key IS NULL THEN 1 ELSE 0 END;
              search_delta := CASE WHEN NOT NEW.search_ready THEN 1 ELSE 0 END;
            ELSIF TG_OP = 'DELETE' THEN
              target_tenant := OLD.tenant_id; target_project := OLD.project_id; target_epoch := OLD.policy_epoch;
              scalar_delta := CASE WHEN OLD.decision_sort_key IS NULL THEN -1 ELSE 0 END;
              search_delta := CASE WHEN NOT OLD.search_ready THEN -1 ELSE 0 END;
            ELSE
              target_tenant := NEW.tenant_id; target_project := NEW.project_id; target_epoch := NEW.policy_epoch;
              scalar_delta := (CASE WHEN NEW.decision_sort_key IS NULL THEN 1 ELSE 0 END)
                - (CASE WHEN OLD.decision_sort_key IS NULL THEN 1 ELSE 0 END);
              search_delta := (CASE WHEN NOT NEW.search_ready THEN 1 ELSE 0 END)
                - (CASE WHEN NOT OLD.search_ready THEN 1 ELSE 0 END);
            END IF;
            IF scalar_delta <> 0 OR search_delta <> 0 THEN
              ${dialectUpsertValuesSql(capabilities, {
                table: "ha_decision_read_status",
                columns: [
                  { name: "tenant_id", valueSql: "target_tenant" },
                  { name: "project_id", valueSql: "target_project" },
                  { name: "policy_epoch", valueSql: "target_epoch" },
                ],
                conflictColumns: ["tenant_id", "project_id", "policy_epoch"],
              })};
              UPDATE ha_decision_read_status SET scalar_pending=scalar_pending+scalar_delta,
                search_pending=search_pending+search_delta,generation=generation+1
              WHERE tenant_id=target_tenant AND project_id=target_project AND policy_epoch=target_epoch;
            END IF;
            RETURN NULL;
          END $function$`,
        ...dialectCreateTriggerStatements(capabilities, {
          triggerName: "ha_decision_read_status_insert",
          tableName: "ha_decisions",
          timingAndEvent: "AFTER INSERT",
          functionCall: "ha_decision_read_status_delta()",
        }),
        ...dialectCreateTriggerStatements(capabilities, {
          triggerName: "ha_decision_read_status_update",
          tableName: "ha_decisions",
          timingAndEvent: "AFTER UPDATE",
          functionCall: "ha_decision_read_status_delta()",
        }),
        ...dialectCreateTriggerStatements(capabilities, {
          triggerName: "ha_decision_read_status_delete",
          tableName: "ha_decisions",
          timingAndEvent: "AFTER DELETE",
          functionCall: "ha_decision_read_status_delta()",
        }),
      ];
  return [
    /* @gate-identity state-store/task.projection.ha_decision_read_status */ `CREATE TABLE IF NOT EXISTS ha_decision_read_status (
      ${POSTGRES_SCOPE_COLUMNS_SQL},readers text[] NOT NULL DEFAULT '{}',
      scalar_pending bigint,search_pending bigint,generation bigint NOT NULL DEFAULT 0,
      PRIMARY KEY(tenant_id,project_id,policy_epoch))`,
    ...rls,
    // Install scoped access before the trigger starts serving the previous writer.
    // Embedded PG has no external runtime/migrator roles.
    ...[POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.runtime, POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.migration].map(
      (role) =>
        `DO $grant$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN
        GRANT SELECT,INSERT,UPDATE,DELETE ON ha_decision_read_status TO "${role}";
      END IF; END $grant$`,
    ),
    ...triggerStatements,
  ];
}

/** Current writers initialize pristine scopes before their first Decision insert.
 * Existing rows leave both counters unknown; readers require management backfill.
 */
export async function initializePgDecisionReadStatus(client: PoolClient, scope: PgProjectionScope): Promise<void> {
  const capabilities = getClientDialectCapabilities(client);
  if (capabilities.supportsLateralJoin && capabilities.supportsOnConflict) {
    await client.query(
      `INSERT INTO ha_decision_read_status(tenant_id,project_id,policy_epoch,scalar_pending,search_pending)
      SELECT $1,$2,$3,empty.count,empty.count FROM LATERAL
        (SELECT CASE WHEN EXISTS(SELECT 1 FROM ha_decisions WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 LIMIT 1)
          THEN NULL::bigint ELSE 0::bigint END AS count) empty
      WHERE NOT EXISTS(SELECT 1 FROM ha_decision_read_status WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3)
      ON CONFLICT DO NOTHING`,
      [scope.tenantId, scope.projectId, scope.policyEpoch],
    );
    return;
  }
  await client.query(
    dialectUpsertSelectSql(capabilities, {
      table: "ha_decision_read_status",
      columns: ["tenant_id", "project_id", "policy_epoch", "scalar_pending", "search_pending"],
      selectSql: `SELECT $1::text AS tenant_id,$2::text AS project_id,$3::bigint AS policy_epoch,empty.count AS scalar_pending,empty.count AS search_pending FROM (
        SELECT CASE WHEN EXISTS(SELECT 1 FROM ha_decisions WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 LIMIT 1)
          THEN NULL::bigint ELSE 0::bigint END AS count
      ) empty
      WHERE NOT EXISTS(SELECT 1 FROM ha_decision_read_status WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3)`,
      conflictColumns: ["tenant_id", "project_id", "policy_epoch"],
    }),
    [scope.tenantId, scope.projectId, scope.policyEpoch],
  );
}

export async function assertPgDecisionReadReady(
  client: PoolClient,
  scope: PgProjectionScope,
  kind: "scalar" | "search",
): Promise<void> {
  const result = await client.query<{ pending: string | null }>(
    `SELECT ${kind === "scalar" ? "scalar_pending" : "search_pending"} AS pending FROM ha_decision_read_status
      WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3`,
    [scope.tenantId, scope.projectId, scope.policyEpoch],
  );
  if (Number(result.rows[0]?.pending ?? NaN) === 0) return;
  if (result.rows.length === 0) {
    // A pristine scope needs no backfill. Check all owners at the caller's read
    // snapshot, without filtering by readiness, state or reader visibility.
    const owners = await client.query(
      `SELECT 1 FROM ha_decisions WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
        ORDER BY decision_id LIMIT 1`,
      [scope.tenantId, scope.projectId, scope.policyEpoch],
    );
    if (owners.rows.length === 0) return;
  }
  throw Object.assign(new Error(`Decision ${kind} backfill is pending`), { code: "projection_pending" });
}

/** Management scans without writer locks, then publishes only if no pending-state
 * transition raced its snapshot. CAS failure leaves unknown state and done=false.
 */
export async function finishPgDecisionReadBackfill(client: PoolClient, scope: PgProjectionScope): Promise<boolean> {
  const keys = [scope.tenantId, scope.projectId, scope.policyEpoch],
    capabilities = getClientDialectCapabilities(client);
  const initialized = await client.query(
    `${dialectUpsertValuesSql(capabilities, {
      table: "ha_decision_read_status",
      columns: [
        { name: "tenant_id", valueSql: "$1::text" },
        { name: "project_id", valueSql: "$2::text" },
        { name: "policy_epoch", valueSql: "$3::bigint" },
      ],
      conflictColumns: ["tenant_id", "project_id", "policy_epoch"],
    })}${capabilities.supportsOnConflict ? " RETURNING 1" : ""}`,
    keys,
  );
  // Commit an absent scope's unknown state before scanning history: the inserted
  // unique key would otherwise keep previous writers waiting for that whole scan.
  if (initialized.rowCount === 1) return false;
  const generation = (
    await client.query<{ generation: string }>(
      "SELECT generation FROM ha_decision_read_status WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3",
      keys,
    )
  ).rows[0]!.generation;
  const result = await client.query<{ scalar_pending: boolean; search_pending: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM ha_decisions WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
      AND decision_sort_key IS NULL LIMIT 1) AS scalar_pending,
      EXISTS(SELECT 1 FROM ha_decisions WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
      AND NOT search_ready LIMIT 1) AS search_pending`,
    keys,
  );
  const row = result.rows[0]!;
  const published = await client.query(
    `UPDATE ha_decision_read_status SET scalar_pending=CASE WHEN $4 THEN scalar_pending ELSE 0 END,
      search_pending=CASE WHEN $5 THEN search_pending ELSE 0 END WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
      AND generation=$6`,
    [...keys, row.scalar_pending, row.search_pending, generation],
  );
  return published.rowCount === 1 && !row.search_pending;
}
