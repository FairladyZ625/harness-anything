import { chmodSync, existsSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * node-pty 1.1.0 ships `prebuilds/<platform>-<arch>/spawn-helper` in the npm
 * tarball with mode 0644 (no executable bit). On macOS node-pty fork()s that
 * helper via posix_spawn, so every direct-pty spawn fails with
 * "posix_spawnp failed." until the bit is repaired.
 *
 * The daemon performs the actual pty spawn and loads node-pty from the same
 * install this GUI runs against, so the trusted main process repairs the
 * shared helper file once at startup. Best-effort by design: on failure the
 * original spawn error still surfaces through the terminal control receipt.
 */
export interface SpawnHelperRepair {
  readonly repaired: ReadonlyArray<string>;
  readonly checked: ReadonlyArray<string>;
}

export function ptySpawnHelperCandidates(input: {
  readonly anchorDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
} = {}): string[] {
  const anchorDir = input.anchorDir ?? path.dirname(fileURLToPath(import.meta.url));
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const candidates: string[] = [];
  try {
    const require = createRequire(path.join(anchorDir, "package.json"));
    // realpath: mkdtemp-style installs (and macOS /var symlinks) otherwise
    // produce a candidate path that will never match the file on disk.
    const packageRoot = path.dirname(realpathSync(require.resolve("node-pty/package.json")));
    const prebuild = path.join(packageRoot, "prebuilds", `${platform}-${arch}`, "spawn-helper");
    const release = path.join(packageRoot, "build", "Release", "spawn-helper");
    // node-pty itself rewrites app.asar → app.asar.unpacked before spawning;
    // the packaged copy lives outside the archive, so repair that path too.
    candidates.push(prebuild, release, ...[prebuild, release].map(asarUnpacked));
  } catch (error) {
    // node-pty not resolvable from this anchor (e.g. a checkout without it).
    consumeKnownError(error);
  }
  return [...new Set(candidates)];
}

export function ensurePtySpawnHelperExecutable(input: {
  readonly anchorDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
} = {}): SpawnHelperRepair {
  const repaired: string[] = [], checked: string[] = [];
  for (const candidate of ptySpawnHelperCandidates(input)) {
    try {
      if (!existsSync(candidate)) continue;
      const mode = statSync(candidate).mode;
      checked.push(candidate);
      if ((mode & 0o111) === 0) {
        chmodSync(candidate, mode | 0o111);
        repaired.push(candidate);
      }
    } catch (error) {
      // Read-only install or foreign-owned file: leave the mode untouched.
      consumeKnownError(error);
    }
  }
  return { repaired, checked };
}

function asarUnpacked(value: string): string {
  return value.replaceAll("app.asar", "app.asar.unpacked");
}

function consumeKnownError(error: unknown): void { void error; }
