import {
  privateRuntimeEventTypes,
  publicRuntimeDispatch,
  publicRuntimeSession,
  publicRuntimeInstallation,
} from "../domain/runtime-public-query.ts";
import type { AgentRuntimeEventV1, RuntimeSession, RuntimeInstallation } from "../domain/agent-runtime.ts";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/** Shared business-table DDL; canonical journal/source and writer metadata are never replicated. */
export const REPOSITORY_READ_TABLES_SQL = `
    CREATE TABLE IF NOT EXISTS runtime_installation (
      installation_id TEXT PRIMARY KEY,
      workspace_revision INTEGER NOT NULL,
      value_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_session (
      runtime_session_id TEXT PRIMARY KEY,
      workspace_revision INTEGER NOT NULL,
      value_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_session_task_binding (
      task_id TEXT NOT NULL,
      runtime_session_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      bound_at TEXT NOT NULL,
      PRIMARY KEY(task_id, runtime_session_id, execution_id)
    );
    CREATE INDEX IF NOT EXISTS runtime_session_task_binding_session
      ON runtime_session_task_binding(runtime_session_id, task_id, execution_id);
    CREATE TABLE IF NOT EXISTS squad_run_projection (
      squad_run_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      state_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pinned_entities (
      entity_ref TEXT PRIMARY KEY,
      pinned_at TEXT NOT NULL,
      pinned_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lease_interval (
      task_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      acquired_revision INTEGER NOT NULL,
      released_revision INTEGER,
      holder_json TEXT NOT NULL,
      previous_holder_json TEXT,
      lease_expires_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY(task_id, execution_id, acquired_revision)
    );
`;

const prefix = ".read-model/repository/";
const tables = [
  {
    name: "runtime_installation",
    keys: ["installation_id"],
    columns: ["installation_id", "workspace_revision", "value_json"],
  },
  {
    name: "runtime_session",
    keys: ["runtime_session_id"],
    columns: ["runtime_session_id", "workspace_revision", "value_json"],
  },
  {
    name: "runtime_session_task_binding",
    keys: ["task_id", "runtime_session_id", "execution_id"],
    columns: ["task_id", "runtime_session_id", "execution_id", "bound_at"],
  },
  { name: "squad_run_projection", keys: ["squad_run_id"], columns: ["squad_run_id", "revision", "state_json"] },
  { name: "pinned_entities", keys: ["entity_ref"], columns: ["entity_ref", "pinned_at", "pinned_by"] },
  {
    name: "lease_interval",
    keys: ["task_id", "execution_id", "acquired_revision"],
    columns: [
      "task_id",
      "execution_id",
      "acquired_revision",
      "released_revision",
      "holder_json",
      "previous_holder_json",
      "lease_expires_at",
      "reason",
    ],
  },
  // Only the event-backed query families below are exported, never the whole canonical event log.
  {
    name: "event_index",
    keys: ["op_id"],
    columns: ["op_id", "workspace_revision", "task_id", "event_json"],
    where: `WHERE
      (json_extract(event_json, '$.schema') = 'agent-runtime-event/v1' AND json_extract(event_json, '$.type') NOT IN (${privateRuntimeEventTypes.map((type) => `'${type}'`).join(", ")}))
      OR json_extract(event_json, '$.type') IN ('fact_recorded', 'decision_superseded', 'decision_retired', 'decision_accepted')
      OR json_extract(event_json, '$.schema') IN ('schedule-event/v1', 'ci-run-observation/v3')
      OR (json_extract(event_json, '$.schema') = 'settings-event/v1' AND workspace_revision =
        (SELECT workspace_revision FROM entity_projection WHERE entity_kind = 'settings' AND entity_id = 'repository'))
      OR (json_extract(event_json, '$.schema') IN ('fact-event/v1', 'decision-event/v1', 'task-event/v1')
        AND json_extract(event_json, '$.actor.executor.id') LIKE 'runtime-session:%')`,
  },
] as const;

export interface RepositoryReadModelRow {
  readonly table: (typeof tables)[number]["name"];
  readonly values: Readonly<Record<string, string | number | null>>;
}

export function createRepositoryReadModelTables(db: DatabaseSync): void {
  db.exec(REPOSITORY_READ_TABLES_SQL);
  db.exec(
    `CREATE TABLE IF NOT EXISTS event_index (op_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL UNIQUE, task_id TEXT, event_json TEXT NOT NULL);`,
  );
}

export function readRepositoryReadModelRows(db: DatabaseSync): readonly RepositoryReadModelRow[] {
  return tables.flatMap((table) =>
    (
      db
        .prepare(
          `SELECT ${table.columns.join(", ")} FROM ${table.name} ${"where" in table ? table.where : ""} ORDER BY ${table.keys.join(", ")}`,
        )
        .all() as RepositoryReadModelRow["values"][]
    ).map((values) => ({ table: table.name, values: publicRow(table.name, values) })),
  );
}

export function repositoryReadModelPath(row: RepositoryReadModelRow): string {
  const table = tables.find(({ name }) => name === row.table)!;
  const key = Buffer.from(JSON.stringify(table.keys.map((column) => row.values[column]))).toString("base64url");
  return `${prefix}${table.name}/${key}.json`;
}

export function applyRepositoryReadModelRow(db: DatabaseSync, entryPath: string, row: RepositoryReadModelRow): boolean {
  if (!entryPath.startsWith(prefix)) return false;
  const table = tables.find(({ name }) => name === row.table);
  if (!table || repositoryReadModelPath(row) !== entryPath)
    throw new Error("repository read model row key is incompatible");
  db.prepare(
    `INSERT OR REPLACE INTO ${table.name} (${table.columns.join(", ")}) VALUES (${table.columns.map(() => "?").join(", ")})`,
  ).run(...table.columns.map((column) => row.values[column] as SQLInputValue));
  return true;
}

export function deleteRepositoryReadModelRow(db: DatabaseSync, entryPath: string): boolean {
  if (!entryPath.startsWith(prefix)) return false;
  const [name, key] = entryPath.slice(prefix.length, -".json".length).split("/");
  const table = tables.find((table) => table.name === name);
  if (!table || !key) throw new Error("repository read model row key is incompatible");
  const values = JSON.parse(Buffer.from(key, "base64url").toString("utf8")) as SQLInputValue[];
  if (values.length !== table.keys.length) throw new Error("repository read model row key is incompatible");
  db.prepare(`DELETE FROM ${table.name} WHERE ${table.keys.map((column) => `${column} = ?`).join(" AND ")}`).run(
    ...values,
  );
  return true;
}

function publicRow(
  table: RepositoryReadModelRow["table"],
  values: RepositoryReadModelRow["values"],
): RepositoryReadModelRow["values"] {
  if (table === "runtime_session")
    return {
      ...values,
      value_json: JSON.stringify(publicRuntimeSession(JSON.parse(String(values.value_json)) as RuntimeSession)),
    };
  if (table === "runtime_installation")
    return {
      ...values,
      value_json: JSON.stringify(
        publicRuntimeInstallation(JSON.parse(String(values.value_json)) as RuntimeInstallation),
      ),
    };
  if (table === "event_index") {
    const event = JSON.parse(String(values.event_json)) as AgentRuntimeEventV1;
    if (event.schema === "agent-runtime-event/v1" && event.type === "runtime_dispatch_requested")
      return { ...values, event_json: JSON.stringify(publicRuntimeDispatch(event)) };
  }
  return values;
}
