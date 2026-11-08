import { readDistBuildId } from "@harness-anything/daemon/internal/build-identity";
import { resolveGuiPackageRoot } from "./window-config.ts";

export interface GuiBuildStamp {
  readonly commit: string | null;
}

const stamps = new Map<string, GuiBuildStamp>();

/**
 * The GUI's own build identity comes from the same `dist/build-id.txt` artifact the daemon and
 * CLI stamp at build time. It is read once per package root and cached for the process life:
 * a rebuild on disk must not rewrite the identity of the bundle this process already loaded.
 * `gui-system-status/v1` carries the daemon's `build.commitSha`, so the renderer compares the two
 * without a second version source.
 */
export function guiBuildStamp(packageRoot: string = resolveGuiPackageRoot()): GuiBuildStamp {
  const cached = stamps.get(packageRoot);
  if (cached !== undefined) return cached;
  const stamp = { commit: readDistBuildId(packageRoot) };
  stamps.set(packageRoot, stamp);
  return stamp;
}
