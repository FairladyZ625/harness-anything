#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { collectGuiVitestFiles, validateGuiVitestManifest } from "./gui-test-runner-lib.mjs";
import { guiVitestManifest } from "./gui-test-manifest.mjs";
import { createHermeticTestEnvironment } from "./test-process-environment.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const listOnly = args.includes("--list");

const unknownArgs = args.filter((arg) => arg !== "--list");
if (unknownArgs.length > 0) {
  console.error(`unknown run-gui-tests option: ${unknownArgs[0]}`);
  process.exit(2);
}

const testFiles = await collectGuiVitestFiles(repoRoot);
const validation = validateGuiVitestManifest(testFiles, guiVitestManifest);
if (validation.errors.length > 0) {
  for (const error of validation.errors) {
    console.error(error);
  }
  process.exit(1);
}

if (listOnly) {
  for (const file of guiVitestManifest) {
    console.log(file);
  }
  process.exit(0);
}

if (guiVitestManifest.length === 0) {
  console.log("No GUI Vitest files found.");
  process.exit(0);
}

const npmCli = resolveNpmCli();
const testEnvironment = createHermeticTestEnvironment();
const child = npmCli
  ? spawn(process.execPath, [npmCli, "run", "test:gui", "-w", "@harness-anything/gui"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: testEnvironment.env
  })
  : spawn("npm", ["run", "test:gui", "-w", "@harness-anything/gui"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: testEnvironment.env
});

child.on("error", (error) => {
  testEnvironment.cleanup();
  console.error(error.message);
  process.exit(1);
});

child.on("close", (code, signal) => {
  testEnvironment.cleanup();
  if (signal !== null) {
    console.error(`GUI Vitest runner terminated by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

function resolveNpmCli() {
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    return process.env.npm_execpath;
  }
  const candidate = resolve(process.execPath, "..", "node_modules", "npm", "bin", "npm-cli.js");
  return existsSync(candidate) ? candidate : undefined;
}
