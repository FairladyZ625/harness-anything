// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { acquireDaemonSocketOwnership } from "../src/commands/daemon/serve-transport.ts";
import {
  delay,
  runDaemonCommand,
  runRawJson,
  runRawJsonAsync,
  withTempRootAsync
} from "./helpers/daemon-cli.ts";

const concurrentClientCount = 8;

test("an unreachable socket owner hands startup ownership to one waiting contender", async () => {
  await withTempRootAsync(async (rootDir) => {
    const endpoint = path.join(rootDir, "daemon.sock");
    const first = await acquireDaemonSocketOwnership(endpoint);
    const contender = Promise.resolve().then(() => acquireDaemonSocketOwnership(endpoint));

    await delay(50);
    first.release();

    const second = await contender;
    second.release();
  });
});

test("Windows named-pipe startup ownership waits for the current contender", async () => {
  await withTempRootAsync(async (rootDir) => {
    const endpoint = `\\\\.\\pipe\\ha-${path.basename(rootDir)}`;
    const first = await acquireDaemonSocketOwnership(endpoint, "win32");
    let contenderSettled = false;
    const contender = acquireDaemonSocketOwnership(endpoint, "win32").then((ownership) => {
      contenderSettled = true;
      return ownership;
    });

    await delay(50);
    assert.equal(contenderSettled, false);
    first.release();

    const second = await contender;
    second.release();
  });
});

test("daemon status cannot report started when its lock exists but the socket is unreachable", async () => {
  await withTempRootAsync(async (rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct" });
    const lockPath = path.join(rootDir, ".harness/locks/global.lock");
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      pid: 999_999,
      hostname: "test-host",
      heartbeatAt: new Date().toISOString(),
      ownerKind: "daemon",
      ownerToken: "unreachable-owner"
    }), "utf8");

    const status = runDaemonCommand(rootDir, ["daemon", "status", "--json"]);
    assert.equal(status.started, false);
    assert.equal(status.reachable, false);
  });
});

test("concurrent cold-start clients converge on one reachable daemon socket owner", {
  skip: process.platform === "win32"
    ? "native Windows writable daemon qualification is deferred"
    : false
}, async () => {
  await withTempRootAsync(async (workspaceRoot) => {
    const userRoot = path.join(workspaceRoot, "user-daemon");
    const repoRoots = Array.from(
      { length: concurrentClientCount },
      (_, index) => path.join(workspaceRoot, `repo-${index}`)
    );

    for (const [index, rootDir] of repoRoots.entries()) {
      mkdirSync(rootDir, { recursive: true });
      runRawJson(rootDir, ["init"], {
        HARNESS_DAEMON_MODE: "direct",
        HARNESS_DAEMON_USER_ROOT: userRoot
      });
      runDaemonCommand(rootDir, [
        "daemon",
        "repo",
        "register",
        "--repo-id",
        `repo-${index}`,
        "--root",
        rootDir,
        "--user-root",
        userRoot,
        "--no-link",
        "--json"
      ], { HARNESS_DAEMON_USER_ROOT: userRoot });
    }

    const clientResults = await Promise.allSettled(repoRoots.map((rootDir, index) =>
      runRawJsonAsync(rootDir, ["--repo", `repo-${index}`, "task", "list"], {
        HARNESS_DAEMON_MODE: "local",
        HARNESS_DAEMON_USER_ROOT: userRoot,
        HARNESS_DAEMON_IDLE_MS: "60000"
      })
    ));

    try {
      assert.deepEqual(
        clientResults.map((result) => result.status),
        Array.from({ length: concurrentClientCount }, () => "fulfilled"),
        clientResults.map(describeSettledResult).join("\n")
      );
      for (const result of clientResults) {
        assert.equal(result.status === "fulfilled" && result.value.ok, true, describeSettledResult(result));
      }

      const status = runDaemonCommand(repoRoots[0]!, [
        "--repo",
        "repo-0",
        "daemon",
        "status",
        "--user-root",
        userRoot,
        "--json"
      ], { HARNESS_DAEMON_USER_ROOT: userRoot });
      assert.equal(status.started, true);
      assert.equal(status.reachable, true);
      assert.equal(typeof status.pid, "number");
      assert.equal(Array.isArray(status.repos), true);
      assert.deepEqual(
        (status.repos as Array<{ readonly state?: unknown }>).map((repo) => repo.state),
        Array.from({ length: concurrentClientCount }, () => "attached")
      );

      const lockPids = repoRoots.map(readDaemonLockPid);
      assert.deepEqual([...new Set(lockPids)], [status.pid]);
    } finally {
      await stopDaemonProcesses(repoRoots);
    }
  });
});

function readDaemonLockPid(rootDir: string): number {
  const lockPath = path.join(rootDir, ".harness/locks/global.lock");
  assert.equal(existsSync(lockPath), true, `missing daemon lock: ${lockPath}`);
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { readonly pid?: unknown };
  assert.equal(typeof lock.pid, "number", `daemon lock has no pid: ${lockPath}`);
  return lock.pid as number;
}

async function stopDaemonProcesses(repoRoots: ReadonlyArray<string>): Promise<void> {
  const pids = new Set<number>();
  for (const rootDir of repoRoots) {
    try {
      pids.add(readDaemonLockPid(rootDir));
    } catch {
      // A failed cold start may leave some repos without a daemon lock.
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process may already have exited after losing the socket race.
    }
  }
  await delay(100);
}

function describeSettledResult(result: PromiseSettledResult<Record<string, unknown>>): string {
  if (result.status === "fulfilled") return JSON.stringify(result.value);
  if (!(result.reason instanceof Error)) return String(result.reason);
  const commandError = result.reason as Error & { readonly stdout?: unknown; readonly stderr?: unknown };
  return [
    `${commandError.name}: ${commandError.message}`,
    typeof commandError.stdout === "string" && commandError.stdout ? `stdout: ${commandError.stdout}` : undefined,
    typeof commandError.stderr === "string" && commandError.stderr ? `stderr: ${commandError.stderr}` : undefined
  ].filter((line) => line !== undefined).join("\n");
}
