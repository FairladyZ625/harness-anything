import { existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout } from "../../kernel/src/index.ts";

const derivedDirectories = [
  "cache",
  "adopt-claims",
  "generated",
  "restore-drills",
  "runtime/dispatches",
  "doc-sync-claims",
  "fleet-uploads",
  "conflicts",
  "presets",
] as const;

export const cachePurgePreservedPaths = Object.freeze([
  ".harness/store",
  ".harness/wal",
  ".harness/store/imports",
  "harness",
  ".worktrees",
  ".gitignore",
]);

export function purgeRepoCache(rootDir: string): readonly string[] {
  const canonicalRoot = realpathSync(rootDir),
    localRoot = resolveHarnessLayout(canonicalRoot).localRoot,
    removed: string[] = [];
  for (const relative of derivedDirectories) {
    const target = path.join(localRoot, ...relative.split("/"));
    if (!existsSync(target)) continue;
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    removed.push(`.harness/${relative}`);
  }
  if (existsSync(localRoot))
    for (const entry of readdirSync(localRoot)
      .filter((name) => /^r-.*\.sock$/u.test(name))
      .sort()) {
      rmSync(path.join(localRoot, entry), { force: true });
      removed.push(`.harness/${entry}`);
    }
  return removed.sort();
}
