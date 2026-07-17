import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import type { AttributionEvent } from "../schemas/attribution-event.ts";
import type { AttributionEventV2, UnionAttributionEvent } from "../schemas/attribution-event-union.ts";
import { ensureEntityAttributionSummaryTable } from "./sqlite-attribution-summary.ts";

export function ensureAttributionEventTables(
  sql: SqlClient.SqlClient
): Effect.Effect<unknown, unknown> {
  return Effect.gen(function* () {
    yield* ensureEntityAttributionSummaryTable(sql);
    yield* migrateWorkspaceScopedRevisionIdentity(sql);
    yield* sql`
      CREATE TABLE IF NOT EXISTS attribution_events (
        event_id TEXT PRIMARY KEY,
        op_id TEXT NOT NULL UNIQUE,
        subject_ref TEXT NOT NULL,
        operation TEXT NOT NULL,
        principal_person_id TEXT NOT NULL,
        executor_agent_id TEXT,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        source_json TEXT NOT NULL
      )
    `;
    yield* sql`CREATE INDEX IF NOT EXISTS attribution_events_subject_time ON attribution_events(subject_ref, occurred_at, event_id)`;
    yield* sql`
      CREATE TABLE IF NOT EXISTS attribution_event_headers (
        event_id TEXT PRIMARY KEY,
        op_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        commit_sha TEXT NOT NULL,
        previous_commit TEXT,
        principal_person_id TEXT NOT NULL,
        executor_agent_id TEXT,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        source_json TEXT NOT NULL,
        UNIQUE (workspace_id, revision)
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS attribution_event_mutations (
        event_id TEXT NOT NULL,
        mutation_index INTEGER NOT NULL,
        registry_version INTEGER NOT NULL,
        entity_kind TEXT NOT NULL,
        subject_ref TEXT NOT NULL,
        operation TEXT NOT NULL,
        PRIMARY KEY (event_id, mutation_index),
        FOREIGN KEY (event_id) REFERENCES attribution_event_headers(event_id) ON DELETE CASCADE
      )
    `;
    yield* sql`CREATE INDEX IF NOT EXISTS attribution_event_mutations_subject ON attribution_event_mutations(subject_ref, event_id)`;
  });
}

function migrateWorkspaceScopedRevisionIdentity(sql: SqlClient.SqlClient): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const [header] = yield* sql<{ readonly sql: string | null }>`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attribution_event_headers'
    `;
    if (!header?.sql || !/revision\s+INTEGER\s+NOT\s+NULL\s+UNIQUE/iu.test(header.sql)) return;
    yield* sql`ALTER TABLE attribution_event_headers RENAME TO attribution_event_headers_global_revision`;
    yield* sql`
      CREATE TABLE attribution_event_headers (
        event_id TEXT PRIMARY KEY,
        op_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        commit_sha TEXT NOT NULL,
        previous_commit TEXT,
        principal_person_id TEXT NOT NULL,
        executor_agent_id TEXT,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        source_json TEXT NOT NULL,
        UNIQUE (workspace_id, revision)
      )
    `;
    yield* sql`
      INSERT INTO attribution_event_headers
      SELECT * FROM attribution_event_headers_global_revision
    `;
    const [mutations] = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attribution_event_mutations'
    `;
    if (mutations) {
      yield* sql`
        CREATE TABLE attribution_event_mutations_workspace_revision (
          event_id TEXT NOT NULL,
          mutation_index INTEGER NOT NULL,
          registry_version INTEGER NOT NULL,
          entity_kind TEXT NOT NULL,
          subject_ref TEXT NOT NULL,
          operation TEXT NOT NULL,
          PRIMARY KEY (event_id, mutation_index),
          FOREIGN KEY (event_id) REFERENCES attribution_event_headers(event_id) ON DELETE CASCADE
        )
      `;
      yield* sql`INSERT INTO attribution_event_mutations_workspace_revision SELECT * FROM attribution_event_mutations`;
      yield* sql`DROP TABLE attribution_event_mutations`;
      yield* sql`ALTER TABLE attribution_event_mutations_workspace_revision RENAME TO attribution_event_mutations`;
    }
    yield* sql`DROP TABLE attribution_event_headers_global_revision`;
  });
}

export function replaceAttributionEvents(
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<UnionAttributionEvent>
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* ensureAttributionEventTables(sql);
    yield* sql`DELETE FROM attribution_event_mutations`;
    yield* sql`DELETE FROM attribution_event_headers`;
    yield* sql`DELETE FROM attribution_events`;
    const legacyEvents = events.filter((event): event is AttributionEvent => event.schema === "attribution-event/v1");
    for (const batch of chunks(legacyEvents, 1_000)) yield* insertLegacyAttributionEvents(sql, batch);
    const currentEvents = events.filter((event): event is AttributionEventV2 => event.schema === "attribution-event/v2");
    for (const batch of chunks(currentEvents, 1_000)) yield* insertAttributionEventHeaders(sql, batch);
    const mutations = currentEvents.flatMap((event) => event.mutationSet.mutations.map((mutation, mutationIndex) => ({
      event,
      mutation,
      mutationIndex
    })));
    for (const batch of chunks(mutations, 1_000)) yield* insertAttributionEventMutations(sql, batch);
  });
}

export function insertAttributionEvent(
  sql: SqlClient.SqlClient,
  event: UnionAttributionEvent
): Effect.Effect<unknown, unknown> {
  if (event.schema === "attribution-event/v1") return insertLegacyAttributionEvent(sql, event);
  return Effect.gen(function* () {
    yield* sql`
      INSERT INTO attribution_event_headers (
        event_id, op_id, workspace_id, revision, commit_sha, previous_commit,
        principal_person_id, executor_agent_id, occurred_at, recorded_at, source_json
      ) VALUES (
        ${event.eventId}, ${event.opId}, ${event.workspaceId}, ${event.revision}, ${event.commitSha}, ${event.previousCommit},
        ${event.actorAxesBinding.principalPersonId}, ${event.actorAxesBinding.executorAgentId},
        ${event.occurredAt}, ${event.recordedAt}, ${JSON.stringify(event)}
      )
    `;
    for (let index = 0; index < event.mutationSet.mutations.length; index += 1) {
      const mutation = event.mutationSet.mutations[index]!;
      yield* sql`
        INSERT INTO attribution_event_mutations (
          event_id, mutation_index, registry_version, entity_kind, subject_ref, operation
        ) VALUES (
          ${event.eventId}, ${index}, ${event.mutationSet.registryVersion}, ${mutation.entity.entityKind},
          ${mutation.entity.canonicalRef}, ${mutation.action.action}
        )
      `;
    }
  });
}

function insertLegacyAttributionEvent(
  sql: SqlClient.SqlClient,
  event: AttributionEvent
): Effect.Effect<unknown, unknown> {
  return sql`
    INSERT INTO attribution_events (
      event_id, op_id, subject_ref, operation, principal_person_id,
      executor_agent_id, occurred_at, recorded_at, source_json
    ) VALUES (
      ${event.eventId}, ${event.opId}, ${event.entityId}, ${event.kind},
      ${event.actor.principal.personId}, ${event.actor.executor?.id ?? null},
      ${event.at}, ${event.recordedAt}, ${JSON.stringify(event)}
    )
  `;
}

function insertLegacyAttributionEvents(
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<AttributionEvent>
): Effect.Effect<unknown, unknown> {
  return sql.unsafe(`
    INSERT INTO attribution_events (
      event_id, op_id, subject_ref, operation, principal_person_id,
      executor_agent_id, occurred_at, recorded_at, source_json
    ) VALUES ${events.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
  `, events.flatMap((event) => [
    event.eventId,
    event.opId,
    event.entityId,
    event.kind,
    event.actor.principal.personId,
    event.actor.executor?.id ?? null,
    event.at,
    event.recordedAt,
    JSON.stringify(event)
  ]));
}

function insertAttributionEventHeaders(
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<AttributionEventV2>
): Effect.Effect<unknown, unknown> {
  return sql.unsafe(`
    INSERT INTO attribution_event_headers (
      event_id, op_id, workspace_id, revision, commit_sha, previous_commit,
      principal_person_id, executor_agent_id, occurred_at, recorded_at, source_json
    ) VALUES ${events.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
  `, events.flatMap((event) => [
    event.eventId,
    event.opId,
    event.workspaceId,
    event.revision,
    event.commitSha,
    event.previousCommit,
    event.actorAxesBinding.principalPersonId,
    event.actorAxesBinding.executorAgentId,
    event.occurredAt,
    event.recordedAt,
    JSON.stringify(event)
  ]));
}

function insertAttributionEventMutations(
  sql: SqlClient.SqlClient,
  rows: ReadonlyArray<{
    readonly event: AttributionEventV2;
    readonly mutation: AttributionEventV2["mutationSet"]["mutations"][number];
    readonly mutationIndex: number;
  }>
): Effect.Effect<unknown, unknown> {
  return sql.unsafe(`
    INSERT INTO attribution_event_mutations (
      event_id, mutation_index, registry_version, entity_kind, subject_ref, operation
    ) VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}
  `, rows.flatMap(({ event, mutation, mutationIndex }) => [
    event.eventId,
    mutationIndex,
    event.mutationSet.registryVersion,
    mutation.entity.entityKind,
    mutation.entity.canonicalRef,
    mutation.action.action
  ]));
}

function chunks<Value>(values: ReadonlyArray<Value>, size: number): ReadonlyArray<ReadonlyArray<Value>> {
  const output: Value[][] = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}
