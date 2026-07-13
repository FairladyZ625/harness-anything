import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import { canonicalEntityKinds, type CanonicalEntityKind } from "../entity/canonical-kinds.ts";
import { entityRegistry } from "../entity/registry.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { localLayoutFileSystem } from "../local/local-layout-file-system.ts";
import {
  decodeUnionAttributionEventBody,
  readUnionAttributionEvents
} from "../local/attribution-event-source.ts";
import type { ActorAxes, ExecutorSource, PrincipalSource } from "../schemas/actor-attribution.ts";
import type { AttributionEvent } from "../schemas/attribution-event.ts";
import {
  attributionEventCompleteness,
  decodeUnionAttributionEvent,
  type AttributionEventCompleteness,
  type AttributionEventV2,
  type UnionAttributionEvent
} from "../schemas/attribution-event-union.ts";
import { unresolvedEntityAttribution } from "./entity-attribution-projection.ts";
import type { ProjectionSourceCacheChange } from "./sqlite-projection-source-cache.ts";
import { runSqlite } from "./sqlite-projection-store.ts";
import type { EntityAttributionProjection } from "./types.ts";

export interface AttributionDigestStatus {
  readonly semanticMutationSet: "verified" | "not-present";
  readonly actorAxesBinding: "verified" | "not-present";
  readonly physicalChangeSet: "verified" | "not-present";
  readonly canonicalEvent: "verified" | "not-present";
}

export interface AttributionProjectionRow {
  readonly eventId: string;
  readonly opId: string;
  readonly eventSchemaVersion: 1 | 2;
  readonly completeness: AttributionEventCompleteness;
  readonly subjectRef: string;
  readonly legacyHostRef: string | null;
  readonly entityKind: CanonicalEntityKind | null;
  readonly operation: string;
  readonly actor: ActorAxes;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly revision: number | null;
  readonly commitSha: string | null;
  readonly principalSource: PrincipalSource | { readonly kind: "actor-axes-binding"; readonly bindingId: string };
  readonly executorSource: ExecutorSource | "verified-binding";
  readonly payloadHash: string;
  readonly payloadRef: AttributionEvent["payloadRef"] | null;
  readonly mutationRegistryVersion: number | null;
  readonly digestStatus: AttributionDigestStatus;
}

export function materializeAttributionProjection(
  rootInput: HarnessLayoutInput,
  projectionPath = resolveHarnessLayout(rootInput).projectionPath
): ReadonlyArray<AttributionProjectionRow> {
  if (!localLayoutFileSystem.exists(projectionPath)) throw new Error("base projection database must exist before attribution materialization");
  return materializeAttributionProjectionFromEvents(projectionPath, readUnionAttributionEvents(rootInput));
}

export function materializeAttributionProjectionFromEvents(
  projectionPath: string,
  events: ReadonlyArray<UnionAttributionEvent>
): ReadonlyArray<AttributionProjectionRow> {
  if (!localLayoutFileSystem.exists(projectionPath)) throw new Error("base projection database must exist before attribution materialization");
  runSqlite(projectionPath, Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.gen(function* () {
    yield* replaceAttributionProjectionRows(sql, events);
    yield* materializeEntityAttributionBlocks(sql, events);
  })));
  return events.flatMap(eventToProjectionRows);
}

export function replaceAttributionProjectionRows(
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<UnionAttributionEvent>
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* createAttributionTables(sql);
    yield* sql`DELETE FROM attribution_event_mutations`;
    yield* sql`DELETE FROM attribution_event_headers`;
    yield* sql`DELETE FROM attribution_events`;
    for (const event of events) yield* insertAttributionEvent(sql, event);
  });
}

export function applyAttributionProjectionDelta(
  sql: SqlClient.SqlClient,
  delta: AttributionProjectionDelta
): Effect.Effect<ReadonlyArray<string>, unknown> {
  return Effect.gen(function* () {
    yield* createAttributionTables(sql);
    for (const eventId of delta.deleteEventIds) {
      yield* sql`DELETE FROM attribution_event_mutations WHERE event_id = ${eventId}`;
      yield* sql`DELETE FROM attribution_event_headers WHERE event_id = ${eventId}`;
      yield* sql`DELETE FROM attribution_events WHERE event_id = ${eventId}`;
    }
    for (const event of delta.upsertEvents) yield* insertAttributionEvent(sql, event);
    return delta.affectedSubjects;
  });
}

export interface AttributionProjectionDelta {
  readonly deleteEventIds: ReadonlyArray<string>;
  readonly upsertEvents: ReadonlyArray<UnionAttributionEvent>;
  readonly affectedSubjects: ReadonlyArray<string>;
}

export function buildAttributionProjectionDelta(change: ProjectionSourceCacheChange): AttributionProjectionDelta {
  const previous = new Map(change.previous.files
    .filter((row) => row.cacheKind === "attribution")
    .map((row) => [row.sourcePath, row]));
  const current = new Map(change.current.files
    .filter((row) => row.cacheKind === "attribution")
    .map((row) => [row.sourcePath, row]));
  const deleteEventIds = new Set<string>();
  const upsertEvents: UnionAttributionEvent[] = [];
  const affectedSubjects = new Set<string>();
  for (const [sourcePath, row] of previous) {
    const next = current.get(sourcePath);
    if (next?.contentSha256 === row.contentSha256) continue;
    const event = decodeUnionAttributionEventBody(row.body);
    deleteEventIds.add(event.eventId);
    eventToProjectionRows(event).forEach((projection) => affectedSubjects.add(projection.subjectRef));
  }
  for (const [sourcePath, row] of current) {
    const prior = previous.get(sourcePath);
    if (prior?.contentSha256 === row.contentSha256) continue;
    const event = decodeUnionAttributionEventBody(row.body);
    upsertEvents.push(event);
    eventToProjectionRows(event).forEach((projection) => affectedSubjects.add(projection.subjectRef));
  }
  return { deleteEventIds: [...deleteEventIds], upsertEvents, affectedSubjects: [...affectedSubjects] };
}

export function materializeEntityAttributionBlocks(
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<UnionAttributionEvent>
): Effect.Effect<void, unknown> {
  const rows = events.flatMap(eventToProjectionRows);
  return Effect.gen(function* () {
    const existing = new Set((yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .map((row) => String(row.name)));
    for (const target of registryAttributionTargets()) {
      if (!existing.has(target.table)) continue;
      yield* sql.unsafe(`UPDATE ${target.table} SET attribution_json = ?`, [JSON.stringify(unresolvedEntityAttribution())]);
      const records = yield* sql.unsafe<Record<string, unknown>>(`SELECT ${target.idColumn} FROM ${target.table}`);
      for (const record of records) {
        const id = String(record[target.idColumn]);
        const attributed = rows.filter((row) => projectionRowMatchesTarget(row, target.kind, id));
        if (attributed.length === 0) continue;
        yield* sql.unsafe(`UPDATE ${target.table} SET attribution_json = ? WHERE ${target.idColumn} = ?`, [
          JSON.stringify(eventAttribution(attributed)), id
        ]);
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
    const rows = yield* readAttributionProjectionRows(sql);
    for (const target of uniqueTargets.values()) {
      const declaration = registryAttributionTargets().find((candidate) => candidate.table === target.table);
      if (!declaration) throw new Error(`unknown attributed projection table: ${target.table}`);
      yield* sql.unsafe(`UPDATE ${declaration.table} SET attribution_json = ? WHERE ${declaration.idColumn} = ?`, [
        JSON.stringify(unresolvedEntityAttribution()), target.id
      ]);
      const attributed = rows.filter((row) => projectionRowMatchesTarget(row, declaration.kind, target.id));
      if (attributed.length === 0) continue;
      yield* sql.unsafe(`UPDATE ${declaration.table} SET attribution_json = ? WHERE ${declaration.idColumn} = ?`, [
        JSON.stringify(eventAttribution(attributed)), target.id
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
    for (const target of registryAttributionTargets()) {
      for (const subjectRef of new Set(subjectRefs)) {
        const id = resolveTargetId(subjectRef, target.kind) ?? legacyTargetId(subjectRef, target.kind);
        if (!id) continue;
        const records = yield* sql.unsafe<Record<string, unknown>>(
          `SELECT ${target.idColumn} AS entity_id FROM ${target.table} WHERE ${target.idColumn} = ?`, [id]
        );
        if (records.length > 0) targets.push({ table: target.table, id });
      }
    }
    yield* materializeEntityAttributionTargets(sql, targets);
  });
}

export function readAttributionProjection(
  rootInput: HarnessLayoutInput,
  projectionPath = resolveHarnessLayout(rootInput).projectionPath
): ReadonlyArray<AttributionProjectionRow> {
  return runSqlite(projectionPath, Effect.flatMap(SqlClient.SqlClient, readAttributionProjectionRows));
}

function createAttributionTables(sql: SqlClient.SqlClient): Effect.Effect<unknown, unknown> {
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
    yield* sql`
      CREATE TABLE IF NOT EXISTS attribution_event_headers (
        event_id TEXT PRIMARY KEY,
        op_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        revision INTEGER NOT NULL UNIQUE,
        commit_sha TEXT NOT NULL,
        previous_commit TEXT,
        principal_person_id TEXT NOT NULL,
        executor_agent_id TEXT,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        source_json TEXT NOT NULL
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

function insertAttributionEvent(sql: SqlClient.SqlClient, event: UnionAttributionEvent): Effect.Effect<unknown, unknown> {
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

function insertLegacyAttributionEvent(sql: SqlClient.SqlClient, event: AttributionEvent): Effect.Effect<unknown, unknown> {
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

function eventToProjectionRows(event: UnionAttributionEvent): ReadonlyArray<AttributionProjectionRow> {
  if (event.schema === "attribution-event/v1") return [legacyEventToProjectionRow(event)];
  return event.mutationSet.mutations.map((mutation) => v2MutationToProjectionRow(event, mutation));
}

function legacyEventToProjectionRow(event: AttributionEvent): AttributionProjectionRow {
  return {
    eventId: event.eventId,
    opId: event.opId,
    eventSchemaVersion: 1,
    completeness: attributionEventCompleteness(event),
    subjectRef: event.entityId,
    legacyHostRef: event.entityId,
    entityKind: null,
    operation: event.kind,
    actor: event.actor,
    occurredAt: event.at,
    recordedAt: event.recordedAt,
    revision: null,
    commitSha: null,
    principalSource: event.principalSource,
    executorSource: event.executorSource,
    payloadHash: event.payloadHash,
    payloadRef: event.payloadRef,
    mutationRegistryVersion: null,
    digestStatus: absentDigestStatus()
  };
}

function v2MutationToProjectionRow(
  event: AttributionEventV2,
  mutation: AttributionEventV2["mutationSet"]["mutations"][number]
): AttributionProjectionRow {
  return {
    eventId: event.eventId,
    opId: event.opId,
    eventSchemaVersion: 2,
    completeness: "complete",
    subjectRef: mutation.entity.canonicalRef,
    legacyHostRef: null,
    entityKind: mutation.entity.entityKind as CanonicalEntityKind,
    operation: mutation.action.action,
    actor: {
      principal: { kind: "person", personId: event.actorAxesBinding.principalPersonId },
      executor: event.actorAxesBinding.executorAgentId === null
        ? null
        : { kind: "agent", id: event.actorAxesBinding.executorAgentId }
    },
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    revision: event.revision,
    commitSha: event.commitSha,
    principalSource: { kind: "actor-axes-binding", bindingId: event.actorAxesBinding.bindingId },
    executorSource: "verified-binding",
    payloadHash: event.semanticRequestDigest,
    payloadRef: null,
    mutationRegistryVersion: event.mutationSet.registryVersion,
    digestStatus: verifiedDigestStatus()
  };
}

function readAttributionProjectionRows(sql: SqlClient.SqlClient): Effect.Effect<ReadonlyArray<AttributionProjectionRow>, unknown> {
  return Effect.gen(function* () {
    yield* createAttributionTables(sql);
    const legacy = yield* sql<LegacyAttributionRecord>`
      SELECT event_id, op_id, subject_ref, operation, principal_person_id,
             executor_agent_id, occurred_at, recorded_at, source_json
      FROM attribution_events
    `;
    const v2 = yield* sql<V2AttributionRecord>`
      SELECT h.event_id, h.op_id, h.revision, h.commit_sha, h.occurred_at, h.recorded_at,
             m.entity_kind, m.subject_ref, m.operation, h.source_json
      FROM attribution_event_headers h
      JOIN attribution_event_mutations m ON m.event_id = h.event_id
    `;
    return [
      ...legacy.map((record) => {
        const event = decodeUnionAttributionEvent(JSON.parse(String(record.source_json)));
        if (event.schema !== "attribution-event/v1") throw new Error(`LEGACY_ATTRIBUTION_ROW_SCHEMA_MISMATCH:${String(record.event_id)}`);
        return legacyEventToProjectionRow(event);
      }),
      ...v2.map((record) => {
        const event = decodeUnionAttributionEvent(JSON.parse(String(record.source_json)));
        if (event.schema !== "attribution-event/v2") throw new Error(`V2_ATTRIBUTION_ROW_SCHEMA_MISMATCH:${String(record.event_id)}`);
        const mutation = event.mutationSet.mutations.find((entry) =>
          entry.entity.canonicalRef === String(record.subject_ref) && entry.action.action === String(record.operation));
        if (!mutation) throw new Error(`EVENT_MUTATION_JOIN_CORRUPT:${String(record.event_id)}`);
        return v2MutationToProjectionRow(event, mutation);
      })
    ].sort(compareProjectionRows);
  });
}

function registryAttributionTargets(): ReadonlyArray<{
  readonly kind: CanonicalEntityKind;
  readonly table: string;
  readonly idColumn: string;
  readonly identityField: string;
}> {
  return canonicalEntityKinds.flatMap((kind) => {
    const facet = entityRegistry[kind].projectionFacet;
    return facet.status === "ready" && facet.attributionTarget
      ? [{ kind, ...facet.attributionTarget }]
      : [];
  });
}

function projectionRowMatchesTarget(row: AttributionProjectionRow, kind: CanonicalEntityKind, id: string): boolean {
  if (row.eventSchemaVersion === 1) return legacyTargetId(row.subjectRef, kind) === id;
  return row.entityKind === kind && resolveTargetId(row.subjectRef, kind) === id;
}

function resolveTargetId(subjectRef: string, kind: CanonicalEntityKind): string | null {
  const facet = entityRegistry[kind].projectionFacet;
  if (facet.status !== "ready" || !facet.attributionTarget) return null;
  try {
    return facet.resolveCanonicalRef(subjectRef)[facet.attributionTarget.identityField] ?? null;
  } catch {
    return null;
  }
}

function legacyTargetId(subjectRef: string, kind: CanonicalEntityKind): string | null {
  if (!subjectRef.includes("/")) return subjectRef;
  if (!subjectRef.startsWith(`${kind}/`)) return null;
  const parts = subjectRef.split("/");
  return parts.at(-1) ?? null;
}

function eventAttribution(rows: ReadonlyArray<AttributionProjectionRow>): EntityAttributionProjection {
  const ordered = [...rows].sort(compareProjectionRows);
  const origin = ordered.find((row) => row.operation === "package_create" || row.operation === "decision_propose") ?? ordered[0]!;
  const completeness = ordered.every((row) => row.completeness === "complete")
    ? "complete"
    : ordered.some((row) => row.completeness === "legacy-partial")
      ? "legacy-partial"
      : "host-only";
  return {
    originator: origin.actor,
    latestActor: ordered.at(-1)!.actor,
    trailCount: ordered.length,
    completeness
  };
}

function compareProjectionRows(left: AttributionProjectionRow, right: AttributionProjectionRow): number {
  if (left.revision !== null && right.revision !== null && left.revision !== right.revision) return left.revision - right.revision;
  return left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId)
    || left.subjectRef.localeCompare(right.subjectRef);
}

function absentDigestStatus(): AttributionDigestStatus {
  return {
    semanticMutationSet: "not-present",
    actorAxesBinding: "not-present",
    physicalChangeSet: "not-present",
    canonicalEvent: "not-present"
  };
}

function verifiedDigestStatus(): AttributionDigestStatus {
  return {
    semanticMutationSet: "verified",
    actorAxesBinding: "verified",
    physicalChangeSet: "verified",
    canonicalEvent: "verified"
  };
}

interface LegacyAttributionRecord {
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

interface V2AttributionRecord {
  readonly event_id: unknown;
  readonly op_id: unknown;
  readonly revision: unknown;
  readonly commit_sha: unknown;
  readonly occurred_at: unknown;
  readonly recorded_at: unknown;
  readonly entity_kind: unknown;
  readonly subject_ref: unknown;
  readonly operation: unknown;
  readonly source_json: unknown;
}
