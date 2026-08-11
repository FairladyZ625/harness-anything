// @write-boundary-exemption rebuildable-projection
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  emptyTaskLifecycleSnapshot,
  reduceTaskEvent,
  serializeTaskEvent,
  type TaskEventV1,
  type TaskLifecycleSnapshot
} from "../domain/task-lifecycle.contract.ts";
import { canonicalizeContractValue } from "../domain/task.ts";
import { localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";

interface EventStreamPort { readonly read: () => { readonly revision: number; readonly events: readonly TaskEventV1[] } }
interface TaskEventStreamV1 { readonly revision: number; readonly events: readonly TaskEventV1[] }

export type TaskProjectionWarning = "projection_missing" | "projection_tampered";
export interface TaskProjectionRead {
  readonly status: "ready" | "pending";
  readonly snapshot: TaskLifecycleSnapshot;
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly TaskProjectionWarning[];
}

export interface TaskProjection {
  readonly path: string;
  readonly apply: (event: TaskEventV1) => void;
  readonly rebuild: () => void;
  readonly read: (taskId: string) => TaskProjectionRead;
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
  const limit = options.catchUpLimit ?? 128;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("task projection catch-up limit must be positive");
  return {
    path: projectionPath,
    apply: (event) => withDatabase(projectionPath, (db) => transaction(db, () => {
      const watermark = projectionWatermark(db);
      if (event.workspaceRevision !== watermark + 1) throw new Error(`projection revision ${event.workspaceRevision} must follow ${watermark}`);
      applyEvent(db, event);
    })),
    rebuild: () => rebuildProjection(projectionPath, options.eventStore.read().events),
    read: (taskId) => readProjection(projectionPath, options.eventStore.read(), taskId, limit)
  };
}

function readProjection(projectionPath: string, stream: TaskEventStreamV1, taskId: string, limit: number): TaskProjectionRead {
  const warnings: TaskProjectionWarning[] = [];
  let watermark: number;
  try {
    watermark = withDatabase(projectionPath, (db) => {
      const current = projectionWatermark(db);
      if (!projectionMatches(db, stream.events.slice(0, current))) throw new Error("projection mismatch");
      return current;
    });
  } catch (error) {
    consumeKnownError(error);
    warnings.push("projection_tampered");
    rebuildProjection(projectionPath, stream.events);
    watermark = stream.revision;
  }
  if (watermark === 0 && stream.revision > 0 && warnings.length === 0) warnings.push("projection_missing");
  if (watermark < stream.revision) {
    const pending = stream.events.slice(watermark, watermark + limit);
    withDatabase(projectionPath, (db) => transaction(db, () => {
      for (const event of pending) applyEvent(db, event);
    }));
    watermark += pending.length;
  }
  const snapshot = withDatabase(projectionPath, (db) => readSnapshot(db, taskId));
  return {
    status: watermark === stream.revision ? "ready" : "pending",
    snapshot,
    watermark,
    sourceRevision: stream.revision,
    warnings
  };
}

function rebuildProjection(projectionPath: string, events: readonly TaskEventV1[]): void {
  withDatabase(projectionPath, (db) => transaction(db, () => {
    db.exec("DROP TABLE IF EXISTS task; DROP TABLE IF EXISTS execution; DROP TABLE IF EXISTS review; DROP TABLE IF EXISTS edge");
    createDerivedTables(db);
    for (const event of events) applyEvent(db, event);
  }));
}

function withDatabase<A>(projectionPath: string, use: (db: DatabaseSync) => A): A {
  localRuntimeStateFileSystem.mkdirp(path.dirname(projectionPath));
  const db = new DatabaseSync(projectionPath);
  try {
    db.exec("PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON");
    createDerivedTables(db);
    return use(db);
  } finally {
    db.close();
  }
}

function createDerivedTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task (
      task_id TEXT NOT NULL,
      op_id TEXT NOT NULL UNIQUE,
      workspace_revision INTEGER NOT NULL UNIQUE,
      event_json TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      PRIMARY KEY (task_id, workspace_revision)
    );
    CREATE TABLE IF NOT EXISTS execution (
      execution_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      workspace_revision INTEGER NOT NULL,
      value_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review (
      review_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      workspace_revision INTEGER NOT NULL,
      value_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS edge (
      task_id TEXT NOT NULL,
      edge_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      workspace_revision INTEGER NOT NULL,
      value_json TEXT NOT NULL,
      PRIMARY KEY (task_id, edge_id, iteration)
    )
  `);
}

function transaction(db: DatabaseSync, run: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function applyEvent(db: DatabaseSync, event: TaskEventV1): void {
  const previous = readSnapshot(db, event.taskId);
  const snapshot = reduceTaskEvent(previous, event);
  db.prepare("INSERT INTO task (task_id, op_id, workspace_revision, event_json, snapshot_json) VALUES (?, ?, ?, ?, ?)").run(
    event.taskId,
    event.opId,
    event.workspaceRevision,
    serializeTaskEvent(event).trimEnd(),
    canonicalJson(snapshot)
  );
  if (event.type !== "task_created") {
    db.prepare("INSERT OR REPLACE INTO execution (execution_id, task_id, workspace_revision, value_json) VALUES (?, ?, ?, ?)").run(
      event.payload.execution.executionId,
      event.taskId,
      event.workspaceRevision,
      canonicalJson(event.payload.execution)
    );
  }
  if (event.type === "review_recorded") {
    db.prepare("INSERT INTO review (review_id, task_id, execution_id, workspace_revision, value_json) VALUES (?, ?, ?, ?, ?)").run(
      event.payload.review.reviewId,
      event.taskId,
      event.payload.review.executionId,
      event.workspaceRevision,
      canonicalJson(event.payload.review)
    );
  }
  const edge = event.type === "execution_submitted" ? event.payload.edge
    : event.type === "review_recorded" ? event.payload.edge : undefined;
  if (edge !== undefined) {
    db.prepare("INSERT INTO edge (task_id, edge_id, iteration, workspace_revision, value_json) VALUES (?, ?, ?, ?, ?)").run(
      event.taskId,
      edge.edgeId,
      edge.iteration,
      event.workspaceRevision,
      canonicalJson(edge)
    );
  }
}

function projectionWatermark(db: DatabaseSync): number {
  const row = db.prepare("SELECT COALESCE(MAX(workspace_revision), 0) AS revision FROM task").get() as { readonly revision: number };
  return Number(row.revision);
}

function readSnapshot(db: DatabaseSync, taskId: string): TaskLifecycleSnapshot {
  const row = db.prepare("SELECT snapshot_json FROM task WHERE task_id = ? ORDER BY workspace_revision DESC LIMIT 1").get(taskId) as { readonly snapshot_json: string } | undefined;
  if (row === undefined) return emptyTaskLifecycleSnapshot();
  const snapshot = JSON.parse(row.snapshot_json) as TaskLifecycleSnapshot;
  return { ...snapshot, lease: null };
}

function projectionMatches(db: DatabaseSync, events: readonly TaskEventV1[]): boolean {
  const rows = db.prepare("SELECT workspace_revision, event_json FROM task ORDER BY workspace_revision").all() as unknown as readonly { readonly workspace_revision: number; readonly event_json: string }[];
  if (rows.length !== events.length || rows.some((row, index) => row.workspace_revision !== index + 1 || row.event_json !== serializeTaskEvent(events[index]!).trimEnd())) return false;
  const latest = db.prepare("SELECT task_id, snapshot_json FROM task WHERE workspace_revision IN (SELECT MAX(workspace_revision) FROM task GROUP BY task_id) ORDER BY task_id").all() as unknown as readonly { readonly task_id: string; readonly snapshot_json: string }[];
  const expectedExecutions = latest.flatMap((row) => (JSON.parse(row.snapshot_json) as TaskLifecycleSnapshot).executions).sort(byId("executionId"));
  const expectedReviews = latest.flatMap((row) => (JSON.parse(row.snapshot_json) as TaskLifecycleSnapshot).reviews).sort(byId("reviewId"));
  const expectedEdges = latest.flatMap((row) => (JSON.parse(row.snapshot_json) as TaskLifecycleSnapshot).edgesTaken).sort((left, right) => `${left.edgeId}:${left.iteration}`.localeCompare(`${right.edgeId}:${right.iteration}`));
  return canonicalJson(readValues(db, "execution", "execution_id")) === canonicalJson(expectedExecutions)
    && canonicalJson(readValues(db, "review", "review_id")) === canonicalJson(expectedReviews)
    && canonicalJson(readValues(db, "edge", "edge_id, iteration")) === canonicalJson(expectedEdges);
}

function readValues(db: DatabaseSync, table: "execution" | "review" | "edge", order: string): readonly unknown[] {
  return (db.prepare(`SELECT value_json FROM ${table} ORDER BY ${order}`).all() as unknown as readonly { readonly value_json: string }[]).map((row) => JSON.parse(row.value_json));
}

function byId<Key extends string>(key: Key): (left: Record<Key, string>, right: Record<Key, string>) => number {
  return (left, right) => left[key].localeCompare(right[key]);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeContractValue(value));
}

function consumeKnownError(error: unknown): void { void error; }
