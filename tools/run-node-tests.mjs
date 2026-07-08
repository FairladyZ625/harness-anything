#!/usr/bin/env node

import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { collectSlowTests, collectTestFiles, formatSlowTestSummary, parseRunnerArgs, resolveTestConcurrency, selectTestFiles } from "./node-test-runner-lib.mjs";
import { testTierManifest, testTierNames } from "./test-tier-manifest.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const roots = ["packages", "tools"];

// Reuse type-strip/compile output across the test host and every CLI
// subprocess it spawns (integration tests cold-start `node src/index.ts` per
// assertion). Native Node compile cache — no build step. Children inherit the
// env, so the cache is shared. Lives under node_modules/.cache (already
// git-ignored).
process.env.NODE_COMPILE_CACHE ||= resolve(repoRoot, "node_modules/.cache/harness-node-compile");
process.env.HARNESS_ACTOR ||= "human:harness-test";
process.env.HARNESS_GIT_AUTHOR_NAME ||= "Harness Test";
process.env.HARNESS_GIT_AUTHOR_EMAIL ||= "harness@example.test";

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

// Cap process fan-out so full runs don't exhaust memory on developer laptops.
// --concurrency wins; else HARNESS_TEST_CONCURRENCY; else, off CI, a
// laptop-friendly default derived from cores; in CI, node's own default.
const concurrency = resolveTestConcurrency({
  flagConcurrency: options.concurrency,
  envConcurrency: process.env.HARNESS_TEST_CONCURRENCY,
  isCi: Boolean(process.env.CI),
  availableParallelism: availableParallelism()
});
const concurrencyArgs =
  concurrency && Number.isInteger(concurrency) && concurrency > 0 ? [`--test-concurrency=${concurrency}`] : [];

const child = spawn(process.execPath, ["--test", ...concurrencyArgs, ...selection.files], {
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
