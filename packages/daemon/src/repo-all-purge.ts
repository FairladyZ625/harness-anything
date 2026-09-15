import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  createLedgerBackup,
  drillLedgerBackup,
  resolveHarnessLayout,
  restoreDrillRetentionFor,
  type DaemonRegistryRepo,
} from "../../kernel/src/index.ts";
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
  if (!path.isAbsolute(input.backup)) throw new Error("--backup must be an absolute path");
  const backupDir = path.resolve(input.backup),
    canonicalBackupDir = canonicalProspectivePath(backupDir),
    layout = resolveHarnessLayout(input.rootDir);
  if (existsSync(backupDir)) throw new Error("--backup destination must not already exist");
  if (
    isWithin(canonicalBackupDir, realpathSync(layout.localRoot)) ||
    isWithin(canonicalBackupDir, realpathSync(layout.authoredRoot))
  )
    throw new Error("--backup must not be inside .harness or harness because those directories will be removed");
  return backupDir;
}

export function backupRepoForAllPurge(input: {
  readonly rootDir: string;
  readonly backupDir: string;
  readonly registration: DaemonRegistryRepo;
  readonly writerEpoch: number;
}): LedgerBackupManifest {
  return createLedgerBackup({
    rootInput: input.rootDir,
    backupDir: input.backupDir,
    registration: {
      repoId: input.registration.repoId,
      mode: input.registration.mode,
      connectionId: input.registration.connectionId,
      displayName: input.registration.displayName,
      authoredBranch: input.registration.authoredBranch,
      writerEpoch: input.writerEpoch,
    },
  });
}

export function drillRepoAllPurgeBackup(input: {
  readonly rootDir: string;
  readonly backupDir: string;
  readonly manifest: LedgerBackupManifest;
}): void {
  const layout = resolveHarnessLayout(input.rootDir);
  drillLedgerBackup({
    backupDir: input.backupDir,
    shadowParent: path.join(layout.localRoot, "restore-drills"),
    retention: restoreDrillRetentionFor(input.rootDir),
    verifiedManifest: input.manifest,
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
