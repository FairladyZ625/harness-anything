import type { AgentRuntimeEventV1 } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import type { CanonicalSquadRun } from "@harness-anything/kernel/internal/domain/squad-run.ts";
// @write-boundary-exemption rebuildable-projection
import type { DatabaseSync } from "node:sqlite";
import type { SquadRunProjectionRow } from "@harness-anything/kernel";
import { normalizeHistoricalSquadRunState } from "@harness-anything/kernel/internal/domain/historical-event-normalization.ts";
import { canonicalJson, queryRows, runSql } from "./rebuildable-task-projection-sql.ts";

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
      "WHERE excluded.revision > squad_run_projection.revision",
    ].join(" "),
    row.squadRunId,
    row.revision,
    canonicalJson(row.state),
  );
}

function projectionRow(row: Readonly<Record<string, unknown>>): SquadRunProjectionRow {
  const state = normalizeHistoricalSquadRunState(JSON.parse(String(row.state_json))) as unknown;
  if (state === null || typeof state !== "object" || Array.isArray(state))
    throw new Error(`squad run projection mismatch for ${String(row.squad_run_id)}`);
  return {
    squadRunId: String(row.squad_run_id),
    revision: Number(row.revision),
    state: state as Readonly<Record<string, unknown>>,
  };
}

/** Only accepted canonical events create the public run view, including cold rebuild. */
export function projectSquadRunEvent(db: DatabaseSync, event: AgentRuntimeEventV1): void {
  const id =
    event.type === "runtime_squad_run_observed"
      ? event.payload.squadRunId
      : event.type === "runtime_dispatch_requested"
        ? event.payload.squadRun?.squadRunId
        : undefined;
  const row = reduceSquadRunProjection(id ? readSquadRun(db, id) : null, event);
  if (row) insertSquadRun(db, row);
}

export function reduceSquadRunProjection(
  currentRow: SquadRunProjectionRow | null,
  event: AgentRuntimeEventV1,
): SquadRunProjectionRow | null {
  let state: CanonicalSquadRun;
  if (
    event.type === "runtime_dispatch_requested" &&
    event.payload.squadRun &&
    !("ownerDispatchId" in event.payload.squadRun)
  ) {
    if (currentRow) return currentRow;
    state = {
      ...event.payload.squadRun,
      ownerDispatchId: event.payload.dispatchId,
      runRevision: 0,
      phase: "planning",
      error: null,
      currentLeaderRuntimeSessionId: null,
      leaderTurns: [],
      workerAttempts: [],
      workerCallbackCount: 0,
      pendingLeaderCallbackCount: 0,
      synthesisReportPath: null,
      owner: { source: event.source, personId: event.actor.principal.personId },
      acceptedRevision: event.workspaceRevision,
      acceptedAt: event.occurredAt,
    };
  } else if (event.type === "runtime_squad_run_observed") {
    const current = currentRow?.state as unknown as CanonicalSquadRun | undefined;
    if (!current || event.payload.runRevision <= current.runRevision)
      throw new Error("Squad canonical event sequence is invalid");
    state = {
      ...event.payload,
      owner: current.owner,
      acceptedRevision: event.workspaceRevision,
      acceptedAt: event.occurredAt,
    };
  } else return null;
  return {
    squadRunId: state.squadRunId,
    revision: state.runRevision,
    state: state as unknown as Record<string, unknown>,
  };
}
