// @write-boundary-exemption rebuildable-projection
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { emptyTaskLifecycleSnapshot, reduceTaskEvent, type LeaseChangeReason, type TaskEventV1,
  type TaskLifecycleSnapshot } from "../domain/task-lifecycle.contract.ts";
import { assertDocSyncWritePlan, isDocEvent, isFactEvent, isTaskEvent, parseCanonicalEvent, serializeCanonicalEvent, verifyDocEventChange, type CanonicalEventV1, type DocEventV1, type DocumentState } from "../domain/doc-sync.contract.ts"; import type { FrozenWritePlan } from "../domain/write-chain.contract.ts";
import { TASK_LEASE_BROKER_CONTRACT, validateLeaseV1, type LeaseHolder, type LeaseV1 } from "../domain/execution.ts";
import { canonicalizeContractValue } from "../domain/task.ts";
import { localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";
import { isAgentRuntimeEvent, markRuntimeSessionUnknown, reduceRuntimeInstallation, reduceRuntimeSession, runtimeSessionId, type AgentRuntimeEventV1, type RuntimeInstallation, type RuntimeSession } from "../domain/agent-runtime.ts";
import { assertTaskBootstrapWritePlan, isTaskBootstrapEvent, type TaskBootstrapEventV1 } from "../domain/task-bootstrap-event.ts";
import type { FactEventV1 } from "../domain/fact-event.ts";
import { assertFactAdmission, createFactProjectionTables, FactProjectionError, readFactAnchorRows, readFactGraphRows, readFactRow, reduceFactEvent, searchFactRows, type FactProjectionRow, type FactSearchFilters } from "./fact-event-projection.ts";

interface EventStreamPort {
  readonly readHead: () => { readonly revision: number } | null;
  readonly readBatch: (cursor: string | null, maxItems: number) => {
    readonly sourceRevision: number; readonly events: readonly CanonicalEventV1[]; readonly cursor: string | null;
    readonly done: boolean; readonly accessedItems: number;
  };
  readonly readContentBlob: (sha256: string) => Uint8Array | null;
}
export type TaskProjectionWarning = "projection_missing";
export interface TaskProjectionRead {
  readonly status: "ready" | "pending"; readonly snapshot: TaskLifecycleSnapshot; readonly watermark: number;
  readonly sourceRevision: number; readonly warnings: readonly TaskProjectionWarning[];
  readonly catchUp: { readonly deadlineMs: 100; readonly maxItems: 64; readonly elapsedMs: number; readonly reducedItems: number; readonly sqliteTransactions: 0 | 1 };
}
export interface TaskProjectionListRow { readonly taskId: string; readonly workspaceRevision: number; readonly updatedAt: string; readonly snapshot: TaskLifecycleSnapshot }
export interface TaskProjectionListRead { readonly status: "ready" | "pending"; readonly rows: readonly TaskProjectionListRow[]; readonly watermark: number; readonly sourceRevision: number; readonly warnings: readonly TaskProjectionWarning[] }
export interface ProjectionApplyReceipt { readonly metrics: { readonly sqliteTransactions: 1; readonly reducedItems: number } }
export interface ProjectionRebuildReceipt {
  readonly watermark: number; readonly metrics: { readonly sqliteTransactions: number; readonly reducedItems: number; readonly maxBatchItems: number; readonly maxBatchElapsedMs: number };
}
export interface LeaseInterval {
  readonly taskId: string; readonly executionId: string; readonly holder: LeaseHolder; readonly previousHolder: LeaseHolder | null;
  readonly acquiredRevision: number; readonly releasedRevision: number | null; readonly leaseExpiresAt: string; readonly reason: LeaseChangeReason;
}
export interface DocumentProjectionRead { readonly status: "ready" | "pending"; readonly document: DocumentState | null; readonly watermark: number; readonly sourceRevision: number }
export interface PresetSnapshotProjectionRead { readonly status: "ready" | "pending"; readonly snapshot: unknown | null; readonly watermark: number; readonly sourceRevision: number }
export interface FactProjectionRead { readonly status: "ready" | "pending"; readonly fact: FactProjectionRow | null; readonly watermark: number; readonly sourceRevision: number }
export interface FactProjectionSearchRead { readonly status: "ready" | "pending"; readonly facts: readonly FactProjectionRow[]; readonly watermark: number; readonly sourceRevision: number }
export interface FactGraphProjectionRead { readonly status: "ready" | "pending"; readonly edges: ReturnType<typeof readFactGraphRows>["edges"]; readonly factAnchors: ReturnType<typeof readFactGraphRows>["factAnchors"]; readonly facts: readonly FactProjectionRow[]; readonly watermark: number; readonly sourceRevision: number }
export interface TaskProjection {
  readonly path: string; readonly apply: { (event: TaskEventV1 | AgentRuntimeEventV1 | FactEventV1): ProjectionApplyReceipt; (event: DocEventV1, plan: FrozenWritePlan<"DocSyncSubmit">): ProjectionApplyReceipt; (event: TaskBootstrapEventV1, plan: FrozenWritePlan<"TaskBootstrap">): ProjectionApplyReceipt }; readonly rebuild: () => ProjectionRebuildReceipt;
  readonly read: (taskId: string) => TaskProjectionRead; readonly list: () => TaskProjectionListRead; readonly readOperation: (opId: string) => { readonly event: CanonicalEventV1; readonly watermark: number } | null;
  readonly readTaskOperation: (opId: string) => { readonly event: TaskEventV1; readonly watermark: number } | null; readonly readDocument: (path: string) => DocumentProjectionRead;
  readonly readPresetSnapshot: (digest: string) => PresetSnapshotProjectionRead;
  readonly admitFact: (event: FactEventV1) => void; readonly readFact: (taskId: string, factId: string) => FactProjectionRead; readonly searchFacts: (filters: FactSearchFilters) => FactProjectionSearchRead; readonly readFactGraph: () => FactGraphProjectionRead;
  readonly readLeaseIntervals: (taskId: string) => readonly LeaseInterval[]; readonly currentLease: (taskId: string, now?: string) => LeaseV1 | null; readonly currentLeaseForExecution: (executionId: string, now?: string) => LeaseV1 | null;
  readonly reserveLease: (lease: LeaseV1, now: string) => LeaseV1; readonly activateLease: (lease: LeaseV1) => LeaseV1;
  readonly renewLease: (lease: LeaseV1, expiresAt: string) => LeaseV1; readonly releaseLease: (lease: LeaseV1) => LeaseV1;
  readonly readRuntimeInstallation: (installationId: string) => RuntimeInstallation | null; readonly readRuntimeInstallations: () => readonly RuntimeInstallation[]; readonly readRuntimeSession: (runtimeSessionId: string) => RuntimeSession | null;
  readonly readRuntimeSessions: () => readonly RuntimeSession[]; readonly readRuntimeSessionsForTask: (taskId: string) => readonly RuntimeSession[];
}

export function defaultLifecycleTaskProjectionPath(rootDir: string): string { return path.join(path.resolve(rootDir), ".harness/cache/task.sqlite"); }
export function readLifecycleFactAnchors(rootDir: string): ReturnType<typeof readFactAnchorRows> { const projectionPath = defaultLifecycleTaskProjectionPath(rootDir); if (!localRuntimeStateFileSystem.exists(projectionPath)) return []; const db = new DatabaseSync(projectionPath, { readOnly: true }); try { return readFactAnchorRows(db); } finally { db.close(); } }
export function makeTaskProjection(options: { readonly rootDir: string; readonly eventStore: EventStreamPort;
  readonly projectionPath?: string; readonly catchUpLimit?: number; readonly now?: () => string }): TaskProjection {
  const projectionPath = options.projectionPath ?? defaultLifecycleTaskProjectionPath(options.rootDir);
  const limit = options.catchUpLimit ?? 64, now = options.now ?? (() => new Date().toISOString());
  if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error("task projection catch-up limit must be between 1 and 64");
  if (localRuntimeStateFileSystem.exists(projectionPath)) withDatabase(projectionPath, (db) => transaction(db, () => markRuntimeSessionsUnknown(db)));
  return {
    path: projectionPath,
    apply: ((event: CanonicalEventV1, plan?: FrozenWritePlan<"DocSyncSubmit" | "TaskBootstrap">) => { if (isDocEvent(event)) assertDocSyncWritePlan(event, plan as FrozenWritePlan<"DocSyncSubmit">); if (isTaskBootstrapEvent(event)) assertTaskBootstrapWritePlan(event, plan as FrozenWritePlan<"TaskBootstrap">); return withDatabase(projectionPath, (db) => reduceBatch(db, [event], limit, options.eventStore.readContentBlob)); }) as TaskProjection["apply"],
    rebuild: () => rebuildProjection(projectionPath, options.eventStore, limit),
    read: (taskId) => readProjection(projectionPath, options.eventStore, taskId, limit, now),
    list: () => listProjection(projectionPath, options.eventStore, limit, now),
    readOperation: (opId) => withDatabase(projectionPath, (db) => {
      const row = db.prepare("SELECT event_json FROM event_index WHERE op_id = ?").get(opId) as { readonly event_json: string } | undefined;
      return row === undefined ? null : { event: parseEventJson(row.event_json), watermark: watermark(db) };
    }),
    readTaskOperation: (opId) => withDatabase(projectionPath, (db) => { const row = db.prepare("SELECT event_json FROM event_index WHERE op_id = ?").get(opId) as { readonly event_json: string } | undefined; if (!row) return null; const event = parseEventJson(row.event_json); return isTaskEvent(event) ? { event, watermark: watermark(db) } : null; }),
    readDocument: (documentPath) => readDocument(projectionPath, options.eventStore, documentPath, limit),
    readPresetSnapshot: (digest) => readPresetSnapshot(projectionPath, options.eventStore, digest, limit),
    admitFact: (event) => withDatabase(projectionPath, (db) => { const round = catchUpRound(db, options.eventStore, limit); if (round.watermark !== round.sourceRevision) throw new FactProjectionError("content_not_ready", `Fact admission requires projection revision ${round.sourceRevision}; current watermark is ${round.watermark}.`); assertFactAdmission(db, event); }),
    readFact: (taskId, factId) => withDatabase(projectionPath, (db) => { const round = catchUpRound(db, options.eventStore, limit), current = watermark(db); return { status: current === round.sourceRevision ? "ready" : "pending", fact: readFactRow(db, taskId, factId), watermark: current, sourceRevision: round.sourceRevision }; }),
    searchFacts: (filters) => withDatabase(projectionPath, (db) => { const round = catchUpRound(db, options.eventStore, limit), current = watermark(db); return { status: current === round.sourceRevision ? "ready" : "pending", facts: searchFactRows(db, filters), watermark: current, sourceRevision: round.sourceRevision }; }),
    readFactGraph: () => withDatabase(projectionPath, (db) => { const round = catchUpRound(db, options.eventStore, limit), current = watermark(db); return { status: current === round.sourceRevision ? "ready" : "pending", ...readFactGraphRows(db), watermark: current, sourceRevision: round.sourceRevision }; }),
    readRuntimeInstallation: (installationId) => withDatabase(projectionPath, (db) => readRuntimeInstallation(db, installationId)), readRuntimeInstallations: () => withDatabase(projectionPath, readRuntimeInstallations),
    readRuntimeSession: (runtimeSessionIdValue) => withDatabase(projectionPath, (db) => readRuntimeSession(db, runtimeSessionIdValue)), readRuntimeSessions: () => withDatabase(projectionPath, readRuntimeSessions),
    readRuntimeSessionsForTask: (taskId) => withDatabase(projectionPath, (db) => readRuntimeSessions(db).filter((session) => session.taskBindings.some((binding) => binding.taskId === taskId))),
    readLeaseIntervals: (taskId) => withDatabase(projectionPath, (db) => readIntervals(db, taskId)),
    currentLease: (taskId, at) => withDatabase(projectionPath, (db) => effectiveLease(db, taskId, at ?? now())),
    currentLeaseForExecution: (executionId, at) => withDatabase(projectionPath, (db) => { const row = db.prepare("SELECT task_id FROM lease_cas WHERE json_extract(lease_json, '$.executionId') = ?").get(executionId) as { readonly task_id: string } | undefined; return row ? effectiveLease(db, row.task_id, at ?? now()) : null; }),
    reserveLease: (lease, now) => withDatabase(projectionPath, (db) => transaction(db, () => reserve(db, lease, now))),
    activateLease: (lease) => withDatabase(projectionPath, (db) => transaction(db, () => changeLease(db, lease, "active", lease.expiresAt, now()))),
    renewLease: (lease, expiresAt) => withDatabase(projectionPath, (db) => transaction(db, () => changeLease(db, lease, "active", expiresAt, now()))),
    releaseLease: (lease) => withDatabase(projectionPath, (db) => transaction(db, () => changeLease(db, lease, "released", lease.expiresAt, now())))
  };
}

function listProjection(projectionPath: string, eventStore: EventStreamPort, limit: number, now: () => string): TaskProjectionListRead {
  const existed = localRuntimeStateFileSystem.exists(projectionPath);
  return withDatabase(projectionPath, (db) => {
    const round = catchUpRound(db, eventStore, limit), current = watermark(db), at = now();
    const rows = db.prepare("SELECT task_snapshot.task_id AS task_id, task_snapshot.workspace_revision AS workspace_revision, event_index.event_json AS event_json FROM task_snapshot JOIN event_index USING(workspace_revision) ORDER BY task_snapshot.task_id").all() as unknown as readonly { readonly task_id: string; readonly workspace_revision: number; readonly event_json: string }[];
    return { status: current === round.sourceRevision ? "ready" : "pending", rows: rows.map((row) => ({ taskId: row.task_id, workspaceRevision: row.workspace_revision,
      updatedAt: parseEventJson(row.event_json).occurredAt, snapshot: readSnapshot(db, row.task_id, at) })), watermark: current, sourceRevision: round.sourceRevision,
      warnings: !existed && round.sourceRevision > 0 ? ["projection_missing"] : [] };
  });
}

function readDocument(projectionPath: string, eventStore: EventStreamPort, documentPath: string, limit: number): DocumentProjectionRead {
  return withDatabase(projectionPath, (db) => { const round = catchUpRound(db, eventStore, limit), current = watermark(db), row = db.prepare("SELECT value_json FROM document WHERE path = ?").get(documentPath) as { readonly value_json: string } | undefined;
    return { status: current === round.sourceRevision ? "ready" : "pending", document: row ? JSON.parse(row.value_json) as DocumentState : null, watermark: current, sourceRevision: round.sourceRevision }; });
}
function readPresetSnapshot(projectionPath: string, eventStore: EventStreamPort, digest: string, limit: number): PresetSnapshotProjectionRead { return withDatabase(projectionPath, (db) => { const round = catchUpRound(db, eventStore, limit), current = watermark(db), row = db.prepare("SELECT value_json FROM preset_snapshot WHERE digest = ?").get(digest) as { readonly value_json: string } | undefined; return { status: current === round.sourceRevision ? "ready" : "pending", snapshot: row ? JSON.parse(row.value_json) : null, watermark: current, sourceRevision: round.sourceRevision }; }); }

function readProjection(projectionPath: string, eventStore: EventStreamPort, taskId: string, limit: number, now: () => string): TaskProjectionRead {
  const started = performance.now();
  const existed = localRuntimeStateFileSystem.exists(projectionPath);
  return withDatabase(projectionPath, (db) => {
    const round = catchUpRound(db, eventStore, limit);
    const current = watermark(db);
    const elapsedMs = performance.now() - started;
    return { status: current === round.sourceRevision ? "ready" : "pending", snapshot: readSnapshot(db, taskId, now()), watermark: current,
      sourceRevision: round.sourceRevision, warnings: !existed && round.sourceRevision > 0 ? ["projection_missing"] : [],
      catchUp: { deadlineMs: 100, maxItems: 64, elapsedMs, reducedItems: round.reducedItems, sqliteTransactions: round.sqliteTransactions } };
  });
}

function rebuildProjection(projectionPath: string, eventStore: EventStreamPort, limit: number): ProjectionRebuildReceipt {
  localRuntimeStateFileSystem.remove(projectionPath);
  let transactions = 0, reducedItems = 0, maxBatchItems = 0, maxBatchElapsedMs = 0;
  for (;;) {
    const started = performance.now();
    const round = withDatabase(projectionPath, (db) => catchUpRound(db, eventStore, limit));
    const elapsedMs = performance.now() - started;
    transactions += round.sqliteTransactions;
    reducedItems += round.reducedItems;
    maxBatchItems = Math.max(maxBatchItems, round.accessedItems);
    maxBatchElapsedMs = Math.max(maxBatchElapsedMs, elapsedMs);
    if (round.watermark === round.sourceRevision) break;
  }
  const current = withDatabase(projectionPath, (db) => transaction(db, () => { markRuntimeSessionsUnknown(db); return watermark(db); })); transactions += 1;
  return { watermark: current, metrics: { sqliteTransactions: transactions, reducedItems, maxBatchItems, maxBatchElapsedMs } };
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
    CREATE TABLE IF NOT EXISTS projection_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), watermark INTEGER NOT NULL, scan_cursor TEXT, scanned_revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO projection_meta(singleton, watermark, scan_cursor, scanned_revision) VALUES (1, 0, NULL, 0);
    CREATE TABLE IF NOT EXISTS event_source (workspace_revision INTEGER PRIMARY KEY, op_id TEXT NOT NULL UNIQUE, event_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS event_index (op_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL UNIQUE, task_id TEXT, event_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS document (path TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, value_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS preset_snapshot (digest TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, value_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_installation (installation_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, value_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_session (runtime_session_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, value_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_snapshot (task_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS execution (execution_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, workspace_revision INTEGER NOT NULL, value_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS review (review_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, execution_id TEXT NOT NULL, workspace_revision INTEGER NOT NULL, value_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS edge (task_id TEXT NOT NULL, edge_id TEXT NOT NULL, iteration INTEGER NOT NULL, workspace_revision INTEGER NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(task_id, edge_id, iteration));
    CREATE TABLE IF NOT EXISTS lease_cas (task_id TEXT PRIMARY KEY, lease_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lease_interval (task_id TEXT NOT NULL, execution_id TEXT NOT NULL, acquired_revision INTEGER NOT NULL, released_revision INTEGER, holder_json TEXT NOT NULL, previous_holder_json TEXT, lease_expires_at TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(task_id, execution_id, acquired_revision));
  `);
  createFactProjectionTables(db);
}

function reduceBatch(db: DatabaseSync, events: readonly CanonicalEventV1[], limit: number, readBlob: EventStreamPort["readContentBlob"]): ProjectionApplyReceipt {
  return transaction(db, () => {
    for (const event of events) stageEvent(db, event);
    const reducedItems = drainDeferred(db, limit, readBlob);
    const state = db.prepare("SELECT scan_cursor, scanned_revision FROM projection_meta WHERE singleton = 1").get() as {
      readonly scan_cursor: string | null; readonly scanned_revision: number;
    };
    const last = events.at(-1);
    if (last !== undefined && state.scan_cursor === null && state.scanned_revision === last.workspaceRevision - events.length
      && watermark(db) >= last.workspaceRevision) {
      runSql(db, "UPDATE projection_meta SET scanned_revision = ? WHERE singleton = 1", last.workspaceRevision);
    }
    return { metrics: { sqliteTransactions: 1, reducedItems } };
  });
}

function catchUpRound(db: DatabaseSync, eventStore: EventStreamPort, limit: number): {
  readonly sourceRevision: number; readonly watermark: number; readonly reducedItems: number;
  readonly accessedItems: number; readonly sqliteTransactions: 0 | 1;
} {
  const sourceRevision = eventStore.readHead()?.revision ?? 0;
  const state = db.prepare("SELECT scan_cursor, scanned_revision FROM projection_meta WHERE singleton = 1").get() as {
    readonly scan_cursor: string | null; readonly scanned_revision: number;
  };
  const shouldScan = state.scan_cursor !== null || state.scanned_revision < sourceRevision;
  const batch = shouldScan ? eventStore.readBatch(state.scan_cursor, limit) : null;
  const hasDeferred = db.prepare("SELECT 1 AS present FROM event_source WHERE workspace_revision = ?").get(watermark(db) + 1) !== undefined;
  if (batch === null && !hasDeferred) return { sourceRevision, watermark: watermark(db), reducedItems: 0, accessedItems: 0, sqliteTransactions: 0 };
  const reducedItems = transaction(db, () => {
    if (batch !== null) {
      for (const event of batch.events) stageEvent(db, event);
      runSql(db, "UPDATE projection_meta SET scan_cursor = ?, scanned_revision = ? WHERE singleton = 1", batch.done ? null : batch.cursor, batch.done ? batch.sourceRevision : state.scanned_revision);
    }
    return drainDeferred(db, limit, eventStore.readContentBlob);
  });
  return { sourceRevision, watermark: watermark(db), reducedItems, accessedItems: batch?.accessedItems ?? 0, sqliteTransactions: 1 };
}

function stageEvent(db: DatabaseSync, event: CanonicalEventV1): void {
  const eventJson = serializeCanonicalEvent(event).trimEnd();
  const applied = db.prepare("SELECT event_json FROM event_index WHERE op_id = ?").get(event.opId) as { readonly event_json: string } | undefined;
  if (applied !== undefined) {
    if (applied.event_json !== eventJson) throw new Error(`projection opId ${event.opId} names different bytes`);
    return;
  }
  const staged = db.prepare("SELECT event_json FROM event_source WHERE op_id = ? OR workspace_revision = ?").get(event.opId, event.workspaceRevision) as { readonly event_json: string } | undefined;
  if (staged !== undefined) {
    if (staged.event_json !== eventJson) throw new Error(`projection revision or opId ${event.opId} names different bytes`);
    return;
  }
  runSql(db, "INSERT INTO event_source(workspace_revision, op_id, event_json) VALUES (?, ?, ?)", event.workspaceRevision, event.opId, eventJson);
}

function drainDeferred(db: DatabaseSync, limit: number, readBlob: EventStreamPort["readContentBlob"]): number {
  let next = watermark(db), reduced = 0;
  while (reduced < limit) {
    const row = db.prepare("SELECT event_json FROM event_source WHERE workspace_revision = ?").get(next + 1) as { readonly event_json: string } | undefined;
    if (row === undefined) break;
    const event = parseEventJson(row.event_json);
    applyEvent(db, event, row.event_json, readBlob);
    runSql(db, "DELETE FROM event_source WHERE workspace_revision = ?", event.workspaceRevision);
    next = event.workspaceRevision;
    reduced += 1;
  }
  runSql(db, "UPDATE projection_meta SET watermark = ? WHERE singleton = 1", next);
  return reduced;
}

function applyEvent(db: DatabaseSync, event: CanonicalEventV1, eventJson: string, readBlob: EventStreamPort["readContentBlob"]): void {
  if (isFactEvent(event)) { reduceFactEvent(db, event); runSql(db, "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, ?, ?)", event.opId, event.workspaceRevision, event.taskId, eventJson); return; }
  if (isAgentRuntimeEvent(event)) { const taskId = event.type === "runtime_session_task_bound" ? event.payload.taskId : null; runSql(db, "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, ?, ?)", event.opId, event.workspaceRevision, taskId, eventJson);
    const installation = reduceRuntimeInstallation(event.type === "runtime_installation_observed" ? readRuntimeInstallation(db, event.payload.installationId) : null, event); if (installation !== null) runSql(db, "INSERT INTO runtime_installation(installation_id, workspace_revision, value_json) VALUES (?, ?, ?) ON CONFLICT(installation_id) DO UPDATE SET workspace_revision=excluded.workspace_revision, value_json=excluded.value_json", installation.installationId, event.workspaceRevision, canonicalJson(installation));
    const sessionId = runtimeSessionId(event); if (sessionId !== null) { const session = reduceRuntimeSession(readRuntimeSession(db, sessionId), event); if (session !== null) runSql(db, "INSERT INTO runtime_session(runtime_session_id, workspace_revision, value_json) VALUES (?, ?, ?) ON CONFLICT(runtime_session_id) DO UPDATE SET workspace_revision=excluded.workspace_revision, value_json=excluded.value_json", session.runtimeSessionId, event.workspaceRevision, canonicalJson(session)); } return; }
  if (isDocEvent(event)) { runSql(db, "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, NULL, ?)", event.opId, event.workspaceRevision, eventJson); for (const change of event.payload.changes) { const bytes = readBlob(change.candidate.sha256); if (!bytes || bytes.byteLength !== change.candidate.size) throw new Error(`document blob ${change.candidate.sha256} is unavailable`); let body: string; try { body = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error(`document blob ${change.candidate.sha256} is not UTF-8`); } const previous = db.prepare("SELECT value_json FROM document WHERE path = ?").get(change.path) as { readonly value_json: string } | undefined, base = previous ? JSON.parse(previous.value_json) as DocumentState : null; if (change.baseBlobSha256 !== (base?.blobSha256 ?? null) || !verifyDocEventChange(change, base?.body ?? "", body)) throw new Error(`document proof mismatch for ${change.path}`);
      const document: DocumentState = { path: change.path, blobSha256: change.candidate.sha256, body, size: change.candidate.size, mediaType: change.candidate.mediaType, policyId: change.policyId, workspaceRevision: event.workspaceRevision }; runSql(db, "INSERT INTO document(path, workspace_revision, value_json) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET workspace_revision=excluded.workspace_revision, value_json=excluded.value_json", change.path, event.workspaceRevision, canonicalJson(document)); } return; }
  if (isTaskBootstrapEvent(event)) { const snapshotBytes = readBlob(event.payload.presetSnapshotClaim.sha256); if (!snapshotBytes || snapshotBytes.byteLength !== event.payload.presetSnapshotClaim.size) throw new Error(`preset snapshot blob ${event.payload.presetSnapshotClaim.sha256} is unavailable`); const snapshotBody = new TextDecoder("utf-8", { fatal: true }).decode(snapshotBytes), snapshot = JSON.parse(snapshotBody);
    runSql(db, "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, ?, ?)", event.opId, event.workspaceRevision, event.taskId, eventJson); runSql(db, "INSERT INTO task_snapshot(task_id, workspace_revision, snapshot_json) VALUES (?, ?, ?)", event.taskId, event.workspaceRevision, canonicalJson({ ...emptyTaskLifecycleSnapshot(event.workspaceRevision), task: event.payload.task })); if (Number(runSql(db, "INSERT INTO preset_snapshot(digest, workspace_revision, value_json) VALUES (?, ?, ?) ON CONFLICT(digest) DO UPDATE SET value_json=excluded.value_json WHERE preset_snapshot.value_json=excluded.value_json", event.payload.presetSnapshotClaim.digest, event.workspaceRevision, canonicalJson(snapshot))) === 0) throw new Error(`preset snapshot digest ${event.payload.presetSnapshotClaim.digest} names different bytes`);
    for (const claim of event.payload.initialDocumentClaims) { const bytes = readBlob(claim.sha256); if (!bytes || bytes.byteLength !== claim.size) throw new Error(`document blob ${claim.sha256} is unavailable`); const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes), document: DocumentState = { path: claim.path as DocumentState["path"], blobSha256: claim.sha256, body, size: claim.size as DocumentState["size"], mediaType: claim.mediaType, policyId: claim.policyId, workspaceRevision: event.workspaceRevision }; runSql(db, "INSERT INTO document(path, workspace_revision, value_json) VALUES (?, ?, ?)", claim.path, event.workspaceRevision, canonicalJson(document)); } return; }
  const snapshot = reduceTaskEvent(readSnapshot(db, event.taskId), event);
  runSql(db, "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, ?, ?)", event.opId, event.workspaceRevision, event.taskId, eventJson);
  runSql(db, "INSERT INTO task_snapshot(task_id, workspace_revision, snapshot_json) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET workspace_revision=excluded.workspace_revision, snapshot_json=excluded.snapshot_json", event.taskId, event.workspaceRevision, canonicalJson(snapshot));
  if (event.type !== "task_created") runSql(db, "INSERT OR REPLACE INTO execution(execution_id, task_id, workspace_revision, value_json) VALUES (?, ?, ?, ?)", event.payload.execution.executionId, event.taskId, event.workspaceRevision, canonicalJson(event.payload.execution));
  if (event.type === "review_recorded") runSql(db, "INSERT INTO review(review_id, task_id, execution_id, workspace_revision, value_json) VALUES (?, ?, ?, ?, ?)", event.payload.review.reviewId, event.taskId, event.payload.review.executionId, event.workspaceRevision, canonicalJson(event.payload.review));
  const edge = event.type === "execution_submitted" ? event.payload.edge : event.type === "review_recorded" ? event.payload.edge : undefined;
  if (edge !== undefined) runSql(db, "INSERT INTO edge(task_id, edge_id, iteration, workspace_revision, value_json) VALUES (?, ?, ?, ?, ?)", event.taskId, edge.edgeId, edge.iteration, event.workspaceRevision, canonicalJson(edge));
  if (event.type === "execution_started") replayClaim(db, event);
  if (event.type === "lease_renewed") replayRenew(db, event);
  if (event.type === "execution_submitted") replayRelease(db, event.taskId, event.payload.execution.executionId, event.workspaceRevision);
}

function replayClaim(db: DatabaseSync, event: Extract<TaskEventV1, { readonly type: "execution_started" }>): void {
  const lease = checkedLease(event.payload.lease);
  const reserving = { ...lease, phase: "reserving" as const };
  db.prepare("INSERT INTO lease_cas(task_id, lease_json) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET lease_json=excluded.lease_json").run(event.taskId, canonicalJson(reserving));
  db.prepare("UPDATE lease_cas SET lease_json = ? WHERE task_id = ?").run(canonicalJson({ ...lease, phase: "active" }), event.taskId);
  db.prepare("INSERT INTO lease_interval(task_id, execution_id, acquired_revision, released_revision, holder_json, previous_holder_json, lease_expires_at, reason) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)").run(event.taskId, lease.executionId, event.workspaceRevision, canonicalJson(holder(lease)), event.payload.previousHolder === null ? null : canonicalJson(event.payload.previousHolder), event.payload.leaseExpiresAt, event.payload.reason);
}

function replayRenew(db: DatabaseSync, event: Extract<TaskEventV1, { readonly type: "lease_renewed" }>): void {
  const current = storedLease(db, event.taskId), renewed = checkedLease(event.payload.lease);
  const matchesPrevious = current !== null && current.phase === "active" && current.executionId === renewed.executionId
    && canonicalJson(current.actor) === canonicalJson(renewed.actor) && canonicalJson(current.source) === canonicalJson(renewed.source)
    && current.version + 1 === renewed.version;
  if (!matchesPrevious && canonicalJson(current) !== canonicalJson(renewed)) throw new Error(`stale lease renewal event for task ${event.taskId}`);
  db.prepare("INSERT INTO lease_cas(task_id, lease_json) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET lease_json=excluded.lease_json").run(event.taskId, canonicalJson(renewed));
  db.prepare("UPDATE lease_interval SET lease_expires_at = ? WHERE task_id = ? AND execution_id = ? AND released_revision IS NULL").run(renewed.expiresAt, event.taskId, renewed.executionId);
}

function replayRelease(db: DatabaseSync, taskId: string, executionId: string, revision: number): void {
  const lease = storedLease(db, taskId);
  if (lease !== null && lease.executionId === executionId) db.prepare("UPDATE lease_cas SET lease_json = ? WHERE task_id = ?").run(canonicalJson({ ...lease, phase: "released", version: lease.version + 1 }), taskId);
  db.prepare("UPDATE lease_interval SET released_revision = ? WHERE task_id = ? AND execution_id = ? AND released_revision IS NULL").run(revision, taskId, executionId);
}

function readSnapshot(db: DatabaseSync, taskId: string, now?: string): TaskLifecycleSnapshot {
  const row = db.prepare("SELECT snapshot_json FROM task_snapshot WHERE task_id = ?").get(taskId) as { readonly snapshot_json: string } | undefined;
  if (row === undefined) return emptyTaskLifecycleSnapshot();
  let snapshot: TaskLifecycleSnapshot;
  try { snapshot = JSON.parse(row.snapshot_json) as TaskLifecycleSnapshot; } catch { throw new Error(`projection snapshot mismatch for task ${taskId}`); }
  const lease = now === undefined ? storedLease(db, taskId) : effectiveLease(db, taskId, now);
  return { ...snapshot, lease: lease?.phase === "released" ? null : lease };
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
  db.prepare("INSERT INTO lease_cas(task_id, lease_json) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET lease_json=excluded.lease_json").run(lease.taskId, canonicalJson(lease));
  return lease;
}

function changeLease(db: DatabaseSync, expected: LeaseV1, phase: "active" | "released", expiresAt: string, now: string): LeaseV1 {
  const current = effectiveLease(db, expected.taskId, now);
  const allowed = phase === "released" ? ["reserving", "active"] : expected.phase === "reserving" ? ["reserving"] : ["active"];
  if (current === null || current.executionId !== expected.executionId || canonicalJson(current.actor) !== canonicalJson(expected.actor)
    || canonicalJson(current.source) !== canonicalJson(expected.source) || current.version !== expected.version || !allowed.includes(current.phase)) {
    throw new Error(`stale lease CAS for task ${expected.taskId}`);
  }
  const next = checkedLease({ ...current, phase, expiresAt, version: current.version + 1 });
  runSql(db, "UPDATE lease_cas SET lease_json = ? WHERE task_id = ?", canonicalJson(next), next.taskId);
  return next;
}

function effectiveLease(db: DatabaseSync, taskId: string, now: string): LeaseV1 | null {
  const current = storedLease(db, taskId);
  if (current === null || current.phase === "released") return current;
  if (current.expiresAt <= now && current.phase !== "orphaned") return checkedLease({ ...current, phase: "orphaned" });
  return current;
}

function storedLease(db: DatabaseSync, taskId: string): LeaseV1 | null { const row = queryRows(db, "SELECT lease_json FROM lease_cas WHERE task_id = ?", taskId)[0]; return row === undefined ? null : checkedLease(JSON.parse(String(row.lease_json)) as LeaseV1); }
function readRuntimeInstallation(db: DatabaseSync, installationId: string): RuntimeInstallation | null { const row = queryRows(db, "SELECT value_json FROM runtime_installation WHERE installation_id = ?", installationId)[0]; return row ? JSON.parse(String(row.value_json)) as RuntimeInstallation : null; } function readRuntimeInstallations(db: DatabaseSync): RuntimeInstallation[] { return queryRows(db, "SELECT value_json FROM runtime_installation ORDER BY installation_id").map((row) => JSON.parse(String(row.value_json)) as RuntimeInstallation); }
function readRuntimeSession(db: DatabaseSync, sessionId: string): RuntimeSession | null { const row = queryRows(db, "SELECT value_json FROM runtime_session WHERE runtime_session_id = ?", sessionId)[0]; return row ? JSON.parse(String(row.value_json)) as RuntimeSession : null; } function readRuntimeSessions(db: DatabaseSync): RuntimeSession[] { return queryRows(db, "SELECT value_json FROM runtime_session ORDER BY runtime_session_id").map((row) => JSON.parse(String(row.value_json)) as RuntimeSession); }
function markRuntimeSessionsUnknown(db: DatabaseSync): number { const rows = queryRows(db, "SELECT runtime_session_id, value_json FROM runtime_session"); let changed = 0; for (const row of rows) { const current = JSON.parse(String(row.value_json)) as RuntimeSession, next = markRuntimeSessionUnknown(current); if (next !== current) { runSql(db, "UPDATE runtime_session SET value_json = ? WHERE runtime_session_id = ?", canonicalJson(next), String(row.runtime_session_id)); changed += 1; } } return changed; }
function holder(lease: LeaseV1): LeaseHolder { return { taskId: lease.taskId, executionId: lease.executionId, actor: lease.actor, source: lease.source }; }
function checkedLease(lease: LeaseV1): LeaseV1 { const issues = validateLeaseV1(lease); if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join("; ")); return lease; }
function watermark(db: DatabaseSync): number { return Number((db.prepare("SELECT watermark FROM projection_meta WHERE singleton = 1").get() as { readonly watermark: number }).watermark); }
function transaction<A>(db: DatabaseSync, run: () => A): A {
  db.exec("BEGIN IMMEDIATE"); try { const value = run(); db.exec("COMMIT"); return value; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
type SqlValue = string | number | bigint | Uint8Array | null; function runSql(db: DatabaseSync, sql: string, ...values: readonly SqlValue[]): number | bigint { return db.prepare(sql).run(...values).changes; } function queryRows(db: DatabaseSync, sql: string, ...values: readonly SqlValue[]): readonly Record<string, unknown>[] { return db.prepare(sql).all(...values) as unknown as readonly Record<string, unknown>[]; }
function canonicalJson(value: unknown): string { return JSON.stringify(canonicalizeContractValue(value)); }
function parseEventJson(value: string): CanonicalEventV1 { return parseCanonicalEvent(`${value}\n`); }
