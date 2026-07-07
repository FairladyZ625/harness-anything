import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";

const gitMaxBuffer = 256 * 1024 * 1024;

export function commitTouchedPaths(
  rootDir: string,
  touchedPaths: ReadonlyArray<string>,
  opIds: ReadonlyArray<string>,
  layoutInput: HarnessLayoutInput = rootDir,
  message?: string,
  sessionId?: string,
  options: { readonly respectGitignorePaths?: ReadonlyArray<string> } = {}
): string {
  if (touchedPaths.length === 0) return "no-git-change";

  const plan = resolveCommitPlan(rootDir, touchedPaths, layoutInput);
  if (!plan) return "no-git-change";
  const respectGitignore = new Set(resolveCommitPlan(rootDir, options.respectGitignorePaths ?? [], layoutInput)?.relativePaths ?? []);
  const forcedPaths = plan.relativePaths.filter((relativePath) => !respectGitignore.has(relativePath));
  const unforcedPaths = plan.relativePaths.filter((relativePath) => respectGitignore.has(relativePath));
  const sessionBranch = sessionBranchName(sessionId);

  if (sessionBranch) checkoutSessionBranch(plan.repoRoot, sessionBranch);
  try {
    if (forcedPaths.length > 0) runGit(plan.repoRoot, "add", "-A", "-f", "--", ...forcedPaths);
    if (unforcedPaths.length > 0) runGit(plan.repoRoot, "add", "-A", "--", ...unforcedPaths);
    unstageLogFiles(plan.repoRoot, plan.relativePaths);
    const staged = runGit(plan.repoRoot, "diff", "--cached", "--name-only", "--", ...plan.relativePaths).trim();
    if (staged.length === 0) return currentGitHead(plan.repoRoot);

    runGit(plan.repoRoot, "commit", "-m", message ?? `harness write ${opIds.join(",")}`);
    return currentGitHead(plan.repoRoot);
  } finally {
    if (sessionBranch) runGit(plan.repoRoot, "checkout", "master");
  }
}

export function resolveCommitPlan(rootDir: string, touchedPaths: ReadonlyArray<string>, layoutInput: HarnessLayoutInput = rootDir): { readonly repoRoot: string; readonly relativePaths: ReadonlyArray<string> } | null {
  if (touchedPaths.length === 0) return null;
  const target = resolveCommitTarget(rootDir, resolveHarnessLayout(layoutInput).authoredRoot);
  if (!target) return null;
  return {
    repoRoot: target.repoRoot,
    relativePaths: unique(touchedPaths.map((filePath) => repoRelativePath(target.repoRoot, filePath)))
  };
}

function resolveCommitTarget(rootDir: string, authoredRoot: string): { readonly repoRoot: string } | null {
  const rootRepo = gitTopLevel(rootDir);
  const authoredRepo = gitTopLevel(authoredRoot);
  if (!authoredRepo) return rootRepo ? { repoRoot: rootRepo } : null;
  if (rootRepo && authoredRepo === rootRepo && isIgnoredByRepo(rootRepo, authoredRoot)) {
    throw new Error("authored root is ignored by Git but is not a nested Git repository");
  }
  return { repoRoot: authoredRepo };
}

export function ledgerGitTopLevel(inputPath: string): string | null {
  return gitTopLevel(inputPath);
}

export function checkoutMaster(repoRoot: string): void {
  runGit(repoRoot, "checkout", "master");
}

export function mergeNoFf(repoRoot: string, branch: string, message: string): void {
  runGit(repoRoot, "merge", "--no-ff", branch, "-m", message);
}

export function deleteBranch(repoRoot: string, branch: string): void {
  runGit(repoRoot, "branch", "-d", branch);
}

export function abortMerge(repoRoot: string): void {
  runGit(repoRoot, "merge", "--abort");
}

export function sessionBranches(repoRoot: string): ReadonlyArray<string> {
  return runGit(repoRoot, "for-each-ref", "--sort=creatordate", "--format=%(refname:short)", "refs/heads/sessions")
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("sessions/"));
}

export function commitsNotInMaster(repoRoot: string, branch: string): ReadonlyArray<string> {
  return runGit(repoRoot, "log", `master..${branch}`, "--oneline")
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function currentGitHead(repoRoot: string): string {
  try {
    return runGit(repoRoot, "rev-parse", "HEAD").trim();
  } catch {
    return "no-git-head";
  }
}

export function changedFilesBetween(repoRoot: string, before: string, after: string): ReadonlyArray<string> {
  if (before === after) return [];
  return runGit(repoRoot, "diff", "--name-only", before, after)
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function refExists(repoRoot: string, ref: string): boolean {
  try {
    runGit(repoRoot, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
}

function gitTopLevel(inputPath: string): string | null {
  try {
    return normalizeExistingPath(execFileSync("git", ["-C", inputPath, "rev-parse", "--show-toplevel"], { encoding: "utf8", maxBuffer: gitMaxBuffer, stdio: ["ignore", "pipe", "pipe"] }).trim());
  } catch {
    return null;
  }
}

function isIgnoredByRepo(repoRoot: string, candidatePath: string): boolean {
  const relativePath = repoRelativePath(repoRoot, candidatePath);
  try {
    runGit(repoRoot, "check-ignore", "-q", "--", relativePath);
    return true;
  } catch {
    return false;
  }
}

function repoRelativePath(repoRoot: string, filePath: string): string {
  const relativePath = path.relative(normalizeExistingPath(repoRoot), normalizeExistingPath(filePath));
  if (relativePath.length === 0) return ".";
  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error("touched path is outside commit repository");
  }
  return relativePath.split(path.sep).join("/");
}

function normalizeExistingPath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  if (existsSync(resolved)) return realpathSync.native(resolved);

  const pendingSegments: string[] = [];
  let current = resolved;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    pendingSegments.unshift(path.basename(current));
    current = parent;
  }
  return path.join(realpathSync.native(current), ...pendingSegments);
}

function runGit(repoRoot: string, ...args: ReadonlyArray<string>): string {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      maxBuffer: gitMaxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Harness Anything",
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "harness@example.invalid",
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Harness Anything",
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "harness@example.invalid"
      }
    });
  } catch (error) {
    throw new Error(`git ${args[0] ?? "command"} failed: ${gitErrorMessage(error)}`);
  }
}

function unstageLogFiles(repoRoot: string, relativePaths: ReadonlyArray<string>): void {
  const logPathspecs = relativePaths.flatMap((relativePath) => logPathspecsFor(relativePath));
  if (logPathspecs.length === 0) return;
  runGit(repoRoot, "reset", "-q", "--", ...unique(logPathspecs));
}

function logPathspecsFor(relativePath: string): ReadonlyArray<string> {
  const normalized = relativePath.replace(/\/+$/u, "");
  if (normalized.length === 0 || normalized === ".") return [":(glob)**/*.log", "*.log"];
  if (normalized.endsWith(".log")) return [normalized];
  return [`:(glob)${normalized}/**/*.log`, `${normalized}/*.log`];
}

function checkoutSessionBranch(repoRoot: string, branchName: string): void {
  runGit(repoRoot, "checkout", "master");
  if (!branchExists(repoRoot, branchName)) {
    runGit(repoRoot, "branch", branchName);
  }
  runGit(repoRoot, "checkout", branchName);
}

function branchExists(repoRoot: string, branchName: string): boolean {
  try {
    runGit(repoRoot, "rev-parse", "--verify", "--quiet", branchName);
    return true;
  } catch {
    return false;
  }
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

function gitErrorMessage(error: unknown): string {
  if (typeof error === "object" && error && "code" in error && typeof (error as { readonly code?: unknown }).code === "string") {
    const code = (error as { readonly code: string }).code;
    if (code.length > 0) return code;
  }
  if (typeof error === "object" && error && "stderr" in error) {
    const stderr = (error as { readonly stderr?: unknown }).stderr;
    const text = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : typeof stderr === "string" ? stderr : "";
    const firstLine = text.trim().split(/\r?\n/u).find((line) => line.trim().length > 0);
    if (firstLine) return firstLine;
  }
  if (error instanceof Error) return error.message.split(/\r?\n/u)[0] ?? error.message;
  return String(error);
}
