import { execFileSync } from "node:child_process";

export function git(rootDir, args, options = {}) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: options.encoding ?? "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
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
  return git(rootDir, ["diff", "--name-only", "-z", base, head, "--"])
    .split("\0")
    .filter(Boolean);
}
