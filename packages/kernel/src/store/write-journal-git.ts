import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";

const gitMaxBuffer = 256 * 1024 * 1024;

export function commitTouchedPaths(rootDir: string, touchedPaths: ReadonlyArray<string>, opIds: ReadonlyArray<string>, layoutInput: HarnessLayoutInput = rootDir): string {
  if (touchedPaths.length === 0) return "no-git-change";

  const plan = resolveCommitPlan(rootDir, touchedPaths, layoutInput);
  if (!plan) return "no-git-change";

  runGit(plan.repoRoot, "add", "-A", "-f", "--", ...plan.relativePaths);
  const staged = runGit(plan.repoRoot, "diff", "--cached", "--name-only", "--", ...plan.relativePaths).trim();
  if (staged.length === 0) return currentGitHead(plan.repoRoot);

  runGit(plan.repoRoot, "commit", "-m", `harness write ${opIds.join(",")}`);
  return currentGitHead(plan.repoRoot);
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
    execFileSync("git", ["-C", repoRoot, "check-ignore", "-q", "--", relativePath], { stdio: "ignore" });
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

function currentGitHead(rootDir: string): string {
  try {
    return execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], { encoding: "utf8", maxBuffer: gitMaxBuffer }).trim();
  } catch {
    return "no-git-head";
  }
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
