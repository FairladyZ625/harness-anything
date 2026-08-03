import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import type { EntityId, TaskId } from "../../domain/index.ts";
import { taskIdFromEntityId } from "../../domain/index.ts";
import { sha256Text } from "../../integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../../layout/index.ts";
import { resolveHarnessLayout } from "../../layout/index.ts";
import { appendJsonLineDurably, fsyncDirectory, readJournal } from "./durable.ts";
import type { LockRecord, LockTakeoverRecord, OperationalActor, OwnedLock } from "./types.ts";

export interface DaemonGlobalLock extends OwnedLock {
  readonly refreshHeartbeat: () => void;
  readonly release: () => void;
}

export interface RepoLockOptions {
  readonly heldGlobalLock?: OwnedLock;
}

export interface DaemonLockProvenance {
  readonly repoId?: string;
  readonly canonicalRoot?: string;
  readonly userRoot?: string;
  readonly endpoint?: string;
}

const lockRecordPublishReadBudgetMs = 20;
const lockRecordPublishReadDelayMs = 2;
const lockRecordPublishFreshnessMs = 100;

export class WriteLockHeldError extends Error {
  readonly _tag = "WriteLockHeldError";
  readonly owner: string;
  readonly entityId?: EntityId;
  readonly taskId?: TaskId;
  readonly reason: "held" | "lock-record-publishing" | "lock-record-invalid" | "changed-during-takeover" | "takeover-in-progress";

  constructor(input: {
    readonly owner: string;
    readonly entityId?: EntityId;
    readonly reason?: WriteLockHeldError["reason"];
  }) {
    const reason = input.reason ?? "held";
    const message = reason === "held"
      ? `lock already held: ${input.owner}`
      : reason === "lock-record-publishing"
        ? `lock record is still publishing: ${input.owner}`
        : reason === "lock-record-invalid"
          ? `lock record is invalid: ${input.owner}`
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
  actor: OperationalActor,
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
  actor: OperationalActor,
  lockTtlMs: number,
  provenance: DaemonLockProvenance = {}
): DaemonGlobalLock {
  const lockRoot = path.relative(rootDir, resolveHarnessLayout(layoutInput).locksRoot).split(path.sep).join("/");
  const lock = acquireLock(rootDir, journalPath, actor, `${lockRoot}/global.lock`, lockTtlMs, undefined, "daemon", {
    ...provenance,
    canonicalRoot: provenance.canonicalRoot ?? path.resolve(rootDir)
  });
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

/** Verifies that the daemon still owns the exact global-lock generation it exposes. */
export function assertDaemonGlobalLockHeld(lock: DaemonGlobalLock): void {
  assertHeldLock(lock);
}

function acquireLock(
  rootDir: string,
  journalPath: string,
  actor: OperationalActor,
  relativeLockPath: string,
  lockTtlMs: number,
  entityId?: EntityId,
  ownerKind?: LockRecord["ownerKind"],
  provenance: DaemonLockProvenance = {}
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

      acquireTakeoverClaim(claimPath, ownerToken, entityId, provenance);
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
        ...(ownerKind ? { ownerKind } : {}),
        ...definedLockProvenance(provenance)
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

function acquireTakeoverClaim(
  claimPath: string,
  ownerToken: string,
  entityId?: EntityId,
  provenance: DaemonLockProvenance = {}
): void {
  let fd: number;
  try {
    fd = openSync(claimPath, "wx");
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      const existing = readClaimRecord(claimPath);
      throw lockHeld(
        existing ? lockOwnerMessage(path.basename(claimPath, ".takeover"), existing) : path.basename(claimPath, ".takeover"),
        entityId,
        "takeover-in-progress"
      );
    }
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      ownerToken,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      ...definedLockProvenance(provenance)
    } satisfies LockRecord));
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
    throw lockHeld(lockOwnerMessage(path.basename(claimPath, ".takeover"), record), entityId, "takeover-in-progress");
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
  const deadline = Date.now() + lockRecordPublishReadBudgetMs;
  do {
    const record = readValidLockRecord(lockPath);
    if (record) return record;
    if (Date.now() >= deadline) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, lockRecordPublishReadDelayMs);
  } while (existsSync(lockPath));

  // open("wx") publishes the directory entry before the owner can write and
  // fsync the JSON body. A fresh incomplete record is a publication window,
  // never evidence of a takeover claim. Persistently malformed records fail
  // closed under their own classification instead of retrying forever.
  const reason = lockRecordIsFresh(lockPath)
    ? "lock-record-publishing"
    : "lock-record-invalid";
  throw lockHeld(relativeLockPath, entityId, reason);
}

function readValidLockRecord(lockPath: string): LockRecord | null {
  try {
    const record = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockRecord>;
    if (
      typeof record.pid !== "number"
      || typeof record.hostname !== "string"
      || typeof record.acquiredAt !== "string"
      || typeof record.heartbeatAt !== "string"
      || typeof record.ownerToken !== "string"
      || !validOptionalLockString(record.repoId)
      || !validOptionalLockString(record.canonicalRoot)
      || !validOptionalLockString(record.userRoot)
      || !validOptionalLockString(record.endpoint)
    ) return null;
    return record as LockRecord;
  } catch {
    return null;
  }
}

function lockRecordIsFresh(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs <= lockRecordPublishFreshnessMs;
  } catch {
    return true;
  }
}

function validOptionalLockString(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

function definedLockProvenance(provenance: DaemonLockProvenance): Partial<LockRecord> {
  return {
    ...(provenance.repoId ? { repoId: provenance.repoId } : {}),
    ...(provenance.canonicalRoot ? { canonicalRoot: path.resolve(provenance.canonicalRoot) } : {}),
    ...(provenance.userRoot ? { userRoot: path.resolve(provenance.userRoot) } : {}),
    ...(provenance.endpoint ? { endpoint: provenance.endpoint } : {})
  };
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
  const repo = record.repoId
    ? `repo ${record.repoId}${record.canonicalRoot ? ` at ${record.canonicalRoot}` : ""}`
    : record.canonicalRoot ? `repo at ${record.canonicalRoot}` : undefined;
  const topology = [record.userRoot ? `userRoot ${record.userRoot}` : undefined, record.endpoint ? `endpoint ${record.endpoint}` : undefined]
    .filter((part): part is string => part !== undefined)
    .join("; ");
  return `${relativeLockPath} (${repo ? `${repo}; ` : ""}held by daemon ${holder}${topology ? `; ${topology}` : ""}; write through daemon via the daemon-backed ha client/API instead of direct WriteCoordinator writes; one canonicalRoot may belong to only one live daemon and daemon manifest repo sets must not overlap: docs-release/operations-server-daemon.md#daemon-repository-ownership-invariants)`;
}
