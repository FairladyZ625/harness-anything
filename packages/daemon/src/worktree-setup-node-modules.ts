import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { runProcessTextAsync } from "./process-port.ts";
import { mirrorNodeModules } from "./worktree-node-modules-mirror.ts";

/**
 * The built-in `node-modules` worktree setup adapter (dec_8B3FCCD256CAC5B0BF3CCEDE58 CH3). The mirror is
 * `mirrorNodeModules` — one implementation, shared with `tools/readonly-checkout.mjs`, so a checkout made to read a
 * baseline and a worktree prepared for a task cannot disagree about what "share the store" means.
 */
export const nodeModulesSetupAdapter = {
  async prepare(input: { readonly rootDir: string; readonly cwd: string }): Promise<void> {
    if (!existsSync(path.join(input.rootDir, "node_modules"))) {
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      await runProcessTextAsync(npm, ["ci"], input.rootDir);
      mkdirSync(path.join(input.rootDir, "node_modules"), { recursive: true });
    }
    if (existsSync(path.join(input.cwd, "node_modules"))) return;
    try {
      mirrorNodeModules(input.rootDir, input.cwd);
    } catch (error) {
      // A half-mirrored store would read as prepared on the next run; only a complete mirror stays.
      rmSync(path.join(input.cwd, "node_modules"), { recursive: true, force: true });
      throw error;
    }
  },
  /** The mirror is this adapter's own product; a node_modules the repository tracks is not. */
  async cleanup(cwd: string): Promise<void> {
    if (!existsSync(path.join(cwd, "node_modules"))) return;
    if ((await runProcessTextAsync("git", ["-C", cwd, "ls-files", "--", "node_modules"])).trim()) return;
    rmSync(path.join(cwd, "node_modules"), { recursive: true, force: true });
  },
};
