// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureLocalDaemonRunning, type DaemonLaunchSpec } from "../src/client/daemon-autostart.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { readDaemonLifecycleRecords, type DaemonLifecycleRecorder } from "../src/lifecycle-log.ts";
import { daemonSingletonLockPath } from "../src/daemon-singleton.ts";
import { readDaemonPid, startDaemon, type RunningDaemon } from "../src/runtime.ts";
import { openBootstrappedRepoCell, registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";

test("the daemon binds and serves status and queued commands before repository attachment settles", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-bind-before-attach-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "bind-before-attach",
    attachmentGate = deferred<void>(),
    attachmentStarted = deferred<void>();
  let daemon: RunningDaemon | undefined,
    attachmentReleased = false;
  rosterRepo(rootDir, repoId);
  registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  try {
    daemon = runningDaemon(
      await startDaemon({
        daemonId: repoId,
        userRoot,
        endpoint: testEndpoint(repoId),
        openCell: async (input) => {
          attachmentStarted.resolve();
          await attachmentGate.promise;
          return openBootstrappedRepoCell(input);
        },
      }),
    );
    await attachmentStarted.promise;
    const status = await requestDaemonJsonRpcAt(daemon.endpoint, "daemon.status", {}, 2_000, 2_000);
    assert.equal((status.repos as { readonly state: string }[])[0]?.state, "warming");
    assert.match(String(status.summary), /attaching 0\/1/u);

    let writeSettled = false;
    const queuedWrite = requestDaemonJsonRpcAt(
      daemon.endpoint,
      "repo.task.create",
      { repo: { repoId }, payload: { taskId: "task-bind-first", title: "Bound before attach" } },
      2_000,
      5_000,
    ).then((receipt) => {
      writeSettled = true;
      return receipt;
    });
    await eventLoopTurn();
    assert.equal(writeSettled, false, "the accepted write waits behind attachment instead of losing its connection");
    attachmentReleased = true;
    attachmentGate.resolve();
    assert.equal((await queuedWrite).outcome, "applied");

    const events = readDaemonLifecycleRecords(userRoot, repoId).map((record) => record.event);
    assert.ok(events.indexOf("socket_bound") < events.indexOf("repo_attach_started"), JSON.stringify(events));
  } finally {
    if (!attachmentReleased) attachmentGate.resolve();
    await daemon?.stop();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a drifted daemon serves a command and reports its old build while a runtime session is live", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-live-build-drain-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    runtimeRoot = path.join(parent, "runtime"),
    runtimeFile = builtRuntime(runtimeRoot, "build-a"),
    buildIdPath = path.join(runtimeRoot, "packages/cli/dist/build-id.txt"),
    repoId = "live-build-drain";
  let daemon: RunningDaemon | undefined, recordLifecycle: DaemonLifecycleRecorder | undefined;
  rosterRepo(rootDir, repoId);
  registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  try {
    daemon = runningDaemon(
      await startDaemon({
        daemonId: repoId,
        userRoot,
        endpoint: testEndpoint(repoId),
        runtimeFile,
        openCell: async (input) => {
          const cell = await openBootstrappedRepoCell(input);
          recordLifecycle = input.recordLifecycle;
          input.recordLifecycle?.({
            event: "runtime_spawn",
            runtimeSessionId: "runtime-still-live",
            dispatchId: "dispatch-still-live",
            pid: process.pid,
          });
          return cell;
        },
      }),
    );
    await waitUntil(async () => {
      const status = await requestDaemonJsonRpcAt(daemon!.endpoint, "daemon.status", {}, 2_000, 2_000);
      return (status.repos as { readonly state: string }[])[0]?.state === "attached";
    });
    const originalPid = readDaemonPid(userRoot, repoId);
    writeFileSync(buildIdPath, "build-b\n", "utf8");
    const receipt = await requestDaemonJsonRpcAt(
      daemon.endpoint,
      "repo.task.create",
      { repo: { repoId }, payload: { taskId: "task-live-drain", title: "Served by old build" } },
      2_000,
      5_000,
      undefined,
      true,
    );
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    const marker = receipt.daemonBuild as Record<string, unknown>;
    assert.deepEqual(
      {
        code: marker.code,
        loadedBuildId: marker.loadedBuildId,
        diskBuildId: marker.diskBuildId,
        liveRuntimeSessions: marker.liveRuntimeSessions,
      },
      { code: "daemon_build_stale", loadedBuildId: "build-a", diskBuildId: "build-b", liveRuntimeSessions: 1 },
    );
    await eventLoopTurn();
    await eventLoopTurn();
    assert.equal(readDaemonPid(userRoot, repoId), originalPid, "the live runtime keeps the loaded daemon resident");
    assert.equal(existsSync(daemon.endpoint), true);
    recordLifecycle?.({
      event: "runtime_exit",
      runtimeSessionId: "runtime-still-live",
      dispatchId: "dispatch-still-live",
      pid: process.pid,
      outcome: "succeeded",
    });
    await waitUntil(() => readDaemonPid(userRoot, repoId) === null && !existsSync(daemon!.endpoint));
    assert.equal(
      readDaemonLifecycleRecords(userRoot, repoId).some(
        (record) => record.event === "process_exit" && record.outcome === "build_superseded",
      ),
      true,
    );
  } finally {
    await daemon?.stop();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a drained superseded daemon exits and the next autostart loads the disk build", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-superseded-exit-")),
    userRoot = path.join(parent, "user"),
    runtimeRoot = path.join(parent, "runtime"),
    runtimeFile = builtRuntime(runtimeRoot, "build-a"),
    buildIdPath = path.join(runtimeRoot, "packages/cli/dist/build-id.txt"),
    daemonId = "superseded-exit";
  let daemon: RunningDaemon | undefined,
    replacement: RunningDaemon | undefined,
    spawns = 0;
  try {
    daemon = runningDaemon(await startDaemon({ daemonId, userRoot, runtimeFile, endpoint: testEndpoint(daemonId) }));
    writeFileSync(buildIdPath, "build-b\n", "utf8");
    const staleStatus = await requestDaemonJsonRpcAt(
      daemon.endpoint,
      "daemon.status",
      {},
      2_000,
      2_000,
      undefined,
      true,
    );
    assert.equal((staleStatus.daemonBuild as Record<string, unknown>).liveRuntimeSessions, 0);
    await waitUntil(() => readDaemonPid(userRoot, daemonId) === null && !existsSync(daemon!.endpoint));
    assert.equal(
      readDaemonLifecycleRecords(userRoot, daemonId).some(
        (record) => record.event === "process_exit" && record.outcome === "build_superseded",
      ),
      true,
    );

    const started = await ensureLocalDaemonRunning({
      socketPath: daemon.endpoint,
      invokingRoot: process.cwd(),
      launch: () => launchSpec(userRoot, daemonId),
      spawnDetached: async () => {
        spawns += 1;
        replacement = runningDaemon(
          await startDaemon({ daemonId, userRoot, runtimeFile, endpoint: testEndpoint(daemonId) }),
        );
      },
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(spawns, 1);
    const current = await requestDaemonJsonRpcAt(daemon.endpoint, "daemon.status", {}, 2_000, 2_000);
    assert.deepEqual(current.build, {
      ...(current.build as Record<string, unknown>),
      loadedBuildId: "build-b",
      diskBuildId: "build-b",
      drifted: false,
    });
  } finally {
    await replacement?.stop();
    await daemon?.stop();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("autostart readiness is independent of a simulated 32 second canonical repository attachment", async () => {
  const simulatedCanonicalAttachMs = 32_000,
    parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-autostart-attach-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "autostart-while-attaching",
    attachmentGate = deferred<void>(),
    attachmentStarted = deferred<void>();
  let daemon: RunningDaemon | undefined,
    daemonStart: Promise<RunningDaemon> | undefined,
    attachmentCompleted = false;
  rosterRepo(rootDir, repoId);
  registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  try {
    const endpoint = testEndpoint(repoId),
      started = await ensureLocalDaemonRunning({
        socketPath: endpoint,
        invokingRoot: rootDir,
        launch: () => launchSpec(userRoot, repoId),
        spawnDetached: async () => {
          daemonStart = startDaemon({
            daemonId: repoId,
            userRoot,
            endpoint,
            openCell: async (input) => {
              attachmentStarted.resolve();
              await attachmentGate.promise;
              attachmentCompleted = true;
              return openBootstrappedRepoCell(input);
            },
          }).then((startedDaemon) => {
            daemon = runningDaemon(startedDaemon);
            return daemon;
          });
          await attachmentStarted.promise;
        },
      });
    assert.equal(started.ok, true, JSON.stringify({ started, simulatedCanonicalAttachMs }));
    await attachmentStarted.promise;
    assert.equal(attachmentCompleted, false, "socket readiness must not await the controlled attachment gate");
    const status = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 2_000, 2_000);
    assert.match(String(status.summary), /attaching 0\/1/u);
  } finally {
    attachmentGate.resolve();
    if (!daemon && daemonStart) daemon = await daemonStart;
    await daemon?.stop();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a drain that rejects still releases the pid file and the singleton lock", async () => {
  // The stop sequence used to release the pid file and the lock after the awaits, so any rejection on
  // the way down left both behind and the next daemon could never claim the singleton. A long
  // migration replay failing inside RepoCell.close is the path that surfaced this on main.
  const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-stop-drain-reject-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "stop-drain-reject",
    lockPath = daemonSingletonLockPath(userRoot, repoId);
  let daemon: RunningDaemon | undefined,
    // The injected close never reaches the real cell, so the test owns closing it: otherwise its
    // worker thread keeps the test process alive after every assertion has passed.
    realCell: Awaited<ReturnType<typeof openBootstrappedRepoCell>> | undefined;
  rosterRepo(rootDir, repoId);
  registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  try {
    daemon = runningDaemon(
      await startDaemon({
        daemonId: repoId,
        userRoot,
        endpoint: testEndpoint(repoId),
        openCell: async (input) => {
          const cell = await openBootstrappedRepoCell(input);
          realCell = cell;
          return {
            ...cell,
            close: async () => {
              throw new Error("simulated migration replay failure during close");
            },
          };
        },
      }),
    );
    assert.equal(existsSync(lockPath), true, "the running daemon holds the singleton lock");
    // Attachment is async: stopping before the cell lands would close an empty registry and never
    // reach the injected failure, which is the same trap that makes this bug hard to see.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await requestDaemonJsonRpcAt(daemon.endpoint, "daemon.status", {}, 2_000, 2_000);
      if ((status.repos as { readonly state: string }[])[0]?.state === "attached") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    await assert.rejects(daemon.stop(), /simulated migration replay failure during close/u);

    assert.equal(existsSync(lockPath), false, "stop exit must release the singleton lock");
    assert.equal(readDaemonPid(userRoot, repoId), null, "stop exit must remove the pid file");
    assert.equal(existsSync(testEndpoint(repoId)), false, "stop exit must remove the socket");
    daemon = undefined;
  } finally {
    await daemon?.stop().catch(() => undefined);
    await realCell?.close().catch(() => undefined);
    rmSync(parent, { recursive: true, force: true });
  }
});

function runningDaemon(started: Awaited<ReturnType<typeof startDaemon>>): RunningDaemon {
  if (!("stop" in started)) throw new Error(`daemon start deferred unexpectedly: ${JSON.stringify(started)}`);
  return started;
}

function launchSpec(userRoot: string, daemonId: string): DaemonLaunchSpec {
  return {
    command: process.execPath,
    args: ["index.ts", "daemon", "serve", "--user-root", userRoot, "--daemon-id", daemonId],
    env: {},
  };
}

function testEndpoint(daemonId: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\ha-daemon-build-drain-${daemonId}-${String(process.pid)}`
    : `/tmp/ha-daemon-build-drain-${daemonId}-${String(process.pid)}.sock`;
}

function builtRuntime(runtimeRoot: string, buildId: string): string {
  const runtimeFile = path.join(runtimeRoot, "packages/cli/dist/daemon/src/runtime.js"),
    marker = path.join(runtimeRoot, "packages/cli/dist/build-id.txt");
  for (const [file, body] of [
    [runtimeFile, "runtime\n"],
    [marker, `${buildId}\n`],
  ] as const) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body, "utf8");
  }
  return runtimeFile;
}

function rosterRepo(rootDir: string, repoId: string): void {
  mkdirSync(rootDir, { recursive: true });
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Daemon Build Drain Test");
  git(rootDir, "config", "user.email", "daemon-build-drain@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
  mkdirSync(path.join(rootDir, "harness"));
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    `schema: harness-anything/v1\nname: ${repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
  );
  writeFileSync(
    path.join(rootDir, "harness/people.yaml"),
    `${JSON.stringify(
      {
        schema: "harness-people/v1",
        people: [
          {
            personId: "writer",
            displayName: "writer",
            roles: ["writer"],
            credentials: [
              {
                kind: "unix-socket-owner-boundary",
                issuer: `host:${hostname()}`,
                subject: String(process.getuid?.() ?? 0),
              },
            ],
          },
        ],
        roles: [{ roleId: "writer", commandClasses: ["repo-read", "repo-write", "admin"] }],
      },
      null,
      2,
    )}\n`,
  );
  git(rootDir, "add", "harness");
  git(rootDir, "commit", "--quiet", "-m", "add roster fixture");
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value?: T) => void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value?: T) => resolvePromise(value as T) };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`condition did not settle within ${String(timeoutMs)}ms`);
}

function eventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
