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
const main = `${schema} IN ('ci-run-observation/v2','ci-run-observation/v3','ci-run-observation/v4') AND json_extract(event_json, '$.payload.run.branch') = 'main'`;
const numeric = `${provider} = 'github-actions' AND ${run} != '' AND ${run} NOT GLOB '*[^0-9]*'`;
const digits = `ltrim(${run}, '0')`;

const rank = `(${numeric})`;
const numericLength = `CASE WHEN ${rank} THEN length(${digits}) END`;
const numericDigits = `CASE WHEN ${rank} THEN ${digits} END`;
const latest = `CASE WHEN NOT ${rank} THEN ${occurred} END`;
const order = `${rank} DESC, ${numericLength} DESC, ${numericDigits} DESC, ${latest} DESC, ${family} COLLATE BINARY`;
export const CI_OBSERVATION_WINDOW_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS ci_observation_family_members ON event_index(${family}) WHERE ${main};
  CREATE INDEX IF NOT EXISTS ci_observation_window_order ON event_index(${order}) WHERE ${main};`;

export function readCiObservationWindowRows(db: DatabaseSync, window: number) {
  if (!Number.isSafeInteger(window) || window < 1 || window > 100)
    throw new Error("CI observatory window must be 1..100");
  const selected = new Set<string>();
  // The index streams scalar family keys in the domain's total order. Members
  // of one family can repeat; stop when N distinct keys are seen or SQLite ends.
  for (const row of prepareQuery(
    db,
    `SELECT ${family} AS family FROM event_index
    INDEXED BY ci_observation_window_order WHERE ${main} ORDER BY ${order}`,
  ).iterate()) {
    selected.add(String(row.family));
    if (selected.size === window) break;
  }
  if (!selected.size) return [];
  return queryRows(
    db,
    `SELECT event_json FROM event_index INDEXED BY ci_observation_family_members
    WHERE ${main} AND ${family} IN (${[...selected].map(() => "?").join(",")})`,
    ...selected,
  );
}
