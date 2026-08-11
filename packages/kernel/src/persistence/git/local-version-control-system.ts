import { execFileSync } from "node:child_process";
import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PreservedWorktreeEdit, VcsCommitAuthor, VcsCommitOptions, VersionControlSystem } from "../../ports/version-control-system.ts";
import { VcsCommandError } from "../../ports/version-control-system.ts";
import { resolveGitMaxBufferBytes } from "../../runtime/operational-limits.ts";
import { commitPathsToBranchHeadless } from "./headless-branch-commit.ts";
import { commitWithScopedIndex, nullDelimitedGitPaths } from "./scoped-index-commit.ts";
import { readGitObjectsAtRef, type GitObjectAtRef } from "./batch-object-reader.ts";
import { vcsCommandError } from "./git-command-error.ts";

const gitMaxBuffer = resolveGitMaxBufferBytes();

export function makeLocalVersionControlSystem(options: {
  readonly cacheRepositoryDiscovery?: boolean;
} = {}): VersionControlSystem {
  const topLevels = new Map<string, string>();
  return {
    normalizePath: normalizeExistingPath,
    topLevel: (inputPath) => {
      const normalized = normalizeExistingPath(inputPath);
      const cached = options.cacheRepositoryDiscovery ? topLevels.get(normalized) : undefined;
      if (cached) return cached;
      const resolved = gitTopLevel(normalized);
      // Cache only positive discovery. A caller may create a repository after
      // constructing this adapter; retaining a negative answer would hide it.
      if (resolved && options.cacheRepositoryDiscovery) topLevels.set(normalized, resolved);
      return resolved;
    },
    isIgnored: (repoRoot, relativePath) => {
      try {
        runGit(repoRoot, "check-ignore", "--no-index", "-q", "--", relativePath);
        return true;
      } catch {
        return false;
      }
    },
    ignoredPaths: readIgnoredPaths,
    add: (repoRoot, input) => {
      if (input.paths.length === 0) return;
      runGit(repoRoot, "add", "-A", ...(input.force ? ["-f"] : []), "--", ...input.paths);
    },
    workingTreeFiles: (repoRoot, paths) => runGit(
      repoRoot,
      "-c", "core.quotePath=false",
      "status", "--porcelain", "-uall", "--", ...paths
    ),
    stagedFiles: (repoRoot, paths) => runGit(repoRoot, "diff", "--cached", "--name-only", "--", ...paths),
    commit: (repoRoot, message, author, options?: VcsCommitOptions) => commitWithScopedIndex(
      repoRoot,
      message,
      author,
      {
        runGitBytes,
        runGitWithInput,
        runGitWithEnvironment,
        runGitWithInputEnvironment,
        fileSystem: {
          exists: existsSync,
          lstat: lstatSync,
          readFile: readFileSync,
          readLink: readlinkSync,
          makeTemporaryDirectory: (prefix) => mkdtempSync(path.join(tmpdir(), prefix)),
          removeTemporaryDirectory: (inputPath) => rmSync(inputPath, { recursive: true, force: true })
        }
      },
      options
    ),
    currentHead: (repoRoot) => {
      try {
        return runGit(repoRoot, "rev-parse", "HEAD").trim();
      } catch {
        return "no-git-head";
      }
    },
    currentBranch: (repoRoot) => {
      try {
        const name = runGit(repoRoot, "rev-parse", "--abbrev-ref", "HEAD").trim();
        return name.length > 0 && name !== "HEAD" ? name : null;
      } catch {
        return null;
      }
    },
    originHeadBranch: (repoRoot) => {
      try {
        const ref = runGit(repoRoot, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD").trim();
        if (ref.length === 0) return null;
        const slash = ref.indexOf("/");
        return slash >= 0 ? ref.slice(slash + 1) : ref;
      } catch {
        return null;
      }
    },
    refExists: (repoRoot, ref) => {
      try {
        runGit(repoRoot, "rev-parse", "--verify", "--quiet", ref);
        return true;
      } catch {
        return false;
      }
    },
    commitExists: (repoRoot, sha) => {
      try {
        runGit(repoRoot, "cat-file", "-e", `${sha}^{commit}`);
        return true;
      } catch {
        return false;
      }
    },
    commitMessage: (repoRoot, ref) => runGit(repoRoot, "show", "-s", "--format=%B", ref).trim(),
    resolveCommit: (repoRoot, ref) => {
      let sha: string;
      try {
        sha = runGit(repoRoot, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).trim();
      } catch {
        try {
          const objectType = runGit(repoRoot, "cat-file", "-t", "--", ref).trim();
          return objectType.length > 0
            ? { ok: false, reason: "non-commit", objectType }
            : { ok: false, reason: "missing" };
        } catch {
          return { ok: false, reason: "missing" };
        }
      }
      if (!/^[0-9a-f]{40}$/u.test(sha)) return { ok: false, reason: "missing" };
      try {
        runGit(repoRoot, "merge-base", "--is-ancestor", sha, "HEAD");
        return { ok: true, sha };
      } catch {
        return { ok: false, reason: "missing" };
      }
    },
    pathExistsAtCommit: (repoRoot, sha, relativePath) => {
      try {
        runGit(repoRoot, "cat-file", "-e", `${sha}:${relativePath}`);
        return true;
      } catch {
        return false;
      }
    },
    filesExistingAtCommit: (repoRoot, sha, input) => {
      assertCanonicalFileMembershipInput(input);
      const expectedByBytes = new Map(
        input.relativePaths.map((relativePath) => [gitPathBytesKey(Buffer.from(relativePath, "utf8")), relativePath])
      );
      if (expectedByBytes.size === 0) return new Set();
      const rootPathspec = input.relativeRoot.length === 0
        ? []
        : ["--", `:(top,literal)${input.relativeRoot}`];
      const listing = runGitBytes(
        repoRoot,
        "ls-tree",
        "-r",
        "-z",
        "--full-tree",
        "--name-only",
        sha,
        ...rootPathspec
      );
      const existing = new Set<string>();
      for (const listedPath of nullDelimitedGitPaths(listing)) {
        const expectedPath = expectedByBytes.get(gitPathBytesKey(listedPath));
        if (expectedPath) existing.add(expectedPath);
      }
      return existing;
    },
    checkout: (repoRoot, ref) => {
      runGit(repoRoot, "checkout", ref);
    },
    createBranch: (repoRoot, branch) => {
      runGit(repoRoot, "branch", branch);
    },
    mergeNoFf: (repoRoot, branch, message, author) => {
      runGitAs(repoRoot, author, "merge", "--no-ff", branch, "-m", message);
    },
    conflictedFiles: (repoRoot) => runGit(repoRoot, "diff", "--name-only", "--diff-filter=U", "-z")
      .split("\0")
      .filter(Boolean),
    readConflictStage: (repoRoot, stage, relativePath) => {
      try {
        return runGitBytes(repoRoot, "show", `:${stage}:${relativePath}`);
      } catch {
        return null;
      }
    },
    checkoutConflictSide: (repoRoot, side, paths) => {
      if (paths.length === 0) return;
      runGit(repoRoot, "checkout", `--${side}`, "--", ...paths);
    },
    latestCommitSubjectForPath: (repoRoot, baseRef, branch, relativePath) => {
      try {
        const subject = runGit(repoRoot, "log", "-1", "--format=%s", `${baseRef}..${branch}`, "--", relativePath).trim();
        return subject.length > 0 ? subject : null;
      } catch {
        return null;
      }
    },
    worktreePathExists: (repoRoot, relativePath) => existsSync(worktreePath(repoRoot, relativePath)),
    writeWorktreeFile: (repoRoot, relativePath, body) => {
      const blob = runGitWithInput(repoRoot, body, "hash-object", "-w", "--stdin").trim();
      runGit(repoRoot, "update-index", "--add", "--cacheinfo", "100644", blob, relativePath);
      runGit(repoRoot, "checkout-index", "--force", "--", relativePath);
    },
    removeWorktreePath: (repoRoot, relativePath) => {
      runGit(repoRoot, "reset", "-q", "--", relativePath);
      runGit(repoRoot, "clean", "-fd", "--", relativePath);
    },
    deleteBranch: (repoRoot, branch) => {
      runGit(repoRoot, "branch", "-d", branch);
    },
    abortMerge: (repoRoot) => {
      runGit(repoRoot, "merge", "--abort");
    },
    sessionBranches: (repoRoot) => runGit(repoRoot, "for-each-ref", "--sort=creatordate", "--format=%(refname:short)", "refs/heads/sessions")
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith("sessions/")),
    commitsNotInTrunk: (repoRoot, trunkBranch, branch) => runGit(repoRoot, "log", `${trunkBranch}..${branch}`, "--oneline")
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter(Boolean),
    changedFilesBetween: (repoRoot, before, after) => {
      if (before === after) return [];
      return nullDelimitedGitPaths(
        runGitBytes(repoRoot, "diff", "--name-only", "-z", before, after)
      ).map((entry) => Buffer.from(entry).toString("utf8"));
    },
    resetQuiet: (repoRoot, pathspecs) => {
      if (pathspecs.length === 0) return;
      runGit(repoRoot, "reset", "-q", "--", ...pathspecs);
    },
    commitPathsToBranch: (repoRoot, input) => commitPathsToBranchHeadless(
      repoRoot,
      input,
      {
        runGitBytes,
        runGitWithInput,
        runGitWithEnvironment,
        runGitWithInputEnvironment,
        fileSystem: {
          exists: existsSync,
          lstat: lstatSync,
          readFile: readFileSync,
          readLink: readlinkSync,
          makeTemporaryDirectory: (prefix) => mkdtempSync(path.join(tmpdir(), prefix)),
          removeTemporaryDirectory: (inputPath) => rmSync(inputPath, { recursive: true, force: true })
        }
      }
    ),
    resetWorktreePaths: (repoRoot, ref, paths, options) => {
      if (paths.length === 0) return [];
      const refObjects = readGitObjectsAtRef(repoRoot, ref, paths, runGitBytesWithInput);
      const restoreObjects = options?.restoreRef
        ? readGitObjectsAtRef(repoRoot, options.restoreRef, paths, runGitBytesWithInput)
        : new Map<string, GitObjectAtRef>();
      const preserved: PreservedWorktreeEdit[] = [];
      for (const relativePath of paths) {
        const absolutePath = path.join(repoRoot, ...relativePath.split("/"));
        const rescued = preserveDivergentWorktreeEdit({
          repoRoot,
          relativePath,
          absolutePath,
          restoreBytes: restoreObjects.get(relativePath)?.blobBytes,
          shouldPreserve: options?.restoreRef !== undefined,
          preserveDir: options?.preserveDir
        });
        if (rescued) preserved.push(rescued);
      }
      const existingPaths = paths.filter((relativePath) => refObjects.get(relativePath)?.exists === true);
      const missingPaths = paths.filter((relativePath) => refObjects.get(relativePath)?.exists !== true);
      if (existingPaths.length > 0) {
        try {
          runGit(repoRoot, "checkout", ref, "--", ...existingPaths);
        } catch {
          // The merge will surface a real conflict if Git cannot restore the
          // complete touched set (for example because a path changed type).
        }
      }
      if (missingPaths.length > 0) {
        try {
          runGit(repoRoot, "reset", "-q", "HEAD", "--", ...missingPaths);
        } catch {
          // Paths may not be in the index; they still need removing below so
          // an untracked file cannot block the merge.
        }
        for (const relativePath of missingPaths) {
          try {
            rmSync(path.join(repoRoot, ...relativePath.split("/")), { force: true });
          } catch {
            // Worktree file may already be gone; ignore.
          }
        }
      }
      return preserved;
    }
  };
}

function preserveDivergentWorktreeEdit(input: {
  readonly repoRoot: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly restoreBytes: Buffer | undefined;
  readonly shouldPreserve: boolean;
  readonly preserveDir: string | undefined;
}): PreservedWorktreeEdit | undefined {
  if (!input.shouldPreserve) return undefined;
  let worktreeBytes: Buffer;
  try {
    worktreeBytes = readFileSync(input.absolutePath);
  } catch {
    return undefined;
  }
  if (input.restoreBytes?.equals(worktreeBytes)) return undefined;
  const preserveRoot = input.preserveDir ?? path.join(input.repoRoot, ".harness", "preserved-worktree-edits");
  const stamp = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const target = path.join(preserveRoot, stamp, ...input.relativePath.split("/"));
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, worktreeBytes);
  } catch {
    return undefined;
  }
  return { path: input.relativePath, preservedAt: target };
}

export function gitProtectedPaths(
  repoRoot: string,
  relativeRoot: string
): { readonly tracked: ReadonlySet<string>; readonly historical: ReadonlySet<string> } {
  const pathspec = `:(top,literal)${relativeRoot}`;
  const tracked = new Set(runGit(repoRoot, "ls-files", "-z", "--", pathspec).split("\0").filter(Boolean));
  const historical = new Set(runGit(repoRoot, "log", "--all", "--format=", "--name-only", "-z", "--", pathspec)
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean));
  return { tracked, historical };
}

export function firstCommitAtForPath(repoRoot: string, inputPath: string): string | null {
  const relativePath = path.relative(repoRoot, inputPath);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return null;
  try {
    return runGit(repoRoot, "log", "--reverse", "--format=%aI", "--", relativePath.split(path.sep).join("/"))
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .find(Boolean) ?? null;
  } catch {
    return null;
  }
}

function gitTopLevel(inputPath: string): string | null {
  try {
    return normalizeExistingPath(runGit(inputPath, "rev-parse", "--show-toplevel").trim());
  } catch {
    return null;
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

function worktreePath(repoRoot: string, relativePath: string): string {
  return path.join(repoRoot, ...relativePath.split("/"));
}

function runGit(repoRoot: string, ...args: ReadonlyArray<string>): string {
  return runGitAs(repoRoot, undefined, ...args);
}

function readIgnoredPaths(repoRoot: string, relativePaths: ReadonlyArray<string>): ReadonlySet<string> {
  if (relativePaths.length === 0) return new Set();
  const input = `${relativePaths.join("\0")}\0`;
  try {
    return new Set(runGitWithInput(
      repoRoot,
      input,
      "check-ignore",
      "--no-index",
      "-z",
      "--stdin"
    ).split("\0").filter(Boolean));
  } catch (error) {
    if (error instanceof VcsCommandError && String(error.exitCode) === "1") return new Set();
    throw error;
  }
}

function runGitBytes(repoRoot: string, ...args: ReadonlyArray<string>): Uint8Array {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      ...localGitProcessOptions(),
      encoding: "buffer",
      windowsHide: true
    });
  } catch (error) {
    throw vcsCommandError(repoRoot, args, error);
  }
}

function runGitBytesWithInput(
  repoRoot: string,
  input: string | Uint8Array,
  ...args: ReadonlyArray<string>
): Uint8Array {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      ...localGitProcessOptions(),
      encoding: "buffer",
      input,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
  } catch (error) {
    throw vcsCommandError(repoRoot, args, error);
  }
}

function gitPathBytesKey(input: Uint8Array): string {
  return Buffer.from(input).toString("base64");
}

function assertCanonicalFileMembershipInput(input: {
  readonly relativeRoot: string;
  readonly relativePaths: ReadonlyArray<string>;
}): void {
  assertCanonicalGitPath(input.relativeRoot, "relativeRoot", true);
  for (const relativePath of input.relativePaths) {
    assertCanonicalGitPath(relativePath, "relativePath", false);
    if (input.relativeRoot.length > 0 && !relativePath.startsWith(`${input.relativeRoot}/`)) {
      throw new Error("GIT_FILE_MEMBERSHIP_PATH_OUTSIDE_ROOT");
    }
  }
}

function assertCanonicalGitPath(value: string, label: string, allowEmpty: boolean): void {
  if (value.length === 0 && allowEmpty) return;
  if (value.length === 0
    || value === "."
    || value.includes("\\")
    || value.includes("\0")
    || path.posix.isAbsolute(value)
    || value === ".."
    || value.startsWith("../")
    || path.posix.normalize(value) !== value
    || value.endsWith("/")) {
    throw new Error(`GIT_FILE_MEMBERSHIP_${label.toUpperCase()}_INVALID`);
  }
}

function runGitWithInput(repoRoot: string, input: string | Uint8Array, ...args: ReadonlyArray<string>): string {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      ...localGitProcessOptions(),
      input,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
  } catch (error) {
    throw vcsCommandError(repoRoot, args, error);
  }
}

function runGitWithInputEnvironment(
  repoRoot: string,
  author: VcsCommitAuthor | undefined,
  environment: Readonly<Record<string, string>>,
  input: string | Uint8Array,
  ...args: ReadonlyArray<string>
): string {
  try {
    const options = localGitProcessOptions(author);
    return execFileSync("git", ["-C", repoRoot, ...args], {
      ...options,
      input,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...(options.env ?? {}), ...environment }
    });
  } catch (error) {
    throw vcsCommandError(repoRoot, args, error);
  }
}

function runGitAs(repoRoot: string, author: VcsCommitAuthor | undefined, ...args: ReadonlyArray<string>): string {
  return runGitWithEnvironment(repoRoot, author, {}, ...args);
}

function runGitWithEnvironment(
  repoRoot: string,
  author: VcsCommitAuthor | undefined,
  environment: Readonly<Record<string, string>>,
  ...args: ReadonlyArray<string>
): string {
  try {
    const options = localGitProcessOptions(author);
    return execFileSync("git", ["-C", repoRoot, ...args], {
      ...options,
      env: { ...(options.env ?? {}), ...environment },
      windowsHide: true
    });
  } catch (error) {
    throw vcsCommandError(repoRoot, args, error);
  }
}

export function localGitProcessOptions(author?: VcsCommitAuthor): ExecFileSyncOptionsWithStringEncoding {
  const env = { ...process.env };
  for (const key of gitRepositoryRedirectEnvironmentKeys) delete env[key];
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)) delete env[key];
  }
  return {
    encoding: "utf8",
    maxBuffer: gitMaxBuffer,
    timeout: 15_000,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...env,
      ...(author ? {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? author.name,
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? author.email
      } : {})
    }
  };
}

const gitRepositoryRedirectEnvironmentKeys = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_OBJECT_DIRECTORY",
  "GIT_QUARANTINE_PATH",
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_SUPER_PREFIX",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_GRAFT_FILE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT"
] as const;
