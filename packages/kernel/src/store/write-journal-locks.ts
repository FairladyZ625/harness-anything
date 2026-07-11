import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import type { EntityId, TaskId } from "../domain/index.ts";
import { taskIdFromEntityId } from "../domain/index.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { appendJsonLineDurably, fsyncDirectory, readJournal } from "./write-journal-durable.ts";
import type { JournalActor, LockRecord, LockTakeoverRecord, OwnedLock } from "./write-journal-types.ts";

export interface DaemonGlobalLock extends OwnedLock {
  readonly refreshHeartbeat: () => void;
  readonly release: () => void;
}

export interface RepoLockOptions {
  readonly heldGlobalLock?: OwnedLock;
}

export class WriteLockHeldError extends Error {
  readonly _tag = "WriteLockHeldError";
  readonly owner: string;
  readonly entityId?: EntityId;
  readonly taskId?: TaskId;
  readonly reason: "held" | "changed-during-takeover" | "takeover-in-progress";

  constructor(input: {
    readonly owner: string;
    readonly entityId?: EntityId;
    readonly reason?: WriteLockHeldError["reason"];
  }) {
    const reason = input.reason ?? "held";
    const message = reason === "held"
      ? `lock already held: ${input.owner}`
      : `lock already held: ${input.owner} ${reason.replaceAll("-", " ")}`;
    super(message);
    this.name = "WriteLockHeldError";
    this.owner = input.owner;
    this.entityId = input.entityId;
    this.taskId = input.entityId ? taskIdFromEntityId(input.entityId) ?? undefined : undefined;
    this.reason = reason;
  }
}

export function withRepoLocks<T>(
  rootDir: string,
  layoutInput: HarnessLayoutInput,
  journalPath: string,
  actor: JournalActor,
  lockTtlMs: number,
  entityIds: ReadonlyArray<EntityId>,
  fn: () => T,
  options: RepoLockOptions = {}
): T {
  const locks: OwnedLock[] = [];

  try {
    const lockRoot = path.relative(rootDir, resolveHarnessLayout(layoutInput).locksRoot).split(path.sep).join("/");
    if (options.heldGlobalLock) {
      assertHeldLock(options.heldGlobalLock);
    } else {
      locks.push(acquireLock(rootDir, journalPath, actor, `${lockRoot}/global.lock`, lockTtlMs));
    }
    const state = readJournal(journalPath, rootDir);
    const lockedEntityIds = new Set([...entityIds, ...state.map((record) => record.entityId)]);
    for (const entityId of [...lockedEntityIds].sort()) {
      locks.push(acquireLock(rootDir, journalPath, actor, `${lockRoot}/entity-${sha256Text(entityId)}.lock`, lockTtlMs, entityId));
    }
    return fn();
  } finally {
    for (const lock of locks.reverse()) releaseLock(lock);
  }
}

export function acquireDaemonGlobalLock(
  rootDir: string,
  layoutInput: HarnessLayoutInput,
  journalPath: string,
  actor: JournalActor,
  lockTtlMs: number
): DaemonGlobalLock {
  const lockRoot = path.relative(rootDir, resolveHarnessLayout(layoutInput).locksRoot).split(path.sep).join("/");
  const lock = acquireLock(rootDir, journalPath, actor, `${lockRoot}/global.lock`, lockTtlMs, undefined, "daemon");
  const refreshHeartbeat = () => refreshLockHeartbeat(lock);
  const interval = setInterval(refreshHeartbeat, Math.max(1_000, Math.floor(lockTtlMs / 3)));
  interval.unref();
  return {
    ...lock,
    refreshHeartbeat,
    release: () => {
      clearInterval(interval);
      releaseLock(lock);
    }
  };
}

export function assertDirectWriteAllowed(rootDir: string, layoutInput: HarnessLayoutInput, lockTtlMs: number): void {
  const lockRoot = path.relative(rootDir, resolveHarnessLayout(layoutInput).locksRoot).split(path.sep).join("/");
  const relativeLockPath = `${lockRoot}/global.lock`;
  const lockPath = path.join(rootDir, relativeLockPath);
  if (!existsSync(lockPath)) return;
  let existing: LockRecord;
  try {
    existing = JSON.parse(readFileSync(lockPath, "utf8")) as LockRecord;
  } catch {
    // The owner may have created the lock directory entry but not finished its
    // durable JSON write. Enqueue remains WAL-only; flush will classify and wait
    // on this same lock before any authored effect is applied.
    return;
  }
  if (existing.ownerKind === "daemon" && !isStaleLock(existing, lockTtlMs)) {
    throw lockHeld(lockOwnerMessage(relativeLockPath, existing));
  }
}

function acquireLock(
  rootDir: string,
  journalPath: string,
  actor: JournalActor,
  relativeLockPath: string,
  lockTtlMs: number,
  entityId?: EntityId,
  ownerKind?: LockRecord["ownerKind"]
): OwnedLock {
  const lockPath = path.join(rootDir, relativeLockPath);
  const claimPath = `${lockPath}.takeover`;
  const ownerToken = randomUUID();
  let staleTakeover: LockTakeoverRecord | null = null;
  let staleQuarantinePath: string | null = null;
  let ownsTakeoverClaim = false;
  mkdirSync(path.dirname(lockPath), { recursive: true });

  try {
    clearStaleTakeoverClaim(claimPath, lockTtlMs, entityId);
    recoverQuarantinedStaleLock(lockPath);

    if (existsSync(lockPath)) {
      const existing = readLockRecordOrConflict(lockPath, relativeLockPath, entityId);
      if (!isStaleLock(existing, lockTtlMs)) {
        throw lockHeld(lockOwnerMessage(relativeLockPath, existing), entityId);
      }

      acquireTakeoverClaim(claimPath, ownerToken, entityId);
      ownsTakeoverClaim = true;
      const current = readLockRecordOrConflict(lockPath, relativeLockPath, entityId);
      if (current.ownerToken !== existing.ownerToken) {
        throw lockHeld(lockOwnerMessage(relativeLockPath, current), entityId, "changed-during-takeover");
      }

      staleTakeover = {
        schema: "lock-takeover/v1",
        actor,
        at: new Date().toISOString(),
        lockPath: relativeLockPath,
        oldPid: existing.pid,
        reason: "stale-lock"
      };
      staleQuarantinePath = `${lockPath}.stale.${existing.ownerToken}.${ownerToken}`;
      renameSync(lockPath, staleQuarantinePath);
    } else if (existsSync(claimPath)) {
      throw lockHeld(relativeLockPath, entityId, "takeover-in-progress");
    }

    let fd: number;
    try {
      fd = openSync(lockPath, "wx");
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        throw lockHeld(relativeLockPath, entityId);
      }
      throw error;
    }
    try {
      writeSync(fd, JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        ownerToken,
        ...(ownerKind ? { ownerKind } : {})
      } satisfies LockRecord));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    if (!ownsTakeoverClaim && existsSync(claimPath)) {
      releaseLock({ path: lockPath, ownerToken });
      throw lockHeld(relativeLockPath, entityId, "takeover-in-progress");
    }

    if (staleTakeover) appendJsonLineDurably(journalPath, staleTakeover);
    if (staleQuarantinePath) rmSync(staleQuarantinePath, { force: true });
    if (ownsTakeoverClaim) rmSync(claimPath, { force: true });

    return { path: lockPath, ownerToken, ...(ownerKind ? { ownerKind } : {}) };
  } catch (error) {
    if (ownsTakeoverClaim) rmSync(claimPath, { force: true });
    if (staleQuarantinePath && existsSync(staleQuarantinePath) && !existsSync(lockPath)) {
      renameSync(staleQuarantinePath, lockPath);
    }
    throw error;
  }
}

function releaseLock(lock: OwnedLock): void {
  if (!existsSync(lock.path)) return;
  const current = JSON.parse(readFileSync(lock.path, "utf8")) as Partial<LockRecord>;
  if (current.ownerToken === lock.ownerToken) unlinkSync(lock.path);
}

function assertHeldLock(lock: OwnedLock): void {
  if (!existsSync(lock.path)) {
    throw lockHeld(path.basename(lock.path));
  }
  const current = JSON.parse(readFileSync(lock.path, "utf8")) as Partial<LockRecord>;
  if (current.ownerToken !== lock.ownerToken) {
    throw lockHeld(path.basename(lock.path));
  }
}

function refreshLockHeartbeat(lock: OwnedLock): void {
  if (!existsSync(lock.path)) return;
  const current = JSON.parse(readFileSync(lock.path, "utf8")) as LockRecord;
  if (current.ownerToken !== lock.ownerToken) return;
  const next = {
    ...current,
    heartbeatAt: new Date().toISOString()
  } satisfies LockRecord;
  const fd = openSync(lock.path, "w");
  try {
    writeSync(fd, JSON.stringify(next));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(path.dirname(lock.path));
}

function acquireTakeoverClaim(claimPath: string, ownerToken: string, entityId?: EntityId): void {
  let fd: number;
  try {
    fd = openSync(claimPath, "wx");
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw lockHeld(path.basename(claimPath, ".takeover"), entityId, "takeover-in-progress");
    }
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      ownerToken,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString()
    }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(path.dirname(claimPath));
}

function isStaleLock(record: LockRecord, lockTtlMs: number): boolean {
  if (record.hostname === hostname() && !pidAlive(record.pid)) return true;
  if (record.hostname === hostname() && pidAlive(record.pid)) return false;
  const age = Date.now() - Date.parse(record.heartbeatAt);
  return Number.isFinite(age) && age > lockTtlMs;
}

function clearStaleTakeoverClaim(claimPath: string, lockTtlMs: number, entityId?: EntityId): void {
  if (!existsSync(claimPath)) return;
  const record = readClaimRecord(claimPath);
  if (!record) {
    throw lockHeld(path.basename(claimPath, ".takeover"), entityId, "takeover-in-progress");
  }
  if (!isStaleLock(record, lockTtlMs)) {
    throw lockHeld(path.basename(claimPath, ".takeover"), entityId, "takeover-in-progress");
  }
  rmSync(claimPath, { force: true });
}

function readClaimRecord(claimPath: string): LockRecord | null {
  try {
    return JSON.parse(readFileSync(claimPath, "utf8")) as LockRecord;
  } catch {
    return null;
  }
}

function recoverQuarantinedStaleLock(lockPath: string): void {
  if (existsSync(lockPath)) return;
  const lockDir = path.dirname(lockPath);
  const quarantinePrefix = `${path.basename(lockPath)}.stale.`;
  const quarantine = readdirSync(lockDir)
    .filter((entry) => entry.startsWith(quarantinePrefix))
    .sort()[0];
  if (!quarantine) return;
  renameSync(path.join(lockDir, quarantine), lockPath);
  fsyncDirectory(lockDir);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function readLockRecordOrConflict(lockPath: string, relativeLockPath: string, entityId?: EntityId): LockRecord {
  try {
    const record = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockRecord>;
    if (
      typeof record.pid !== "number"
      || typeof record.hostname !== "string"
      || typeof record.acquiredAt !== "string"
      || typeof record.heartbeatAt !== "string"
      || typeof record.ownerToken !== "string"
    ) {
      throw new Error("incomplete lock record");
    }
    return record as LockRecord;
  } catch {
    // open("wx") publishes the directory entry before the owner can write and
    // fsync the JSON body. Treat that short visibility window as contention so
    // bounded lock retry absorbs it instead of leaking JournalUnavailable.
    throw lockHeld(relativeLockPath, entityId, "takeover-in-progress");
  }
}

function lockHeld(
  owner: string,
  entityId?: EntityId,
  reason?: WriteLockHeldError["reason"]
): WriteLockHeldError {
  return new WriteLockHeldError({ owner, entityId, reason });
}

function lockOwnerMessage(relativeLockPath: string, record: LockRecord): string {
  const holder = `pid ${record.pid} on ${record.hostname}`;
  if (record.ownerKind !== "daemon") return `${relativeLockPath} (held by ${holder})`;
  return `${relativeLockPath} (held by daemon ${holder}; write through daemon via the daemon-backed ha client/API instead of direct WriteCoordinator writes)`;
}
