import path from "node:path";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import type { VersionControlSystem } from "../ports/version-control-system.ts";
import { makeLocalVersionControlSystem } from "./local-version-control-system.ts";
import type { GitCommitAuthor } from "./write-journal-types.ts";

const defaultVersionControlSystem = makeLocalVersionControlSystem();

export function commitTouchedPaths(
  rootDir: string,
  touchedPaths: ReadonlyArray<string>,
  opIds: ReadonlyArray<string>,
  layoutInput: HarnessLayoutInput = rootDir,
  message?: string,
  sessionId?: string,
  options: {
    readonly respectGitignorePaths?: ReadonlyArray<string>;
    readonly author?: GitCommitAuthor;
    readonly versionControlSystem?: VersionControlSystem;
  } = {}
): string {
  if (touchedPaths.length === 0) return "no-git-change";
  const vcs = options.versionControlSystem ?? defaultVersionControlSystem;

  const plan = resolveCommitPlan(rootDir, touchedPaths, layoutInput, vcs);
  if (!plan) return "no-git-change";
  const respectGitignore = new Set(resolveCommitPlan(rootDir, options.respectGitignorePaths ?? [], layoutInput, vcs)?.relativePaths ?? []);
  const forcedPaths = plan.relativePaths.filter((relativePath) => !respectGitignore.has(relativePath));
  const unforcedPaths = plan.relativePaths.filter((relativePath) => respectGitignore.has(relativePath));
  const sessionBranch = sessionBranchName(sessionId);
  // Resolve the trunk branch while HEAD still points at it, before checkoutSessionBranch
  // moves us onto the session branch; the finally must return to the same trunk.
  const trunkBranch = sessionBranch ? resolveTrunkBranch(plan.repoRoot, undefined, vcs) : undefined;

  if (sessionBranch) checkoutSessionBranch(plan.repoRoot, sessionBranch, trunkBranch!, vcs);
  try {
    if (forcedPaths.length > 0) vcs.add(plan.repoRoot, { paths: forcedPaths, force: true });
    if (unforcedPaths.length > 0) vcs.add(plan.repoRoot, { paths: unforcedPaths });
    unstageLogFiles(plan.repoRoot, plan.relativePaths, vcs);
    const staged = vcs.stagedFiles(plan.repoRoot, plan.relativePaths).trim();
    if (staged.length === 0) return currentGitHead(plan.repoRoot, vcs);

    vcs.commit(plan.repoRoot, message ?? `harness write ${opIds.join(",")}`, options.author);
    return currentGitHead(plan.repoRoot, vcs);
  } finally {
    if (sessionBranch && trunkBranch) vcs.checkout(plan.repoRoot, trunkBranch);
  }
}

export function resolveCommitPlan(
  rootDir: string,
  touchedPaths: ReadonlyArray<string>,
  layoutInput: HarnessLayoutInput = rootDir,
  versionControlSystem: VersionControlSystem = defaultVersionControlSystem
): { readonly repoRoot: string; readonly relativePaths: ReadonlyArray<string> } | null {
  if (touchedPaths.length === 0) return null;
  const target = resolveCommitTarget(rootDir, resolveHarnessLayout(layoutInput).authoredRoot, versionControlSystem);
  if (!target) return null;
  return {
    repoRoot: target.repoRoot,
    relativePaths: unique(touchedPaths.map((filePath) => repoRelativePath(target.repoRoot, filePath, versionControlSystem)))
  };
}

function resolveCommitTarget(rootDir: string, authoredRoot: string, vcs: VersionControlSystem): { readonly repoRoot: string } | null {
  const rootRepo = vcs.topLevel(rootDir);
  const authoredRepo = vcs.topLevel(authoredRoot);
  if (!authoredRepo) return rootRepo ? { repoRoot: rootRepo } : null;
  if (rootRepo && authoredRepo === rootRepo && isIgnoredByRepo(rootRepo, authoredRoot, vcs)) {
    throw new Error("authored root is ignored by Git but is not a nested Git repository");
  }
  return { repoRoot: authoredRepo };
}

export function ledgerGitTopLevel(inputPath: string, versionControlSystem: VersionControlSystem = defaultVersionControlSystem): string | null {
  return versionControlSystem.topLevel(inputPath);
}

export function checkoutTrunk(repoRoot: string, trunkBranch: string, versionControlSystem: VersionControlSystem = defaultVersionControlSystem): void {
  versionControlSystem.checkout(repoRoot, trunkBranch);
}

// Resolve the repository's trunk (integration) branch. The session-branch write model
// checks out trunk, branches sessions/<id> from it, then materializes back into trunk;
// hardcoding "master" broke every repo whose trunk is "main" (or anything else). Order:
// current branch (unless it is a session branch) -> origin/HEAD -> local main -> local
// master -> "main". Detection is git-native so any trunk name works without config.
export function resolveTrunkBranch(repoRoot: string, explicit?: string, versionControlSystem: VersionControlSystem = defaultVersionControlSystem): string {
  const configured = explicit?.trim();
  if (configured) return configured;

  const current = versionControlSystem.currentBranch(repoRoot);
  if (current && !current.startsWith("sessions/")) return current;

  const originHead = versionControlSystem.originHeadBranch(repoRoot);
  if (originHead) return originHead;

  for (const candidate of ["main", "master"]) {
    if (localBranchExists(repoRoot, candidate, versionControlSystem)) return candidate;
  }
  return "main";
}

function localBranchExists(repoRoot: string, branch: string, vcs: VersionControlSystem): boolean {
  return refExists(repoRoot, `refs/heads/${branch}`, vcs);
}

export function mergeNoFf(repoRoot: string, branch: string, message: string, versionControlSystem: VersionControlSystem = defaultVersionControlSystem): void {
  versionControlSystem.mergeNoFf(repoRoot, branch, message);
}

export function deleteBranch(repoRoot: string, branch: string, versionControlSystem: VersionControlSystem = defaultVersionControlSystem): void {
  versionControlSystem.deleteBranch(repoRoot, branch);
}

export function abortMerge(repoRoot: string, versionControlSystem: VersionControlSystem = defaultVersionControlSystem): void {
  versionControlSystem.abortMerge(repoRoot);
}

export function sessionBranches(repoRoot: string, versionControlSystem: VersionControlSystem = defaultVersionControlSystem): ReadonlyArray<string> {
  return versionControlSystem.sessionBranches(repoRoot);
}

export function commitsNotInTrunk(repoRoot: string, trunkBranch: string, branch: string, versionControlSystem: VersionControlSystem = defaultVersionControlSystem): ReadonlyArray<string> {
  return versionControlSystem.commitsNotInTrunk(repoRoot, trunkBranch, branch);
}

export function currentGitHead(repoRoot: string, versionControlSystem: VersionControlSystem = defaultVersionControlSystem): string {
  return versionControlSystem.currentHead(repoRoot);
}

export function changedFilesBetween(repoRoot: string, before: string, after: string, versionControlSystem: VersionControlSystem = defaultVersionControlSystem): ReadonlyArray<string> {
  return versionControlSystem.changedFilesBetween(repoRoot, before, after);
}

export function refExists(repoRoot: string, ref: string, versionControlSystem: VersionControlSystem = defaultVersionControlSystem): boolean {
  return versionControlSystem.refExists(repoRoot, ref);
}

function isIgnoredByRepo(repoRoot: string, candidatePath: string, vcs: VersionControlSystem): boolean {
  const relativePath = repoRelativePath(repoRoot, candidatePath, vcs);
  return vcs.isIgnored(repoRoot, relativePath);
}

function repoRelativePath(repoRoot: string, filePath: string, vcs: VersionControlSystem): string {
  const relativePath = path.relative(vcs.normalizePath(repoRoot), vcs.normalizePath(filePath));
  if (relativePath.length === 0) return ".";
  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error("touched path is outside commit repository");
  }
  return relativePath.split(path.sep).join("/");
}

function unstageLogFiles(repoRoot: string, relativePaths: ReadonlyArray<string>, vcs: VersionControlSystem): void {
  const logPathspecs = relativePaths.flatMap((relativePath) => logPathspecsFor(relativePath));
  if (logPathspecs.length === 0) return;
  vcs.resetQuiet(repoRoot, unique(logPathspecs));
}

function logPathspecsFor(relativePath: string): ReadonlyArray<string> {
  const normalized = relativePath.replace(/\/+$/u, "");
  if (normalized.length === 0 || normalized === ".") return [":(glob)**/*.log", "*.log"];
  if (normalized.endsWith(".log")) return [normalized];
  return [`:(glob)${normalized}/**/*.log`, `${normalized}/*.log`];
}

function checkoutSessionBranch(repoRoot: string, branchName: string, trunkBranch: string, vcs: VersionControlSystem): void {
  vcs.checkout(repoRoot, trunkBranch);
  if (!branchExists(repoRoot, branchName, vcs)) {
    vcs.createBranch(repoRoot, branchName);
  }
  vcs.checkout(repoRoot, branchName);
}

function branchExists(repoRoot: string, branchName: string, vcs: VersionControlSystem): boolean {
  return vcs.refExists(repoRoot, branchName);
}

function sessionBranchName(sessionId: string | undefined): string | undefined {
  const safeSessionId = sessionId?.trim();
  if (!safeSessionId) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(safeSessionId)) {
    throw new Error(`invalid session id for git branch: ${safeSessionId}`);
  }
  return `sessions/${safeSessionId}`;
}

function unique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)];
}
