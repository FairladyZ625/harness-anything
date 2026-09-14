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
