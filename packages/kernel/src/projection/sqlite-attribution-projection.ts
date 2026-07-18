import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import { canonicalEntityKinds, type CanonicalEntityKind } from "../entity/canonical-kinds.ts";
import { entityRegistry } from "../entity/registry.ts";
import { stableStringify } from "../integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { localLayoutFileSystem } from "../local/local-layout-file-system.ts";
import {
  decodeUnionAttributionEventBody,
  readUnionAttributionEvents,
  selectUnionAttributionEventPrecedence
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
import {
  attributionFromRecord,
  attributionSummarySelect,
  deleteEntityAttributionSummary,
  ensureEntityAttributionSummaryTable,
  replaceEntityAttributionSummaries,
  upsertEntityAttributionSummary,
  type EntityAttributionSummaryRow
} from "./sqlite-attribution-summary.ts";
import {
  ensureAttributionEventTables,
  insertAttributionEvent,
  replaceAttributionEvents
} from "./sqlite-attribution-event-store.ts";
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

export interface ModuleAttributionProjectionRow {
  readonly moduleKey: string;
  readonly attribution: EntityAttributionProjection;
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
  const selectedEvents = selectUnionAttributionEventPrecedence(events);
  runSqlite(projectionPath, Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.gen(function* () {
    yield* replaceAttributionProjectionRows(sql, selectedEvents);
    yield* materializeEntityAttributionBlocks(sql, selectedEvents);
  })));
  return selectedEvents.flatMap(eventToProjectionRows);
}

export function readModuleAttributionProjection(
  projectionPath: string,
  moduleKey?: string
): ReadonlyArray<ModuleAttributionProjectionRow> {
  const facet = entityRegistry.module.projectionFacet;
  if (facet.status !== "ready" || !facet.attributionTarget
    || facet.attributionTarget.materialization !== "mutation-index") {
    throw new Error("MODULE_ATTRIBUTION_PROJECTION_FACET_NOT_READY");
  }
  return runSqlite(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureEntityAttributionSummaryTable(sql);
    const where = moduleKey === undefined ? "" : " AND entity_id = ?";
    const rows = yield* sql.unsafe<Record<string, unknown>>(
      `SELECT entity_id AS module_key, ${attributionSummarySelect("entity_attribution_summary")}
       FROM entity_attribution_summary
       WHERE entity_kind = 'module'${where}
       ORDER BY entity_id`,
      moduleKey === undefined ? [] : [moduleKey]
    );
    return rows.map((row) => ({
      moduleKey: String(row.module_key),
      attribution: attributionFromRecord(row)
    }));
  }));
}

export function replaceAttributionProjectionRows(
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<UnionAttributionEvent>
): Effect.Effect<void, unknown> {
  return replaceAttributionEvents(sql, selectUnionAttributionEventPrecedence(events));
}

export function applyAttributionProjectionDelta(
  sql: SqlClient.SqlClient,
  delta: AttributionProjectionDelta
): Effect.Effect<ReadonlyArray<string>, unknown> {
  return Effect.gen(function* () {
    yield* ensureAttributionEventTables(sql);
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
  const previous = new Map(selectUnionAttributionEventPrecedence(change.previous.files
    .filter((row) => row.cacheKind === "attribution")
    .map((row) => decodeUnionAttributionEventBody(row.body)))
    .map((event) => [event.opId, event]));
  const current = new Map(selectUnionAttributionEventPrecedence(change.current.files
    .filter((row) => row.cacheKind === "attribution")
    .map((row) => decodeUnionAttributionEventBody(row.body)))
    .map((event) => [event.opId, event]));
  const deleteEventIds = new Set<string>();
  const upsertEvents: UnionAttributionEvent[] = [];
  const affectedSubjects = new Set<string>();
  for (const [opId, event] of previous) {
    const next = current.get(opId);
    if (next && stableStringify(next) === stableStringify(event)) continue;
    deleteEventIds.add(event.eventId);
    eventToProjectionRows(event).forEach((projection) => affectedSubjects.add(projection.subjectRef));
  }
  for (const [opId, event] of current) {
    const prior = previous.get(opId);
    if (prior && stableStringify(prior) === stableStringify(event)) continue;
    upsertEvents.push(event);
    eventToProjectionRows(event).forEach((projection) => affectedSubjects.add(projection.subjectRef));
  }
  return { deleteEventIds: [...deleteEventIds], upsertEvents, affectedSubjects: [...affectedSubjects] };
}

export function materializeEntityAttributionBlocks(
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<UnionAttributionEvent>
): Effect.Effect<void, unknown> {
  const rows = selectUnionAttributionEventPrecedence(events).flatMap(eventToProjectionRows);
  const rowsByTarget = attributionRowsByTarget(rows);
  return Effect.gen(function* () {
    const existing = new Set((yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .map((row) => String(row.name)));
    const summaries: EntityAttributionSummaryRow[] = [];
    for (const target of registryAttributionTargets()) {
      if (target.materialization === "mutation-index") {
        for (const [key, attributed] of rowsByTarget) {
          const prefix = `${target.kind}\0`;
          if (!key.startsWith(prefix)) continue;
          summaries.push({
            entityKind: target.kind,
            entityId: key.slice(prefix.length),
            attribution: eventAttribution(attributed)
          });
        }
        continue;
      }
      if (!existing.has(target.table)) continue;
      const records = yield* sql.unsafe<Record<string, unknown>>(`SELECT ${target.idColumn} FROM ${target.table}`);
      for (const record of records) {
        const id = String(record[target.idColumn]);
        const attributed = rowsByTarget.get(attributionTargetKey(target.kind, id));
        if (attributed) summaries.push({ entityKind: target.kind, entityId: id, attribution: eventAttribution(attributed) });
      }
    }
    yield* replaceEntityAttributionSummaries(sql, summaries);
  });
}

export function materializeEntityAttributionTargets(
  sql: SqlClient.SqlClient,
  targets: ReadonlyArray<{ readonly table: string; readonly id: string }>
): Effect.Effect<void, unknown> {
  const uniqueTargets = new Map(targets.map((target) => [`${target.table}\0${target.id}`, target]));
  return Effect.gen(function* () {
    const rows = yield* readAttributionProjectionRows(sql);
    const rowsByTarget = attributionRowsByTarget(rows);
    const existing = new Set((yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .map((row) => String(row.name)));
    for (const target of uniqueTargets.values()) {
      const declaration = registryAttributionTargets().find((candidate) => candidate.table === target.table);
      if (!declaration) throw new Error(`unknown attributed projection table: ${target.table}`);
      yield* deleteEntityAttributionSummary(sql, declaration.kind, target.id);
      if (declaration.materialization === "existing-entity-table") {
        if (!existing.has(declaration.table)) continue;
        const [record] = yield* sql.unsafe<Record<string, unknown>>(
          `SELECT ${declaration.idColumn} FROM ${declaration.table} WHERE ${declaration.idColumn} = ?`, [target.id]
        );
        if (!record) continue;
      }
      const attributed = rowsByTarget.get(attributionTargetKey(declaration.kind, target.id));
      if (attributed) yield* upsertEntityAttributionSummary(sql, {
        entityKind: declaration.kind,
        entityId: target.id,
        attribution: eventAttribution(attributed)
      });
    }
  });
}

export function materializeEntityAttributionSubjects(
  sql: SqlClient.SqlClient,
  subjectRefs: ReadonlyArray<string>
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const targets: Array<{ readonly table: string; readonly id: string }> = [];
    const existing = new Set((yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .map((row) => String(row.name)));
    for (const target of registryAttributionTargets()) {
      for (const subjectRef of new Set(subjectRefs)) {
        const id = resolveTargetId(subjectRef, target.kind) ?? legacyTargetId(subjectRef, target.kind);
        if (!id) continue;
        if (target.materialization === "mutation-index") {
          targets.push({ table: target.table, id });
          continue;
        }
        if (!existing.has(target.table)) continue;
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

export function countAttributionProjectionRows(projectionPath: string): number {
  return runSqlite(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [record] = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM attribution_events`;
    return Number(record?.count ?? 0);
  }));
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
    yield* ensureAttributionEventTables(sql);
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
  readonly materialization: "existing-entity-table" | "mutation-index";
}> {
  return canonicalEntityKinds.flatMap((kind) => {
    const facet = entityRegistry[kind].projectionFacet;
    return facet.status === "ready" && facet.attributionTarget
      ? [{ kind, materialization: "existing-entity-table" as const, ...facet.attributionTarget }]
      : [];
  });
}

function attributionRowsByTarget(
  rows: ReadonlyArray<AttributionProjectionRow>
): ReadonlyMap<string, ReadonlyArray<AttributionProjectionRow>> {
  const indexed = new Map<string, AttributionProjectionRow[]>();
  for (const target of registryAttributionTargets()) {
    for (const row of rows) {
      const id = row.eventSchemaVersion === 1
        ? legacyTargetId(row.subjectRef, target.kind)
        : row.entityKind === target.kind
          ? resolveTargetId(row.subjectRef, target.kind)
          : null;
      if (!id) continue;
      const key = attributionTargetKey(target.kind, id);
      const existing = indexed.get(key) ?? [];
      existing.push(row);
      indexed.set(key, existing);
    }
  }
  return indexed;
}

function attributionTargetKey(kind: CanonicalEntityKind, id: string): string {
  return `${kind}\0${id}`;
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
  const origin = ordered.find(isOriginAttributionOperation) ?? ordered[0]!;
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

function isOriginAttributionOperation(row: AttributionProjectionRow): boolean {
  return row.eventSchemaVersion === 1
    ? row.operation === "package_create" || row.operation === "decision_propose"
    : row.operation === "create" || (row.entityKind === "decision" && row.operation === "propose");
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
