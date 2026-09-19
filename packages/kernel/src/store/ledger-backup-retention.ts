import path from "node:path";
import { timestamp } from "../domain/timestamp.ts";
import { localLedgerBackupFileSystem as fileSystem } from "../local/local-layout-file-system.ts";
import { readLedgerBackupManifest } from "./ledger-backup.ts";

/** Retention policy of the scheduled ledger backup (defaults live with the daemon executor). */
export interface LedgerBackupRetentionPolicyV1 {
  /** Backups from the most recent `keepDays` natural (UTC) days are all retained. */
  readonly keepDays: number;
  /** Older than that, retain the newest backup of each natural (UTC) month. */
  readonly keepMonthly: boolean;
}

/** One retention candidate: an executor-named directory plus the backup's own creation time. */
export interface LedgerBackupRetentionEntryV1 {
  readonly dir: string;
  readonly createdAt: string;
}

/**
 * Directory names the scheduled executor itself creates: `ledger-backup-<occurrenceId>`, where
 * an occurrence id is `occurrence_<24 hex>` or `manual_<24 hex>`. Retention only ever considers
 * directories matching this shape — backups made by other means are never touched.
 */
export const ledgerBackupDirPattern = /^ledger-backup-(?:occurrence|manual)_[0-9a-f]{24}$/u;

const dayMs = 86_400_000;

/**
 * Pure retention plan: which entries to delete. Semantics (UTC natural days): every backup
 * from the most recent `keepDays` natural days is kept. Older backups keep the newest one
 * per calendar month when `keepMonthly` — but a month whose newest backup already sits in
 * the retained window is represented and contributes no extra keep. Protected entries (the
 * occurrence's own fresh output) are never planned for deletion.
 */
export function planLedgerBackupRetention(input: {
  readonly entries: readonly LedgerBackupRetentionEntryV1[];
  readonly now: string;
  readonly policy: LedgerBackupRetentionPolicyV1;
  readonly protectedDirs: readonly string[];
}): readonly string[] {
  const protectedNames = new Set(input.protectedDirs.map((dir) => path.basename(path.resolve(dir)))),
    // First instant of the oldest retained natural day: today minus (keepDays - 1) days.
    cutoff = Date.parse(`${input.now.slice(0, 10)}T00:00:00.000Z`) - (input.policy.keepDays - 1) * dayMs,
    newestFirst = [...input.entries].sort(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.dir.localeCompare(right.dir),
    ),
    monthsRepresentedInWindow = new Set(
      newestFirst
        .filter(({ createdAt }) => Date.parse(createdAt) >= cutoff)
        .map(({ createdAt }) => createdAt.slice(0, 7)),
    ),
    keptMonths = new Set<string>(),
    deletions: string[] = [];
  for (const entry of newestFirst) {
    const month = entry.createdAt.slice(0, 7);
    if (Date.parse(entry.createdAt) >= cutoff) continue;
    // A protected entry is retained outright, and as its month's newest it still represents
    // that month — otherwise a same-month sibling would survive on a technicality.
    if (protectedNames.has(path.basename(path.resolve(entry.dir)))) {
      keptMonths.add(month);
      continue;
    }
    if (input.policy.keepMonthly && !monthsRepresentedInWindow.has(month) && !keptMonths.has(month)) {
      keptMonths.add(month);
      continue;
    }
    deletions.push(entry.dir);
  }
  return deletions;
}

/**
 * Apply retention under the backup root: identify executor-named directories that carry a
 * readable ledger-backup manifest, plan deletions, and remove exactly the planned set.
 * A directory that fails identification is reported in `skipped` and left in place — an
 * unidentified directory is never deleted, and neither is anything outside the naming
 * pattern. A removal that fails is reported in `warnings` (the drill retention shape);
 * the already-verified fresh backup of this occurrence is never a removal candidate.
 */
export function applyLedgerBackupRetention(input: {
  readonly backupRoot: string;
  readonly now: string;
  readonly policy: LedgerBackupRetentionPolicyV1;
  readonly protectedDirs: readonly string[];
}): {
  readonly removed: readonly string[];
  readonly retained: readonly string[];
  readonly skipped: readonly string[];
  readonly warnings: readonly string[];
} {
  const root = path.resolve(input.backupRoot);
  if (!fileSystem.exists(root)) return { removed: [], retained: [], skipped: [], warnings: [] };
  const identify = (dir: string): LedgerBackupRetentionEntryV1 | string => {
    try {
      const manifest = readLedgerBackupManifest(dir);
      if (!timestamp(manifest.createdAt)) throw new Error("manifest createdAt is not a UTC timestamp");
      return { dir, createdAt: manifest.createdAt };
    } catch (error) {
      return `could not identify ${dir} as a ledger backup: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const entries: LedgerBackupRetentionEntryV1[] = [],
    skipped: string[] = [];
  for (const name of fileSystem.readDirectory(root)) {
    if (!ledgerBackupDirPattern.test(name)) continue;
    const dir = path.join(root, name);
    if (!fileSystem.lstat(dir).isDirectory()) continue;
    const identified = identify(dir);
    if (typeof identified === "string") skipped.push(identified);
    else entries.push(identified);
  }
  const planned = new Set(planLedgerBackupRetention({ ...input, entries })),
    // Returns "" when the removal succeeded, otherwise a warning the settlement detail carries.
    removeOne = (dir: string): string => {
      try {
        fileSystem.remove(dir);
        return "";
      } catch (error) {
        return `could not remove ${dir}: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    removed: string[] = [],
    warnings: string[] = [];
  for (const entry of entries)
    if (planned.has(entry.dir)) {
      const warning = removeOne(entry.dir);
      if (warning === "") removed.push(entry.dir);
      else warnings.push(warning);
    }
  return {
    removed,
    retained: entries.filter((entry) => !planned.has(entry.dir)).map(({ dir }) => dir),
    skipped,
    warnings,
  };
}
