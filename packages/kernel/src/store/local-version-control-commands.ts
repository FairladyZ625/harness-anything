import { consumeKnownError } from "../error-consumption.ts";
import type {
  VcsCommitAuthor,
  VersionControlSystem,
} from "../ports/version-control-system.ts";

interface LocalVersionControlCommandAdapter {
  readonly normalizePath: (inputPath: string) => string;
  readonly topLevel: (inputPath: string) => string | null;
  readonly execute: (
    repoRoot: string,
    ...args: ReadonlyArray<string>
  ) => string;
  readonly executeAs: (
    repoRoot: string,
    author: VcsCommitAuthor | undefined,
    ...args: ReadonlyArray<string>
  ) => string;
}

export function makeLocalVersionControlCommands(
  adapter: LocalVersionControlCommandAdapter,
): VersionControlSystem {
  const execute = adapter.execute;
  return {
    normalizePath: adapter.normalizePath,
    topLevel: adapter.topLevel,
    isIgnored: (repoRoot, relativePath) => {
      try {
        execute(
          repoRoot,
          "check-ignore",
          "--no-index",
          "-q",
          "--",
          relativePath,
        );
        return true;
      } catch {
        return false;
      }
    },
    add: (repoRoot, input) => {
      if (input.paths.length === 0) return;
      execute(
        repoRoot,
        "add",
        "-A",
        ...(input.force ? ["-f"] : []),
        "--",
        ...input.paths,
      );
    },
    workingTreeFiles: (repoRoot, paths) =>
      execute(repoRoot, "status", "--porcelain", "-uall", "--", ...paths),
    stagedFiles: (repoRoot, paths) =>
      execute(repoRoot, "diff", "--cached", "--name-only", "--", ...paths),
    commit: (repoRoot, message, author) => {
      adapter.executeAs(repoRoot, author, "commit", "-m", message);
    },
    currentHead: (repoRoot) => {
      try {
        return execute(repoRoot, "rev-parse", "HEAD").trim();
      } catch {
        return "no-git-head";
      }
    },
    currentBranch: (repoRoot) => {
      try {
        const name = execute(
          repoRoot,
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ).trim();
        return name.length > 0 && name !== "HEAD" ? name : null;
      } catch (error) {
        consumeKnownError(error);
        return null;
      }
    },
    originHeadBranch: (repoRoot) => {
      try {
        const ref = execute(
          repoRoot,
          "symbolic-ref",
          "--quiet",
          "--short",
          "refs/remotes/origin/HEAD",
        ).trim();
        if (ref.length === 0) return null;
        const slash = ref.indexOf("/");
        return slash >= 0 ? ref.slice(slash + 1) : ref;
      } catch (error) {
        consumeKnownError(error);
        return null;
      }
    },
    refExists: (repoRoot, ref) => {
      try {
        execute(repoRoot, "rev-parse", "--verify", "--quiet", ref);
        return true;
      } catch {
        return false;
      }
    },
    commitExists: (repoRoot, sha) => {
      try {
        execute(repoRoot, "cat-file", "-e", `${sha}^{commit}`);
        return true;
      } catch {
        return false;
      }
    },
    pathExistsAtCommit: (repoRoot, sha, relativePath) => {
      try {
        execute(repoRoot, "cat-file", "-e", `${sha}:${relativePath}`);
        return true;
      } catch {
        return false;
      }
    },
    checkout: (repoRoot, ref) => {
      execute(repoRoot, "checkout", ref);
    },
    createBranch: (repoRoot, branch) => {
      execute(repoRoot, "branch", branch);
    },
    mergeNoFf: (repoRoot, branch, message) => {
      execute(repoRoot, "merge", "--no-ff", branch, "-m", message);
    },
    deleteBranch: (repoRoot, branch) => {
      execute(repoRoot, "branch", "-d", branch);
    },
    abortMerge: (repoRoot) => {
      execute(repoRoot, "merge", "--abort");
    },
    sessionBranches: (repoRoot) =>
      execute(
        repoRoot,
        "for-each-ref",
        "--sort=creatordate",
        "--format=%(refname:short)",
        "refs/heads/sessions",
      )
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .filter((entry) => entry.startsWith("sessions/")),
    commitsNotInTrunk: (repoRoot, trunkBranch, branch) =>
      execute(repoRoot, "log", `${trunkBranch}..${branch}`, "--oneline")
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .filter(Boolean),
    changedFilesBetween: (repoRoot, before, after) => {
      if (before === after) return [];
      return execute(repoRoot, "diff", "--name-only", before, after)
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .filter(Boolean);
    },
    resetQuiet: (repoRoot, pathspecs) => {
      if (pathspecs.length === 0) return;
      execute(repoRoot, "reset", "-q", "--", ...pathspecs);
    },
  };
}
