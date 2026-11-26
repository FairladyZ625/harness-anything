import path from "node:path";
import { resolveHarnessLayout, type HarnessLayoutInput } from "@harness-anything/kernel/internal/layout/index.ts";
export const SQLITE_LEDGER_GENERATION = 3;
export function sqliteLedgerPath(input: HarnessLayoutInput, generation = SQLITE_LEDGER_GENERATION): string {
  return path.join(resolveHarnessLayout(input).localRoot, "store", "generations", String(generation), "ledger.sqlite");
}

/**
 * Reserve headroom below Windows' 260-char MAX_PATH for SQLite's Win32 VFS `-wal` / `-shm` /
 * `-journal` sidecar suffixes so `node:sqlite` (`DatabaseSync` / `backup` / `VACUUM INTO`)
 * never fails with `SQLITE_CANTOPEN` (`unable to open database file`) when opening deeply nested
 * replica or worktree paths on Windows.
 */
export function sqliteDatabasePath(filePath: string, platform: NodeJS.Platform = process.platform): string {
  if (
    platform !== "win32" ||
    filePath === ":memory:" ||
    filePath.startsWith("file:") ||
    filePath.startsWith("\\\\?\\")
  ) {
    return filePath;
  }
  const resolved = path.win32.resolve(filePath);
  if (resolved.length < 240) return filePath;
  if (resolved.startsWith("\\\\")) return `\\\\?\\UNC\\${resolved.slice(2)}`;
  return `\\\\?\\${resolved}`;
}
