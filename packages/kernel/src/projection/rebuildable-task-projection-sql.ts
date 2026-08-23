// @write-boundary-exemption rebuildable-projection

import { DatabaseSync } from "node:sqlite";
import { sha256Text } from "../integrity/stable-hash.ts";
import { parseCanonicalEvent, type CanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import { canonicalizeContractValue } from "../domain/task.ts";

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
  ["execution", "execution_id"],
  ["review", "review_id"],
  ["edge", "task_id, edge_id, iteration"],
  ["lease_cas", "task_id"],
  ["lease_interval", "task_id, execution_id, acquired_revision"],
  ["fact", "task_id, fact_id"],
  ["relation_edge", "relation_id"],
  ["decision", "decision_id"],
  ["decision_option", "decision_id, kind, option_id"],
  ["decision_claim", "decision_id, claim_id"],
  ["decision_judgment_consent", "consent_id"],
  ["decision_amendment", "amendment_id"],
  ["decision_content_pin", "pin_id"],
] as const;

export function watermark(db: DatabaseSync): number {
  const row = db.prepare("SELECT watermark FROM projection_meta WHERE singleton = 1").get() as {
    readonly watermark: number;
  };
  return Number(row.watermark);
}

export function readStateDigest(db: DatabaseSync): `sha256:${string}` | null {
  const row = db.prepare("SELECT state_digest FROM projection_meta WHERE singleton = 1").get() as {
    readonly state_digest: string | null;
  };
  return row.state_digest === null ? null : (row.state_digest as `sha256:${string}`);
}

export function isAtSourceCut(db: DatabaseSync, sourceRevision: number): boolean {
  const state = db
    .prepare("SELECT watermark, scan_cursor, scanned_revision FROM projection_meta WHERE singleton = 1")
    .get() as {
    readonly watermark: number;
    readonly scan_cursor: string | null;
    readonly scanned_revision: number;
  };
  return (
    Number(state.watermark) === sourceRevision &&
    state.scan_cursor === null &&
    Number(state.scanned_revision) === sourceRevision &&
    db.prepare("SELECT 1 FROM event_source LIMIT 1").get() === undefined
  );
}

export function refreshStateDigestAtSourceCut(db: DatabaseSync, sourceRevision: number): `sha256:${string}` | null {
  if (!isAtSourceCut(db, sourceRevision)) return null;
  let digest = sha256Text("task-projection-state/v1");
  for (const [table, order] of stateDigestTables) {
    digest = sha256Text(`${digest}\n${table}`);
    for (const row of queryRows(db, `SELECT * FROM ${table} ORDER BY ${order}`))
      digest = sha256Text(`${digest}\n${canonicalJson(row)}`);
  }
  const value = `sha256:${digest}` as `sha256:${string}`;
  runSql(db, "UPDATE projection_meta SET state_digest = ? WHERE singleton = 1", value);
  return value;
}
export function transaction<A>(db: DatabaseSync, run: () => A): A {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = run();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
type SqlValue = string | number | bigint | Uint8Array | null;
export function runSql(db: DatabaseSync, sql: string, ...values: readonly SqlValue[]): number | bigint {
  return db.prepare(sql).run(...values).changes;
}
export function prepareQuery(db: DatabaseSync, sql: string) {
  return db.prepare(sql);
}
export function queryRow(
  db: DatabaseSync,
  sql: string,
  ...values: readonly SqlValue[]
): Record<string, unknown> | undefined {
  return prepareQuery(db, sql).get(...values) as Record<string, unknown> | undefined;
}
export function queryRows(
  db: DatabaseSync,
  sql: string,
  ...values: readonly SqlValue[]
): readonly Record<string, unknown>[] {
  return prepareQuery(db, sql).all(...values) as unknown as readonly Record<string, unknown>[];
}
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeContractValue(value));
}
export function parseEventJson(value: string): CanonicalEventV1 {
  return parseCanonicalEvent(`${value}\n`);
}
