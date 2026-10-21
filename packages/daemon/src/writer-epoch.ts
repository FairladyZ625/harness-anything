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
  readonly code:
    | "writer_epoch_stale"
    | "writer_epoch_invalid"
    | "writer_epoch_migration_required"
    | "writer_epoch_legacy_unreadable"
    | "writer_epoch_legacy_unsupported"
    | "writer_epoch_daemon_running";
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

const repoIdPattern = /^[a-z][a-z0-9-]{0,62}$/u;

function openEpochDatabase(databasePath: string): DatabaseSync {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
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
  return database;
}

/** One repository's epoch authority over its own database file. The append fence must exclude
 *  only takeover of its repository, and SQLite locks are database-granular, so the fencing scope
 *  is one repo: `stateRoot/writer-epochs/<repoId>.sqlite`. A shared database serialized every
 *  repository's append behind one write lock; under load a queued fence could exhaust
 *  busy_timeout and reject its write ("database is locked"). */
function openRepoEpochAuthority(options: {
  readonly databasePath: string;
  readonly repoId: string;
  readonly holderId: string;
  readonly now: () => string;
  readonly initialEpochFloor?: number;
}) {
  const database = openEpochDatabase(options.databasePath);
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
  const initialEpochFloor = options.initialEpochFloor;
  if (initialEpochFloor !== undefined) {
    withImmediateTransaction(() => {
      const previous = readCurrent(options.repoId),
        historyFloor = Number((selectFloor.get(options.repoId) as { readonly floor: number | null }).floor ?? 0),
        floor = Math.max(previous?.epoch ?? 0, historyFloor, initialEpochFloor);
      if (floor > historyFloor) insertHistory.run(options.repoId, floor);
      if (previous && previous.epoch <= Math.max(historyFloor, initialEpochFloor)) deleteCurrent.run(options.repoId);
    });
  }
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

type LegacyWriterEpochFloor = { readonly repo_id: unknown; readonly floor: unknown };
export interface LegacyWriterEpochMigrationResult {
  readonly schema: "writer-epoch-migration-receipt/v1";
  readonly state: "not-needed" | "already-migrated" | "migrated" | "partial";
  readonly migratedRepos: readonly string[];
  readonly rejectedRepos: readonly {
    readonly repoId: string;
    readonly code: "writer_epoch_legacy_unreadable";
    readonly hint: string;
  }[];
}

const legacyFloorSql =
  "SELECT repo_id, MAX(epoch_floor) AS floor FROM (" +
  "SELECT repo_id, epoch AS epoch_floor FROM writer_epoch_history UNION ALL " +
  "SELECT repo_id, epoch AS epoch_floor FROM writer_epochs UNION ALL " +
  "SELECT repo_id, version AS epoch_floor FROM writer_epochs) GROUP BY repo_id ORDER BY repo_id";

function parseSafeFloorNumber(
  value: unknown,
  repoId: string,
): { readonly floor: number } | { readonly error: WriterEpochError } {
  if (typeof value === "bigint") {
    if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER))
      return {
        error: new WriterEpochError(
          "writer_epoch_legacy_unreadable",
          `legacy writer epoch floor is outside the safe integer range for repo ${repoId}`,
        ),
      };
    return { floor: Number(value) };
  }
  const floor = Number(value);
  if (!Number.isSafeInteger(floor) || floor < 1)
    return {
      error: new WriterEpochError(
        "writer_epoch_legacy_unreadable",
        `legacy writer epoch floor is not a safe positive integer for repo ${repoId}`,
      ),
    };
  return { floor };
}

function safeFloorNumber(value: unknown, repoId: string): number {
  const result = parseSafeFloorNumber(value, repoId);
  if ("error" in result) throw result.error;
  return result.floor;
}

function legacyFloorForRepo(database: DatabaseSync, repoId: string): number | null {
  const statement = database.prepare(
    "SELECT MAX(epoch_floor) AS floor FROM (" +
      "SELECT epoch AS epoch_floor FROM writer_epoch_history WHERE repo_id=? UNION ALL " +
      "SELECT epoch AS epoch_floor FROM writer_epochs WHERE repo_id=? UNION ALL " +
      "SELECT version AS epoch_floor FROM writer_epochs WHERE repo_id=?)",
  );
  statement.setReadBigInts(true);
  const row = statement.get(repoId, repoId, repoId) as { readonly floor: unknown };
  if (row.floor === null) return null;
  return safeFloorNumber(row.floor, repoId);
}

function legacyUnreadable(repoId: string, legacyPath: string, detail: string): WriterEpochError {
  return new WriterEpochError(
    "writer_epoch_legacy_unreadable",
    `Cannot read a safe legacy writer-epoch floor for repo ${repoId} from ${legacyPath}: ${detail}. ` +
      `Restore writer-epochs.sqlite from a backup, then run \`ha migrate writer-epoch\`; do not remove it or ` +
      "attach this repo with a reset epoch.",
  );
}

function targetEpochFloor(databasePath: string, repoId: string): number | null {
  if (!existsSync(databasePath)) return null;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const statement = database.prepare(
      "SELECT MAX(epoch_floor) AS floor FROM (" +
        "SELECT epoch AS epoch_floor FROM writer_epoch_history WHERE repo_id=? UNION ALL " +
        "SELECT epoch AS epoch_floor FROM writer_epochs WHERE repo_id=? UNION ALL " +
        "SELECT version AS epoch_floor FROM writer_epochs WHERE repo_id=?)",
    );
    statement.setReadBigInts(true);
    const row = statement.get(repoId, repoId, repoId) as { readonly floor: unknown };
    return row.floor === null ? null : safeFloorNumber(row.floor, repoId);
  } finally {
    database.close();
  }
}

function assertLegacyWriterEpochRepoMigrated(stateRoot: string, repoId: string, databasePath: string): void {
  const legacyPath = path.join(stateRoot, "writer-epochs.sqlite");
  if (!existsSync(legacyPath)) return;

  const legacy = new DatabaseSync(legacyPath, { readOnly: true });
  try {
    const userVersion = Number(
      (legacy.prepare("PRAGMA user_version").get() as { readonly user_version: number }).user_version,
    );
    if (userVersion === 1) return;
    if (userVersion > 1)
      throw new WriterEpochError(
        "writer_epoch_legacy_unsupported",
        `legacy writer epoch database version ${userVersion} is newer than supported version 1 for repo ${repoId}; ` +
          `restore a compatible backup before attaching this repo`,
      );
    if (userVersion === 0) {
      let floor: number | null;
      try {
        floor = legacyFloorForRepo(legacy, repoId);
      } catch (error) {
        if (error instanceof WriterEpochError) throw legacyUnreadable(repoId, legacyPath, error.message);
        throw legacyUnreadable(repoId, legacyPath, error instanceof Error ? error.message : String(error));
      }
      if (floor === null) return;
      const importedFloor = targetEpochFloor(databasePath, repoId);
      if (importedFloor === null || importedFloor < floor)
        throw new WriterEpochError(
          "writer_epoch_migration_required",
          `Legacy writer-epoch state for repo ${repoId} has not been migrated. Run \`ha migrate writer-epoch\` ` +
            "with this daemon stopped, then retry the repository attach.",
        );
    }
  } catch (error) {
    if (error instanceof WriterEpochError) throw error;
    throw legacyUnreadable(repoId, legacyPath, error instanceof Error ? error.message : String(error));
  } finally {
    legacy.close();
  }
}

/** Convert the legacy shared authority as an explicit offline operation. */
export function migrateLegacyWriterEpochDatabase(stateRoot: string): LegacyWriterEpochMigrationResult {
  const legacyPath = path.join(stateRoot, "writer-epochs.sqlite");
  if (!existsSync(legacyPath))
    return { schema: "writer-epoch-migration-receipt/v1", state: "not-needed", migratedRepos: [], rejectedRepos: [] };

  const legacy = new DatabaseSync(legacyPath);
  let transactionOpen = false;
  try {
    legacy.exec("PRAGMA busy_timeout=5000");
    let userVersion = Number(
      (legacy.prepare("PRAGMA user_version").get() as { readonly user_version: number }).user_version,
    );
    if (userVersion === 1)
      return {
        schema: "writer-epoch-migration-receipt/v1",
        state: "already-migrated",
        migratedRepos: [],
        rejectedRepos: [],
      };
    if (userVersion > 1)
      throw new WriterEpochError(
        "writer_epoch_legacy_unsupported",
        `legacy writer epoch database version ${userVersion} is newer than supported version 1; ` +
          "restore a compatible backup before migrating",
      );
    legacy.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    userVersion = Number(
      (legacy.prepare("PRAGMA user_version").get() as { readonly user_version: number }).user_version,
    );
    if (userVersion === 1) {
      legacy.exec("COMMIT");
      transactionOpen = false;
      return {
        schema: "writer-epoch-migration-receipt/v1",
        state: "already-migrated",
        migratedRepos: [],
        rejectedRepos: [],
      };
    }
    if (userVersion > 1)
      throw new WriterEpochError(
        "writer_epoch_legacy_unsupported",
        `legacy writer epoch database version ${userVersion} is newer than supported version 1; ` +
          "restore a compatible backup before migrating",
      );

    let floors: readonly LegacyWriterEpochFloor[];
    try {
      const statement = legacy.prepare(legacyFloorSql);
      statement.setReadBigInts(true);
      floors = statement.all() as unknown as readonly LegacyWriterEpochFloor[];
    } catch (error) {
      throw legacyUnreadable("<unknown>", legacyPath, error instanceof Error ? error.message : String(error));
    }
    const migratedRepos: string[] = [],
      rejectedRepos: LegacyWriterEpochMigrationResult["rejectedRepos"][number][] = [];
    for (const row of floors) {
      const repoId = typeof row.repo_id === "string" ? row.repo_id : String(row.repo_id);
      if (!repoIdPattern.test(repoId)) {
        rejectedRepos.push({
          repoId,
          code: "writer_epoch_legacy_unreadable",
          hint: legacyUnreadable(repoId, legacyPath, "the repo id is invalid").message,
        });
        continue;
      }
      const parsedFloor = parseSafeFloorNumber(row.floor, repoId);
      if ("error" in parsedFloor) {
        rejectedRepos.push({
          repoId,
          code: "writer_epoch_legacy_unreadable",
          hint: legacyUnreadable(repoId, legacyPath, parsedFloor.error.message).message,
        });
        continue;
      }
      const migrated = openRepoEpochAuthority({
        databasePath: path.join(stateRoot, "writer-epochs", `${repoId}.sqlite`),
        repoId,
        holderId: "legacy-migration",
        now: () => new Date().toISOString(),
        initialEpochFloor: parsedFloor.floor,
      });
      migrated.close();
      migratedRepos.push(repoId);
    }
    if (rejectedRepos.length === 0) legacy.exec("PRAGMA user_version=1");
    legacy.exec("COMMIT");
    transactionOpen = false;
    return {
      schema: "writer-epoch-migration-receipt/v1",
      state: rejectedRepos.length > 0 ? "partial" : "migrated",
      migratedRepos,
      rejectedRepos,
    };
  } finally {
    try {
      if (transactionOpen) legacy.exec("ROLLBACK");
    } finally {
      legacy.close();
    }
  }
}

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
      const databasePath = path.join(options.stateRoot, "writer-epochs", `${repoId}.sqlite`);
      assertLegacyWriterEpochRepoMigrated(options.stateRoot, repoId, databasePath);
      authority = openRepoEpochAuthority({
        databasePath,
        repoId,
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
