// @write-boundary-exemption rebuildable-projection
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { consumeKnownError } from "../error-consumption.ts";
import { localEventFileSystem, localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";
import { createDecisionProjectionTables } from "./decision-event-projection.ts";
import { createFactProjectionTables } from "./fact-event-projection.ts";
import { createRelationGraphProjectionTables } from "./relation-graph-projection.ts";
import { taskProjectionSchemaVersion } from "./projection-schema.ts";
import { createTaskRelationProjectionTable } from "./task-query-projection.ts";
import type { EventStreamPort } from "./rebuildable-task-projection-types.ts";
import { queryRows, runSql } from "./rebuildable-task-projection-sql.ts";
export type { ProjectionPage, TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";
export type { TaskProjection } from "./task-projection-port.ts";

// Projection database ownership, lifetime, initialization, and schema checks.
interface ProjectionDatabaseOwner {
  readonly use: <A>(operation: (db: DatabaseSync) => A) => A;
  readonly close: () => void;
}

export class ProjectionIdentityMismatchError extends Error {
  constructor() {
    super("projection cache ledger identity mismatch; run daemon projection rebuild");
    this.name = "ProjectionIdentityMismatchError";
  }
}

export class ProjectionSchemaMismatchError extends Error {
  readonly code = "kernel_schema_mismatch";
  readonly observed: number;

  constructor(observed: number, projectionPath: string) {
    super(
      `kernel projection schema ${observed} does not match supported schema ${taskProjectionSchemaVersion}; ` +
        (observed > taskProjectionSchemaVersion
          ? `run a daemon build that understands ${projectionPath}`
          : "the cache can only be rebuilt from a continuous canonical event stream"),
    );
    this.name = "ProjectionSchemaMismatchError";
    this.observed = observed;
  }
}

export class ProjectionEventStreamIncompleteError extends Error {
  readonly code = "invalid_store";
  readonly cacheWatermark: number;
  readonly cacheScannedRevision: number;
  readonly eventStreamHead: number | null;
  readonly missingRange: { readonly from: number; readonly to: number };

  constructor(
    cacheWatermark: number,
    cacheScannedRevision: number,
    eventStreamHead: number | null,
    missingRange: { readonly from: number; readonly to: number },
  ) {
    super(
      `projection cache through revision ${Math.max(cacheWatermark, cacheScannedRevision)} cannot be discarded: ` +
        `event stream head is ${eventStreamHead ?? "null"} and revisions ` +
        `${missingRange.from}-${missingRange.to} are not continuously readable; cache retained`,
    );
    this.name = "ProjectionEventStreamIncompleteError";
    this.cacheWatermark = cacheWatermark;
    this.cacheScannedRevision = cacheScannedRevision;
    this.eventStreamHead = eventStreamHead;
    this.missingRange = missingRange;
  }
}
const projectionDatabaseOwners = new WeakMap<EventStreamPort["readHead"], Map<string, ProjectionDatabaseOwner>>();
const projectionClosers = new Map<string, Set<() => void>>();
const projectionBusyTimeoutMs = 250;
let queryOnlySession: {
  readonly projectionPath: string;
  readonly readHead: EventStreamPort["readHead"];
  readonly db: DatabaseSync;
} | null = null;

/** Test fixtures can close all projection databases before removing a temporary repository. */
export function closeTaskProjectionsUnder(rootDir: string): void {
  const resolvedRoot = canonicalProjectionPath(rootDir),
    prefix = `${resolvedRoot}${path.sep}`;
  for (const projectionPath of [...projectionClosers.keys()]) {
    if (projectionPath !== resolvedRoot && !projectionPath.startsWith(prefix)) continue;
    closeProjectionHandlesAt(projectionPath);
  }
}

// Owners are keyed by readHead identity, so one projection file can be open under several owners
// at once. Deleting it while any handle is still open is invisible on POSIX -- unlink detaches the
// name and the open handles keep working -- and EPERM on Windows, so a discard has to close every
// handle on the path rather than only the caller's. Each owner reopens on its next use.
function closeProjectionHandlesAt(resolvedProjectionPath: string): void {
  const closers = projectionClosers.get(resolvedProjectionPath);
  if (closers === undefined) return;
  for (const close of [...closers]) close();
  closers.clear();
  projectionClosers.delete(resolvedProjectionPath);
}

export function withDatabase<A>(
  projectionPath: string,
  readHead: EventStreamPort["readHead"],
  use: (db: DatabaseSync) => A,
): A {
  if (
    queryOnlySession?.projectionPath === canonicalProjectionPath(projectionPath) &&
    queryOnlySession.readHead === readHead
  )
    return use(queryOnlySession.db);
  return projectionDatabaseOwner(projectionPath, readHead).use(use);
}

export function withQueryOnlyDatabaseSession<A>(
  projectionPath: string,
  readHead: EventStreamPort["readHead"],
  use: (db: DatabaseSync) => A,
): A {
  if (queryOnlySession !== null) throw new Error("projection query-only sessions cannot be nested");
  const resolvedProjectionPath = canonicalProjectionPath(projectionPath);
  if (!localRuntimeStateFileSystem.exists(resolvedProjectionPath))
    throw new Error(`projection is unavailable at ${resolvedProjectionPath}`);
  const db = /* @gate-identity check-bypass-write-boundary/bypass-write-007 */ new DatabaseSync(
    resolvedProjectionPath,
    { readOnly: true },
  );
  try {
    /* @gate-identity check-bypass-write-boundary/bypass-write-104 */
    db.exec(`PRAGMA busy_timeout = ${projectionBusyTimeoutMs}; PRAGMA query_only = ON; BEGIN`);
    queryOnlySession = { projectionPath: resolvedProjectionPath, readHead, db };
    const value = use(db);
    if (value !== null && typeof value === "object" && "then" in value)
      throw new Error("projection reader sessions must complete synchronously inside one SQLite transaction");
    /* @gate-identity check-bypass-write-boundary/bypass-write-105 */
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      /* @gate-identity check-bypass-write-boundary/bypass-write-106 */
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      consumeKnownError(rollbackError);
      // Opening/schema failures can happen before BEGIN establishes a transaction.
    }
    throw error;
  } finally {
    queryOnlySession = null;
    db.close();
  }
}
export function discardDatabase(projectionPath: string, eventStore: EventStreamPort): void {
  if (!localRuntimeStateFileSystem.exists(projectionPath)) return;
  const coverage = readProjectionCoverage(projectionPath, eventStore.readHead);
  assertEventStreamContinuity(eventStore, coverage);
  closeProjectionHandlesAt(canonicalProjectionPath(projectionPath));
  localRuntimeStateFileSystem.remove(projectionPath);
}
// close() shares discard()'s invariant: callers close a projection so they can remove its file, and
// a handle held by any other owner blocks that on Windows. Closing only the caller's owner made
// `projection.close(); rm(projection.path)` -- the documented teardown -- fail there.
export function closeDatabase(projectionPath: string, readHead: EventStreamPort["readHead"]): void {
  const owners = projectionDatabaseOwners.get(readHead);
  closeProjectionHandlesAt(canonicalProjectionPath(projectionPath));
  owners?.delete(projectionPath);
}

function projectionDatabaseOwner(
  projectionPath: string,
  readHead: EventStreamPort["readHead"],
): ProjectionDatabaseOwner {
  let owners = projectionDatabaseOwners.get(readHead);
  if (owners === undefined) {
    owners = new Map();
    projectionDatabaseOwners.set(readHead, owners);
  }
  const known = owners.get(projectionPath);
  if (known !== undefined) return known;
  const resolvedProjectionPath = canonicalProjectionPath(projectionPath);
  let db: DatabaseSync | null = null,
    fingerprint: string | null = null,
    schemaChecked = false,
    useDepth = 0;
  let unregister = (): void => undefined;
  const register = (): void => {
    if (projectionClosers.get(resolvedProjectionPath)?.has(close)) return;
    const registeredClosers = projectionClosers.get(resolvedProjectionPath) ?? new Set<() => void>();
    registeredClosers.add(close);
    projectionClosers.set(resolvedProjectionPath, registeredClosers);
    unregister = () => {
      registeredClosers.delete(close);
      if (registeredClosers.size === 0) projectionClosers.delete(resolvedProjectionPath);
      unregister = () => undefined;
    };
  };
  const close = () => {
    db?.close();
    db = null;
    fingerprint = null;
    unregister();
  };
  const open = () => {
    register();
    localRuntimeStateFileSystem.mkdirp(path.dirname(projectionPath));
    db = openDatabase(projectionPath);
    configureDatabase(db);
    fingerprint = projectionFileFingerprint(projectionPath);
  };
  const initialize = () => {
    open();
    const observed = projectionSchemaVersion(db!);
    if (observed !== null && observed !== taskProjectionSchemaVersion) {
      close();
      throw new ProjectionSchemaMismatchError(observed, projectionPath);
    }
    if (!schemaChecked || observed === null) createTables(db!);
    schemaChecked = true;
  };
  const use = <A>(operation: (database: DatabaseSync) => A): A => {
    // A query operation can call back into this same owner while its own `operation` is still
    // running (an event-shape migration's rewrite reads the scratch projection it is replaying
    // into, mid-round). useDepth makes that reentrant, so a nested call reuses the still-open
    // connection instead of initializing a second owner.
    if (useDepth === 0) {
      if (db !== null && fingerprint !== projectionFileFingerprint(projectionPath)) close();
      if (db === null) initialize();
    }
    useDepth += 1;
    let succeeded = false;
    try {
      const observed = projectionSchemaVersion(db!);
      if (observed !== null && observed > taskProjectionSchemaVersion)
        throw new ProjectionSchemaMismatchError(observed, projectionPath);
      assertLedgerIdentity(db!, readHead());
      const value = operation(db!);
      succeeded = true;
      return value;
    } finally {
      useDepth -= 1;
      if (!succeeded && useDepth === 0) close();
    }
  };
  const owner = { use, close };
  owners.set(projectionPath, owner);
  return owner;
}
function canonicalProjectionPath(inputPath: string): string {
  const resolved = path.resolve(inputPath),
    pending: string[] = [];
  let current = resolved;
  while (!localRuntimeStateFileSystem.exists(current)) {
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    pending.unshift(path.basename(current));
    current = parent;
  }
  return path.join(localEventFileSystem.realpath(current), ...pending);
}

function projectionFileFingerprint(projectionPath: string): string | null {
  return localRuntimeStateFileSystem.fileIdentity(projectionPath);
}

// The cache is only fresh for the ledger it was scanned from. Revision alone cannot tell two
// ledgers apart (a genesis replay rewrites every event while keeping the revision), so the meta
// row also pins the head eventDigest as of the last completed scan. A cache whose scan claims the
// current head revision but pins a different digest belongs to another ledger: discard it. A cache
// which has scanned or applied beyond the current source cut may be the only readable copy of those
// revisions, so opening must retain it and fail closed.
function assertLedgerIdentity(db: DatabaseSync, head: ReturnType<EventStreamPort["readHead"]>): void {
  const row =
    /* @gate-identity check-bypass-write-boundary/bypass-write-010 */
    db.prepare("SELECT watermark, scanned_revision, head_digest FROM projection_meta WHERE singleton = 1").get() as {
      readonly watermark: number;
      readonly scanned_revision: number;
      readonly head_digest: string | null;
    };
  const sourceRevision = head?.revision ?? 0;
  if (Number(row.watermark) > sourceRevision || Number(row.scanned_revision) > sourceRevision)
    throw new ProjectionEventStreamIncompleteError(
      Number(row.watermark),
      Number(row.scanned_revision),
      head?.revision ?? null,
      { from: sourceRevision + 1, to: Math.max(Number(row.watermark), Number(row.scanned_revision)) },
    );
  if (Number(row.scanned_revision) === sourceRevision && row.head_digest !== (head?.eventDigest ?? null))
    throw new ProjectionIdentityMismatchError();
}

function readProjectionCoverage(
  projectionPath: string,
  readHead: EventStreamPort["readHead"],
): {
  readonly watermark: number;
  readonly scannedRevision: number;
} {
  return withQueryOnlyDatabaseSession(projectionPath, readHead, (db) => {
    const row = queryRows<{ readonly watermark: number; readonly scanned_revision: number }>(
      db,
      "SELECT watermark, scanned_revision FROM projection_meta WHERE singleton = 1",
    )[0];
    if (row === undefined) throw new Error(`projection cache metadata is unavailable at ${projectionPath}`);
    return { watermark: Number(row.watermark), scannedRevision: Number(row.scanned_revision) };
  });
}

function assertEventStreamContinuity(
  eventStore: EventStreamPort,
  coverage: { readonly watermark: number; readonly scannedRevision: number },
): void {
  const head = eventStore.readHead(),
    headRevision = head?.revision ?? 0,
    coverageRevision = Math.max(coverage.watermark, coverage.scannedRevision);
  const fail = (from: number, to: number): never => {
    throw new ProjectionEventStreamIncompleteError(
      coverage.watermark,
      coverage.scannedRevision,
      head?.revision ?? null,
      { from, to },
    );
  };
  if (headRevision < coverageRevision) fail(headRevision + 1, coverageRevision);
  let expectedRevision = 1,
    cursor: string | null = null;
  while (expectedRevision <= coverageRevision) {
    const batch = eventStore.readBatch(cursor, 4096);
    for (const event of batch.events) {
      if (event.workspaceRevision < expectedRevision) continue;
      if (event.workspaceRevision > expectedRevision)
        fail(expectedRevision, Math.min(coverageRevision, event.workspaceRevision - 1));
      expectedRevision += 1;
      if (expectedRevision > coverageRevision) return;
    }
    if (batch.done || batch.cursor === cursor) fail(expectedRevision, coverageRevision);
    cursor = batch.cursor;
  }
}
function openDatabase(projectionPath: string): DatabaseSync {
  return /* @gate-identity check-bypass-write-boundary/bypass-write-007 */ new DatabaseSync(projectionPath);
}
function configureDatabase(db: DatabaseSync): void {
  /* @gate-identity check-bypass-write-boundary/bypass-write-008 */
  db.exec(`PRAGMA busy_timeout = ${projectionBusyTimeoutMs}; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON`);
}

function createTables(db: DatabaseSync): void {
  /* @gate-identity check-bypass-write-boundary/bypass-write-009 */
  db.exec(`
    CREATE TABLE IF NOT EXISTS projection_meta (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      schema_version INTEGER NOT NULL,
      watermark INTEGER NOT NULL,
      scan_cursor TEXT,
      scanned_revision INTEGER NOT NULL,
      head_digest TEXT,
      state_digest TEXT,
      squad_run_ready INTEGER NOT NULL CHECK(squad_run_ready IN (0, 1))
    );
    INSERT OR IGNORE INTO projection_meta(
      singleton, schema_version, watermark, scan_cursor, scanned_revision, head_digest, state_digest, squad_run_ready
    ) VALUES (1, ${taskProjectionSchemaVersion}, 0, NULL, 0, NULL, NULL, 0);
    CREATE TABLE IF NOT EXISTS event_source (
      workspace_revision INTEGER PRIMARY KEY,
      op_id TEXT NOT NULL UNIQUE,
      event_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_index (
      op_id TEXT PRIMARY KEY,
      workspace_revision INTEGER NOT NULL UNIQUE,
      task_id TEXT,
      event_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS event_index_task_id ON event_index (task_id);
    CREATE INDEX IF NOT EXISTS event_index_runtime_dispatch_lookup ON event_index (
      json_extract(event_json, '$.payload.runtimeSessionId'),
      json_extract(event_json, '$.payload.definitionSnapshotRef'),
      workspace_revision
    ) WHERE
      json_extract(event_json, '$.schema') = 'agent-runtime-event/v1'
      AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested';
    CREATE TABLE IF NOT EXISTS document (
      path TEXT PRIMARY KEY,
      workspace_revision INTEGER NOT NULL,
      value_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS preset_snapshot (
      digest TEXT PRIMARY KEY,
      workspace_revision INTEGER NOT NULL,
      value_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_installation (
      installation_id TEXT PRIMARY KEY,
      workspace_revision INTEGER NOT NULL,
      value_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_session (
      runtime_session_id TEXT PRIMARY KEY,
      workspace_revision INTEGER NOT NULL,
      value_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_session_task_binding (
      task_id TEXT NOT NULL,
      runtime_session_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      bound_at TEXT NOT NULL,
      PRIMARY KEY(task_id, runtime_session_id, execution_id)
    );
    CREATE INDEX IF NOT EXISTS runtime_session_task_binding_session
      ON runtime_session_task_binding(runtime_session_id, task_id, execution_id);
    CREATE TABLE IF NOT EXISTS squad_run_projection (
      squad_run_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      state_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_snapshot (
      task_id TEXT PRIMARY KEY,
      workspace_revision INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      status TEXT,
      pinned INTEGER NOT NULL GENERATED ALWAYS AS (
        json_extract(snapshot_json, '$.task.pinned')
      ) STORED,
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS task_snapshot_status_updated ON task_snapshot(status, updated_at DESC, task_id ASC);
    CREATE INDEX IF NOT EXISTS task_snapshot_updated_task ON task_snapshot(updated_at DESC, task_id ASC);
    CREATE INDEX IF NOT EXISTS task_snapshot_revision_task ON task_snapshot(workspace_revision, task_id ASC);
    CREATE INDEX IF NOT EXISTS task_snapshot_agenda_status_pin ON task_snapshot(status, pinned DESC, task_id ASC);
    CREATE TABLE IF NOT EXISTS task_package (task_id TEXT PRIMARY KEY, package_path TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS task_generation (
      task_id TEXT PRIMARY KEY,
      generation TEXT NOT NULL CHECK(generation IN ('v0','v1'))
    );

    CREATE TABLE IF NOT EXISTS task_progress (
      workspace_revision INTEGER PRIMARY KEY,
      task_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      event_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entity_projection (
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      workspace_revision INTEGER NOT NULL,
      freshness TEXT NOT NULL,
      current_version,
      value_json TEXT NOT NULL,
      PRIMARY KEY(entity_kind, task_id, entity_id)
    );
    CREATE INDEX IF NOT EXISTS entity_projection_task
      ON entity_projection(entity_kind, task_id, workspace_revision, entity_id);
    CREATE TABLE IF NOT EXISTS archived_entity (
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      workspace_revision INTEGER NOT NULL,
      row_json TEXT NOT NULL,
      PRIMARY KEY(entity_kind, entity_id)
    );
    CREATE TABLE IF NOT EXISTS edge (
      task_id TEXT NOT NULL,
      edge_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      workspace_revision INTEGER NOT NULL,
      value_json TEXT NOT NULL,
      PRIMARY KEY(task_id, edge_id, iteration)
    );
    CREATE TABLE IF NOT EXISTS lease_cas (task_id TEXT PRIMARY KEY, lease_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lease_interval (
      task_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      acquired_revision INTEGER NOT NULL,
      released_revision INTEGER,
      holder_json TEXT NOT NULL,
      previous_holder_json TEXT,
      lease_expires_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY(task_id, execution_id, acquired_revision)
    );
  `);
  // This table is a disposable lookup over runtime_session.value_json, so adding it must not
  // invalidate the self-contained projection database (event_source lives in the same file).
  // Backfill once in place; steady-state runtime events maintain the rows transactionally.
  runSql(
    db,
    `
    INSERT OR IGNORE INTO runtime_session_task_binding(task_id, runtime_session_id, execution_id, bound_at)
    SELECT
      json_extract(binding.value, '$.taskId'),
      session.runtime_session_id,
      json_extract(binding.value, '$.executionId'),
      json_extract(binding.value, '$.boundAt')
    FROM runtime_session AS session
    JOIN json_each(session.value_json, '$.taskBindings') AS binding
    WHERE json_type(binding.value, '$.taskId') = 'text'
      AND json_type(binding.value, '$.executionId') = 'text'
      AND json_type(binding.value, '$.boundAt') = 'text';
  `,
  );
  createTaskRelationProjectionTable(db);
  createRelationGraphProjectionTables(db);
  createFactProjectionTables(db);
  createDecisionProjectionTables(db);
}

export function projectionSchemaVersion(db: DatabaseSync): number | null {
  if (queryRows(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='projection_meta'").length === 0)
    return null;
  const columns = queryRows(db, "PRAGMA table_info(projection_meta)");
  if (!columns.some(({ name }) => name === "schema_version")) return 0;
  const row = queryRows(db, "SELECT schema_version FROM projection_meta WHERE singleton=1")[0];
  return row ? Number(row.schema_version) : 0;
}
