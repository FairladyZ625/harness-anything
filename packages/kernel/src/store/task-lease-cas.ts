import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TASK_LEASE_BROKER_CONTRACT, validateLeaseV1, type LeaseV1 } from "../domain/execution.ts";
import { canonicalizeContractValue, isRecord, validateActorAxes, type ActorAxes } from "../domain/task.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";
import type { WriteOp } from "../ports/write-coordinator.ts";
import { defaultLifecycleTaskProjectionPath } from "../projection/task-projection.ts";
export interface LeaseCasPayload {
  readonly operation: "reserve" | "activate" | "renew" | "release";
  readonly taskId: string; readonly executionId: string; readonly actor: ActorAxes;
  readonly now: string; readonly expiresAt?: string;
  readonly version?: number; readonly capacity: number;
}
interface LeaseRow {
  readonly task_id: string; readonly execution_id: string; readonly actor_json: string;
  readonly phase: LeaseV1["phase"]; readonly expires_at: string; readonly version: number;
}
export class TaskLeaseCasRejected extends Error {
  readonly origin = "task-lease-broker"; readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "TaskLeaseCasRejected"; this.code = code; }
}
export function isLeaseCasWriteOp(op: Pick<WriteOp, "kind">): boolean { return op.kind === "lease_cas"; }
export function taskLeaseDatabasePath(root: HarnessLayoutInput): string {
  return defaultLifecycleTaskProjectionPath(typeof root === "string" ? root : root.rootDir);
}
export function validateLeaseCasWrite(op: WriteOp): LeaseCasPayload {
  if (op.kind !== "lease_cas" || !isRecord(op.payload)) throw reject("invalid_lease_cas", "lease_cas requires an object payload");
  const p = op.payload as unknown as LeaseCasPayload;
  if (!(["reserve", "activate", "renew", "release"] as const).includes(p.operation) || !text(p.taskId) || !text(p.executionId)
    || validateActorAxes(p.actor).length > 0 || !text(p.now) || p.capacity !== TASK_LEASE_BROKER_CONTRACT.capacity) {
    throw reject("invalid_lease_cas", "lease_cas identity, operation, timestamp, or capacity is invalid");
  }
  if (p.operation === "reserve" && (p.actor === undefined || !text(p.expiresAt))) throw reject("invalid_lease_cas", "reserve requires actor and expiry");
  if (p.operation !== "reserve" && !Number.isInteger(p.version)) throw reject("invalid_lease_cas", `${p.operation} requires the expected version`);
  if (p.operation === "renew" && !text(p.expiresAt)) throw reject("invalid_lease_cas", "renew requires expiry");
  return p;
}
export function applyLeaseCasWrite(root: HarnessLayoutInput, op: WriteOp): void {
  const payload = validateLeaseCasWrite(op), databasePath = taskLeaseDatabasePath(root);
  localRuntimeStateFileSystem.mkdirp(path.dirname(databasePath));
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA journal_mode = DELETE; CREATE TABLE IF NOT EXISTS lease_cas (task_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, actor_json TEXT NOT NULL, phase TEXT NOT NULL CHECK (phase IN ('reserving', 'active', 'released')), expires_at TEXT NOT NULL, version INTEGER NOT NULL)");
    transaction(db, () => mutate(db, payload));
  } finally { db.close(); }
}
export function readStoredTaskLease(root: HarnessLayoutInput, taskId: string): LeaseV1 | null {
  const databasePath = taskLeaseDatabasePath(root);
  if (!localRuntimeStateFileSystem.exists(databasePath)) return null;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try { return fromRow(row(db, taskId)); }
  catch (error) {
    if (!(error instanceof Error) || !/no such table: lease_cas/u.test(error.message)) throw error;
    consumeKnownError(error); return null;
  } finally { db.close(); }
}
export function readEffectiveTaskLease(root: HarnessLayoutInput, taskId: string, now: string): LeaseV1 | null {
  const lease = readStoredTaskLease(root, taskId);
  return lease === null || lease.phase === "released" || lease.expiresAt <= now ? null : lease;
}
function mutate(db: DatabaseSync, p: LeaseCasPayload): void {
  const current = row(db, p.taskId), actorJson = JSON.stringify(canonicalizeContractValue(p.actor));
  if (p.operation === "reserve") {
    const effective = current !== null && current.phase !== "released" && current.expires_at > p.now;
    if (effective && current.execution_id === p.executionId && current.actor_json === actorJson) return;
    if (effective) throw reject("lease_conflict", `task ${p.taskId} already has an effective lease`);
    const count = db.prepare("SELECT COUNT(*) AS count FROM lease_cas WHERE phase != 'released' AND expires_at > ?").get(p.now) as { readonly count: number };
    if (count.count >= p.capacity) throw reject("lease_capacity_exhausted", `Lease broker capacity ${p.capacity} is exhausted. Wait for an existing lease to be released or expire, then retry task start.`);
    const lease = checked({ schema: "lease/v1", taskId: p.taskId, executionId: p.executionId, actor: p.actor,
      phase: "reserving", expiresAt: p.expiresAt!, version: current === null ? 0 : current.version + 1 });
    db.prepare("INSERT INTO lease_cas (task_id, execution_id, actor_json, phase, expires_at, version) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET execution_id=excluded.execution_id, actor_json=excluded.actor_json, phase=excluded.phase, expires_at=excluded.expires_at, version=excluded.version")
      .run(lease.taskId, lease.executionId, actorJson, lease.phase, lease.expiresAt, lease.version);
    return;
  }
  if (current === null || current.execution_id !== p.executionId || current.actor_json !== actorJson) throw stale(p);
  const phase = p.operation === "release" ? "released" : "active", expiry = p.expiresAt ?? current.expires_at;
  if (current.version === p.version! + 1 && current.phase === phase && current.expires_at === expiry) return;
  const from = p.operation === "activate" ? ["reserving"] : p.operation === "renew" ? ["active"] : ["reserving", "active"];
  if (current.version !== p.version || !from.includes(current.phase)) throw stale(p);
  const result = db.prepare("UPDATE lease_cas SET phase = ?, expires_at = ?, version = ? WHERE task_id = ? AND execution_id = ? AND actor_json = ? AND version = ? AND phase = ?")
    .run(phase, expiry, current.version + 1, p.taskId, p.executionId, actorJson, p.version!, current.phase);
  if (result.changes !== 1) throw stale(p);
}
function transaction(db: DatabaseSync, run: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try { run(); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
}
function row(db: DatabaseSync, taskId: string): LeaseRow | null { return db.prepare("SELECT * FROM lease_cas WHERE task_id = ?").get(taskId) as LeaseRow | undefined ?? null; }
function fromRow(value: LeaseRow | null): LeaseV1 | null {
  return value === null ? null : checked({ schema: "lease/v1", taskId: value.task_id, executionId: value.execution_id,
    actor: JSON.parse(value.actor_json) as ActorAxes, phase: value.phase, expiresAt: value.expires_at, version: value.version });
}
function checked(lease: LeaseV1): LeaseV1 {
  const issues = validateLeaseV1(lease);
  if (issues.length > 0) throw reject("invalid_lease", issues.map((issue) => issue.message).join("; "));
  return lease;
}
function stale(p: LeaseCasPayload): TaskLeaseCasRejected { return reject("lease_conflict", `lease CAS rejected stale holder for task ${p.taskId}`); }
function reject(code: string, message: string): TaskLeaseCasRejected { return new TaskLeaseCasRejected(code, message); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function consumeKnownError(error: unknown): void { void error; }
