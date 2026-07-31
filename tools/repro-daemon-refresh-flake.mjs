#!/usr/bin/env node

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const targetTest = "packages/cli/test/daemon-refresh-preflight.test.ts";
const burners = positiveIntegerOption("--burners", Math.max(2, os.availableParallelism() * 2));
const runs = positiveIntegerOption("--runs", 1);

console.error(JSON.stringify({
  scenario: "daemon-refresh-resource-pressure",
  burners,
  runs,
  availableParallelism: os.availableParallelism(),
  pressureWindow: "admin.daemon.refresh"
}));

let exitCode = 0;
for (let run = 1; run <= runs; run += 1) {
  console.error(`[repro] run ${run}/${runs}`);
  const code = await runTargetTest();
  if (code !== 0) {
    exitCode = code;
    break;
  }
}

process.exitCode = exitCode;

function runTargetTest() {
  const nodeArgs = [
    "--test",
    "--test-concurrency=1",
    "--test-timeout=180000",
    "--test-name-pattern=refresh derives",
    targetTest
  ];
  const preload = `--import=${path.join(repoRoot, "tools/cli-test-fixture-register.mjs")}`;
  const preflightBackground = `--import=${path.join(repoRoot, "packages/cli/test/fixtures/daemon-refresh-preflight-background.mjs")}`;
  const child = spawn(process.execPath, nodeArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      HARNESS_CLI_TEST_FIXTURE_PRELOAD: "1",
      HARNESS_TEST_DAEMON_REFRESH_CONTROL_TIMEOUT_MS: "60000",
      HARNESS_TEST_DAEMON_REFRESH_CPU_BURNERS: String(burners),
      HARNESS_TEST_DAEMON_REFRESH_PREFLIGHT_DELAY_MS: "40000",
      HARNESS_TEST_DAEMON_REFRESH_PREFLIGHT_BACKGROUND: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
      NODE_OPTIONS: [process.env.NODE_OPTIONS, preload, preflightBackground].filter(Boolean).join(" ")
    }
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`resource-pressure test terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function positiveIntegerOption(name, fallback) {
  const inline = process.argv.slice(2).find((arg) => arg.startsWith(`${name}=`));
  const index = process.argv.indexOf(name);
  const raw = inline?.slice(name.length + 1) ?? (index === -1 ? undefined : process.argv[index + 1]);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
