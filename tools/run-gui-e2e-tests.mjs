#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHermeticTestEnvironment } from "./test-process-environment.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

export function selectGuiE2eCommand({ platform, display, hasXvfbRun }) {
  const baseCommand = {
    command: "npm",
    args: ["run", "test:e2e", "-w", "@harness-anything/gui"],
    requiresXvfb: false
  };

  if (platform !== "linux" || display) {
    return baseCommand;
  }

  if (!hasXvfbRun) {
    return {
      ...baseCommand,
      requiresXvfb: true,
      missingXvfb: true
    };
  }

  return {
    command: "xvfb-run",
    args: ["--auto-servernum", "npm", ...baseCommand.args],
    requiresXvfb: true
  };
}

function binaryExists(name) {
  const result = spawnSync(`command -v ${name}`, { shell: "/bin/sh", stdio: "ignore" });
  return result.status === 0;
}

function main() {
  const selected = selectGuiE2eCommand({
    platform: process.platform,
    display: process.env.DISPLAY,
    hasXvfbRun: binaryExists("xvfb-run")
  });

  if (selected.missingXvfb) {
    console.error("GUI Electron E2E requires a display server on Linux. Install xvfb or run under xvfb-run.");
    process.exit(1);
  }

  const testEnvironment = createHermeticTestEnvironment();
  let result;
  try {
    result = spawnSync(selected.command, selected.args, {
      cwd: repoRoot,
      env: testEnvironment.env,
      stdio: "inherit"
    });
  } finally {
    testEnvironment.cleanup();
  }

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
