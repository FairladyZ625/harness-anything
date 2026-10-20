import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  consumeKnownError,
  openSqliteEventStore,
  resolveActiveGeneration,
  sqliteLedgerPath,
} from "@harness-anything/kernel";

export interface WriterEpochLease {
  readonly repoId: string;
  readonly holderId: string;
  readonly epoch: number;
  readonly version: number;
  readonly issuedAt: string;
}
export interface WriterEpochFenceDescriptor {
  readonly schema: "harness-writer-epoch-fence/v1";
  readonly stateRoot: string;
  readonly repoId: string;
  readonly epoch: number;
  readonly holderId: string;
}
export interface PersistentWriterEpoch {
  readonly acquire: (repoId: string, observedLedgerEpoch?: number) => WriterEpochLease;
  readonly current: (repoId: string) => WriterEpochLease | null;
  readonly highWatermark: (repoId: string) => number;
  readonly retireCurrent: (repoId: string) => void;
  readonly assert: (repoId: string, epoch: number, holderId?: string) => void;
  readonly withAppendFence: <T>(repoId: string, epoch: number, holderId: string, operation: () => T) => T;
  readonly close: () => void;
}
export class WriterEpochError extends Error {
  readonly code: "writer_epoch_stale" | "writer_epoch_invalid";
  constructor(code: WriterEpochError["code"], message: string) {
    super(message);
    this.name = "WriterEpochError";
    this.code = code;
  }
}

type EpochRow = {
  readonly repo_id: string;
  readonly holder_id: string;
  readonly epoch: number;
  readonly version: number;
  readonly issued_at: string;
};

/** One repository's epoch authority over its own database file. The append fence must exclude
 *  only takeover of its repository, and SQLite locks are database-granular, so the fencing scope
 *  is one repo: `stateRoot/writer-epochs/<repoId>.sqlite`. A shared database serialized every
 *  repository's append behind one write lock; under load a queued fence could exhaust
 *  busy_timeout and reject its write ("database is locked"). */
function openRepoEpochAuthority(options: {
  readonly databasePath: string;
  readonly holderId: string;
  readonly now: () => string;
}) {
  mkdirSync(path.dirname(options.databasePath), { recursive: true });
  const database = new DatabaseSync(options.databasePath);
  database.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS writer_epoch_history (
      repo_id TEXT NOT NULL,
      epoch INTEGER NOT NULL CHECK(epoch > 0),
      PRIMARY KEY(repo_id, epoch)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS writer_epochs (
      repo_id TEXT PRIMARY KEY,
      holder_id TEXT NOT NULL CHECK(length(holder_id) > 0),
      epoch INTEGER NOT NULL CHECK(epoch > 0),
      version INTEGER NOT NULL CHECK(version > 0),
      issued_at TEXT NOT NULL
    ) STRICT;
  `);
  const selectCurrent = database.prepare(
      "SELECT repo_id, holder_id, epoch, version, issued_at FROM writer_epochs WHERE repo_id=?",
    ),
    selectFloor = database.prepare("SELECT MAX(epoch) AS floor FROM writer_epoch_history WHERE repo_id=?"),
    deleteCurrent = database.prepare("DELETE FROM writer_epochs WHERE repo_id=?"),
    insertHistory = database.prepare("INSERT INTO writer_epoch_history(repo_id, epoch) VALUES (?, ?)"),
    upsertCurrent = database.prepare(
      "INSERT INTO writer_epochs(repo_id, holder_id, epoch, version, issued_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(repo_id) DO UPDATE SET holder_id=excluded.holder_id, epoch=excluded.epoch, " +
        "version=excluded.version, issued_at=excluded.issued_at",
    );
  let closed = false;
  const ensureOpen = (): void => {
    if (closed) throw new WriterEpochError("writer_epoch_invalid", "writer epoch authority is closed");
  };
  const readCurrent = (repoId: string): WriterEpochLease | null => {
    const row = selectCurrent.get(repoId) as EpochRow | undefined;
    return row ? leaseFromRow(row) : null;
  };
  const withImmediateTransaction = <T>(operation: () => T): T => {
    ensureOpen();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch (rollbackError) {
        consumeKnownError(rollbackError);
      }
      throw error;
    }
  };
  const assertState = (repoId: string, epoch: number, expectedHolderId: string): void => {
    const observed = readCurrent(repoId);
    if (!observed || observed.epoch !== epoch || observed.holderId !== expectedHolderId)
      throw new WriterEpochError(
        "writer_epoch_stale",
        `writer epoch ${epoch} for ${repoId} is stale; current epoch is ${observed?.epoch ?? "missing"}. ` +
          "Query the receipt or reacquire the writer epoch before retrying.",
      );
  };
  return {
    acquire: (repoId: string, observedLedgerEpoch: number): WriterEpochLease => {
      ensureOpen();
      if (!Number.isSafeInteger(observedLedgerEpoch) || observedLedgerEpoch < 0)
        throw new WriterEpochError("writer_epoch_invalid", "Observed ledger epoch must be a nonnegative safe integer");
      return withImmediateTransaction(() => {
        const previous = readCurrent(repoId),
          floor = Number((selectFloor.get(repoId) as { readonly floor: number | null }).floor ?? 0),
          epoch = Math.max(previous?.epoch ?? 0, floor, observedLedgerEpoch) + 1,
          lease: WriterEpochLease = {
            repoId,
            holderId: options.holderId,
            epoch,
            version: Math.max(previous?.version ?? 0, floor) + 1,
            issuedAt: options.now(),
          };
        if (!Number.isSafeInteger(epoch))
          throw new WriterEpochError(
            "writer_epoch_invalid",
            `writer epoch for ${repoId} exceeds the safe integer range`,
          );
        insertHistory.run(repoId, lease.epoch);
        upsertCurrent.run(repoId, lease.holderId, lease.epoch, lease.version, lease.issuedAt);
        return lease;
      });
    },
    current: (repoId: string): WriterEpochLease | null => {
      ensureOpen();
      return readCurrent(repoId);
    },
    highWatermark: (repoId: string): number => {
      ensureOpen();
      const current = readCurrent(repoId)?.epoch ?? 0,
        history = Number((selectFloor.get(repoId) as { readonly floor: number | null }).floor ?? 0);
      return Math.max(current, history);
    },
    retireCurrent: (repoId: string): void => {
      withImmediateTransaction(() => {
        deleteCurrent.run(repoId);
      });
    },
    assert: (repoId: string, epoch: number, expectedHolderId: string): void => {
      ensureOpen();
      assertState(repoId, epoch, expectedHolderId);
    },
    withAppendFence: <T>(repoId: string, epoch: number, expectedHolderId: string, operation: () => T): T =>
      withImmediateTransaction(() => {
        assertState(repoId, epoch, expectedHolderId);
        return operation();
      }),
    close: () => {
      if (closed) return;
      closed = true;
      database.close();
    },
  };
}

const repoIdPattern = /^[a-z][a-z0-9-]{0,62}$/u;

export function openPersistentWriterEpoch(options: {
  readonly stateRoot: string;
  readonly holderId?: string;
  readonly now?: () => string;
}): PersistentWriterEpoch {
  mkdirSync(options.stateRoot, { recursive: true });
  const holderId = options.holderId ?? `center-${process.pid}-${randomUUID()}`,
    now = options.now ?? (() => new Date().toISOString()),
    authorities = new Map<string, ReturnType<typeof openRepoEpochAuthority>>();
  let closed = false;
  const ensureOpen = (): void => {
    if (closed) throw new WriterEpochError("writer_epoch_invalid", "writer epoch authority is closed");
  };
  const authorityFor = (repoId: string): ReturnType<typeof openRepoEpochAuthority> => {
    ensureOpen();
    // The repository id becomes a path component of its epoch database.
    if (!repoIdPattern.test(repoId))
      throw new WriterEpochError("writer_epoch_invalid", `repoId ${repoId} is invalid for a writer epoch database`);
    let authority = authorities.get(repoId);
    if (!authority) {
      authority = openRepoEpochAuthority({
        databasePath: path.join(options.stateRoot, "writer-epochs", `${repoId}.sqlite`),
        holderId,
        now,
      });
      authorities.set(repoId, authority);
    }
    return authority;
  };
  return {
    acquire: (repoId, observedLedgerEpoch = 0) => {
      if (!repoId) throw new WriterEpochError("writer_epoch_invalid", "repoId is required for writer epoch allocation");
      return authorityFor(repoId).acquire(repoId, observedLedgerEpoch);
    },
    current: (repoId) => authorityFor(repoId).current(repoId),
    highWatermark: (repoId) => authorityFor(repoId).highWatermark(repoId),
    retireCurrent: (repoId) => authorityFor(repoId).retireCurrent(repoId),
    assert: (repoId, epoch, expectedHolderId = holderId) =>
      authorityFor(repoId).assert(repoId, epoch, expectedHolderId),
    withAppendFence: (repoId, epoch, expectedHolderId, operation) =>
      authorityFor(repoId).withAppendFence(repoId, epoch, expectedHolderId, operation),
    close: () => {
      if (closed) return;
      closed = true;
      for (const authority of authorities.values()) authority.close();
      authorities.clear();
    },
  };
}

// Descriptor checks reuse one authority per state root for the life of this thread. A repo writer
// is one worker thread serving one repository, so its epoch database opens once per writer, not
// once per check; the authority itself keys databases per repository.
const descriptorAuthorities = new Map<string, PersistentWriterEpoch>();

function descriptorAuthority(descriptor: WriterEpochFenceDescriptor): PersistentWriterEpoch {
  validateWriterEpochFenceDescriptor(descriptor);
  let authority = descriptorAuthorities.get(descriptor.stateRoot);
  if (!authority) {
    authority = openPersistentWriterEpoch({ stateRoot: descriptor.stateRoot, holderId: descriptor.holderId });
    descriptorAuthorities.set(descriptor.stateRoot, authority);
  }
  return authority;
}

export function withWriterEpochFenceDescriptor<T>(descriptor: WriterEpochFenceDescriptor, operation: () => T): T {
  return descriptorAuthority(descriptor).withAppendFence(
    descriptor.repoId,
    descriptor.epoch,
    descriptor.holderId,
    operation,
  );
}

export function assertWriterEpochFenceDescriptor(descriptor: WriterEpochFenceDescriptor): void {
  descriptorAuthority(descriptor).assert(descriptor.repoId, descriptor.epoch, descriptor.holderId);
}

export function closeWriterEpochFenceDescriptors(): void {
  for (const authority of descriptorAuthorities.values()) authority.close();
  descriptorAuthorities.clear();
}

function leaseFromRow(row: EpochRow): WriterEpochLease {
  return {
    repoId: row.repo_id,
    holderId: row.holder_id,
    epoch: row.epoch,
    version: row.version,
    issuedAt: row.issued_at,
  };
}

function validateWriterEpochFenceDescriptor(descriptor: WriterEpochFenceDescriptor): void {
  if (
    descriptor.schema !== "harness-writer-epoch-fence/v1" ||
    !descriptor.stateRoot ||
    !descriptor.repoId ||
    !descriptor.holderId ||
    !Number.isSafeInteger(descriptor.epoch) ||
    descriptor.epoch < 1
  )
    throw new WriterEpochError("writer_epoch_invalid", "writer epoch fence descriptor is invalid");
}

export function readLedgerWriterEpoch(repoId: string, rootDir: string | null | undefined): number {
  if (typeof rootDir !== "string") return 0;
  const generation = resolveActiveGeneration({ rootInput: rootDir, repoId }),
    databasePath = sqliteLedgerPath(rootDir, generation);
  if (!existsSync(databasePath)) return 0;
  const ledger = openSqliteEventStore({ repoId, rootInput: rootDir, generation, readOnly: true });
  try {
    return ledger.writerFence()?.epoch ?? 0;
  } finally {
    ledger.close();
  }
}
