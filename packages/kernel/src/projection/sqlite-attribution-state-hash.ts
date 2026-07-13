import type { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import { stablePayloadHash } from "../integrity/stable-hash.ts";

export function hashAttributionProjectionState(sql: SqlClient.SqlClient): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const tableRecords = yield* sql<{ readonly name: unknown }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
    const tableNames = tableRecords.map((record) => String(record.name));
    const entities: Array<{
      readonly table: string;
      readonly rows: ReadonlyArray<{ readonly id: string; readonly attribution: string }>;
    }> = [];
    for (const table of tableNames) {
      const quotedTable = quoteSqliteIdentifier(table);
      const columns = yield* sql.unsafe<{ readonly name: unknown; readonly pk: unknown }>(`PRAGMA table_info(${quotedTable})`);
      if (!columns.some((column) => String(column.name) === "attribution_json")) continue;
      const primaryKey = columns.find((column) => Number(column.pk) > 0);
      if (!primaryKey) throw new Error(`attributed projection table ${table} has no primary key`);
      const idColumn = quoteSqliteIdentifier(String(primaryKey.name));
      const records = yield* sql.unsafe<Record<string, unknown>>(
        `SELECT ${idColumn} AS entity_id, attribution_json FROM ${quotedTable} ORDER BY ${idColumn}`
      );
      entities.push({
        table,
        rows: records.map((record) => ({ id: String(record.entity_id), attribution: String(record.attribution_json) }))
      });
    }
    const events = tableNames.includes("attribution_events")
      ? (yield* sql<Record<string, unknown>>`
          SELECT event_id, op_id, subject_ref, operation, principal_person_id,
                 executor_agent_id, occurred_at, recorded_at, source_json
          FROM attribution_events
          ORDER BY occurred_at, event_id
        `).map((record) => ({
          eventId: String(record.event_id),
          opId: String(record.op_id),
          subjectRef: String(record.subject_ref),
          operation: String(record.operation),
          principalPersonId: String(record.principal_person_id),
          executorAgentId: record.executor_agent_id === null ? null : String(record.executor_agent_id),
          occurredAt: String(record.occurred_at),
          recordedAt: String(record.recorded_at),
          source: String(record.source_json)
        }))
      : [];
    const eventHeaders = tableNames.includes("attribution_event_headers")
      ? (yield* sql<Record<string, unknown>>`
          SELECT event_id, op_id, workspace_id, revision, commit_sha, previous_commit,
                 principal_person_id, executor_agent_id, occurred_at, recorded_at, source_json
          FROM attribution_event_headers
          ORDER BY revision, event_id
        `).map((record) => ({
          eventId: String(record.event_id),
          opId: String(record.op_id),
          workspaceId: String(record.workspace_id),
          revision: Number(record.revision),
          commitSha: String(record.commit_sha),
          previousCommit: record.previous_commit === null ? null : String(record.previous_commit),
          principalPersonId: String(record.principal_person_id),
          executorAgentId: record.executor_agent_id === null ? null : String(record.executor_agent_id),
          occurredAt: String(record.occurred_at),
          recordedAt: String(record.recorded_at),
          source: String(record.source_json)
        }))
      : [];
    const eventMutations = tableNames.includes("attribution_event_mutations")
      ? (yield* sql<Record<string, unknown>>`
          SELECT event_id, mutation_index, registry_version, entity_kind, subject_ref, operation
          FROM attribution_event_mutations
          ORDER BY event_id, mutation_index
        `).map((record) => ({
          eventId: String(record.event_id),
          mutationIndex: Number(record.mutation_index),
          registryVersion: Number(record.registry_version),
          entityKind: String(record.entity_kind),
          subjectRef: String(record.subject_ref),
          operation: String(record.operation)
        }))
      : [];
    return stablePayloadHash({
      schema: "projection-attribution-state/v2",
      entities,
      legacyEvents: events,
      eventHeaders,
      eventMutations
    });
  });
}

function quoteSqliteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Invalid SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
