#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "../..");

export function selectGuiSmokeCommand({ platform = process.platform, display, hasXvfbRun, noBuild = true }) {
  const scriptArgs = ["tools/gui-e2e.mjs", "--smoke", ...(noBuild ? ["--no-build"] : [])];
  if (platform !== "linux" || display) {
    return {
      command: process.execPath,
      args: scriptArgs,
      requiresXvfb: false,
      shell: false,
    };
  }
  if (!hasXvfbRun) {
    return {
      command: process.execPath,
      args: scriptArgs,
      requiresXvfb: true,
      missingXvfb: true,
      shell: false,
    };
  }
  return {
    command: "xvfb-run",
    args: ["--auto-servernum", process.execPath, ...scriptArgs],
    requiresXvfb: true,
    shell: false,
  };
}

function binaryExists(name, platform = process.platform) {
  if (platform !== "linux") return false;
  const result = spawnSync(`command -v ${name}`, { shell: "/bin/sh", stdio: "ignore" });
  return result.status === 0;
}

function main(argv = process.argv.slice(2)) {
  const noBuild = !argv.includes("--build");
  const selected = selectGuiSmokeCommand({
    platform: process.platform,
    display: process.env.DISPLAY,
    hasXvfbRun: binaryExists("xvfb-run", process.platform),
    noBuild,
  });

  if (selected.missingXvfb) {
    console.error("GUI Electron E2E smoke requires a display server on Linux. Install xvfb or run under xvfb-run.");
    process.exit(1);
  }

  const result = spawnSync(selected.command, selected.args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    shell: selected.shell,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
