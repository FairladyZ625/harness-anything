import path from "node:path";
import type { VcsCommitAuthor, VcsCommitPhase } from "../../ports/version-control-system.ts";
import type { ScopedIndexGitOperations } from "./scoped-index-commit.ts";

/**
 * Commit the working-tree state of specific paths to a Git branch without
 * checking out that branch. The working tree, the shared index, and HEAD are
 * never touched — the commit is assembled entirely with plumbing commands on a
 * temporary alternate index.
 *
 * This eliminates the publication window in which the old checkout-based
 * publisher restored the worktree to trunk (clobbering user-authored content)
 * between session commit and materializer merge.
 */
export function commitPathsToBranchHeadless(
  repoRoot: string,
  input: {
    readonly branchName: string;
    readonly baseBranchName: string;
    readonly stagePaths: ReadonlyArray<string>;
    readonly excludePaths: ReadonlySet<string>;
    readonly message: string;
    readonly author?: VcsCommitAuthor;
    readonly onPhase?: (phase: VcsCommitPhase) => void;
  },
  git: ScopedIndexGitOperations
): string {
  const report = (phase: VcsCommitPhase): void => {
    try {
      input.onPhase?.(phase);
    } catch {
      // Telemetry is deliberately non-authoritative.
    }
  };

  // Determine base ref: append to the session branch if it exists, otherwise
  // branch from trunk. refExists is resolved via rev-parse so there is no
  // working-tree or HEAD movement.
  const branchExists = canResolveRef(repoRoot, input.branchName, git);
  const baseRef = branchExists ? input.branchName : input.baseBranchName;
  const [baseSha, baseTreeSha] = git
    .runGitWithEnvironment(repoRoot, undefined, {}, "rev-parse", baseRef, `${baseRef}^{tree}`)
    .trim()
    .split(/\r?\n/u);
  if (!baseSha || !baseTreeSha) throw new Error(`git could not resolve commit and tree for ${baseRef}`);

  const temporaryIndexDirectory = git.fileSystem.makeTemporaryDirectory("ha-git-branch-commit-");
  const temporaryIndex = path.join(temporaryIndexDirectory, "index");
  try {
    const indexEnv: Readonly<Record<string, string>> = { GIT_INDEX_FILE: temporaryIndex };
    git.runGitWithEnvironment(repoRoot, undefined, indexEnv, "read-tree", baseSha);

    report("stage-start");
    const includedPaths = input.stagePaths.filter((relativePath) => !input.excludePaths.has(relativePath));
    const presentPaths = includedPaths.filter((relativePath) => worktreePathExists(repoRoot, relativePath, git));
    const presentPathSet = new Set(presentPaths);
    const removedPaths = includedPaths.filter((relativePath) => !presentPathSet.has(relativePath));
    if (presentPaths.length > 0) {
      git.runGitWithEnvironment(repoRoot, undefined, indexEnv, "update-index", "--add", "--", ...presentPaths);
    }
    if (removedPaths.length > 0) {
      git.runGitWithEnvironment(repoRoot, undefined, indexEnv, "update-index", "--force-remove", "--", ...removedPaths);
    }
    report("stage-done");

    const treeSha = git.runGitWithEnvironment(repoRoot, undefined, indexEnv, "write-tree").trim();
    if (treeSha === baseTreeSha) {
      // Nothing changed relative to the base tree; no commit to create.
      return baseSha;
    }

    report("commit-call-start");
    const commitSha = git
      .runGitWithEnvironment(
        repoRoot,
        input.author,
        {},
        "commit-tree",
        treeSha,
        "-p",
        baseSha,
        "-m",
        input.message
      )
      .trim();
    git.runGitWithEnvironment(
      repoRoot,
      undefined,
      {},
      "update-ref",
      `refs/heads/${input.branchName}`,
      commitSha
    );
    report("commit-call-done");

    return commitSha;
  } finally {
    git.fileSystem.removeTemporaryDirectory(temporaryIndexDirectory);
  }
}

function canResolveRef(repoRoot: string, ref: string, git: ScopedIndexGitOperations): boolean {
  try {
    git.runGitWithEnvironment(repoRoot, undefined, {}, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

function worktreePathExists(repoRoot: string, relativePath: string, git: ScopedIndexGitOperations): boolean {
  const absolutePath = path.join(repoRoot, ...relativePath.split("/"));
  try {
    // lstat (not exists) so broken symlinks are still detected as present —
    // Git stores symlinks as their target text, and update-index --add handles
    // them correctly regardless of whether the target resolves.
    git.fileSystem.lstat(absolutePath);
    return true;
  } catch {
    return false;
  }
}
