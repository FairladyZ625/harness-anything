import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { discoverTestTierManifest } from "./test-tier-manifest.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const categoryNames = Object.freeze(["filesystem", "path", "process"]);

export const windowsSmokeTestFiles = Object.freeze([
  { path: "packages/cli/test/daemon-autostart-socket-race-cli.test.ts", categories: ["process"] },
  { path: "packages/cli/test/daemon-connect.test.ts", categories: ["path", "process"] },
  { path: "packages/cli/test/local-lifecycle-crlf-cli.test.ts", categories: ["filesystem", "path"] },
  { path: "packages/daemon/test/transport-integration.test.ts", categories: ["path", "process"] },
  { path: "packages/daemon/test/transport-stop-integration.test.ts", categories: ["process"] },
  { path: "packages/kernel/test/layout/portable-path.test.ts", categories: ["path"] },
  { path: "packages/kernel/test/local-runtime-state-file-system.test.ts", categories: ["filesystem"] },
  { path: "packages/kernel/test/store/local-version-control-system.test.ts", categories: ["filesystem", "process"] },
  { path: "tools/run-local-check.test.mjs", categories: ["path", "process"] },
  { path: "tools/run-node-tests-lifecycle.test.mjs", categories: ["process"] },
  { path: "tools/smoke-cli-package.test.mjs", categories: ["filesystem", "process"] }
]);

export function validateWindowsSmokeFiles(entries, manifest, { readSource = () => "" } = {}) {
  const errors = [];
  const tierByFile = new Map(Object.entries(manifest).flatMap(([tier, files]) => files.map((file) => [file, tier])));
  const seen = new Set();
  const tiers = new Set();
  const categories = new Set();
  for (const entry of entries) {
    if (seen.has(entry.path)) errors.push(`duplicate Windows smoke file: ${entry.path}`);
    seen.add(entry.path);
    const tier = tierByFile.get(entry.path);
    if (tier === undefined) errors.push(`Windows smoke file is not present in the test tier manifest: ${entry.path}`);
    else tiers.add(tier);
    if (!Array.isArray(entry.categories) || entry.categories.length === 0) {
      errors.push(`Windows smoke file must declare at least one category: ${entry.path}`);
    } else {
      for (const category of entry.categories) {
        if (!categoryNames.includes(category)) errors.push(`unknown Windows smoke category: ${category}`);
        else categories.add(category);
      }
    }
    try {
      readSource(entry.path);
    } catch (error) {
      errors.push(`Windows smoke file cannot be read: ${entry.path}: ${error.message}`);
    }
  }
  for (const category of categoryNames) {
    if (!categories.has(category)) errors.push(`Windows smoke category has no file: ${category}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    tiers: [...tiers].sort(),
    categories: [...categories].sort()
  };
}

function main() {
  const manifest = discoverTestTierManifest(repoRoot);
  const validation = validateWindowsSmokeFiles(windowsSmokeTestFiles, manifest);
  if (!validation.ok) throw new Error(validation.errors.join("\n"));
  const result = spawnSync(process.execPath, [
    "tools/run-node-tests.mjs",
    ...windowsSmokeTestFiles.flatMap((entry) => ["--file", entry.path])
  ], { cwd: repoRoot, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
