import { existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { runProcessTextAsync } from "./process-port.ts";

/**
 * The built-in `node-modules` worktree setup adapter (dec_8B3FCCD256CAC5B0BF3CCEDE58 CH3). npm workspaces hoist
 * every package's dependencies to the repository root store, so the fresh worktree shares that store entry by
 * entry instead of installing. Linking the whole store would also share its workspace links, and every workspace
 * import would resolve to the canonical checkout's source (F-81A23176); npm writes those links relative
 * (@scope/pkg -> ../../packages/pkg), so a copy of the link lands in the worktree's own packages.
 */
export const nodeModulesSetupAdapter = {
  prepare(input: { readonly rootDir: string; readonly cwd: string }): void {
    if (!existsSync(path.join(input.rootDir, "node_modules")))
      throw new Error(`${path.join(input.rootDir, "node_modules")} does not exist; install dependencies there first.`);
    if (existsSync(path.join(input.cwd, "node_modules"))) return;
    try {
      mirrorStore(input.rootDir, input.cwd, "node_modules");
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

/** Scope directories and .bin hold links of their own, so they are mirrored rather than linked. */
function mirrorStore(rootDir: string, worktreeDir: string, relative: string): void {
  mkdirSync(path.join(worktreeDir, relative));
  for (const entry of readdirSync(path.join(rootDir, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name),
      source = path.join(rootDir, name);
    if (entry.isDirectory() && (entry.name.startsWith("@") || entry.name === ".bin")) {
      mirrorStore(rootDir, worktreeDir, name);
      continue;
    }
    const link = entry.isSymbolicLink() ? readlinkSync(source) : null,
      inRepository =
        link !== null &&
        !path.isAbsolute(link) &&
        !path.relative(rootDir, path.resolve(path.dirname(source), link)).startsWith(".."),
      type = statSync(source, { throwIfNoEntry: false })?.isDirectory() ? "junction" : "file";
    symlinkSync(inRepository ? link : source, path.join(worktreeDir, name), type);
  }
}
