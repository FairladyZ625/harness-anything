#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { collectGuiVitestFiles } from "./gui-test-runner-lib.mjs";
import { readTestQuarantine } from "./test-quarantine.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
process.exitCode = await main();

async function main() {
  const args = process.argv.slice(2);
  const listOnly = args.includes("--list");

  const unknownArgs = args.filter((arg) => arg !== "--list");
  if (unknownArgs.length > 0) {
    console.error(`unknown run-gui-tests option: ${unknownArgs[0]}`);
    return 2;
  }

  const testFiles = await collectGuiVitestFiles(repoRoot);

  if (listOnly) {
    for (const file of testFiles) {
      console.log(file);
    }
    return 0;
  }

  if (testFiles.length === 0) {
    console.log("No GUI Vitest files found.");
    return 0;
  }

  const npmCli = resolveNpmCli();
  const vitestResults = process.env.HARNESS_CI_VITEST_RESULTS ?? process.env.HARNESS_CI_OBSERVATION_RAW;
  const quarantinePattern =
    process.env.HARNESS_TEST_QUARANTINE === "skip"
      ? excludedTestNamePattern(readTestQuarantine(repoRoot).map((entry) => entry.test))
      : null;
  const vitestArgs = [
    ...(vitestResults
      ? ["--reporter=default", "--reporter=json", `--outputFile=${resolve(repoRoot, vitestResults)}`]
      : []),
    ...(quarantinePattern ? [`--testNamePattern=${quarantinePattern}`] : []),
  ];
  const observationArgs = vitestArgs.length > 0 ? ["--", ...vitestArgs] : [];
  const child = npmCli
    ? spawn(process.execPath, [npmCli, "run", "test:gui", "-w", "@harness-anything/gui", ...observationArgs], {
        cwd: repoRoot,
        stdio: "inherit",
      })
    : spawn("npm", ["run", "test:gui", "-w", "@harness-anything/gui", ...observationArgs], {
        cwd: repoRoot,
        stdio: "inherit",
      });

  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

  child.on("close", (code, signal) => {
    if (signal !== null) {
      console.error(`GUI Vitest runner terminated by signal ${signal}`);
      process.exitCode = 1;
    }
    process.exitCode = code ?? 1;
  });
}

function resolveNpmCli() {
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    return process.env.npm_execpath;
  }
  const candidate = resolve(process.execPath, "..", "node_modules", "npm", "bin", "npm-cli.js");
  return existsSync(candidate) ? candidate : undefined;
}

function excludedTestNamePattern(names) {
  if (names.length === 0) return null;
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
  return `^(?!(?:${escaped})$).*`;
}
