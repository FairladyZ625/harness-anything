import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";

export function git(rootDir, args, options = {}) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: options.encoding ?? "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// The single enumeration port for gates that select check inputs from repository
// directories: tracked plus untracked-but-not-ignored files only. .gitignore is the
// sole ignore authority, so gitignored build output (packages/gui/build-resources,
// dist/, node_modules/) never feeds a violation the way raw readdirSync walks did.
// lstat keeps symlinked entries — file or directory targets — out of the list, the
// way Dirent-based walkers did; throwIfNoEntry skips index entries deleted from the
// worktree without git rm, which ls-files --cached still reports.
export function listWorktreeFiles(rootDir, pathspecs = []) {
  return git(rootDir, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...pathspecs])
    .split("\0")
    .filter(Boolean)
    .filter((file) => lstatSync(path.join(rootDir, file), { throwIfNoEntry: false })?.isFile())
    .sort();
}

export function repoRoot(cwd = process.cwd()) {
  return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

export function pathExistsAt(rootDir, revision, filePath) {
  try {
    git(rootDir, ["cat-file", "-e", `${revision}:${filePath}`]);
    return true;
  } catch {
    return false;
  }
}

export function changedFiles(rootDir, base, head = "HEAD") {
  return git(rootDir, ["diff", "--name-only", "-z", `${base}...${head}`, "--"])
    .split("\0")
    .filter(Boolean);
}

// PR checkers must derive the same diff context locally that CI injects via base/head
// env vars; a missing base ref fails closed with a fix instead of silently skipping checks.
export function pullRequestBase(rootDir) {
  try {
    return git(rootDir, ["merge-base", "origin/main", "HEAD"]).trim();
  } catch {
    throw new Error(
      "Cannot derive the pull request diff context: `git merge-base origin/main HEAD` failed. " +
        "Fetch the base ref with `git fetch origin main` (ensuring refs/remotes/origin/main exists), " +
        "or pass the base/head explicitly (PR_BASE_SHA/PR_HEAD_SHA, or --base/--head where supported).",
    );
  }
}
