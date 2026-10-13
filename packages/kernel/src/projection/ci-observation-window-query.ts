import type { DatabaseSync } from "node:sqlite";
import { prepareQuery, queryRows } from "./rebuildable-task-projection-sql.ts";

// Expressions mirror decodeCiObservation's historical identity mapping. Indexes are
// node-local derived data; no canonical event or replicated row is changed.
const schema = "json_extract(event_json, '$.schema')";
const provider = `CASE WHEN ${schema} = 'ci-run-observation/v4' THEN json_extract(event_json, '$.payload.identity.provider') ELSE coalesce(json_extract(event_json, '$.payload.verification.source'), 'local') END`;
const repository = `CASE WHEN ${schema} = 'ci-run-observation/v4' THEN json_extract(event_json, '$.payload.identity.repositoryId') ELSE 'legacy' END`;
const run = `CASE WHEN ${schema} = 'ci-run-observation/v4' THEN json_extract(event_json, '$.payload.identity.databaseRunId') ELSE coalesce(json_extract(event_json, '$.payload.verification.runId'), json_extract(event_json, '$.payload.run.runId')) END`;
const family = `json_array(${provider}, ${repository}, ${run})`;
const occurred = "json_extract(event_json, '$.occurredAt')";
export const ciObservationWindowPredicate = `${schema} IN ('ci-run-observation/v2','ci-run-observation/v3','ci-run-observation/v4') AND json_extract(event_json, '$.payload.run.branch') = 'main'`;
const numeric = `${provider} IN ('github-actions','gitlab-pipeline') AND ${run} != '' AND ${run} NOT GLOB '*[^0-9]*'`;
const digits = `ltrim(${run}, '0')`;

const rank = `(${numeric})`;
const numericLength = `CASE WHEN ${rank} THEN length(${digits}) END`;
const numericDigits = `CASE WHEN ${rank} THEN ${digits} END`;
const latest = `CASE WHEN NOT ${rank} THEN ${occurred} END`;
export const ciObservationWindowOrder = `${rank} DESC, ${numericLength} DESC, ${numericDigits} DESC, ${latest} DESC, ${family} COLLATE BINARY`;
export const CI_OBSERVATION_WINDOW_INDEX_SQL = `
  DROP INDEX IF EXISTS ci_observation_family_members;
  DROP INDEX IF EXISTS ci_observation_window_order;
  CREATE INDEX IF NOT EXISTS ci_observation_family_members_v2 ON event_index(${family}) WHERE ${ciObservationWindowPredicate};
  CREATE INDEX IF NOT EXISTS ci_observation_window_order_v2 ON event_index(${ciObservationWindowOrder}) WHERE ${ciObservationWindowPredicate};`;

export function readCiObservationWindowRows(db: DatabaseSync, window: number) {
  if (!Number.isSafeInteger(window) || window < 1 || window > 100)
    throw new Error("CI observatory window must be 1..100");
  const selected = new Set<string>();
  // The index streams scalar family keys in the domain's total order. Members
  // of one family can repeat; stop when N distinct keys are seen or SQLite ends.
  for (const row of prepareQuery(
    db,
    `SELECT ${family} AS family FROM event_index
    INDEXED BY ci_observation_window_order_v2 WHERE ${ciObservationWindowPredicate} ORDER BY ${ciObservationWindowOrder}`,
  ).iterate()) {
    selected.add(String(row.family));
    if (selected.size === window) break;
  }
  if (!selected.size) return [];
  return queryRows(
    db,
    `SELECT event_json FROM event_index INDEXED BY ci_observation_family_members_v2
    WHERE ${ciObservationWindowPredicate} AND ${family} IN (${[...selected].map(() => "?").join(",")})`,
    ...selected,
  );
}
