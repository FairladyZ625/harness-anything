// @write-boundary-exemption rebuildable-projection

import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue, StatementSync } from "node:sqlite";
import { consumeKnownError } from "../error-consumption.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { canonicalizeContractValue } from "../domain/task.ts";
import type { EventStreamPort } from "./rebuildable-task-projection-types.ts";

// SQL execution, projection watermark, canonical serialization, and state digest primitives.
const stateDigestTables = [
  ["event_index", "op_id"],
  ["document", "path"],
  ["preset_snapshot", "digest"],
  ["runtime_installation", "installation_id"],
  ["runtime_session", "runtime_session_id"],
  ["task_snapshot", "task_id"],
  ["task_package", "task_id"],
  ["task_generation", "task_id"],
  ["task_relation", "relation_id"],
  ["task_progress", "workspace_revision"],
  ["entity_projection", "entity_kind, task_id, entity_id"],
  ["archived_entity", "entity_kind, entity_id"],
  ["edge", "task_id, edge_id, iteration"],
  ["lease_cas", "task_id"],
  ["lease_interval", "task_id, execution_id, acquired_revision"],
  ["fact", "fact_id"],
  ["relation_edge", "relation_id"],
  ["decision", "decision_id"],
  ["decision_option", "decision_id, kind, option_id"],
  ["decision_claim", "decision_id, claim_id"],
  ["decision_judgment_consent", "consent_id"],
  ["decision_amendment", "amendment_id"],
  ["decision_content_pin", "pin_id"],
] as const;

export function watermark(db: DatabaseSync): number {
  const row = prepareQuery(db, "SELECT watermark FROM projection_meta WHERE singleton = 1", (sql) =>
    /* @gate-identity check-bypass-write-boundary/bypass-write-031 */ db.prepare(sql),
  ).get() as { readonly watermark: number };
  return Number(row.watermark);
}

export function readProjectionCut(
  db: DatabaseSync,
  readHead: EventStreamPort["readHead"],
): {
  readonly status: "ready" | "pending";
  readonly watermark: number;
  readonly sourceRevision: number;
} {
  const current = watermark(db),
    sourceRevision = readHead()?.revision ?? 0;
  return {
    status: current === sourceRevision ? "ready" : "pending",
    watermark: current,
    sourceRevision,
  };
}

export function isAtSourceCut(db: DatabaseSync, sourceRevision: number): boolean {
  const state =
    /* @gate-identity check-bypass-write-boundary/bypass-write-033 */
    db.prepare("SELECT watermark, scan_cursor, scanned_revision FROM projection_meta WHERE singleton = 1").get() as {
      readonly watermark: number;
      readonly scan_cursor: string | null;
      readonly scanned_revision: number;
    };
  return (
    Number(state.watermark) === sourceRevision &&
    state.scan_cursor === null &&
    Number(state.scanned_revision) === sourceRevision &&
    /* @gate-identity check-bypass-write-boundary/bypass-write-034 */
    db.prepare("SELECT 1 FROM event_source LIMIT 1").get() === undefined
  );
}

// Hashes every projection row, so only explicit rebuilds and read-side checks call it; writes never do.
export function readStateDigest(db: DatabaseSync, sourceRevision: number): `sha256:${string}` | null {
  return queryTransaction(db, () => {
    if (!isAtSourceCut(db, sourceRevision)) return null;
    let digest = sha256Text("task-projection-state/v1");
    for (const [table, order] of stateDigestTables) {
      digest = sha256Text(`${digest}\n${table}`);
      for (const row of prepareQuery(db, `SELECT * FROM ${table} ORDER BY ${order}`).iterate())
        digest = sha256Text(`${digest}\n${canonicalJson(row as ProjectionSqlRow)}`);
    }
    return `sha256:${digest}` as const;
  });
}
export function transaction<A>(db: DatabaseSync, run: () => A): A {
  /* @gate-identity check-bypass-write-boundary/bypass-write-028 */
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = run();
    /* @gate-identity check-bypass-write-boundary/bypass-write-029 */
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      /* @gate-identity check-bypass-write-boundary/bypass-write-030 */
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      consumeKnownError(rollbackError);
    }
    throw error;
  }
}

export function queryTransaction<A>(db: DatabaseSync, run: () => A): A {
  if (db.isTransaction) return run();
  /* @gate-identity check-bypass-write-boundary/bypass-write-107 */
  db.exec("BEGIN");
  try {
    const value = run();
    /* @gate-identity check-bypass-write-boundary/bypass-write-108 */
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      /* @gate-identity check-bypass-write-boundary/bypass-write-109 */
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      consumeKnownError(rollbackError);
    }
    throw error;
  }
}
type SqlValue = string | number | bigint | Uint8Array | null;
export function runSql(db: DatabaseSync, sql: string, ...values: readonly SqlValue[]): number | bigint {
  return prepareQuery(db, sql, (text) =>
    /* @gate-identity check-bypass-write-boundary/bypass-write-035 */ db.prepare(text),
  ).run(...values).changes;
}
// Statements are keyed by connection object and SQL text. Closing a connection finalizes its
// statements and a reopen constructs a new object, so a finalized statement is never reused.
const connectionStatements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
/** The connection's statement for `sql`, prepared on first use. Call sites that carry their own
 * write-boundary identity pass the `prepare` that performs it. */
export function prepareQuery(
  db: DatabaseSync,
  sql: string,
  prepare = (text: string) => /* @gate-identity check-bypass-write-boundary/bypass-write-036 */ db.prepare(text),
): StatementSync {
  let statements = connectionStatements.get(db);
  if (statements === undefined) connectionStatements.set(db, (statements = new Map()));
  let statement = statements.get(sql);
  if (statement === undefined) statements.set(sql, (statement = prepare(sql)));
  return statement;
}
/** Table names read once per connection: every table is created while a connection initializes. */
const connectionTables = new WeakMap<DatabaseSync, ReadonlySet<string>>();
export function projectionTables(db: DatabaseSync): ReadonlySet<string> {
  let tables = connectionTables.get(db);
  if (tables === undefined)
    connectionTables.set(
      db,
      (tables = new Set(
        queryRows(db, "SELECT name FROM sqlite_master WHERE type='table'").map(({ name }) => String(name)),
      )),
    );
  return tables;
}
export type ProjectionSqlRow = Readonly<Record<string, SQLOutputValue>>;
export function queryRow<Row extends ProjectionSqlRow = ProjectionSqlRow>(
  db: DatabaseSync,
  sql: string,
  ...values: readonly SqlValue[]
): Row | undefined {
  return prepareQuery(db, sql).get(...values) as Row | undefined;
}
export function queryRows<Row extends ProjectionSqlRow = ProjectionSqlRow>(
  db: DatabaseSync,
  sql: string,
  ...values: readonly SqlValue[]
): readonly Row[] {
  return queryPreparedRows<Row>(prepareQuery(db, sql), ...values);
}
export function queryPreparedRows<Row extends ProjectionSqlRow = ProjectionSqlRow>(
  statement: StatementSync,
  ...values: readonly SqlValue[]
): readonly Row[] {
  return statement.all(...values) as Row[];
}
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeContractValue(value));
}
