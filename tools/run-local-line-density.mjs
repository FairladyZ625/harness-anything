import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./gates/git.mjs";
import { resolveLocalLineBudgetBase } from "./run-local-line-budget.mjs";

export function main(argv = process.argv.slice(2)) {
  if (argv.length > 0) {
    console.error("Local line-density base resolution failed: this command accepts no arguments; its base must come from freshly fetched canonical main.");
    return 1;
  }

  const rootDir = repoRoot();
  let resolved;
  try {
    resolved = resolveLocalLineBudgetBase(rootDir);
  } catch (error) {
    console.error(`Local line-density base resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  console.log(`Local line-density base: ${resolved.remote}/main ${resolved.base}`);
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "gates/line-density.mjs"), "--base", resolved.base], {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) {
    console.error(`Local line-density failed to launch G36: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
