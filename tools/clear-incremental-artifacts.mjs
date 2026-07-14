/**
 * Clear incremental TypeScript/build artifacts that produce false TS6305 reds.
 *
 * `gui-build`'s `vite build` writes packages/gui/dist; a later `tsc -b` is then
 * poisoned by TS6305 "stale output" — a false red that sends you hunting for a
 * type error that does not exist. CI hits a clean checkout so never sees it;
 * local runners must clear it themselves. Any operation that writes gui/dist
 * (worktree add, rebase, a manual build) followed by a `tsc -b` reproduces it.
 *
 * Used by run-ci-equivalent (clears before every job) and run-local-check
 * (clears + retries only when the incremental typecheck fails, so the common
 * path keeps full incremental speed).
 */
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";

export function clearIncrementalArtifacts(root) {
  rmSync(path.join(root, "packages/gui/dist"), { recursive: true, force: true });
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".tsbuildinfo")) rmSync(full, { force: true });
    }
  }
}
