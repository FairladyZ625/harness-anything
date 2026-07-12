import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { localLayoutFileSystem } from "../local/local-layout-file-system.ts";
import { readAttributionEvents } from "../local/attribution-event-source.ts";
import type { ActorAxes, ExecutorSource, PrincipalSource } from "../schemas/actor-attribution.ts";
import type { AttributionEvent } from "../schemas/attribution-event.ts";
import type { EntityAttributionProjection } from "./types.ts";
import { legacyEntityAttribution, readLegacyPersonIds, unresolvedEntityAttribution } from "./entity-attribution-projection.ts";
import { runSqlite } from "./sqlite-projection-store.ts";
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
  runSqlite(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* createAttributionTable(sql);
    yield* sql`DELETE FROM attribution_events`;
    for (const event of events) yield* insertAttributionEvent(sql, event);
  }));
  materializeEntityAttributionBlocks(rootInput, projectionPath);
  return events.map(eventToProjectionRow);
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

function materializeEntityAttributionBlocks(rootInput: HarnessLayoutInput, projectionPath: string): void {
  const rows = readAttributionProjection(rootInput, projectionPath);
  const bySubject = Map.groupBy(rows, (row) => row.subjectRef);
  const personIds = readLegacyPersonIds(rootInput);
  runSqlite(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const existing = new Set((yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .map((row) => String(row.name)));
    if (existing.has("decision_projection")) {
      const decisions = yield* sql<{ readonly decision_id: string; readonly proposed_by_json: string | null; readonly arbiter_json: string | null }>`
        SELECT decision_id, proposed_by_json, arbiter_json FROM decision_projection
      `;
      for (const decision of decisions) {
        const legacy = legacyDecisionAttribution(decision.proposed_by_json, decision.arbiter_json, personIds);
        yield* sql`UPDATE decision_projection SET attribution_json = ${JSON.stringify(legacy)} WHERE decision_id = ${decision.decision_id}`;
      }
    }
    for (const entity of entityProjectionTables) {
      if (!existing.has(entity.table)) continue;
      const records = yield* sql.unsafe<Record<string, unknown>>(`SELECT ${entity.id} FROM ${entity.table}`);
      for (const record of records) {
        const id = String(record[entity.id]);
        const events = bySubject.get(id) ?? bySubject.get(`${entity.prefix}${id}`);
        if (!events || events.length === 0) continue;
        const attribution = eventAttribution(events);
        yield* sql.unsafe(`UPDATE ${entity.table} SET attribution_json = ? WHERE ${entity.id} = ?`, [JSON.stringify(attribution), id]);
      }
    }
  }));
}

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

function legacyDecisionAttribution(
  proposedByJson: string | null,
  arbiterJson: string | null,
  personIds: ReadonlySet<string>
): EntityAttributionProjection {
  const originator = legacyActor(proposedByJson, personIds);
  const latestActor = legacyActor(arbiterJson, personIds) ?? originator;
  return originator ? legacyEntityAttribution(originator, latestActor) : {
    ...unresolvedEntityAttribution(),
    latestActor
  };
}

function legacyActor(value: string | null, personIds: ReadonlySet<string>): ActorAxes | null {
  if (!value) return null;
  try {
    const actor = JSON.parse(value) as { readonly kind?: unknown; readonly id?: unknown };
    if (actor.kind !== "human" || typeof actor.id !== "string" || !personIds.has(actor.id)) return null;
    return { principal: { kind: "person", personId: actor.id }, executor: null };
  } catch {
    return null;
  }
}
