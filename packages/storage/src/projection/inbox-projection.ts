// Inbox read model (dec_7CE3162BF9BFB157DAB9F9B6C0 CH1): the kernel item reducer folded over the
// accepted `inbox_item_*` events. One row per item, unique by (inbox_id, dedupe_key), so folding one
// event touches one row regardless of inbox history. It is derived state only: a cache written before
// these tables existed, or by a binary with another Inbox model version, is refolded from its own event
// rows on open through the same reducer, so the read model always equals a cold replay.
import type { DatabaseSync } from "node:sqlite";
import {
  INBOX_MODEL_VERSION,
  inboxEventTypes,
  inboxItemLookup,
  inboxPageLimit,
  inboxQueueCursor,
  inboxQueueNextCursor,
  inboxQueueStatuses,
  isInboxEvent,
  reduceInboxItem,
  type InboxEvent,
  type InboxItem,
  type InboxQuery,
  type InboxRead,
} from "@harness-anything/kernel/internal/domain/inbox.ts";
import {
  PEER_REQUEST_MODEL_VERSION,
  isPeerRequestEvent,
  peerRequestCursor,
  peerRequestEventRequestId,
  peerRequestEventTypes,
  peerRequestNextCursor,
  peerRequestPageLimit,
  reducePeerRequestEvent,
  type PeerRequestEventV1,
  type PeerRequestQuery,
  type PeerRequestRead,
  type PeerRequestV1,
} from "@harness-anything/kernel/internal/domain/peer-collaboration.ts";
import { queryRows, runSql, transaction } from "./rebuildable-task-projection-sql.ts";

const INBOX_TABLES = ["inbox_item", "inbox_cursor"] as const;
const CATCH_UP_BATCH = 512;
const inboxEventTypeSql = inboxEventTypes.map((type) => `'${type}'`).join(",");

export const INBOX_TABLES_SQL = `
    /* @gate-identity state-store/task.projection.inbox_item */ CREATE TABLE IF NOT EXISTS inbox_item (
      inbox_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      consumer_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      enqueued_revision INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      item_json TEXT NOT NULL,
      PRIMARY KEY (inbox_id, item_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS inbox_item_dedupe ON inbox_item(inbox_id, dedupe_key);
    CREATE INDEX IF NOT EXISTS inbox_item_queue
      ON inbox_item(consumer_kind, status, enqueued_revision)
      WHERE status IN ('pending', 'quarantined_external', 'claimed');
    CREATE INDEX IF NOT EXISTS inbox_item_inbox_queue
      ON inbox_item(inbox_id, consumer_kind, status, enqueued_revision)
      WHERE status IN ('pending', 'quarantined_external', 'claimed');
    CREATE INDEX IF NOT EXISTS inbox_item_by_inbox
      ON inbox_item(inbox_id, enqueued_revision);
    /* @gate-identity state-store/task.projection.inbox_cursor */ CREATE TABLE IF NOT EXISTS inbox_cursor (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      revision INTEGER NOT NULL,
      model_version INTEGER NOT NULL
    );`;

/** Fold one accepted canonical event; runs inside the SQLite projection event transaction. */
export function projectInboxEvent(db: DatabaseSync, event: { readonly schema: string; readonly type: string }): void {
  if (!isInboxEvent(event)) return;
  const input = event as InboxEvent,
    step = reduceInboxItem(readAddressedItem(db, input), input);
  if (step.kind === "applied") writeItem(db, step.item);
  runSql(
    db,
    `INSERT INTO inbox_cursor(singleton, revision, model_version) VALUES (1, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET revision = max(revision, excluded.revision)`,
    input.workspaceRevision,
    INBOX_MODEL_VERSION,
  );
}

/** Refold Inbox events this cache holds but has not folded: O(unfolded Inbox events) via the type index. */
export function catchUpInbox(db: DatabaseSync, onProgress?: (progress: { applied: number; total: number }) => void) {
  ensureInboxModel(db);
  let applied = 0,
    total = 0;
  for (;;) {
    const after = foldedThrough(db),
      rows = queryRows<{ event_json: string }>(
        db,
        `SELECT i.event_json FROM event_summary s
         JOIN event_index i ON i.workspace_revision = s.workspace_revision
         WHERE s.event_type IN (${inboxEventTypeSql}) AND s.workspace_revision > ?
         ORDER BY s.workspace_revision LIMIT ${CATCH_UP_BATCH}`,
        after,
      );
    if (rows.length === 0) return;
    if (total === 0)
      total = Number(
        queryRows<{ count: number }>(
          db,
          `SELECT count(*) AS count FROM event_summary WHERE event_type IN (${inboxEventTypeSql}) AND workspace_revision > ?`,
          after,
        )[0]!.count,
      );
    transaction(db, () => {
      for (const row of rows) projectInboxEvent(db, JSON.parse(row.event_json) as InboxEvent);
    });
    applied += rows.length;
    onProgress?.({ applied, total });
  }
}

function modelVersion(db: DatabaseSync): number | undefined | null {
  const cursorColumns = queryRows<{ name: string }>(db, "PRAGMA table_info(inbox_cursor)").map(({ name }) => name),
    itemColumns = queryRows<{ name: string }>(db, "PRAGMA table_info(inbox_item)").map(({ name }) => name);
  if (
    !cursorColumns.includes("model_version") ||
    !itemColumns.includes("enqueued_revision") ||
    !itemColumns.includes("consumer_kind")
  )
    return null;
  return queryRows<{ model_version: number }>(db, "SELECT model_version FROM inbox_cursor WHERE singleton = 1")[0]
    ?.model_version;
}

/** Inbox state of another model version is discarded and refolded from the event rows. */
export function ensureInboxModel(db: DatabaseSync): void {
  const version = modelVersion(db);
  if (version === null || (version !== undefined && version !== INBOX_MODEL_VERSION)) {
    for (const table of INBOX_TABLES) runSql(db, `DROP TABLE IF EXISTS ${table}`);
    for (const statement of INBOX_TABLES_SQL.split(";")) if (statement.trim()) runSql(db, statement);
  }
}

function inboxModelCurrent(db: DatabaseSync): boolean {
  const version = modelVersion(db);
  return version === undefined || version === INBOX_MODEL_VERSION;
}

function foldedThrough(db: DatabaseSync): number {
  return Number(
    queryRows<{ revision: number }>(db, "SELECT revision FROM inbox_cursor WHERE singleton = 1")[0]?.revision ?? 0,
  );
}

function readAddressedItem(db: DatabaseSync, event: InboxEvent): InboxItem | null {
  const lookup = inboxItemLookup(event),
    row =
      lookup.dedupeKey === null
        ? queryRows<{ item_json: string }>(
            db,
            "SELECT item_json FROM inbox_item WHERE inbox_id = ? AND item_id = ?",
            lookup.inboxId,
            lookup.itemId,
          )[0]
        : queryRows<{ item_json: string }>(
            db,
            `SELECT item_json FROM inbox_item WHERE inbox_id = ? AND (item_id = ? OR dedupe_key = ?)
             ORDER BY enqueued_revision LIMIT 1`,
            lookup.inboxId,
            lookup.itemId,
            lookup.dedupeKey,
          )[0];
  return row ? (JSON.parse(row.item_json) as InboxItem) : null;
}

function writeItem(db: DatabaseSync, item: InboxItem): void {
  runSql(
    db,
    `INSERT INTO inbox_item(inbox_id, item_id, dedupe_key, consumer_kind, status, enqueued_revision, revision, item_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(inbox_id, item_id) DO UPDATE SET
       status = excluded.status, revision = excluded.revision, item_json = excluded.item_json`,
    item.inboxId,
    item.itemId,
    item.dedupeKey,
    item.consumerKind,
    item.status,
    item.enqueuedRevision,
    item.revision,
    JSON.stringify(item),
  );
}

/** Indexed point reads (`item`, `dedupe`), targeted inbox history (`inbox`), or an ordered queue page (`queue`). */
export function readInboxRows(
  db: DatabaseSync,
  query: InboxQuery,
  cut: { readonly watermark: number; readonly sourceRevision: number },
): InboxRead {
  if (!inboxModelCurrent(db)) return { status: "pending", ...cut };
  if (query.by === "inbox") {
    if (typeof query.inboxId !== "string" || query.inboxId.length === 0)
      throw new Error("inbox history reads require a targeted inboxId");
    const limit = inboxPageLimit(query.limit);
    const items = queryRows<{ item_json: string }>(
      db,
      `SELECT item_json FROM inbox_item
       WHERE inbox_id = ? AND enqueued_revision > ?
       ORDER BY enqueued_revision LIMIT ?`,
      query.inboxId,
      inboxQueueCursor(query.cursor),
      limit + 1,
    ).map(({ item_json }) => JSON.parse(item_json) as InboxItem);
    return { status: "ready", ...cut, items: items.slice(0, limit), nextCursor: inboxQueueNextCursor(items, limit) };
  }
  if (query.by !== "queue") {
    const row = queryRows<{ item_json: string }>(
      db,
      `SELECT item_json FROM inbox_item WHERE inbox_id = ? AND ${query.by === "item" ? "item_id" : "dedupe_key"} = ?`,
      query.inboxId,
      query.by === "item" ? query.itemId : query.dedupeKey,
    )[0];
    return { status: "ready", ...cut, items: row ? [JSON.parse(row.item_json) as InboxItem] : [], nextCursor: null };
  }
  if (!(inboxQueueStatuses as readonly string[]).includes(query.status))
    throw new Error(`inbox queue status is not a queue: ${String(query.status)}`);
  if (query.consumerKind === "interactive_watch" && (typeof query.inboxId !== "string" || query.inboxId.length === 0))
    throw new Error("interactive watch Inbox reads require a targeted inboxId");
  const limit = inboxPageLimit(query.limit),
    parameters: (string | number)[] = [query.consumerKind, query.status, inboxQueueCursor(query.cursor)],
    inboxClause = query.inboxId === undefined ? "" : " AND inbox_id = ?";
  if (query.inboxId !== undefined) parameters.push(query.inboxId);
  const items = queryRows<{ item_json: string }>(
    db,
    `SELECT item_json FROM inbox_item
     WHERE consumer_kind = ? AND status = ? AND enqueued_revision > ?${inboxClause}
     ORDER BY enqueued_revision LIMIT ?`,
    ...parameters,
    limit + 1,
  ).map(({ item_json }) => JSON.parse(item_json) as InboxItem);
  return { status: "ready", ...cut, items: items.slice(0, limit), nextCursor: inboxQueueNextCursor(items, limit) };
}

const PEER_REQUEST_TABLES = ["peer_request", "peer_request_cursor"] as const;
const peerEventTypeSql = peerRequestEventTypes.map((type) => `'${type}'`).join(",");

export const PEER_REQUEST_TABLES_SQL = `
    /* @gate-identity state-store/task.projection.peer_request */ CREATE TABLE IF NOT EXISTS peer_request (
      request_id TEXT PRIMARY KEY,
      from_person_id TEXT NOT NULL,
      to_person_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      work_id TEXT,
      lane TEXT,
      opened_revision INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      request_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS peer_request_recipient
      ON peer_request(to_person_id, state, opened_revision);
    CREATE INDEX IF NOT EXISTS peer_request_sender
      ON peer_request(from_person_id, state, opened_revision);
    CREATE INDEX IF NOT EXISTS peer_request_opened
      ON peer_request(opened_revision);
    /* @gate-identity state-store/task.projection.peer_request_cursor */ CREATE TABLE IF NOT EXISTS peer_request_cursor (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      revision INTEGER NOT NULL,
      model_version INTEGER NOT NULL
    );`;

/** Fold one accepted canonical event; runs inside the SQLite projection event transaction. */
export function projectPeerRequestEvent(
  db: DatabaseSync,
  event: { readonly schema: string; readonly type: string },
): void {
  if (!isPeerRequestEvent(event)) return;
  const input = event as PeerRequestEventV1,
    requestId = peerRequestEventRequestId(input),
    existing = readExistingPeerRow(db, requestId),
    next = reducePeerRequestEvent(existing?.request ?? null, input),
    openedRevision = existing?.openedRevision ?? input.workspaceRevision;
  writePeerRow(db, next, openedRevision, input.workspaceRevision);
  runSql(
    db,
    `INSERT INTO peer_request_cursor(singleton, revision, model_version) VALUES (1, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET revision = max(revision, excluded.revision)`,
    input.workspaceRevision,
    PEER_REQUEST_MODEL_VERSION,
  );
}

/** Refold PeerRequest events this cache holds but has not folded: O(unfolded peer events). */
export function catchUpPeerRequests(
  db: DatabaseSync,
  onProgress?: (progress: { applied: number; total: number }) => void,
): void {
  ensurePeerRequestModel(db);
  let applied = 0,
    total = 0;
  for (;;) {
    const after = peerFoldedThrough(db),
      rows = queryRows<{ event_json: string }>(
        db,
        `SELECT i.event_json FROM event_summary s
         JOIN event_index i ON i.workspace_revision = s.workspace_revision
         WHERE s.event_type IN (${peerEventTypeSql}) AND s.workspace_revision > ?
         ORDER BY s.workspace_revision LIMIT ${CATCH_UP_BATCH}`,
        after,
      );
    if (rows.length === 0) return;
    if (total === 0)
      total = Number(
        queryRows<{ count: number }>(
          db,
          `SELECT count(*) AS count FROM event_summary WHERE event_type IN (${peerEventTypeSql}) AND workspace_revision > ?`,
          after,
        )[0]!.count,
      );
    transaction(db, () => {
      for (const row of rows) projectPeerRequestEvent(db, JSON.parse(row.event_json) as PeerRequestEventV1);
    });
    applied += rows.length;
    onProgress?.({ applied, total });
  }
}

function peerModelVersion(db: DatabaseSync): number | undefined | null {
  const cursorColumns = queryRows<{ name: string }>(db, "PRAGMA table_info(peer_request_cursor)").map(
      ({ name }) => name,
    ),
    requestColumns = queryRows<{ name: string }>(db, "PRAGMA table_info(peer_request)").map(({ name }) => name);
  if (
    !cursorColumns.includes("model_version") ||
    !requestColumns.includes("opened_revision") ||
    !requestColumns.includes("to_person_id")
  )
    return null;
  return queryRows<{ model_version: number }>(
    db,
    "SELECT model_version FROM peer_request_cursor WHERE singleton = 1",
  )[0]?.model_version;
}

/** PeerRequest state of another model version is discarded and refolded from the event rows. */
export function ensurePeerRequestModel(db: DatabaseSync): void {
  const version = peerModelVersion(db);
  if (version === null || (version !== undefined && version !== PEER_REQUEST_MODEL_VERSION)) {
    for (const table of PEER_REQUEST_TABLES) runSql(db, `DROP TABLE IF EXISTS ${table}`);
    for (const statement of PEER_REQUEST_TABLES_SQL.split(";")) if (statement.trim()) runSql(db, statement);
  }
}

function peerRequestModelCurrent(db: DatabaseSync): boolean {
  const version = peerModelVersion(db);
  return version === undefined || version === PEER_REQUEST_MODEL_VERSION;
}

function peerFoldedThrough(db: DatabaseSync): number {
  return Number(
    queryRows<{ revision: number }>(db, "SELECT revision FROM peer_request_cursor WHERE singleton = 1")[0]?.revision ??
      0,
  );
}

function readExistingPeerRow(
  db: DatabaseSync,
  requestId: string,
): { readonly request: PeerRequestV1; readonly openedRevision: number } | null {
  const row = queryRows<{ request_json: string; opened_revision: number }>(
    db,
    "SELECT request_json, opened_revision FROM peer_request WHERE request_id = ?",
    requestId,
  )[0];
  return row ? { request: JSON.parse(row.request_json) as PeerRequestV1, openedRevision: row.opened_revision } : null;
}

function writePeerRow(
  db: DatabaseSync,
  request: PeerRequestV1,
  openedRevision: number,
  workspaceRevision: number,
): void {
  runSql(
    db,
    `INSERT INTO peer_request(
       request_id, from_person_id, to_person_id, kind, state, work_id, lane, opened_revision, revision, request_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(request_id) DO UPDATE SET
       state = excluded.state,
       revision = excluded.revision,
       request_json = excluded.request_json`,
    request.requestId,
    request.from.personId,
    request.to.personId,
    request.kind,
    request.state,
    request.to.workId ?? null,
    request.to.lane ?? null,
    openedRevision,
    workspaceRevision,
    JSON.stringify(request),
  );
}

/** Point read (`id`) or ordered, bounded list (`list`). */
export function readPeerRequestRows(
  db: DatabaseSync,
  query: PeerRequestQuery,
  cut: { readonly watermark: number; readonly sourceRevision: number },
): PeerRequestRead {
  if (!peerRequestModelCurrent(db)) return { status: "pending", ...cut };
  if (query.by === "id") {
    const row = queryRows<{ request_json: string }>(
      db,
      "SELECT request_json FROM peer_request WHERE request_id = ?",
      query.requestId,
    )[0];
    return {
      status: "ready",
      ...cut,
      requests: row ? [JSON.parse(row.request_json) as PeerRequestV1] : [],
      nextCursor: null,
    };
  }
  const limit = peerRequestPageLimit(query.limit),
    parameters: (string | number)[] = [peerRequestCursor(query.cursor)],
    predicates = ["opened_revision > ?"];
  if (query.recipientPersonId !== undefined) {
    predicates.push("to_person_id = ?");
    parameters.push(query.recipientPersonId);
  }
  if (query.senderPersonId !== undefined) {
    predicates.push("from_person_id = ?");
    parameters.push(query.senderPersonId);
  }
  if (query.state !== undefined) {
    predicates.push("state = ?");
    parameters.push(query.state);
  }
  if (query.kind !== undefined) {
    predicates.push("kind = ?");
    parameters.push(query.kind);
  }
  if (query.workId !== undefined) {
    predicates.push("work_id = ?");
    parameters.push(query.workId);
  }
  if (query.lane !== undefined) {
    predicates.push("lane = ?");
    parameters.push(query.lane);
  }
  const rows = queryRows<{ request_json: string; opened_revision: number }>(
    db,
    `SELECT request_json, opened_revision FROM peer_request
     WHERE ${predicates.join(" AND ")}
     ORDER BY opened_revision ASC LIMIT ?`,
    ...parameters,
    limit + 1,
  ).map((row) => ({
    request: JSON.parse(row.request_json) as PeerRequestV1,
    openedRevision: row.opened_revision,
  }));
  return {
    status: "ready",
    ...cut,
    requests: rows.slice(0, limit).map(({ request }) => request),
    nextCursor: peerRequestNextCursor(rows, limit),
  };
}
