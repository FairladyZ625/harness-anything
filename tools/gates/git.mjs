import { execFileSync } from "node:child_process";

export function git(rootDir, args, options = {}) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: options.encoding ?? "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
