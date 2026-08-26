// @write-boundary-exemption rebuildable-projection
import { DatabaseSync } from "node:sqlite";
import {
  normalizePersistedCanonicalEvent,
  serializePersistedCanonicalEvent,
  type CanonicalEventV1,
} from "../domain/doc-sync.contract.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import type { EventContentPrefetch, EventStreamPort } from "./rebuildable-task-projection-types.ts";
import type { ProjectionApplyReceipt } from "./projection-reads.ts";
import { applyEvent } from "./rebuildable-task-projection-event-application.ts";
import {
  isAtSourceCut,
  parseEventJson,
  queryRows,
  readStateDigest,
  refreshStateDigestAtSourceCut,
  runSql,
  transaction,
  watermark,
} from "./rebuildable-task-projection-sql.ts";
export type { ProjectionPage, TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";
export type { TaskProjection } from "./task-projection-port.ts";

// Incremental source scanning, deferred-event staging, and batch replay.
const batchContentPrefetchers = new WeakMap<EventStreamPort, EventContentPrefetch>();
export function reduceBatch(
  db: DatabaseSync,
  events: readonly CanonicalEventV1[],
  limit: number,
  readBlob: EventStreamPort["readContentBlob"],
  sourceRevision: number,
): ProjectionApplyReceipt {
  return transaction(db, () => {
    for (const event of events) stageEvent(db, event);
    const reducedItems = drainDeferred(db, limit, readBlob, true);
    const state =
      /* @gate-identity check-bypass-write-boundary/bypass-write-001 */
      db.prepare("SELECT scan_cursor, scanned_revision FROM projection_meta WHERE singleton = 1").get() as {
        readonly scan_cursor: string | null;
        readonly scanned_revision: number;
      };
    const last = events.at(-1);
    if (
      last !== undefined &&
      state.scan_cursor === null &&
      state.scanned_revision === last.workspaceRevision - events.length &&
      watermark(db) >= last.workspaceRevision
    ) {
      runSql(
        db,
        "UPDATE projection_meta SET scanned_revision = ?, head_digest = ? WHERE singleton = 1",
        last.workspaceRevision,
        `sha256:${sha256Text(serializePersistedCanonicalEvent(last))}`,
      );
    }
    refreshStateDigestAtSourceCut(db, sourceRevision);
    return { metrics: { sqliteTransactions: 1, reducedItems } };
  });
}

export function catchUpRound(
  db: DatabaseSync,
  eventStore: EventStreamPort,
  limit: number,
): {
  readonly sourceRevision: number;
  readonly watermark: number;
  readonly reducedItems: number;
  readonly accessedItems: number;
  readonly sqliteTransactions: 0 | 1;
} {
  const head = eventStore.readHead();
  const sourceRevision = head?.revision ?? 0;
  const state =
    /* @gate-identity check-bypass-write-boundary/bypass-write-002 */
    db.prepare("SELECT scan_cursor, scanned_revision FROM projection_meta WHERE singleton = 1").get() as {
      readonly scan_cursor: string | null;
      readonly scanned_revision: number;
    };
  const shouldScan = state.scan_cursor !== null || state.scanned_revision < sourceRevision;
  const batch = shouldScan ? eventStore.readBatch(state.scan_cursor, limit) : null;
  if (batch?.prefetchContent !== undefined) batchContentPrefetchers.set(eventStore, batch.prefetchContent);
  const hasDeferred =
    /* @gate-identity check-bypass-write-boundary/bypass-write-003 */
    db.prepare("SELECT 1 AS present FROM event_source WHERE workspace_revision > ? LIMIT 1").get(watermark(db)) !==
    undefined;
  if (batch === null && !hasDeferred) {
    const current = watermark(db);
    if (readStateDigest(db) !== null || !isAtSourceCut(db, sourceRevision))
      return {
        sourceRevision,
        watermark: current,
        reducedItems: 0,
        accessedItems: 0,
        sqliteTransactions: 0,
      };
    const digest = transaction(db, () => refreshStateDigestAtSourceCut(db, sourceRevision));
    if (digest === null) throw new Error("projection digest refresh lost its source-complete cut");
    return {
      sourceRevision,
      watermark: current,
      reducedItems: 0,
      accessedItems: 0,
      sqliteTransactions: 1,
    };
  }
  // A complete source scan proves that an absent revision is a permanent hole in this
  // ledger. Before that point, keep strict continuity so a later batch can still supply it.
  const allowRevisionGaps = batch === null || batch.done;
  const replayEvents = readyDeferredEvents(db, batch?.events ?? [], limit, allowRevisionGaps);
  let prefetch = batch?.prefetchContent ?? batchContentPrefetchers.get(eventStore);
  if (prefetch === undefined && hasDeferred) {
    prefetch = eventStore.readBatch(null, 1).prefetchContent;
    if (prefetch !== undefined) batchContentPrefetchers.set(eventStore, prefetch);
  }
  if (replayEvents.length > 0 && prefetch === undefined)
    throw new Error("event stream must provide a verified batch content prefetch");
  const prefetchedContent = replayEvents.length ? prefetch!(replayEvents) : new Map<string, Uint8Array | null>();
  const reducedItems = transaction(db, () => {
    if (batch !== null) {
      for (const event of batch.events) stageEvent(db, event);
      if (batch.done)
        runSql(
          db,
          "UPDATE projection_meta SET scan_cursor = NULL, scanned_revision = ?, head_digest = ? WHERE singleton = 1",
          batch.sourceRevision,
          head?.eventDigest ?? null,
        );
      else runSql(db, "UPDATE projection_meta SET scan_cursor = ? WHERE singleton = 1", batch.cursor);
    }
    const reduced = drainDeferred(db, limit, (sha256) => prefetchedContent.get(sha256) ?? null, allowRevisionGaps);
    refreshStateDigestAtSourceCut(db, sourceRevision);
    return reduced;
  });
  return {
    sourceRevision,
    watermark: watermark(db),
    reducedItems,
    accessedItems: batch?.accessedItems ?? 0,
    sqliteTransactions: 1,
  };
}

function readyDeferredEvents(
  db: DatabaseSync,
  batch: readonly CanonicalEventV1[],
  limit: number,
  allowRevisionGaps: boolean,
): readonly CanonicalEventV1[] {
  const current = watermark(db),
    candidates = new Map<number, CanonicalEventV1>();
  for (const row of queryRows(
    db,
    [
      "SELECT workspace_revision, event_json FROM event_source",
      "WHERE workspace_revision > ? AND workspace_revision <= ?",
      "ORDER BY workspace_revision",
    ].join(" "),
    current,
    current + limit,
  ))
    candidates.set(Number(row.workspace_revision), parseEventJson(String(row.event_json)));
  for (const event of batch)
    if (event.workspaceRevision <= current + limit) candidates.set(event.workspaceRevision, event);
  const ready: CanonicalEventV1[] = [];
  for (let revision = current + 1; revision <= current + limit; revision += 1) {
    const event = candidates.get(revision);
    if (event === undefined) {
      if (!allowRevisionGaps) break;
      continue;
    }
    ready.push(event);
  }
  return ready;
}

function stageEvent(db: DatabaseSync, event: CanonicalEventV1): void {
  const eventJson = serializePersistedCanonicalEvent(event).trimEnd();
  const applied =
    /* @gate-identity check-bypass-write-boundary/bypass-write-004 */
    db.prepare("SELECT event_json FROM event_index WHERE op_id = ?").get(event.opId) as
      | { readonly event_json: string }
      | undefined;
  if (applied !== undefined) {
    if (applied.event_json !== eventJson) throw new Error(`projection opId ${event.opId} names different bytes`);
    return;
  }
  const staged =
    /* @gate-identity check-bypass-write-boundary/bypass-write-005 */
    db
      .prepare("SELECT event_json FROM event_source WHERE op_id = ? OR workspace_revision = ?")
      .get(event.opId, event.workspaceRevision) as { readonly event_json: string } | undefined;
  if (staged !== undefined) {
    if (staged.event_json !== eventJson)
      throw new Error(`projection revision or opId ${event.opId} names different bytes`);
    return;
  }
  runSql(
    db,
    "INSERT INTO event_source(workspace_revision, op_id, event_json) VALUES (?, ?, ?)",
    event.workspaceRevision,
    event.opId,
    eventJson,
  );
}

function drainDeferred(
  db: DatabaseSync,
  limit: number,
  readBlob: EventStreamPort["readContentBlob"],
  allowRevisionGaps = false,
): number {
  let next = watermark(db),
    reduced = 0;
  while (reduced < limit) {
    const row =
      /* @gate-identity check-bypass-write-boundary/bypass-write-006 */
      db
        .prepare(
          [
            "SELECT event_json FROM event_source WHERE workspace_revision = ?",
            "OR (? = 1 AND workspace_revision > ?) ORDER BY workspace_revision LIMIT 1",
          ].join(" "),
        )
        .get(next + 1, allowRevisionGaps ? 1 : 0, next) as { readonly event_json: string } | undefined;
    if (row === undefined) break;
    const event = parseEventJson(row.event_json);
    applyEvent(db, normalizePersistedCanonicalEvent(event), row.event_json, readBlob);
    runSql(db, "DELETE FROM event_source WHERE workspace_revision = ?", event.workspaceRevision);
    next = event.workspaceRevision;
    reduced += 1;
  }
  runSql(db, "UPDATE projection_meta SET watermark = ? WHERE singleton = 1", next);
  return reduced;
}
