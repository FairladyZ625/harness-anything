// @slice-activation P4 W2 owns the sole replay/v1 runtime Lease CAS table used by application transactions.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateLeaseV1, type LeaseV1 } from "../domain/execution.ts";
import { canonicalizeContractValue, type ActorAxes } from "../domain/task.ts";
import { defaultLifecycleTaskProjectionPath } from "../projection/task-projection.ts";
import { localRuntimeStateFileSystem } from "./local-layout-file-system.ts";

export class TaskLeaseConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskLeaseConflictError";
  }
}

export interface TaskLeaseStore {
  readonly current: (taskId: string) => LeaseV1 | null;
  readonly reserve: (input: {
    readonly taskId: string;
    readonly executionId: string;
    readonly actor: ActorAxes;
    readonly credentialHash: string;
    readonly expiresAt: string;
  }) => LeaseV1;
  readonly activate: (input: LeaseCasInput) => LeaseV1;
  readonly renew: (input: LeaseCasInput & { readonly expiresAt: string }) => LeaseV1;
  readonly release: (input: LeaseCasInput) => LeaseV1;
}

interface LeaseCasInput {
  readonly taskId: string;
  readonly executionId: string;
  readonly credentialHash: string;
  readonly version: number;
}

interface LeaseRow {
  readonly task_id: string;
  readonly execution_id: string;
  readonly actor_json: string;
  readonly credential_hash: string;
  readonly phase: LeaseV1["phase"];
  readonly expires_at: string;
  readonly version: number;
}

export function makeTaskLeaseStore(options: {
  readonly rootDir: string;
  readonly projectionPath?: string;
  readonly now?: () => string;
}): TaskLeaseStore {
  const databasePath = options.projectionPath ?? defaultLifecycleTaskProjectionPath(options.rootDir);
  const now = options.now ?? (() => new Date().toISOString());
  return {
    current: (taskId) => withLeaseDatabase(databasePath, (db) => effectiveLease(readRow(db, taskId), now())),
    reserve: (input) => withLeaseDatabase(databasePath, (db) => transaction(db, () => {
      const existing = readRow(db, input.taskId);
      if (effectiveLease(existing, now()) !== null) throw new TaskLeaseConflictError(`task ${input.taskId} already has an effective lease`);
      const lease = checkedLease({
        schema: "lease/v1",
        ...input,
        phase: "reserving",
        version: existing === null ? 0 : existing.version + 1
      });
      db.prepare(`
        INSERT OR REPLACE INTO lease_cas
          (task_id, execution_id, actor_json, credential_hash, phase, expires_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        lease.taskId,
        lease.executionId,
        canonicalJson(lease.actor),
        lease.credentialHash,
        lease.phase,
        lease.expiresAt,
        lease.version
      );
      return lease;
    })),
    activate: (input) => updateLease(databasePath, input, ["reserving"], "active"),
    renew: (input) => updateLease(databasePath, input, ["active"], "active", input.expiresAt),
    release: (input) => updateLease(databasePath, input, ["reserving", "active"], "released")
  };
}

function updateLease(
  databasePath: string,
  input: LeaseCasInput,
  from: readonly LeaseV1["phase"][],
  phase: LeaseV1["phase"],
  expiresAt?: string
): LeaseV1 {
  return withLeaseDatabase(databasePath, (db) => transaction(db, () => {
    const row = readRow(db, input.taskId);
    if (row === null || row.execution_id !== input.executionId || row.credential_hash !== input.credentialHash
      || row.version !== input.version || !from.includes(row.phase)) {
      throw new TaskLeaseConflictError(`lease CAS rejected stale holder for task ${input.taskId}`);
    }
    const next = checkedLease({
      schema: "lease/v1",
      taskId: row.task_id,
      executionId: row.execution_id,
      actor: JSON.parse(row.actor_json) as ActorAxes,
      credentialHash: row.credential_hash,
      phase,
      expiresAt: expiresAt ?? row.expires_at,
      version: row.version + 1
    });
    const result = db.prepare(`
      UPDATE lease_cas SET phase = ?, expires_at = ?, version = ?
      WHERE task_id = ? AND execution_id = ? AND credential_hash = ? AND version = ? AND phase = ?
    `).run(phase, next.expiresAt, next.version, input.taskId, input.executionId, input.credentialHash, input.version, row.phase);
    if (result.changes !== 1) throw new TaskLeaseConflictError(`lease CAS lost a concurrent update for task ${input.taskId}`);
    return next;
  }));
}

function withLeaseDatabase<A>(databasePath: string, use: (db: DatabaseSync) => A): A {
  localRuntimeStateFileSystem.mkdirp(path.dirname(databasePath));
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE IF NOT EXISTS lease_cas (
        task_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        credential_hash TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('reserving', 'active', 'released')),
        expires_at TEXT NOT NULL,
        version INTEGER NOT NULL
      )
    `);
    return use(db);
  } finally {
    db.close();
  }
}

function transaction<A>(db: DatabaseSync, run: () => A): A {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function readRow(db: DatabaseSync, taskId: string): LeaseRow | null {
  return db.prepare("SELECT * FROM lease_cas WHERE task_id = ?").get(taskId) as LeaseRow | undefined ?? null;
}

function effectiveLease(row: LeaseRow | null, now: string): LeaseV1 | null {
  if (row === null || row.phase === "released" || row.expires_at <= now) return null;
  return checkedLease({
    schema: "lease/v1",
    taskId: row.task_id,
    executionId: row.execution_id,
    actor: JSON.parse(row.actor_json) as ActorAxes,
    credentialHash: row.credential_hash,
    phase: row.phase,
    expiresAt: row.expires_at,
    version: row.version
  });
}

function checkedLease(lease: LeaseV1): LeaseV1 {
  const issues = validateLeaseV1(lease);
  if (issues.length > 0) throw new TaskLeaseConflictError(issues.map((issue) => issue.message).join("; "));
  return lease;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeContractValue(value));
}
