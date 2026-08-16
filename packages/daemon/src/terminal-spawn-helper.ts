import { chmodSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * node-pty 1.1.0 ships `prebuilds/<platform>-<arch>/spawn-helper` in its npm
 * tarball with mode 0644. macOS node-pty posix_spawn()s that helper, so every
 * pty spawn fails with "posix_spawnp failed." until the bit is repaired — under
 * CI (`npm ci` reproduces the tarball mode) and on any machine that never ran
 * the Electron main process. The daemon owns the pty spawn, so it repairs the
 * helper it is about to fork, which covers GUI, CLI, and bare-daemon callers
 * alike. Best-effort: on a read-only or foreign-owned install the original
 * spawn error still surfaces through the terminal control receipt. Returns the
 * repaired path, or null when nothing needed repair or the helper is unreachable.
 */
export function ensurePtySpawnHelperExecutable(input: { readonly anchorDir?: string; readonly platform?: NodeJS.Platform; readonly arch?: NodeJS.Architecture } = {}): string | null {
  try {
    // realpath: mkdtemp-style installs (and macOS /var symlinks) otherwise
    // produce a candidate path that never matches the file on disk.
    const anchorDir = input.anchorDir ?? path.dirname(fileURLToPath(import.meta.url)), packageRoot = path.dirname(realpathSync(createRequire(path.join(anchorDir, "package.json")).resolve("node-pty/package.json")));
    const helper = path.join(packageRoot, "prebuilds", `${input.platform ?? process.platform}-${input.arch ?? process.arch}`, "spawn-helper"), mode = statSync(helper).mode;
    if ((mode & 0o111) !== 0) return null;
    chmodSync(helper, mode | 0o111);
    return helper;
  } catch (error) { consumeKnownError(error); return null; }
}
function consumeKnownError(error: unknown): void { void error; }
