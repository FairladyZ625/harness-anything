import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import type { CommandRunner } from "../../cli/runner-registry.ts";

export const runVersionCommand: CommandRunner = () =>
  Effect.sync(() => ({ ok: true, command: "version", version: resolveCliVersion() }));

function resolveCliVersion(): string {
  // Walk up from this module to the @harness-anything/cli package.json. Robust
  // across layouts: src, built dist, and installed package layouts.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { readonly name?: unknown; readonly version?: unknown };
        if (pkg.name === "@harness-anything/cli" && typeof pkg.version === "string") return pkg.version;
      } catch {
        // malformed package.json: keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}
