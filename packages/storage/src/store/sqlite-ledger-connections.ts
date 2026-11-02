import { consumeKnownError } from "@harness-anything/kernel/internal/error-consumption";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

const SQLITE_BUSY = 5;

export function isSqliteBusy(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { readonly errcode?: unknown }).errcode === SQLITE_BUSY
  );
}

// Every ledger connection this process opened, keyed by resolved database path. One ledger file can
// be open under several stores at once (a writer and its readers), and deleting the file while any
// of them is open is invisible on POSIX — unlink detaches the name and the open handles keep
// working — and EPERM on Windows, so a teardown has to close every handle on the path, not only one
// owner's.
const openLedgerClosers = new Map<string, Set<() => void>>();

/** Registers one connection's close and returns it; the guard keeps a second close — a teardown that
 *  already closed every handle on this path, then the owner's own close — from throwing. */
export function registerLedgerClose(databasePath: string, db: DatabaseSync): () => void {
  const resolvedLedgerPath = path.resolve(databasePath),
    closers = openLedgerClosers.get(resolvedLedgerPath) ?? new Set<() => void>();
  let closed = false;
  const close = () => {
    closers.delete(close);
    if (closers.size === 0) openLedgerClosers.delete(resolvedLedgerPath);
    if (closed) return;
    closed = true;
    db.close();
  };
  closers.add(close);
  openLedgerClosers.set(resolvedLedgerPath, closers);
  return close;
}

/** Test fixtures can close every ledger connection rooted at a temporary repository before removing it. */
export function closeSqliteEventStoresUnder(rootDir: string): void {
  const resolved = path.resolve(rootDir),
    prefix = `${resolved}${path.sep}`;
  for (const databasePath of [...openLedgerClosers.keys()]) {
    if (databasePath !== resolved && !databasePath.startsWith(prefix)) continue;
    const closers = openLedgerClosers.get(databasePath)!;
    for (const close of [...closers]) close();
    closers.clear();
    openLedgerClosers.delete(databasePath);
  }
}

const OPEN_BUSY_BUDGET_MS = 5000,
  OPEN_BUSY_BACKOFF_MS = 10;

// busy_timeout goes first so every later lock wait is honoured. The WAL switch is the exception:
// SQLite skips the busy handler when a connection holding SHARED asks for EXCLUSIVE while another
// connection holds RESERVED (deadlock avoidance), so with several openers on one fresh ledger a
// concurrent opener gets SQLITE_BUSY at once no matter the timeout. A bounded retry within the same
// budget is the only remedy the engine leaves; every pragma here is idempotent.
export function configureLedgerConnection(executePragma: (sql: string) => void, readOnly = false): void {
  const deadline = Date.now() + OPEN_BUSY_BUDGET_MS;
  for (;;) {
    try {
      executePragma(
        readOnly
          ? `PRAGMA busy_timeout=${OPEN_BUSY_BUDGET_MS}; PRAGMA foreign_keys=ON`
          : `PRAGMA busy_timeout=${OPEN_BUSY_BUDGET_MS}; PRAGMA journal_mode=WAL; ` +
              "PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON",
      );
      return;
    } catch (error) {
      // Retry only while a further attempt can still start inside the budget.
      if (!isSqliteBusy(error) || Date.now() + OPEN_BUSY_BACKOFF_MS >= deadline) throw error;
      consumeKnownError(error);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, OPEN_BUSY_BACKOFF_MS);
      // The wait can oversleep; never start an attempt at or after the deadline.
      if (Date.now() >= deadline) throw error;
    }
  }
}
