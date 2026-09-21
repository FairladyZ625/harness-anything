import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  createLedgerBackup,
  drillLedgerBackup,
  resolveHarnessLayout,
  restoreDrillRetentionFor,
  type DaemonRegistryRepo,
} from "@harness-anything/kernel";
import { removeHarnessIgnoreRules } from "./repo-bootstrap.ts";
import { removeRepoHarnessRoots } from "./repo-cache-purge.ts";

type LedgerBackupManifest = ReturnType<typeof createLedgerBackup>;

export function validateRepoAllPurge(input: {
  readonly rootDir: string;
  readonly repoId: string;
  readonly backup?: string;
  readonly confirm?: string;
}): string {
  if (input.confirm !== input.repoId) throw new Error(`--confirm must equal repository id ${input.repoId}`);
  if (!input.backup) throw new Error("--backup is required when --scope is all");
  return validateBackupDestination(input.rootDir, input.backup);
}

/** A backup lands outside the live ledger roots: purge removes them, and a drill restores below them. */
export function validateBackupDestination(rootDir: string, backup: string): string {
  if (!path.isAbsolute(backup)) throw new Error("backup destination must be an absolute path");
  const backupDir = path.resolve(backup),
    canonicalBackupDir = canonicalProspectivePath(backupDir),
    layout = resolveHarnessLayout(rootDir);
  if (existsSync(backupDir)) throw new Error("backup destination must not already exist");
  if (
    isWithin(canonicalBackupDir, canonicalProspectivePath(layout.localRoot)) ||
    isWithin(canonicalBackupDir, canonicalProspectivePath(layout.authoredRoot))
  )
    throw new Error("backup destination must not be inside .harness or harness");
  return backupDir;
}

export function backupRepo(
  input: { readonly rootDir: string; readonly backupDir: string } & (
    | { readonly registration: DaemonRegistryRepo; readonly writerEpoch: number }
    | { readonly registration?: never; readonly writerEpoch?: never }
  ),
): LedgerBackupManifest {
  return createLedgerBackup({
    rootInput: input.rootDir,
    backupDir: input.backupDir,
    ...(input.registration
      ? {
          registration: {
            repoId: input.registration.repoId,
            mode: input.registration.mode,
            connectionId: input.registration.connectionId,
            displayName: input.registration.displayName,
            authoredBranch: input.registration.authoredBranch,
            writerEpoch: input.writerEpoch,
          },
        }
      : {}),
  });
}

export function drillRepoBackup(input: {
  readonly rootDir: string;
  readonly backupDir: string;
  readonly manifest?: LedgerBackupManifest;
  readonly shadowParent?: string;
}) {
  const layout = resolveHarnessLayout(input.rootDir);
  return drillLedgerBackup({
    backupDir: input.backupDir,
    shadowParent: input.shadowParent ?? path.join(layout.localRoot, "restore-drills"),
    retention: restoreDrillRetentionFor(input.rootDir),
    ...(input.manifest ? { verifiedManifest: input.manifest } : {}),
  });
}

export function removeRepoHarnessData(rootDir: string): readonly string[] {
  const canonicalRoot = realpathSync(rootDir),
    layout = resolveHarnessLayout(canonicalRoot),
    removed = removeRepoHarnessRoots(canonicalRoot);
  removeHarnessIgnoreRules(canonicalRoot, layout.authoredRoot, layout.localRoot);
  return removed;
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalProspectivePath(candidate: string): string {
  const remainder: string[] = [];
  let existing = candidate;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    remainder.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync(existing), ...remainder);
}
