// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { receiptDataString } from "../helpers/forced-command-daemon.ts";
import {
  defaultDaemonUserRoot,
  runDaemonCommand,
  runRawJson,
  stopDaemon,
  withTempRootAsync
} from "../helpers/daemon-cli.ts";
import { cliTestEnv } from "../helpers/cli-test-env.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const localP95BudgetMs = 1_000;
const warmWriteP95BudgetMs = 3_000;
const budgetMultiplier = positiveNumber(process.env.HARNESS_CLI_LATENCY_BUDGET_MULTIPLIER, 2);

test("daemon-independent help stays local and exposes phase timing", () => {
  const missingUserRoot = path.resolve("/tmp", `ha-cli-help-no-daemon-${process.pid}-${Date.now()}`);
  const result = spawnSync(process.execPath, [cliEntry, "--help"], {
    encoding: "utf8",
    env: cliTestEnv({
      HA_TIMING: "1",
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_USER_ROOT: missingUserRoot
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: harness-anything/u);
  assert.equal(existsSync(missingUserRoot), false, "help must not initialize or connect to a daemon user root");
  const timing = parseTiming(result.stderr);
  assert.equal(timing.schema, "ha-cli-timing/v1");
  assert.equal(typeof timing.phasesMs.process_start, "number");
  assert.equal(typeof timing.phasesMs.module_load, "number");
  assert.equal(typeof timing.phasesMs.parse, "number");
  assert.equal(typeof timing.phasesMs.command_execute, "number");
  assert.equal(typeof timing.phasesMs.process_exit_wait, "number");
  assert.equal("daemon_connect" in timing.phasesMs, false);
  assert.equal("daemon_launch_authority_ready" in timing.phasesMs, false);
});

test("CLI latency budgets cover local p95 and warm daemon writes", { timeout: 60_000 }, async (t) => {
  await withTempRootAsync(async (rootDir) => {
    const userRoot = defaultDaemonUserRoot(rootDir);
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture", HARNESS_DAEMON_USER_ROOT: userRoot });
    const created = runRawJson(rootDir, ["task", "create", "--title", "Latency Budget Fixture"], {
      HARNESS_DAEMON_MODE: "fixture",
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
    const taskId = receiptDataString(created, "taskId");
    runDaemonCommand(rootDir, ["daemon", "start", "--service", "--json"], { HARNESS_DAEMON_USER_ROOT: userRoot });

    try {
      const localSamples = sample(7, () => runCli(rootDir, userRoot, ["--help"]));
      runRawJson(rootDir, ["task", "progress", "append", taskId, "--text", "warmup"], {
        HARNESS_DAEMON_MODE: "local",
        HARNESS_DAEMON_USER_ROOT: userRoot,
        HARNESS_DAEMON_IDLE_MS: "60000"
      });
      const writeSamples = sample(5, (index) => runCli(rootDir, userRoot, [
        "--json", "task", "progress", "append", taskId, "--text", `latency sample ${index}`
      ]));
      const localP95 = percentile95(localSamples);
      const writeP95 = percentile95(writeSamples);
      t.diagnostic(JSON.stringify({ localP95, writeP95, budgetMultiplier, localSamples, writeSamples }));
      assert.equal(localP95 < localP95BudgetMs * budgetMultiplier, true, `local p95 ${localP95.toFixed(1)}ms exceeded budget`);
      assert.equal(writeP95 < warmWriteP95BudgetMs * budgetMultiplier, true, `warm write p95 ${writeP95.toFixed(1)}ms exceeded budget`);
    } finally {
      await stopDaemon(rootDir, userRoot);
    }
  });
});

function runCli(rootDir: string, userRoot: string, args: ReadonlyArray<string>): void {
  const result = spawnSync(process.execPath, [cliEntry, "--root", rootDir, ...args], {
    encoding: "utf8",
    env: cliTestEnv({
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_USER_ROOT: userRoot,
      HARNESS_DAEMON_IDLE_MS: "60000",
      HARNESS_ACTOR: "agent:latency-budget",
      HARNESS_GIT_AUTHOR_NAME: "Harness Test",
      HARNESS_GIT_AUTHOR_EMAIL: "harness@example.test"
    })
  });
  assert.equal(result.status, 0, result.stderr);
}

function sample(count: number, run: (index: number) => void): number[] {
  return Array.from({ length: count }, (_, index) => {
    const startedAt = performance.now();
    run(index);
    return Math.round((performance.now() - startedAt) * 100) / 100;
  });
}

function percentile95(samples: ReadonlyArray<number>): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTiming(stderr: string): { readonly schema: string; readonly phasesMs: Record<string, number> } {
  const line = stderr.split("\n").find((candidate) => candidate.startsWith("[ha timing] "));
  assert.ok(line, `missing HA_TIMING output: ${stderr}`);
  return JSON.parse(line.slice("[ha timing] ".length)) as { schema: string; phasesMs: Record<string, number> };
}
