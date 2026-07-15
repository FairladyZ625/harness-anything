import { execFileSync } from "node:child_process";
import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { VcsCommitAuthor, VersionControlSystem } from "../ports/version-control-system.ts";
import { VcsCommandError } from "../ports/version-control-system.ts";

const gitMaxBuffer = 256 * 1024 * 1024;

export function makeLocalVersionControlSystem(): VersionControlSystem {
  return {
    normalizePath: normalizeExistingPath,
    topLevel: gitTopLevel,
    isIgnored: (repoRoot, relativePath) => {
      try {
        runGit(repoRoot, "check-ignore", "--no-index", "-q", "--", relativePath);
        return true;
      } catch {
        return false;
      }
    },
    add: (repoRoot, input) => {
      if (input.paths.length === 0) return;
      runGit(repoRoot, "add", "-A", ...(input.force ? ["-f"] : []), "--", ...input.paths);
    },
    workingTreeFiles: (repoRoot, paths) => runGit(repoRoot, "status", "--porcelain", "-uall", "--", ...paths),
    stagedFiles: (repoRoot, paths) => runGit(repoRoot, "diff", "--cached", "--name-only", "--", ...paths),
    commit: (repoRoot, message, author) => {
      runGitAs(repoRoot, author, "commit", "-m", message);
    },
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
    pathExistsAtCommit: (repoRoot, sha, relativePath) => {
      try {
        runGit(repoRoot, "cat-file", "-e", `${sha}:${relativePath}`);
        return true;
      } catch {
        return false;
      }
    },
    checkout: (repoRoot, ref) => {
      runGit(repoRoot, "checkout", ref);
    },
    createBranch: (repoRoot, branch) => {
      runGit(repoRoot, "branch", branch);
    },
    mergeNoFf: (repoRoot, branch, message) => {
      runGit(repoRoot, "merge", "--no-ff", branch, "-m", message);
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
      return runGit(repoRoot, "diff", "--name-only", before, after)
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .filter(Boolean);
    },
    resetQuiet: (repoRoot, pathspecs) => {
      if (pathspecs.length === 0) return;
      runGit(repoRoot, "reset", "-q", "--", ...pathspecs);
    }
  };
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

function runGitAs(repoRoot: string, author: VcsCommitAuthor | undefined, ...args: ReadonlyArray<string>): string {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], localGitProcessOptions(author));
  } catch (error) {
    throw vcsCommandError(repoRoot, args, error);
  }
}

function vcsCommandError(repoRoot: string, args: ReadonlyArray<string>, error: unknown): VcsCommandError {
  return new VcsCommandError({
    command: args[0] ?? "command",
    cwd: repoRoot,
    exitCode: commandErrorCode(error),
    signal: commandErrorSignal(error),
    stderrSummary: commandErrorSummary(error)
  });
}

export function localGitProcessOptions(author?: VcsCommitAuthor): ExecFileSyncOptionsWithStringEncoding {
  return {
    encoding: "utf8",
    maxBuffer: gitMaxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      ...(author ? {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? author.name,
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? author.email
      } : {})
    }
  };
}

function commandErrorCode(error: unknown): string | number | undefined {
  if (typeof error === "object" && error && "status" in error) {
    const status = (error as { readonly status?: unknown }).status;
    if (typeof status === "number" || typeof status === "string") return status;
  }
  if (typeof error === "object" && error && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "number" || typeof code === "string") return code;
  }
  return undefined;
}

function commandErrorSignal(error: unknown): string | undefined {
  if (typeof error === "object" && error && "signal" in error) {
    const signal = (error as { readonly signal?: unknown }).signal;
    if (typeof signal === "string" && signal.length > 0) return signal;
  }
  return undefined;
}

function commandErrorSummary(error: unknown): string | undefined {
  if (typeof error === "object" && error && "stderr" in error) {
    const stderr = (error as { readonly stderr?: unknown }).stderr;
    const text = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : typeof stderr === "string" ? stderr : "";
    const firstLine = text.trim().split(/\r?\n/u).find((line) => line.trim().length > 0);
    if (firstLine) return firstLine;
  }
  if (error instanceof Error) return error.message.split(/\r?\n/u)[0] ?? error.message;
  return String(error);
}
