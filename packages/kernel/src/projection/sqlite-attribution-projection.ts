import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { localLayoutFileSystem } from "../local/local-layout-file-system.ts";
import { decodeAttributionEventBody, readAttributionEvents } from "../local/attribution-event-source.ts";
import type { ActorAxes, ExecutorSource, PrincipalSource } from "../schemas/actor-attribution.ts";
import type { AttributionEvent } from "../schemas/attribution-event.ts";
import { unresolvedEntityAttribution } from "./entity-attribution-projection.ts";
import type { EntityAttributionProjection } from "./types.ts";
import { runSqlite } from "./sqlite-projection-store.ts";
import type { ProjectionSourceCacheChange } from "./sqlite-projection-source-cache.ts";
import { SqlClient } from "@effect/sql";
import { Effect } from "effect";

export interface AttributionProjectionRow {
  readonly eventId: string;
  readonly opId: string;
  readonly subjectRef: string;
  readonly operation: string;
  readonly actor: ActorAxes;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly principalSource: PrincipalSource;
  readonly executorSource: ExecutorSource;
  readonly payloadHash: string;
  readonly payloadRef: AttributionEvent["payloadRef"];
}

export function materializeAttributionProjection(
  rootInput: HarnessLayoutInput,
  projectionPath = resolveHarnessLayout(rootInput).projectionPath
): ReadonlyArray<AttributionProjectionRow> {
  if (!localLayoutFileSystem.exists(projectionPath)) throw new Error("base projection database must exist before attribution materialization");
  const events = readAttributionEvents(rootInput);
  return materializeAttributionProjectionFromEvents(projectionPath, events);
}

export function materializeAttributionProjectionFromEvents(
  projectionPath: string,
  events: ReadonlyArray<AttributionEvent>
): ReadonlyArray<AttributionProjectionRow> {
  if (!localLayoutFileSystem.exists(projectionPath)) throw new Error("base projection database must exist before attribution materialization");
  runSqlite(projectionPath, Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.gen(function* () {
    yield* replaceAttributionProjectionRows(sql, events);
    yield* materializeEntityAttributionBlocks(sql, events);
  })));
  return events.map(eventToProjectionRow);
}

export function replaceAttributionProjectionRows(
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<AttributionEvent>
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* createAttributionTable(sql);
    yield* sql`DELETE FROM attribution_events`;
    for (const event of events) yield* insertAttributionEvent(sql, event);
  });
}

export function applyAttributionProjectionDelta(
  sql: SqlClient.SqlClient,
  delta: AttributionProjectionDelta
): Effect.Effect<ReadonlyArray<string>, unknown> {
  return Effect.gen(function* () {
    yield* createAttributionTable(sql);
    for (const eventId of delta.deleteEventIds) {
      yield* sql`DELETE FROM attribution_events WHERE event_id = ${eventId}`;
    }
    for (const event of delta.upsertEvents) yield* insertAttributionEvent(sql, event);
    return delta.affectedSubjects;
  });
}

export interface AttributionProjectionDelta {
  readonly deleteEventIds: ReadonlyArray<string>;
  readonly upsertEvents: ReadonlyArray<AttributionEvent>;
  readonly affectedSubjects: ReadonlyArray<string>;
}

export function buildAttributionProjectionDelta(
  change: ProjectionSourceCacheChange
): AttributionProjectionDelta {
  const previous = new Map(change.previous.files
    .filter((row) => row.cacheKind === "attribution")
    .map((row) => [row.sourcePath, row]));
  const current = new Map(change.current.files
    .filter((row) => row.cacheKind === "attribution")
    .map((row) => [row.sourcePath, row]));
  const deleteEventIds = new Set<string>();
  const upsertEvents: AttributionEvent[] = [];
  const affectedSubjects = new Set<string>();
  for (const [sourcePath, row] of previous) {
    const next = current.get(sourcePath);
    if (next?.contentSha256 === row.contentSha256) continue;
    const event = decodeAttributionEventBody(row.body);
    deleteEventIds.add(event.eventId);
    affectedSubjects.add(event.entityId);
  }
  for (const [sourcePath, row] of current) {
    const prior = previous.get(sourcePath);
    if (prior?.contentSha256 === row.contentSha256) continue;
    const event = decodeAttributionEventBody(row.body);
    upsertEvents.push(event);
    affectedSubjects.add(event.entityId);
  }
  return {
    deleteEventIds: [...deleteEventIds],
    upsertEvents,
    affectedSubjects: [...affectedSubjects]
  };
}

export function materializeEntityAttributionBlocks(
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<AttributionEvent>
): Effect.Effect<void, unknown> {
  const rows = events.map(eventToProjectionRow);
  const bySubject = Map.groupBy(rows, (row) => row.subjectRef);
  return Effect.gen(function* () {
    const existing = new Set((yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .map((row) => String(row.name)));
    for (const entity of entityProjectionTables) {
      if (!existing.has(entity.table)) continue;
      yield* sql.unsafe(`UPDATE ${entity.table} SET attribution_json = ?`, [JSON.stringify(unresolvedEntityAttribution())]);
      const records = yield* sql.unsafe<Record<string, unknown>>(`SELECT ${entity.id} FROM ${entity.table}`);
      for (const record of records) {
        const id = String(record[entity.id]);
        const attributed = bySubject.get(id) ?? bySubject.get(`${entity.prefix}${id}`);
        if (!attributed || attributed.length === 0) continue;
        const attribution = eventAttribution(attributed);
        yield* sql.unsafe(`UPDATE ${entity.table} SET attribution_json = ? WHERE ${entity.id} = ?`, [JSON.stringify(attribution), id]);
      }
    }
  });
}

export function materializeEntityAttributionTargets(
  sql: SqlClient.SqlClient,
  targets: ReadonlyArray<{ readonly table: string; readonly id: string }>
): Effect.Effect<void, unknown> {
  const uniqueTargets = new Map(targets.map((target) => [`${target.table}\0${target.id}`, target]));
  return Effect.gen(function* () {
    for (const target of uniqueTargets.values()) {
      const entity = entityProjectionTables.find((candidate) => candidate.table === target.table);
      if (!entity) throw new Error(`unknown attributed projection table: ${target.table}`);
      yield* sql.unsafe(`UPDATE ${entity.table} SET attribution_json = ? WHERE ${entity.id} = ?`, [
        JSON.stringify(unresolvedEntityAttribution()),
        target.id
      ]);
      const records = yield* sql.unsafe<AttributionRecord>(`
        SELECT event_id, op_id, subject_ref, operation, principal_person_id,
               executor_agent_id, occurred_at, recorded_at, source_json
        FROM attribution_events
        WHERE subject_ref = ? OR subject_ref = ?
        ORDER BY occurred_at, event_id
      `, [target.id, `${entity.prefix}${target.id}`]);
      if (records.length === 0) continue;
      yield* sql.unsafe(`UPDATE ${entity.table} SET attribution_json = ? WHERE ${entity.id} = ?`, [
        JSON.stringify(eventAttribution(records.map(recordToProjectionRow))),
        target.id
      ]);
    }
  });
}

export function materializeEntityAttributionSubjects(
  sql: SqlClient.SqlClient,
  subjectRefs: ReadonlyArray<string>
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const targets: Array<{ readonly table: string; readonly id: string }> = [];
    for (const entity of entityProjectionTables) {
      for (const subjectRef of new Set(subjectRefs)) {
        const candidateId = subjectRef.startsWith(entity.prefix)
          ? subjectRef.slice(entity.prefix.length)
          : subjectRef;
        const records = yield* sql.unsafe<Record<string, unknown>>(
          `SELECT ${entity.id} AS entity_id FROM ${entity.table} WHERE ${entity.id} = ?`,
          [candidateId]
        );
        if (records.length > 0) targets.push({ table: entity.table, id: candidateId });
      }
    }
    yield* materializeEntityAttributionTargets(sql, targets);
  });
}

export function readAttributionProjection(
  rootInput: HarnessLayoutInput,
  projectionPath = resolveHarnessLayout(rootInput).projectionPath
): ReadonlyArray<AttributionProjectionRow> {
  return runSqlite(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const records = yield* sql<AttributionRecord>`
      SELECT event_id, op_id, subject_ref, operation, principal_person_id,
             executor_agent_id, occurred_at, recorded_at, source_json
      FROM attribution_events
      ORDER BY occurred_at, event_id
    `;
    return records.map(recordToProjectionRow);
  }));
}

function createAttributionTable(sql: SqlClient.SqlClient): Effect.Effect<unknown, unknown> {
  return Effect.gen(function* () {
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
  });
}

function insertAttributionEvent(sql: SqlClient.SqlClient, event: AttributionEvent): Effect.Effect<unknown, unknown> {
  return sql`
    INSERT INTO attribution_events (
      event_id, op_id, subject_ref, operation, principal_person_id,
      executor_agent_id, occurred_at, recorded_at, source_json
    ) VALUES (
      ${event.eventId}, ${event.opId}, ${event.entityId}, ${event.kind},
      ${event.actor.principal.personId}, ${event.actor.executor?.id ?? null},
      ${event.at}, ${event.recordedAt}, ${JSON.stringify(eventSource(event))}
    )
  `;
}

function eventToProjectionRow(event: AttributionEvent): AttributionProjectionRow {
  return {
    eventId: event.eventId,
    opId: event.opId,
    subjectRef: event.entityId,
    operation: event.kind,
    actor: event.actor,
    occurredAt: event.at,
    recordedAt: event.recordedAt,
    principalSource: event.principalSource,
    executorSource: event.executorSource,
    payloadHash: event.payloadHash,
    payloadRef: event.payloadRef
  };
}

function recordToProjectionRow(record: AttributionRecord): AttributionProjectionRow {
  const source = JSON.parse(String(record.source_json)) as ReturnType<typeof eventSource>;
  return {
    eventId: String(record.event_id),
    opId: String(record.op_id),
    subjectRef: String(record.subject_ref),
    operation: String(record.operation),
    actor: {
      principal: { kind: "person", personId: String(record.principal_person_id) },
      executor: record.executor_agent_id === null ? null : { kind: "agent", id: String(record.executor_agent_id) }
    },
    occurredAt: String(record.occurred_at),
    recordedAt: String(record.recorded_at),
    principalSource: source.principalSource,
    executorSource: source.executorSource,
    payloadHash: source.payloadHash,
    payloadRef: source.payloadRef
  };
}

function eventSource(event: AttributionEvent): {
  readonly journalRecordSchema: "write-journal/v2";
  readonly principalSource: PrincipalSource;
  readonly executorSource: ExecutorSource;
  readonly payloadHash: string;
  readonly payloadRef: AttributionEvent["payloadRef"];
} {
  return {
    journalRecordSchema: event.journalRecordSchema,
    principalSource: event.principalSource,
    executorSource: event.executorSource,
    payloadHash: event.payloadHash,
    payloadRef: event.payloadRef
  };
}

interface AttributionRecord {
  readonly event_id: unknown;
  readonly op_id: unknown;
  readonly subject_ref: unknown;
  readonly operation: unknown;
  readonly principal_person_id: unknown;
  readonly executor_agent_id: unknown;
  readonly occurred_at: unknown;
  readonly recorded_at: unknown;
  readonly source_json: unknown;
}

const entityProjectionTables = [
  { table: "task_projection", id: "task_id", prefix: "task/" },
  { table: "decision_projection", id: "decision_id", prefix: "decision/" },
  { table: "session_projection", id: "session_id", prefix: "session/" },
  { table: "execution_projection", id: "execution_id", prefix: "execution/" },
  { table: "review_projection", id: "review_id", prefix: "review/" }
] as const;

function eventAttribution(rows: ReadonlyArray<AttributionProjectionRow>): EntityAttributionProjection {
  const ordered = [...rows].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId));
  const origin = ordered.find((row) => row.operation === "package_create" || row.operation === "decision_propose") ?? ordered[0]!;
  return {
    originator: origin.actor,
    latestActor: ordered.at(-1)!.actor,
    trailCount: ordered.length,
    completeness: "complete"
  };
}
