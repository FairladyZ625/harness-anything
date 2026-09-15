import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createLedgerBackup,
  drillLedgerBackup,
  resolveHarnessLayout,
  restoreDrillRetentionFor,
  type DaemonRegistryRepo,
} from "../../kernel/src/index.ts";

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
    removed: string[] = [];
  removePath(layout.localRoot, ".harness", removed);
  removePath(layout.authoredRoot, "harness", removed);
  removeHarnessGitignoreRules(canonicalRoot, layout.localRoot, layout.authoredRoot);
  return removed;
}

function removePath(target: string, receiptPath: string, removed: string[]): void {
  if (!existsSync(target)) return;
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  removed.push(receiptPath);
}

function removeHarnessGitignoreRules(rootDir: string, localRoot: string, authoredRoot: string): void {
  const projectRoot = execFileSync("git", ["-C", rootDir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim(),
    ignorePath = path.join(projectRoot, ".gitignore");
  if (!existsSync(ignorePath)) return;
  const status = lstatSync(ignorePath);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(".gitignore must be a regular file");
  const rules = new Set(
      [authoredRoot, localRoot].map((target) => `/${path.relative(projectRoot, target).split(path.sep).join("/")}/`),
    ),
    existing = readFileSync(ignorePath, "utf8"),
    retained = existing.split(/(?<=\n)/u).filter((line) => !rules.has(line.replace(/\r?\n$/u, "")));
  if (retained.length !== existing.split(/(?<=\n)/u).length) writeFileSync(ignorePath, retained.join(""), "utf8");
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
