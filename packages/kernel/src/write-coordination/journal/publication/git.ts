import path from "node:path";
import type { HarnessLayoutInput } from "../../../layout/index.ts";
import { resolveHarnessLayout } from "../../../layout/index.ts";
import type { VcsCommitAuthor, VcsCommitPhase, VcsCommitOptions, VersionControlSystem } from "../../../ports/version-control-system.ts";
import { makeLocalVersionControlSystem } from "../../../persistence/git/local-version-control-system.ts";
import { WriteRejectedError } from "../rejection.ts";

const defaultVersionControlSystem = makeLocalVersionControlSystem();
const authoredRootNotIsolatedMessage = "authored root is not isolated from the outer code repository; run harness-anything init so the authored root is an independent Git repository and the outer .gitignore isolates it";
const authoredRootNotIsolatedCode = "authored_root_not_isolated";

export function commitTouchedPaths(
  rootDir: string,
  touchedPaths: ReadonlyArray<string>,
  opIds: ReadonlyArray<string>,
  layoutInput: HarnessLayoutInput = rootDir,
  message?: string,
  sessionId?: string,
  options: {
    readonly preserveExplicitLogPaths?: ReadonlyArray<string>;
    readonly author?: VcsCommitAuthor;
    readonly versionControlSystem?: VersionControlSystem;
    readonly onCommitPhase?: VcsCommitOptions["onPhase"];
  } = {}
): string {
  if (touchedPaths.length === 0) return "no-git-change";
  const vcs = options.versionControlSystem ?? defaultVersionControlSystem;
  const report = (phase: VcsCommitPhase): void => {
    try {
      options.onCommitPhase?.(phase);
    } catch {
      // Commit telemetry is deliberately non-authoritative.
    }
  };

  report("commit-plan-start");
  const plan = resolveCommitPlan(rootDir, touchedPaths, layoutInput, vcs);
  report("commit-plan-done");
  if (!plan) return "no-git-change";
  const preserveExplicitLogs = resolveExplicitLogSet(
    rootDir,
    options.preserveExplicitLogPaths ?? [],
    layoutInput,
    vcs
  );
  const sessionBranch = sessionBranchName(sessionId);
  const commitMessage = message ?? `harness write ${opIds.join(",")}`;

  if (sessionBranch) {
    // Zero-checkout session commit: assemble the commit entirely with Git
    // plumbing on a temporary alternate index. The shared worktree is never
    // touched, eliminating the publication window in which the old
    // checkout-based publisher clobbered user-authored content by restoring
    // the worktree to trunk between session commit and materializer merge.
    const trunkBranch = resolveTrunkBranch(plan.repoRoot, undefined, vcs);
    const excludePaths = new Set(
      plan.relativePaths.filter(
        (relativePath) => relativePath.endsWith(".log") && !preserveExplicitLogs.has(relativePath)
      )
    );
    const commitSha = vcs.commitPathsToBranch(plan.repoRoot, {
      branchName: sessionBranch,
      baseBranchName: trunkBranch,
      stagePaths: plan.relativePaths,
      excludePaths,
      message: commitMessage,
      ...(options.author ? { author: options.author } : {}),
      ...(options.onCommitPhase ? { onPhase: options.onCommitPhase } : {})
    });
    return commitSha;
  }

  // Non-session path: commit on the current branch via the shared index.
  // A failed commit can leave a hard-delete already staged while its path no
  // longer exists in either the worktree or index. Re-adding that path fails;
  // preserve its staged deletion and continue the recovery commit.
  const addablePaths = plan.relativePaths.filter((relativePath) => {
    const staged = vcs.stagedFiles(plan.repoRoot, [relativePath]).trim().length > 0;
    return !staged || hasUnstagedChanges(vcs.workingTreeFiles(plan.repoRoot, [relativePath]));
  });
  if (addablePaths.length > 0) {
    report("stage-start");
    vcs.add(plan.repoRoot, { paths: addablePaths });
    report("stage-done");
  }
  report("unstage-logs-start");
  unstageLogFiles(plan.repoRoot, plan.relativePaths, vcs);
  report("unstage-logs-done");
  const preservedLogs = plan.relativePaths.filter((relativePath) => preserveExplicitLogs.has(relativePath));
  if (preservedLogs.length > 0) vcs.add(plan.repoRoot, { paths: preservedLogs });
  const staged = vcs.stagedFiles(plan.repoRoot, plan.relativePaths).trim();
  if (staged.length === 0) return vcs.currentHead(plan.repoRoot);

  report("commit-call-start");
  vcs.commit(plan.repoRoot, commitMessage, options.author, {
    ...(options.onCommitPhase ? { onPhase: options.onCommitPhase } : {})
  });
  report("commit-call-done");
  return vcs.currentHead(plan.repoRoot);
}

export function resolveCommitPlan(
  rootDir: string,
  touchedPaths: ReadonlyArray<string>,
  layoutInput: HarnessLayoutInput = rootDir,
  versionControlSystem: VersionControlSystem = defaultVersionControlSystem
): { readonly repoRoot: string; readonly relativePaths: ReadonlyArray<string> } | null {
  const layout = resolveHarnessLayout(layoutInput);
  const committablePaths = excludeLocalRootPaths(layout.localRoot, touchedPaths, versionControlSystem);
  if (committablePaths.length === 0) return null;
  const target = resolveCommitTarget(rootDir, layout.authoredRoot, committablePaths, versionControlSystem);
  if (!target) return null;
  return {
    repoRoot: target.repoRoot,
    relativePaths: unique(committablePaths.map((filePath) => repoRelativePath(target.repoRoot, filePath, versionControlSystem)))
  };
}

export function assertCommitPlanAddable(
  rootDir: string,
  touchedPaths: ReadonlyArray<string>,
  layoutInput: HarnessLayoutInput = rootDir,
  options: {
    readonly forceAddPaths?: ReadonlyArray<string>;
    readonly versionControlSystem?: VersionControlSystem;
  } = {}
): { readonly repoRoot: string; readonly relativePaths: ReadonlyArray<string> } | null {
  const vcs = options.versionControlSystem ?? defaultVersionControlSystem;
  const plan = resolveCommitPlan(rootDir, touchedPaths, layoutInput, vcs);
  if (!plan) return null;
  const forceAdd = resolveForceAddSet(rootDir, options.forceAddPaths ?? [], layoutInput, vcs);
  const ignoredPaths = plan.relativePaths.filter((relativePath) => !forceAdd.has(relativePath) && vcs.isIgnored(plan.repoRoot, relativePath));
  if (ignoredPaths.length > 0) {
    throw new Error(`gitignored authored path requires explicit forceAddPaths: ${ignoredPaths.join(", ")}`);
  }
  return plan;
}

function resolveCommitTarget(rootDir: string, authoredRoot: string, touchedPaths: ReadonlyArray<string>, vcs: VersionControlSystem): { readonly repoRoot: string } | null {
  const authoredRepo = vcs.topLevel(authoredRoot);
  if (!touchedPaths.every((filePath) => isPathInside(authoredRoot, filePath, vcs))) return null;
  if (!authoredRepo) {
    const rootRepo = vcs.topLevel(rootDir);
    if (!rootRepo || !isPathInsideRepo(rootRepo, authoredRoot, vcs)) return null;
    throw new WriteRejectedError(authoredRootNotIsolatedMessage, undefined, { code: authoredRootNotIsolatedCode });
  }
  if (!isSamePath(authoredRepo, authoredRoot, vcs)) {
    throw new WriteRejectedError(authoredRootNotIsolatedMessage, undefined, { code: authoredRootNotIsolatedCode });
  }
  return { repoRoot: authoredRepo };
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
    if (versionControlSystem.refExists(repoRoot, `refs/heads/${candidate}`)) return candidate;
  }
  return "main";
}

function resolveForceAddSet(
  rootDir: string,
  forceAddPaths: ReadonlyArray<string>,
  layoutInput: HarnessLayoutInput,
  vcs: VersionControlSystem
): ReadonlySet<string> {
  if (forceAddPaths.length === 0) return new Set<string>();
  return new Set(resolveCommitPlan(rootDir, forceAddPaths, layoutInput, vcs)?.relativePaths ?? []);
}

function resolveExplicitLogSet(
  rootDir: string,
  explicitLogPaths: ReadonlyArray<string>,
  layoutInput: HarnessLayoutInput,
  vcs: VersionControlSystem
): ReadonlySet<string> {
  if (explicitLogPaths.length === 0) return new Set<string>();
  return new Set(
    (resolveCommitPlan(rootDir, explicitLogPaths, layoutInput, vcs)?.relativePaths ?? [])
      .filter((relativePath) => relativePath.endsWith(".log"))
  );
}

function excludeLocalRootPaths(localRoot: string, touchedPaths: ReadonlyArray<string>, vcs: VersionControlSystem): ReadonlyArray<string> {
  return touchedPaths.filter((filePath) => !isPathInside(localRoot, filePath, vcs));
}

function isPathInside(rootPath: string, filePath: string, vcs: VersionControlSystem): boolean {
  const relativePath = path.relative(vcs.normalizePath(rootPath), vcs.normalizePath(filePath));
  return relativePath.length === 0 || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

function isPathInsideRepo(repoRoot: string, filePath: string, vcs: VersionControlSystem): boolean {
  const relativePath = path.relative(vcs.normalizePath(repoRoot), vcs.normalizePath(filePath));
  return relativePath.length === 0 || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

function isSamePath(left: string, right: string, vcs: VersionControlSystem): boolean {
  return vcs.normalizePath(left) === vcs.normalizePath(right);
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

function hasUnstagedChanges(status: string): boolean {
  return status.split(/\r?\n/u).some((line) => line.length >= 2 && line[1] !== " ");
}

function logPathspecsFor(relativePath: string): ReadonlyArray<string> {
  const normalized = relativePath.replace(/\/+$/u, "");
  if (normalized.length === 0 || normalized === ".") return [":(glob)**/*.log", "*.log"];
  if (normalized.endsWith(".log")) return [normalized];
  return [`:(glob)${normalized}/**/*.log`, `${normalized}/*.log`];
}

export function sessionBranchName(sessionId: string | undefined): string | undefined {
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
