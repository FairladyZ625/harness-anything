#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { selectIntegrationShardFiles } from "./integration-test-shards.mjs";
import { discoverQosPrefix, prefixCommand, withLocalHeavySlot } from "./local-resource-governance.mjs";
import { collectSlowTests, filterTestFilesByPrefixes, formatSlowTestSummary, parseRunnerArgs, resolveTestConcurrency, selectTestFiles } from "./node-test-runner-lib.mjs";
import { discoverTestTierManifest, testTierNames } from "./test-tier-manifest.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

// Reuse type-strip/compile output across the test host and every CLI
// subprocess it spawns (integration tests cold-start `node src/index.ts` per
// assertion). Native Node compile cache — no build step. Children inherit the
// env, so the cache is shared. Lives under node_modules/.cache (already
// git-ignored).
process.env.NODE_COMPILE_CACHE ||= resolve(repoRoot, "node_modules/.cache/harness-node-compile");
process.env.HARNESS_ACTOR ||= "agent:harness-test";
process.env.HARNESS_GIT_AUTHOR_NAME ||= "Harness Test";
process.env.HARNESS_GIT_AUTHOR_EMAIL ||= "harness@example.test";

let options;
try {
  options = parseRunnerArgs(process.argv.slice(2), testTierNames);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const testTierManifest = discoverTestTierManifest(repoRoot);
const testFiles = Object.values(testTierManifest).flat().sort();
const selection = selectTestFiles(testFiles, testTierManifest, options.tier);

// Most CLI integration fixtures exercise the in-process application boundary
// against disposable repositories. Keep that test boundary explicit now that
// initialized product repositories default to the user daemon. Daemon-focused
// tests opt back into local mode with HARNESS_DAEMON_MODE=local and isolated
// user roots.
if (options.tier === "integration" || options.tier === "all") {
  process.env.HARNESS_DAEMON_MODE ||= "direct";
}

if (selection.errors.length > 0) {
  for (const error of selection.errors) {
    console.error(error);
  }
  process.exit(1);
}

if (options.shard !== undefined) {
  selection.files = selectIntegrationShardFiles(options.shard, selection.files);
}
selection.files = filterTestFilesByPrefixes(selection.files, options.prefixes);

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
// fixed per-session budget; in CI, node's own default.
const concurrency = resolveTestConcurrency({
  flagConcurrency: options.concurrency,
  envConcurrency: process.env.HARNESS_TEST_CONCURRENCY,
  isCi: Boolean(process.env.CI)
});
const concurrencyArgs =
  concurrency && Number.isInteger(concurrency) && concurrency > 0 ? [`--test-concurrency=${concurrency}`] : [];

process.exitCode = await withLocalHeavySlot({ label: `node-tests:${options.tier}` }, async (lease) => {
  const qosPrefix = lease.inherited ? [] : discoverQosPrefix();
  const invocation = prefixCommand(qosPrefix, process.execPath, ["--test", ...concurrencyArgs, ...selection.files]);
  const child = spawn(invocation.command, invocation.args, {
    cwd: repoRoot,
    stdio: ["inherit", "pipe", "pipe"],
    env: lease.childEnv
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

  return new Promise((resolveExitCode) => {
    child.once("error", (error) => {
      console.error(error.message);
      resolveExitCode(1);
    });
    child.once("close", (code, signal) => {
      if (signal !== null) {
        console.error(`node --test terminated by signal ${signal}`);
        resolveExitCode(1);
        return;
      }
      const slowTests = collectSlowTests(output, options.slowThresholdMs);
      console.log(formatSlowTestSummary(slowTests, options.slowThresholdMs, options.slowLimit));
      resolveExitCode(code ?? 1);
    });
  });
});
