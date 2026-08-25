// @write-boundary-exemption rebuildable-projection
import type { DatabaseSync } from "node:sqlite";
import type { SquadRunProjectionRow } from "./task-projection-port.ts";
import { canonicalJson, queryRows, runSql } from "./rebuildable-task-projection-sql.ts";

export function squadRunProjectionReady(db: DatabaseSync): boolean {
  return (
    Number(queryRows(db, "SELECT squad_run_ready FROM projection_meta WHERE singleton = 1")[0]?.squad_run_ready) === 1
  );
}

export function replaceSquadRuns(db: DatabaseSync, rows: readonly SquadRunProjectionRow[]): void {
  runSql(db, "DELETE FROM squad_run_projection");
  for (const row of rows) insertSquadRun(db, row);
  runSql(db, "UPDATE projection_meta SET squad_run_ready = 1 WHERE singleton = 1");
}

export function markSquadRunProjectionDirty(db: DatabaseSync): void {
  runSql(db, "UPDATE projection_meta SET squad_run_ready = 0 WHERE singleton = 1");
}

export function upsertSquadRun(db: DatabaseSync, row: SquadRunProjectionRow): void {
  insertSquadRun(db, row);
  runSql(db, "UPDATE projection_meta SET squad_run_ready = 1 WHERE singleton = 1");
}

export function readSquadRun(db: DatabaseSync, squadRunId: string): SquadRunProjectionRow | null {
  const row = queryRows(
    db,
    "SELECT squad_run_id, revision, state_json FROM squad_run_projection WHERE squad_run_id = ?",
    squadRunId,
  )[0];
  return row === undefined ? null : projectionRow(row);
}

export function readSquadRuns(db: DatabaseSync): readonly SquadRunProjectionRow[] {
  return queryRows(db, "SELECT squad_run_id, revision, state_json FROM squad_run_projection ORDER BY squad_run_id").map(
    projectionRow,
  );
}

function insertSquadRun(db: DatabaseSync, row: SquadRunProjectionRow): void {
  if (!row.squadRunId || !Number.isSafeInteger(row.revision) || row.revision < 0)
    throw new Error("squad run projection row is invalid");
  runSql(
    db,
    [
      "INSERT INTO squad_run_projection(squad_run_id, revision, state_json) VALUES (?, ?, ?)",
      "ON CONFLICT(squad_run_id) DO UPDATE SET revision=excluded.revision, state_json=excluded.state_json",
      "WHERE excluded.revision >= squad_run_projection.revision",
    ].join(" "),
    row.squadRunId,
    row.revision,
    canonicalJson(row.state),
  );
}

function projectionRow(row: Readonly<Record<string, unknown>>): SquadRunProjectionRow {
  const state = JSON.parse(String(row.state_json)) as unknown;
  if (state === null || typeof state !== "object" || Array.isArray(state))
    throw new Error(`squad run projection mismatch for ${String(row.squad_run_id)}`);
  return {
    squadRunId: String(row.squad_run_id),
    revision: Number(row.revision),
    state: state as Readonly<Record<string, unknown>>,
  };
}
