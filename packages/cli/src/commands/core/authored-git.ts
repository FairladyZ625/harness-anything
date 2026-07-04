import { execFileSync } from "node:child_process";
import path from "node:path";
import { normalizeSlashes } from "../../cli/path.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../../../../kernel/src/layout/index.ts";

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
  const paths = [...new Set(relativePaths.map((entry) => normalizeSlashes(entry)).filter(Boolean))].sort();
  if (paths.length === 0) return { attempted: false, committed: false, paths, reason: "no_paths" };
  if (!isGitWorkTree(layout.authoredRoot)) return { attempted: false, committed: false, paths, reason: "authored_root_not_git" };

  execFileSync("git", ["-C", layout.authoredRoot, "add", "--force", "--", ...paths], { stdio: "ignore" });
  const staged = execFileSync("git", ["-C", layout.authoredRoot, "diff", "--cached", "--name-only", "--", ...paths], { encoding: "utf8" })
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (staged.length === 0) return { attempted: true, committed: false, paths, reason: "no_changes" };
  execFileSync("git", ["-C", layout.authoredRoot, "commit", "-m", message], { stdio: "ignore" });
  return { attempted: true, committed: true, paths: staged.map((entry) => normalizeSlashes(entry)) };
}

export function authoredRelativePath(rootInput: HarnessLayoutInput, absolutePath: string): string {
  const layout = resolveHarnessLayout(rootInput);
  return normalizeSlashes(path.relative(layout.authoredRoot, absolutePath));
}

function isGitWorkTree(cwd: string): boolean {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).trim() === "true";
  } catch {
    return false;
  }
}
