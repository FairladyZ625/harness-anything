import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { normalizeSlashes } from "../../cli/path.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../../../../kernel/src/index.ts";

export interface AuthoredGitCommitResult {
  readonly attempted: boolean;
  readonly committed: boolean;
  readonly paths: ReadonlyArray<string>;
  readonly reason?: string;
}

export function commitAuthoredPaths(
  rootInput: HarnessLayoutInput,
  relativePaths: ReadonlyArray<string>,
  message: string
): AuthoredGitCommitResult {
  const layout = resolveHarnessLayout(rootInput);
  const paths = validateAuthoredRelativePaths(layout.rootDir, layout.authoredRoot, relativePaths);
  if (paths.length === 0) return { attempted: false, committed: false, paths, reason: "no_paths" };
  const rootRepo = gitTopLevel(layout.rootDir);
  const authoredRepo = gitTopLevel(layout.authoredRoot);
  if (!authoredRepo) return { attempted: false, committed: false, paths, reason: "authored_root_not_git" };
  if (rootRepo && authoredRepo === rootRepo && isIgnoredByRepo(rootRepo, layout.authoredRoot)) {
    throw new Error("authored root is ignored by Git but is not a nested Git repository");
  }

  execFileSync("git", ["-C", layout.authoredRoot, "add", "--force", "--", ...paths], { stdio: "ignore" });
  const staged = execFileSync("git", ["-C", layout.authoredRoot, "diff", "--cached", "--name-only", "--", ...paths], { encoding: "utf8" })
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (staged.length === 0) return { attempted: true, committed: false, paths, reason: "no_changes" };
  // materializer-exempt: authored metadata helpers commit directly because they
  // are outside the WriteCoordinator journal stream.
  execFileSync("git", ["-C", layout.authoredRoot, "commit", "-m", message], { stdio: "ignore", env: authoredGitEnv() });
  return { attempted: true, committed: true, paths: staged.map((entry) => normalizeSlashes(entry)) };
}

export function authoredRelativePath(rootInput: HarnessLayoutInput, absolutePath: string): string {
  const layout = resolveHarnessLayout(rootInput);
  return normalizeSlashes(path.relative(layout.authoredRoot, absolutePath));
}

function validateAuthoredRelativePaths(
  rootDir: string,
  authoredRoot: string,
  relativePaths: ReadonlyArray<string>
): ReadonlyArray<string> {
  const authoredReal = normalizeExistingPath(authoredRoot);
  return [...new Set(relativePaths.map((entry) => normalizeSlashes(entry)).filter(Boolean))]
    .map((entry) => {
      if (path.isAbsolute(entry) || entry === "." || entry === ".." || entry.startsWith("../") || entry.includes("/../")) {
        throw new Error(`authored git path escapes authored root: ${entry}`);
      }
      const absolutePath = path.resolve(authoredRoot, entry);
      const normalizedAbsolute = normalizeExistingPath(absolutePath);
      const relativeToAuthored = path.relative(authoredReal, normalizedAbsolute);
      if (relativeToAuthored === ".." || relativeToAuthored.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToAuthored)) {
        throw new Error(`authored git path escapes authored root: ${entry}`);
      }
      const relativeToRoot = path.relative(normalizeExistingPath(rootDir), normalizedAbsolute);
      if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
        throw new Error(`authored git path escapes project root: ${entry}`);
      }
      return normalizeSlashes(relativeToAuthored);
    })
    .sort();
}

function gitTopLevel(inputPath: string): string | null {
  try {
    return normalizeExistingPath(execFileSync("git", ["-C", inputPath, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
  } catch {
    return null;
  }
}

function isIgnoredByRepo(repoRoot: string, candidatePath: string): boolean {
  const relativePath = normalizeSlashes(path.relative(normalizeExistingPath(repoRoot), normalizeExistingPath(candidatePath)));
  try {
    execFileSync("git", ["-C", repoRoot, "check-ignore", "-q", "--", relativePath], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
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

function authoredGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Harness Anything",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "harness@example.invalid",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Harness Anything",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "harness@example.invalid"
  };
}
