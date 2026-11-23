// PeerRequestV1 read model (dec_2B573FD17D82C9ADDE2FC69C5D CH2): the kernel PeerRequest reducer
// folded over accepted `peer-request-event/v1` events. One row per requestId, so folding one event
// touches one row regardless of history. Derived state only: caches written before these tables
// existed or with an older model version are refolded from canonical event rows on open.
import type { DatabaseSync } from "node:sqlite";
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

const PEER_REQUEST_TABLES = ["peer_request", "peer_request_cursor"] as const;
const CATCH_UP_BATCH = 512;
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
    existing = readExistingRow(db, requestId),
    next = reducePeerRequestEvent(existing?.request ?? null, input),
    openedRevision = existing?.openedRevision ?? input.workspaceRevision;
  writeRow(db, next, openedRevision, input.workspaceRevision);
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
    const after = foldedThrough(db),
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

function modelVersion(db: DatabaseSync): number | undefined | null {
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
  const version = modelVersion(db);
  if (version === null || (version !== undefined && version !== PEER_REQUEST_MODEL_VERSION)) {
    for (const table of PEER_REQUEST_TABLES) runSql(db, `DROP TABLE IF EXISTS ${table}`);
    for (const statement of PEER_REQUEST_TABLES_SQL.split(";")) if (statement.trim()) runSql(db, statement);
  }
}

function peerRequestModelCurrent(db: DatabaseSync): boolean {
  const version = modelVersion(db);
  return version === undefined || version === PEER_REQUEST_MODEL_VERSION;
}

function foldedThrough(db: DatabaseSync): number {
  return Number(
    queryRows<{ revision: number }>(db, "SELECT revision FROM peer_request_cursor WHERE singleton = 1")[0]?.revision ??
      0,
  );
}

function readExistingRow(
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

function writeRow(db: DatabaseSync, request: PeerRequestV1, openedRevision: number, workspaceRevision: number): void {
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
