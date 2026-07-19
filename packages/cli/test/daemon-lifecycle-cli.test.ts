// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeDaemonLogService } from "../../application/src/index.ts";
import { makeDaemonLogFileStore } from "../src/daemon/daemon-log-file-store.ts";
import {
  defaultDaemonUserRoot,
  pollUntil,
  runDaemonCommand,
  runRawJson,
  stopDaemon,
  withTempRootAsync
} from "./helpers/daemon-cli.ts";

test("daemon status distinguishes a daemon that has never started", async () => {
  await withTempRootAsync(async (rootDir) => {
    const userRoot = initializeFixture(rootDir);
    const status = daemonStatus(rootDir, userRoot);

    assert.deepEqual(status.lifecycle, {
      state: "never-started",
      previouslyStarted: false,
      reason: "no-lifecycle-record"
    });
  });
});

test("daemon status preserves pre-lifecycle operational history", async () => {
  await withTempRootAsync(async (rootDir) => {
    const userRoot = initializeFixture(rootDir);
    await makeDaemonLogService({ store: makeDaemonLogFileStore({ userRoot }) }).append({
      level: "info",
      source: "daemon",
      component: "protocol.json-rpc",
      event: "repo.command.run",
      message: "legacy daemon activity"
    }, { repo: { repoId: "canonical", canonicalRoot: rootDir } });

    assert.deepEqual(daemonStatus(rootDir, userRoot).lifecycle, {
      state: "previously-started-untracked",
      previouslyStarted: true,
      reason: "legacy-operational-history-without-lifecycle"
    });
  });
});

test("daemon records a terminal reason when it receives a stop signal", async () => {
  await withTempRootAsync(async (rootDir) => {
    const userRoot = initializeFixture(rootDir);
    startDaemon(rootDir, userRoot);

    await stopDaemon(rootDir, userRoot);
    const lifecycle = daemonStatus(rootDir, userRoot).lifecycle as Record<string, unknown>;

    assert.equal(lifecycle.state, "cleanly-terminated");
    assert.equal(lifecycle.previouslyStarted, true);
    assert.equal(lifecycle.reason, "signal:SIGTERM");
    assert.deepEqual(lifecycleEvents(userRoot), ["daemon.lifecycle.started", "daemon.lifecycle.terminated"]);
  });
});

test("daemon status persists an inferred terminal reason after an uncatchable exit", {
  skip: process.platform === "win32" ? "SIGKILL is unavailable on Windows" : false
}, async () => {
  await withTempRootAsync(async (rootDir) => {
    const userRoot = initializeFixture(rootDir);
    const pid = startDaemon(rootDir, userRoot);
    await killDaemon(pid);

    try {
      const status = daemonStatus(rootDir, userRoot);
      const lifecycle = status.lifecycle as Record<string, unknown>;

      assert.equal(status.started, false);
      assert.equal(status.reachable, false);
      assert.equal(lifecycle.state, "exited-unexpectedly");
      assert.equal(lifecycle.previouslyStarted, true);
      assert.equal(lifecycle.reason, "process-disappeared");
      assert.equal(lifecycleEvents(userRoot).at(-1), "daemon.lifecycle.exit-inferred");
    } finally {
      startDaemon(rootDir, userRoot);
      await stopDaemon(rootDir, userRoot);
    }
  });
});

test("daemon restart preserves an inferred exit before replacing a stale start marker", {
  skip: process.platform === "win32" ? "SIGKILL is unavailable on Windows" : false
}, async () => {
  await withTempRootAsync(async (rootDir) => {
    const userRoot = initializeFixture(rootDir);
    const pid = startDaemon(rootDir, userRoot);
    await killDaemon(pid);

    try {
      startDaemon(rootDir, userRoot);
      assert.deepEqual(lifecycleEvents(userRoot), [
        "daemon.lifecycle.started",
        "daemon.lifecycle.exit-inferred",
        "daemon.lifecycle.started"
      ]);
    } finally {
      await stopDaemon(rootDir, userRoot);
    }
  });
});

function initializeFixture(rootDir: string): string {
  const userRoot = defaultDaemonUserRoot(rootDir);
  runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture", HARNESS_DAEMON_USER_ROOT: userRoot });
  return userRoot;
}

function startDaemon(rootDir: string, userRoot: string): number {
  const started = runDaemonCommand(rootDir, ["daemon", "start", "--service", "--json"], {
    HARNESS_DAEMON_USER_ROOT: userRoot
  });
  assert.equal(typeof started.pid, "number");
  return started.pid as number;
}

function daemonStatus(rootDir: string, userRoot: string): Record<string, unknown> {
  return runDaemonCommand(rootDir, ["daemon", "status", "--user-root", userRoot, "--json"], {
    HARNESS_DAEMON_USER_ROOT: userRoot
  });
}

async function killDaemon(pid: number): Promise<void> {
  process.kill(pid, "SIGKILL");
  await pollUntil(
    () => processAlive(pid),
    (alive) => !alive,
    (alive, error) => JSON.stringify({ pid, alive, error: String(error ?? "") })
  );
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lifecycleEvents(userRoot: string): ReadonlyArray<string> {
  const logRoot = path.join(userRoot, "logs", "harness-anything");
  return readdirSync(logRoot)
    .filter((name) => name.endsWith(".ndjson"))
    .sort()
    .flatMap((name) => readFileSync(path.join(logRoot, name), "utf8").split("\n"))
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { readonly event?: unknown })
    .flatMap((entry) => typeof entry.event === "string" && entry.event.startsWith("daemon.lifecycle.") ? [entry.event] : []);
}
