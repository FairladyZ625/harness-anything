import path from "node:path";
import type { VcsCommitAuthor } from "../../ports/version-control-system.ts";

interface StagedIndexEntry {
  readonly mode: string;
  readonly object: string;
}

export interface ScopedIndexGitOperations {
  readonly runGitBytes: (repoRoot: string, ...args: ReadonlyArray<string>) => Uint8Array;
  readonly runGitWithInput: (repoRoot: string, input: string | Uint8Array, ...args: ReadonlyArray<string>) => string;
  readonly runGitWithEnvironment: (
    repoRoot: string,
    author: VcsCommitAuthor | undefined,
    environment: Readonly<Record<string, string>>,
    ...args: ReadonlyArray<string>
  ) => string;
  readonly runGitWithInputEnvironment: (
    repoRoot: string,
    author: VcsCommitAuthor | undefined,
    environment: Readonly<Record<string, string>>,
    input: string | Uint8Array,
    ...args: ReadonlyArray<string>
  ) => string;
  readonly fileSystem: ScopedIndexFileSystem;
}

interface ScopedIndexFileStats {
  readonly mode: number;
  readonly isSymbolicLink: () => boolean;
}

interface ScopedIndexFileSystem {
  readonly exists: (inputPath: string) => boolean;
  readonly lstat: (inputPath: string) => ScopedIndexFileStats;
  readonly readFile: (inputPath: string) => Uint8Array;
  readonly readLink: (inputPath: string) => string | Uint8Array;
  readonly makeTemporaryDirectory: (prefix: string) => string;
  readonly removeTemporaryDirectory: (inputPath: string) => void;
}

/**
 * Commit the already-staged work through a small alternate index. Git's
 * ordinary commit refreshes every stat-invalid entry before invoking hooks;
 * this is particularly expensive after copy-on-write restores. The alternate
 * index starts at HEAD and receives only the staged entries, while the normal
 * commit command (and therefore all configured hooks) remains in use.
 *
 * If the worktree differs from the staged content, or the index contains an
 * unsupported/unmerged shape, fall back to Git's native commit so staged-versus-
 * unstaged semantics remain exact.
 */
export function commitWithScopedIndex(
  repoRoot: string,
  message: string,
  author: VcsCommitAuthor | undefined,
  git: ScopedIndexGitOperations
): void {
  let stagedPaths: ReadonlyArray<string>;
  try {
    stagedPaths = stagedGitPaths(repoRoot, git);
  } catch {
    git.runGitWithEnvironment(repoRoot, author, {}, "commit", "-m", message);
    return;
  }
  if (stagedPaths.length === 0) {
    git.runGitWithEnvironment(repoRoot, author, {}, "commit", "-m", message);
    return;
  }

  let stagedEntries: Map<string, StagedIndexEntry | undefined> | null;
  try {
    stagedEntries = readStagedIndexEntries(repoRoot, stagedPaths, git);
  } catch {
    git.runGitWithEnvironment(repoRoot, author, {}, "commit", "-m", message);
    return;
  }
  if (!stagedEntries || !worktreeMatchesStagedEntries(repoRoot, stagedEntries, git)) {
    git.runGitWithEnvironment(repoRoot, author, {}, "commit", "-m", message);
    return;
  }

  const temporaryIndexDirectory = git.fileSystem.makeTemporaryDirectory("ha-git-commit-index-");
  const temporaryIndex = path.join(temporaryIndexDirectory, "index");
  try {
    const environment = { GIT_INDEX_FILE: temporaryIndex };
    try {
      git.runGitWithEnvironment(repoRoot, undefined, environment, "read-tree", "HEAD");
    } catch {
      git.runGitWithEnvironment(repoRoot, undefined, environment, "read-tree", "--empty");
    }
    // The alternate index is a complete HEAD tree, but its stat tuples are
    // intentionally not copied from the possibly cold original index. Mark
    // every HEAD entry index-only so commit's refresh cannot stat the entire
    // authored tree; staged entries are cleared below before commit.
    const headPaths = git.runGitWithEnvironment(repoRoot, undefined, environment, "ls-files", "-z");
    if (headPaths.length > 0) {
      git.runGitWithInputEnvironment(
        repoRoot,
        undefined,
        environment,
        Buffer.from(headPaths, "utf8"),
        "update-index",
        "--skip-worktree",
        "-z",
        "--stdin"
      );
    }
    for (const relativePath of stagedPaths) {
      const entry = stagedEntries.get(relativePath);
      if (entry) {
        git.runGitWithEnvironment(
          repoRoot,
          undefined,
          environment,
          "update-index",
          "--add",
          "--cacheinfo",
          entry.mode,
          entry.object,
          relativePath
        );
        git.runGitWithEnvironment(repoRoot, undefined, environment, "update-index", "--no-skip-worktree", "--", relativePath);
      } else {
        git.runGitWithEnvironment(repoRoot, undefined, environment, "update-index", "--force-remove", "--", relativePath);
      }
    }

    git.runGitWithEnvironment(repoRoot, author, environment, "commit", "-m", message);

    // stagedGitPaths enumerates the complete pre-hook staged set, so the
    // alternate index contains every change the normal commit would have
    // consumed. Re-read HEAD into the original index without touching the
    // worktree; this keeps the next publication from paying a second refresh.
    git.runGitWithEnvironment(repoRoot, undefined, {}, "read-tree", "HEAD");
  } finally {
    git.fileSystem.removeTemporaryDirectory(temporaryIndexDirectory);
  }
}

function stagedGitPaths(repoRoot: string, git: ScopedIndexGitOperations): ReadonlyArray<string> {
  return nullDelimitedGitPaths(git.runGitBytes(repoRoot, "diff", "--cached", "--no-renames", "--name-only", "-z", "--"))
    .map((input) => Buffer.from(input).toString("utf8"));
}

function readStagedIndexEntries(
  repoRoot: string,
  stagedPaths: ReadonlyArray<string>,
  git: ScopedIndexGitOperations
): Map<string, StagedIndexEntry | undefined> | null {
  const entriesByPath = new Map<string, StagedIndexEntry[]>();
  const listing = git.runGitBytes(repoRoot, "ls-files", "--stage", "-z", "--", ...stagedPaths);
  for (const record of nullDelimitedGitPaths(listing)) {
    const separator = record.indexOf(9);
    if (separator < 0) return null;
    const metadata = Buffer.from(record.subarray(0, separator)).toString("ascii").split(" ");
    const relativePath = Buffer.from(record.subarray(separator + 1)).toString("utf8");
    if (metadata.length !== 3 || !metadata[0] || !metadata[1] || !metadata[2]) return null;
    const entries = entriesByPath.get(relativePath) ?? [];
    entries.push({ mode: metadata[0], object: metadata[1] });
    entriesByPath.set(relativePath, entries);
  }

  const result = new Map<string, StagedIndexEntry | undefined>();
  for (const relativePath of stagedPaths) {
    const entries = entriesByPath.get(relativePath) ?? [];
    if (entries.length > 1) return null;
    result.set(relativePath, entries[0]);
  }
  return result;
}

function worktreeMatchesStagedEntries(
  repoRoot: string,
  stagedEntries: ReadonlyMap<string, StagedIndexEntry | undefined>,
  git: ScopedIndexGitOperations
): boolean {
  for (const [relativePath, entry] of stagedEntries) {
    const worktreePath = path.join(repoRoot, ...relativePath.split("/"));
    if (!entry) {
      if (git.fileSystem.exists(worktreePath)) return false;
      continue;
    }
    let stats: ScopedIndexFileStats;
    let body: Uint8Array;
    try {
      stats = git.fileSystem.lstat(worktreePath);
      body = stats.isSymbolicLink()
        ? Buffer.from(git.fileSystem.readLink(worktreePath))
        : git.fileSystem.readFile(worktreePath);
    } catch {
      return false;
    }
    if (gitWorktreeMode(stats) !== entry.mode) return false;
    try {
      const object = git.runGitWithInput(repoRoot, body, "hash-object", `--path=${relativePath}`, "--stdin").trim();
      if (object !== entry.object) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function gitWorktreeMode(stats: ScopedIndexFileStats): string {
  if (stats.isSymbolicLink()) return "120000";
  return stats.mode & 0o111 ? "100755" : "100644";
}

export function nullDelimitedGitPaths(input: Uint8Array): ReadonlyArray<Uint8Array> {
  const paths: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== 0) continue;
    paths.push(input.subarray(start, index));
    start = index + 1;
  }
  if (start !== input.length) {
    throw new Error("GIT_PATH_LIST_NUL_TERMINATOR_MISSING");
  }
  return paths;
}
