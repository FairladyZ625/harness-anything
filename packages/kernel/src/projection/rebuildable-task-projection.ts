// @write-boundary-exemption rebuildable-projection
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  emptyTaskLifecycleSnapshot,
  reduceTaskEvent,
  serializeTaskEvent,
  type LeaseChangeReason,
  type TaskEventV1,
  type TaskLifecycleSnapshot
} from "../domain/task-lifecycle.contract.ts";
import { TASK_LEASE_BROKER_CONTRACT, validateLeaseV1, type LeaseHolder, type LeaseV1 } from "../domain/execution.ts";
import { canonicalizeContractValue } from "../domain/task.ts";
import { localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";

interface EventStreamPort { readonly read: () => { readonly revision: number; readonly events: readonly TaskEventV1[] } }
export type TaskProjectionWarning = "projection_missing";
export interface TaskProjectionRead {
  readonly status: "ready" | "pending";
  readonly snapshot: TaskLifecycleSnapshot;
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly TaskProjectionWarning[];
  readonly catchUp: { readonly deadlineMs: 100; readonly maxItems: 64; readonly elapsedMs: number; readonly reducedItems: number; readonly sqliteTransactions: 0 | 1 };
}
export interface ProjectionApplyReceipt { readonly metrics: { readonly sqliteTransactions: 1; readonly reducedItems: number } }
export interface ProjectionRebuildReceipt {
  readonly watermark: number;
  readonly metrics: { readonly sqliteTransactions: number; readonly reducedItems: number; readonly maxBatchItems: number; readonly maxBatchElapsedMs: number };
}
export interface LeaseInterval {
  readonly taskId: string;
  readonly executionId: string;
  readonly holder: LeaseHolder;
  readonly previousHolder: LeaseHolder | null;
  readonly acquiredRevision: number;
  readonly releasedRevision: number | null;
  readonly leaseExpiresAt: string;
  readonly reason: LeaseChangeReason;
}
export interface TaskProjection {
  readonly path: string;
  readonly apply: (event: TaskEventV1) => ProjectionApplyReceipt;
  readonly rebuild: () => ProjectionRebuildReceipt;
  readonly read: (taskId: string) => TaskProjectionRead;
  readonly readOperation: (opId: string) => { readonly event: TaskEventV1; readonly watermark: number } | null;
  readonly readLeaseIntervals: (taskId: string) => readonly LeaseInterval[];
  readonly currentLease: (taskId: string, now?: string) => LeaseV1 | null;
  readonly reserveLease: (lease: LeaseV1, now: string) => LeaseV1;
  readonly activateLease: (lease: LeaseV1) => LeaseV1;
  readonly renewLease: (lease: LeaseV1, expiresAt: string) => LeaseV1;
  readonly releaseLease: (lease: LeaseV1) => LeaseV1;
}

export function defaultLifecycleTaskProjectionPath(rootDir: string): string {
  return path.join(path.resolve(rootDir), ".harness/cache/task.sqlite");
}

export function makeTaskProjection(options: {
  readonly rootDir: string;
  readonly eventStore: EventStreamPort;
  readonly projectionPath?: string;
  readonly catchUpLimit?: number;
}): TaskProjection {
  const projectionPath = options.projectionPath ?? defaultLifecycleTaskProjectionPath(options.rootDir);
  const limit = options.catchUpLimit ?? 64;
  if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error("task projection catch-up limit must be between 1 and 64");
  return {
    path: projectionPath,
    apply: (event) => withDatabase(projectionPath, (db) => reduceBatch(db, [event])),
    rebuild: () => rebuildProjection(projectionPath, options.eventStore.read().events),
    read: (taskId) => readProjection(projectionPath, options.eventStore.read(), taskId, limit),
    readOperation: (opId) => withDatabase(projectionPath, (db) => {
      const row = db.prepare("SELECT event_json FROM event_index WHERE op_id = ?").get(opId) as { readonly event_json: string } | undefined;
      return row === undefined ? null : { event: JSON.parse(row.event_json) as TaskEventV1, watermark: watermark(db) };
    }),
    readLeaseIntervals: (taskId) => withDatabase(projectionPath, (db) => readIntervals(db, taskId)),
    currentLease: (taskId, now) => withDatabase(projectionPath, (db) => now === undefined ? storedLease(db, taskId) : transaction(db, () => effectiveLease(db, taskId, now))),
    reserveLease: (lease, now) => withDatabase(projectionPath, (db) => transaction(db, () => reserve(db, lease, now))),
    activateLease: (lease) => withDatabase(projectionPath, (db) => transaction(db, () => changeLease(db, lease, "active", lease.expiresAt))),
    renewLease: (lease, expiresAt) => withDatabase(projectionPath, (db) => transaction(db, () => changeLease(db, lease, "active", expiresAt))),
    releaseLease: (lease) => withDatabase(projectionPath, (db) => transaction(db, () => changeLease(db, lease, "released", lease.expiresAt)))
  };
}

function readProjection(projectionPath: string, stream: ReturnType<EventStreamPort["read"]>, taskId: string, limit: number): TaskProjectionRead {
  const existed = localRuntimeStateFileSystem.exists(projectionPath);
  return withDatabase(projectionPath, (db) => {
    const started = performance.now();
    const before = watermark(db);
    const pending = stream.events.slice(before, before + limit);
    if (pending.length > 0) reduceBatch(db, pending);
    const current = watermark(db);
    const elapsedMs = performance.now() - started;
    if (elapsedMs > 100) throw new Error(`projection catch-up exceeded 100ms deadline: ${elapsedMs}`);
    return { status: current === stream.revision ? "ready" : "pending", snapshot: readSnapshot(db, taskId), watermark: current,
      sourceRevision: stream.revision, warnings: !existed && stream.revision > 0 ? ["projection_missing"] : [],
      catchUp: { deadlineMs: 100, maxItems: 64, elapsedMs, reducedItems: pending.length, sqliteTransactions: pending.length === 0 ? 0 : 1 } };
  });
}

function rebuildProjection(projectionPath: string, events: readonly TaskEventV1[]): ProjectionRebuildReceipt {
  localRuntimeStateFileSystem.remove(projectionPath);
  let transactions = 0;
  let maxBatchItems = 0;
  let maxBatchElapsedMs = 0;
  for (let cursor = 0; cursor < events.length; cursor += 64) {
    const batch = events.slice(cursor, cursor + 64);
    const started = performance.now();
    withDatabase(projectionPath, (db) => reduceBatch(db, batch));
    const elapsedMs = performance.now() - started;
    if (elapsedMs > 100) throw new Error(`projection rebuild batch exceeded 100ms deadline: ${elapsedMs}`);
    transactions += 1;
    maxBatchItems = Math.max(maxBatchItems, batch.length);
    maxBatchElapsedMs = Math.max(maxBatchElapsedMs, elapsedMs);
  }
  if (events.length === 0) withDatabase(projectionPath, () => undefined);
  return { watermark: events.length, metrics: { sqliteTransactions: transactions, reducedItems: events.length, maxBatchItems, maxBatchElapsedMs } };
}

function withDatabase<A>(projectionPath: string, use: (db: DatabaseSync) => A): A {
  localRuntimeStateFileSystem.mkdirp(path.dirname(projectionPath));
  const db = new DatabaseSync(projectionPath);
  try {
    db.exec("PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON");
    createTables(db);
    return use(db);
  } finally { db.close(); }
}

function createTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projection_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), watermark INTEGER NOT NULL);
    INSERT OR IGNORE INTO projection_meta(singleton, watermark) VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS event_index (op_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL UNIQUE, task_id TEXT NOT NULL, event_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_snapshot (task_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS execution (execution_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, workspace_revision INTEGER NOT NULL, value_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS review (review_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, execution_id TEXT NOT NULL, workspace_revision INTEGER NOT NULL, value_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS edge (task_id TEXT NOT NULL, edge_id TEXT NOT NULL, iteration INTEGER NOT NULL, workspace_revision INTEGER NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(task_id, edge_id, iteration));
    CREATE TABLE IF NOT EXISTS lease_cas (task_id TEXT PRIMARY KEY, lease_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lease_interval (task_id TEXT NOT NULL, execution_id TEXT NOT NULL, acquired_revision INTEGER NOT NULL, released_revision INTEGER, holder_json TEXT NOT NULL, previous_holder_json TEXT, lease_expires_at TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(task_id, execution_id, acquired_revision));
  `);
}

function reduceBatch(db: DatabaseSync, events: readonly TaskEventV1[]): ProjectionApplyReceipt {
  return transaction(db, () => {
    let next = watermark(db);
    for (const event of events) {
      const eventJson = serializeTaskEvent(event).trimEnd();
      const existing = db.prepare("SELECT event_json FROM event_index WHERE op_id = ?").get(event.opId) as { readonly event_json: string } | undefined;
      if (existing !== undefined) {
        if (existing.event_json !== eventJson) throw new Error(`projection opId ${event.opId} names different bytes`);
        continue;
      }
      if (event.workspaceRevision !== next + 1) throw new Error(`projection revision ${event.workspaceRevision} must follow ${next}`);
      applyEvent(db, event, eventJson);
      next = event.workspaceRevision;
    }
    db.prepare("UPDATE projection_meta SET watermark = ? WHERE singleton = 1").run(next);
    return { metrics: { sqliteTransactions: 1, reducedItems: events.length } };
  });
}

function applyEvent(db: DatabaseSync, event: TaskEventV1, eventJson: string): void {
  const snapshot = reduceTaskEvent(readSnapshot(db, event.taskId), event);
  db.prepare("INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, ?, ?)")
    .run(event.opId, event.workspaceRevision, event.taskId, eventJson);
  db.prepare("INSERT INTO task_snapshot(task_id, workspace_revision, snapshot_json) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET workspace_revision=excluded.workspace_revision, snapshot_json=excluded.snapshot_json")
    .run(event.taskId, event.workspaceRevision, canonicalJson(snapshot));
  if (event.type !== "task_created") db.prepare("INSERT OR REPLACE INTO execution(execution_id, task_id, workspace_revision, value_json) VALUES (?, ?, ?, ?)")
    .run(event.payload.execution.executionId, event.taskId, event.workspaceRevision, canonicalJson(event.payload.execution));
  if (event.type === "review_recorded") db.prepare("INSERT INTO review(review_id, task_id, execution_id, workspace_revision, value_json) VALUES (?, ?, ?, ?, ?)")
    .run(event.payload.review.reviewId, event.taskId, event.payload.review.executionId, event.workspaceRevision, canonicalJson(event.payload.review));
  const edge = event.type === "execution_submitted" ? event.payload.edge : event.type === "review_recorded" ? event.payload.edge : undefined;
  if (edge !== undefined) db.prepare("INSERT INTO edge(task_id, edge_id, iteration, workspace_revision, value_json) VALUES (?, ?, ?, ?, ?)")
    .run(event.taskId, edge.edgeId, edge.iteration, event.workspaceRevision, canonicalJson(edge));
  if (event.type === "execution_started") replayClaim(db, event);
  if (event.type === "execution_submitted") replayRelease(db, event.taskId, event.payload.execution.executionId, event.workspaceRevision);
}

function replayClaim(db: DatabaseSync, event: Extract<TaskEventV1, { readonly type: "execution_started" }>): void {
  const lease = checkedLease(event.payload.lease);
  const reserving = { ...lease, phase: "reserving" as const };
  db.prepare("INSERT INTO lease_cas(task_id, lease_json) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET lease_json=excluded.lease_json")
    .run(event.taskId, canonicalJson(reserving));
  db.prepare("UPDATE lease_cas SET lease_json = ? WHERE task_id = ?").run(canonicalJson({ ...lease, phase: "active" }), event.taskId);
  db.prepare("INSERT INTO lease_interval(task_id, execution_id, acquired_revision, released_revision, holder_json, previous_holder_json, lease_expires_at, reason) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)")
    .run(event.taskId, lease.executionId, event.workspaceRevision, canonicalJson(holder(lease)), event.payload.previousHolder === null ? null : canonicalJson(event.payload.previousHolder), event.payload.leaseExpiresAt, event.payload.reason);
}

function replayRelease(db: DatabaseSync, taskId: string, executionId: string, revision: number): void {
  const lease = storedLease(db, taskId);
  if (lease !== null && lease.executionId === executionId) db.prepare("UPDATE lease_cas SET lease_json = ? WHERE task_id = ?")
    .run(canonicalJson({ ...lease, phase: "released", version: lease.version + 1 }), taskId);
  db.prepare("UPDATE lease_interval SET released_revision = ? WHERE task_id = ? AND execution_id = ? AND released_revision IS NULL")
    .run(revision, taskId, executionId);
}

function readSnapshot(db: DatabaseSync, taskId: string): TaskLifecycleSnapshot {
  const row = db.prepare("SELECT snapshot_json FROM task_snapshot WHERE task_id = ?").get(taskId) as { readonly snapshot_json: string } | undefined;
  if (row === undefined) return emptyTaskLifecycleSnapshot();
  let snapshot: TaskLifecycleSnapshot;
  try { snapshot = JSON.parse(row.snapshot_json) as TaskLifecycleSnapshot; }
  catch { throw new Error(`projection snapshot mismatch for task ${taskId}`); }
  const lease = storedLease(db, taskId);
  return { ...snapshot, lease: lease?.phase === "active" || lease?.phase === "reserving" ? lease : null };
}

function readIntervals(db: DatabaseSync, taskId: string): readonly LeaseInterval[] {
  const rows = db.prepare("SELECT * FROM lease_interval WHERE task_id = ? ORDER BY acquired_revision").all(taskId) as unknown as readonly Record<string, unknown>[];
  return rows.map((row) => ({ taskId: String(row.task_id), executionId: String(row.execution_id), acquiredRevision: Number(row.acquired_revision),
    releasedRevision: row.released_revision === null ? null : Number(row.released_revision), holder: JSON.parse(String(row.holder_json)) as LeaseHolder,
    previousHolder: row.previous_holder_json === null ? null : JSON.parse(String(row.previous_holder_json)) as LeaseHolder,
    leaseExpiresAt: String(row.lease_expires_at), reason: String(row.reason) as LeaseChangeReason }));
}

function reserve(db: DatabaseSync, lease: LeaseV1, now: string): LeaseV1 {
  checkedLease(lease);
  const current = effectiveLease(db, lease.taskId, now);
  if (current !== null && current.phase !== "orphaned" && current.phase !== "released") throw new Error(`lease conflict for task ${lease.taskId}`);
  const count = db.prepare("SELECT COUNT(*) AS count FROM lease_cas WHERE json_extract(lease_json, '$.phase') NOT IN ('released', 'orphaned') AND json_extract(lease_json, '$.expiresAt') > ?").get(now) as { readonly count: number };
  if (count.count >= TASK_LEASE_BROKER_CONTRACT.capacity) throw new Error(`lease capacity ${TASK_LEASE_BROKER_CONTRACT.capacity} exhausted; wait for a lease to be released or expire`);
  const expectedVersion = current === null ? 0 : current.version + 1;
  if (lease.phase !== "reserving" || lease.version !== expectedVersion) throw new Error(`stale lease reservation for task ${lease.taskId}`);
  db.prepare("INSERT INTO lease_cas(task_id, lease_json) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET lease_json=excluded.lease_json")
    .run(lease.taskId, canonicalJson(lease));
  return lease;
}

function changeLease(db: DatabaseSync, expected: LeaseV1, phase: "active" | "released", expiresAt: string): LeaseV1 {
  const current = storedLease(db, expected.taskId);
  const allowed = phase === "released" ? ["reserving", "active"] : expected.phase === "reserving" ? ["reserving"] : ["active"];
  if (current === null || current.executionId !== expected.executionId || canonicalJson(current.actor) !== canonicalJson(expected.actor)
    || canonicalJson(current.source) !== canonicalJson(expected.source) || current.version !== expected.version || !allowed.includes(current.phase)) {
    throw new Error(`stale lease CAS for task ${expected.taskId}`);
  }
  const next = checkedLease({ ...current, phase, expiresAt, version: current.version + 1 });
  db.prepare("UPDATE lease_cas SET lease_json = ? WHERE task_id = ?").run(canonicalJson(next), next.taskId);
  return next;
}

function effectiveLease(db: DatabaseSync, taskId: string, now: string): LeaseV1 | null {
  const current = storedLease(db, taskId);
  if (current === null || current.phase === "released") return current;
  if (current.expiresAt <= now && current.phase !== "orphaned") {
    const orphaned = checkedLease({ ...current, phase: "orphaned" });
    db.prepare("UPDATE lease_cas SET lease_json = ? WHERE task_id = ?").run(canonicalJson(orphaned), taskId);
    return orphaned;
  }
  return current;
}

function storedLease(db: DatabaseSync, taskId: string): LeaseV1 | null {
  const row = db.prepare("SELECT lease_json FROM lease_cas WHERE task_id = ?").get(taskId) as { readonly lease_json: string } | undefined;
  return row === undefined ? null : checkedLease(JSON.parse(row.lease_json) as LeaseV1);
}
function holder(lease: LeaseV1): LeaseHolder { return { taskId: lease.taskId, executionId: lease.executionId, actor: lease.actor, source: lease.source }; }
function checkedLease(lease: LeaseV1): LeaseV1 {
  const issues = validateLeaseV1(lease);
  if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join("; "));
  return lease;
}
function watermark(db: DatabaseSync): number { return Number((db.prepare("SELECT watermark FROM projection_meta WHERE singleton = 1").get() as { readonly watermark: number }).watermark); }
function transaction<A>(db: DatabaseSync, run: () => A): A {
  db.exec("BEGIN IMMEDIATE");
  try { const value = run(); db.exec("COMMIT"); return value; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function canonicalJson(value: unknown): string { return JSON.stringify(canonicalizeContractValue(value)); }
