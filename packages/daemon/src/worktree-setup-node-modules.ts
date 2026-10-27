import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { runProcessTextAsync } from "./process-port.ts";
import { mirrorNodeModules } from "./worktree-node-modules-mirror.ts";

/**
 * The built-in `node-modules` worktree setup adapter (dec_8B3FCCD256CAC5B0BF3CCEDE58 CH3). The mirror is
 * `mirrorNodeModules` — one implementation, shared with `tools/readonly-checkout.mjs`, so a checkout made to read a
 * baseline and a worktree prepared for a task cannot disagree about what "share the store" means.
 *
 * The worktree is the only directory this adapter installs into. Its store root is whatever the operator already
 * installed in the main checkout; a remote edge has no such checkout — the node's rootDir is the Harness workspace,
 * whose ancestors carry no package manifest — so installing "at the store root" there either failed outright or,
 * where an ancestor does carry one, reified that unrelated tree instead (2026-10-27). Sharing a store the checkout
 * does not own is the only thing that directory is good for; a worktree with no store to share installs its own.
 */
export const nodeModulesSetupAdapter = {
  async prepare(input: { readonly rootDir: string; readonly cwd: string }): Promise<void> {
    if (existsSync(path.join(input.cwd, "node_modules"))) return;
    if (existsSync(path.join(input.rootDir, "node_modules"))) {
      try {
        mirrorNodeModules(input.rootDir, input.cwd);
      } catch (error) {
        // A half-mirrored store would read as prepared on the next run; only a complete mirror stays.
        rmSync(path.join(input.cwd, "node_modules"), { recursive: true, force: true });
        throw error;
      }
      return;
    }
    // `npm ci` looks for a lockfile in ancestor directories when the working directory has none, and installs the
    // tree of whichever one it finds. Naming the worktree's own lockfile keeps the install inside the worktree and
    // turns a missing one into this step's failure instead of a write to some ancestor's dependencies.
    if (!["package-lock.json", "npm-shrinkwrap.json"].some((name) => existsSync(path.join(input.cwd, name)))) {
      throw new Error(
        `${path.join(input.rootDir, "node_modules")} does not exist and ${input.cwd} has no package-lock.json or ` +
          "npm-shrinkwrap.json to install from; share a store from the main checkout or commit a lockfile.",
      );
    }
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    await runProcessTextAsync(npm, ["ci"], input.cwd);
  },
  /** The mirror is this adapter's own product; a node_modules the repository tracks is not. */
  async cleanup(cwd: string): Promise<void> {
    if (!existsSync(path.join(cwd, "node_modules"))) return;
    if ((await runProcessTextAsync("git", ["-C", cwd, "ls-files", "--", "node_modules"])).trim()) return;
    rmSync(path.join(cwd, "node_modules"), { recursive: true, force: true });
  },
};
