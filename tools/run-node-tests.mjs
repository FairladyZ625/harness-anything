#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { collectSlowTests, collectTestFiles, formatSlowTestSummary, parseRunnerArgs, selectTestFiles } from "./node-test-runner-lib.mjs";
import { testTierManifest, testTierNames } from "./test-tier-manifest.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const roots = ["packages", "tools"];

let options;
try {
  options = parseRunnerArgs(process.argv.slice(2), testTierNames);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const testFiles = await collectTestFiles(repoRoot, roots);
const selection = selectTestFiles(testFiles, testTierManifest, options.tier);

if (selection.errors.length > 0) {
  for (const error of selection.errors) {
    console.error(error);
  }
  process.exit(1);
}

if (selection.files.length === 0) {
  console.log(`No node test files found for tier ${options.tier}.`);
  process.exit(0);
}

if (options.list) {
  for (const file of selection.files) {
    console.log(file);
  }
  process.exit(0);
}

const child = spawn(process.execPath, ["--test", ...selection.files], {
  cwd: repoRoot,
  stdio: ["inherit", "pipe", "pipe"]
});

let output = "";

child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
});

child.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stderr.write(text);
});

child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (signal !== null) {
    console.error(`node --test terminated by signal ${signal}`);
    process.exit(1);
  }

  const slowTests = collectSlowTests(output, options.slowThresholdMs);
  console.log(formatSlowTestSummary(slowTests, options.slowThresholdMs, options.slowLimit));

  process.exit(code ?? 1);
});
