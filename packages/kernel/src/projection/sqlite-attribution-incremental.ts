import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import { stableStringify } from "../integrity/stable-hash.ts";
import { decodeUnionAttributionEventBody } from "../local/attribution-event-source.ts";
import type { UnionAttributionEvent } from "../schemas/attribution-event-union.ts";
import { decodeUnionAttributionEvent } from "../schemas/attribution-event-union.ts";
import type { ProjectionSourceCacheChange } from "./sqlite-projection-source-cache.ts";
import { runSqliteReadonly } from "./sqlite-projection-store.ts";

export interface AttributionProjectionDelta {
  readonly deleteEventIds: ReadonlyArray<string>;
  readonly upsertEvents: ReadonlyArray<UnionAttributionEvent>;
  readonly affectedSubjects: ReadonlyArray<string>;
}

export type AttributionProjectionDecisionReason =
  | "delete-present"
  | "non-single-upsert"
  | "source-path-exists"
  | "event-decode-failed"
  | "projected-read-failed"
  | "op-id-ambiguous"
  | "v1-v2-precedence"
  | "replay"
  | "new-source-path"
  | "v1-to-v2-replacement"
  | "op-id-collision"
  | "other";

export interface AttributionProjectionDecision {
  readonly mode: "incremental" | "full";
  readonly reason: AttributionProjectionDecisionReason;
  readonly delta?: AttributionProjectionDelta;
}

export function buildAppendOnlyAttributionProjectionDelta(
  change: ProjectionSourceCacheChange,
  projectionPath: string,
  eventToProjectionRows: (event: UnionAttributionEvent) => ReadonlyArray<{ readonly subjectRef: string }>
): AttributionProjectionDecision {
  const deleted = change.deleteFiles.filter((row) => row.cacheKind === "attribution");
  const upserted = change.upsertFiles.filter((row) => row.cacheKind === "attribution");
  if (deleted.length > 0) return full("delete-present");
  if (upserted.length !== 1) return full("non-single-upsert");

  const [candidate] = upserted;
  if (!candidate || change.previous.files.some((row) =>
    row.cacheKind === "attribution" && row.sourcePath === candidate.sourcePath)) return full("source-path-exists");

  let event: UnionAttributionEvent;
  try {
    event = decodeUnionAttributionEventBody(candidate.body);
  } catch {
    return full("event-decode-failed");
  }

  let projected: ReadonlyArray<UnionAttributionEvent>;
  try {
    projected = readProjectedAttributionEventsByOpId(projectionPath, event.opId);
  } catch {
    return full("projected-read-failed");
  }
  if (projected.length > 1) return full("op-id-ambiguous");

  const prior = projected[0];
  if (!prior) return incremental("new-source-path", delta([], [event], eventToProjectionRows(event)));
  if (prior.schema === "attribution-event/v2" && event.schema === "attribution-event/v1") {
    return incremental("v1-v2-precedence", delta([], [], []));
  }
  if (stableStringify(prior) === stableStringify(event)) return incremental("replay", delta([], [], []));
  if (prior.schema === event.schema && prior.eventId !== event.eventId) return full("op-id-collision");
  return incremental("v1-to-v2-replacement", delta(
    [prior.eventId],
    [event],
    [...eventToProjectionRows(prior), ...eventToProjectionRows(event)]
  ));
}

function full(reason: AttributionProjectionDecisionReason): AttributionProjectionDecision {
  return { mode: "full", reason };
}

function incremental(reason: AttributionProjectionDecisionReason, deltaValue: AttributionProjectionDelta): AttributionProjectionDecision {
  return { mode: "incremental", reason, delta: deltaValue };
}

function delta(
  deleteEventIds: ReadonlyArray<string>,
  upsertEvents: ReadonlyArray<UnionAttributionEvent>,
  rows: ReadonlyArray<{ readonly subjectRef: string }>
): AttributionProjectionDelta {
  return {
    deleteEventIds,
    upsertEvents,
    affectedSubjects: rows.map((row) => row.subjectRef)
  };
}

function readProjectedAttributionEventsByOpId(
  projectionPath: string,
  opId: string
): ReadonlyArray<UnionAttributionEvent> {
  return runSqliteReadonly(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = new Set((yield* sql<{ readonly name: unknown }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).map((row) => String(row.name)));
    const sourceJsons: string[] = [];
    if (tables.has("attribution_events")) sourceJsons.push(...(yield* sql<{ readonly source_json: unknown }>`
      SELECT source_json FROM attribution_events WHERE op_id = ${opId}
    `).map((row) => String(row.source_json)));
    if (tables.has("attribution_event_headers")) sourceJsons.push(...(yield* sql<{ readonly source_json: unknown }>`
      SELECT source_json FROM attribution_event_headers WHERE op_id = ${opId}
    `).map((row) => String(row.source_json)));
    return sourceJsons.map((sourceJson) => decodeUnionAttributionEvent(JSON.parse(sourceJson)));
  }));
}
