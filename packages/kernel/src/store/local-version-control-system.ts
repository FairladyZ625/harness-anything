import { execFileSync } from "node:child_process";
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
        runGit(repoRoot, "check-ignore", "-q", "--", relativePath);
        return true;
      } catch {
        return false;
      }
    },
    add: (repoRoot, input) => {
      if (input.paths.length === 0) return;
      runGit(repoRoot, "add", "-A", ...(input.force ? ["-f"] : []), "--", ...input.paths);
    },
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
    checkout: (repoRoot, ref) => {
      runGit(repoRoot, "checkout", ref);
    },
    createBranch: (repoRoot, branch) => {
      runGit(repoRoot, "branch", branch);
    },
    mergeNoFf: (repoRoot, branch, message) => {
      runGit(repoRoot, "merge", "--no-ff", branch, "-m", message);
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

function runGit(repoRoot: string, ...args: ReadonlyArray<string>): string {
  return runGitAs(repoRoot, undefined, ...args);
}

function runGitAs(repoRoot: string, author: VcsCommitAuthor | undefined, ...args: ReadonlyArray<string>): string {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      maxBuffer: gitMaxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(author ? {
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? author.name,
          GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? author.email
        } : {})
      }
    });
  } catch (error) {
    throw new VcsCommandError({
      command: args[0] ?? "command",
      cwd: repoRoot,
      exitCode: commandErrorCode(error),
      signal: commandErrorSignal(error),
      stderrSummary: commandErrorSummary(error)
    });
  }
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
