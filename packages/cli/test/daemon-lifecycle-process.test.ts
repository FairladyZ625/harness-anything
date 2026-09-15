// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { readDaemonStartProgress, type DaemonLaunchSpec } from "../../daemon/src/client/daemon-autostart.ts";
import { localUserDaemonEndpoint } from "../../daemon/src/client/local-daemon-target.ts";
import { daemonProcessAlive, daemonSingletonLockPath } from "../../daemon/src/daemon-singleton.ts";
import { openDaemonLifecycleLog } from "../../daemon/src/lifecycle-log.ts";
import { daemonPidPath, readDaemonPid } from "../../daemon/src/runtime.ts";
import { buildProjectionOracle } from "../../daemon/test/migration-import.fixtures.ts";
import { registerBootstrappedDaemonRepo, seedSettingsEvent } from "../../daemon/test/repo-settings.fixture.ts";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import { daemonServeEntry } from "../src/daemon/client.ts";
import { withAutostart } from "../src/daemon/with-autostart.ts";

const cli = path.resolve("packages/cli/src/index.ts"),
  repoRoot = path.resolve("."),
  drainMs = 8_000;

// #1565: on Windows nothing delivers SIGTERM -- process.kill terminates unconditionally and the
// daemon's shutdown never runs, so its pid file outlives it. `daemon stop` waited on that file and
// reported daemon_stop_timeout for a daemon that had already stopped. SIGKILL reproduces the same
// condition here: the handler does not run, and the file is left behind exactly as on Windows.
test("#1565: a daemon whose shutdown never ran still yields a successful stop receipt", async () => {
  const fixture = setup();
  try {
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    const pid = readDaemonPid(fixture.userRoot, "default");
    assert.ok(pid, "the resident daemon must have published a pid");
    process.kill(pid as number, "SIGKILL");
    await waitForProcessExit(pid as number, 5_000);
    assert.equal(
      existsSync(daemonPidPath(fixture.userRoot, "default")),
      true,
      "an ungraceful exit leaves the pid file behind",
    );
    assert.equal(
      existsSync(daemonSingletonLockPath(fixture.userRoot, "default")),
      true,
      "an ungraceful exit leaves the singleton lock behind",
    );

    const stopped = run(fixture.root, fixture.userRoot, ["daemon", "stop"]);
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    assert.notEqual(stopped.code, "daemon_stop_timeout");
    assert.equal(
      existsSync(daemonPidPath(fixture.userRoot, "default")),
      false,
      "stop must clear the bookkeeping it outlived",
    );
    assert.equal(
      existsSync(daemonSingletonLockPath(fixture.userRoot, "default")),
      false,
      "stop must clear the singleton lock it outlived",
    );
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("two concurrent daemon serves yield exactly one resident daemon and one deferral receipt", async () => {
  const fixture = setup();
  try {
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    register(fixture.root, fixture.userRoot, "singleton-race");
    assert.equal(
      run(fixture.root, fixture.userRoot, [
        "task",
        "create",
        "--id",
        "task-singleton",
        "--admin",
        "--title",
        "Singleton",
      ]).outcome,
      "applied",
    );
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "stop"]).ok, true);
    waitForDaemonDown(fixture.userRoot);

    const first = spawnServe(fixture.userRoot),
      second = spawnServe(fixture.userRoot);
    try {
      const deferred = await firstDeferral([first, second]),
        survivorPid = await residentPid(fixture.userRoot);
      assert.equal(deferred.ok, true, JSON.stringify(deferred));
      assert.equal(deferred.outcome, "deferred");
      assert.equal(deferred.incumbent?.pid, survivorPid, "the deferral receipt must point at the serving incumbent");
      assert.equal((await firstExit([first, second])).code, 0, "the yielding serve must exit 0");
      // One holder owns both surfaces: the socket answers and the workspace writer lock is not rejected.
      assert.equal(run(fixture.root, fixture.userRoot, ["task", "list"]).outcome, "applied");
      assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "stop"]).ok, true);
      waitForDaemonDown(fixture.userRoot);
      assert.equal(
        existsSync(daemonSingletonLockPath(fixture.userRoot, "default")),
        false,
        "a stopped daemon must release the singleton lock",
      );
    } finally {
      reap(first);
      reap(second);
    }
  } finally {
    stop(fixture.userRoot);
    cleanup(fixture.parent);
  }
});

test("platform stop during a long migration replay exits the daemon in bounded time and releases every lock", async () => {
  const fixture = setup(),
    legacyRoot = path.join(fixture.parent, "legacy");
  try {
    legacyFixture(legacyRoot, 150);
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    register(fixture.root, fixture.userRoot, "singleton-import");

    const migration = spawn(
      process.execPath,
      [cli, "--root", fixture.root, "--json", "migrate", "import", "--source", legacyRoot],
      { encoding: "utf8", env: cliEnv(fixture.root, fixture.userRoot) },
    );
    await waitForImportProgress(fixture.root, 3);
    const pid = readDaemonPid(fixture.userRoot, "default");
    assert.ok(pid, "a resident daemon pid file must exist mid-replay");
    const stopAt = Date.now();
    if (process.platform === "win32")
      assert.equal(
        run(fixture.root, fixture.userRoot, ["daemon", "stop"]).ok,
        true,
        "Windows must request cooperative cleanup instead of terminating past it",
      );
    else process.kill(pid, "SIGTERM");
    await waitForProcessExit(pid, 20_000);
    const exitMs = Date.now() - stopAt;
    assert.ok(exitMs < 20_000, `daemon must exit in bounded time, took ${exitMs}ms`);
    const migrationResult = await closeOf(migration);
    assert.notEqual(migrationResult.code, 0, "an interrupted migration must not report success");
    assert.equal(
      existsSync(daemonSingletonLockPath(fixture.userRoot, "default")),
      false,
      "stop exit must release the singleton lock",
    );
    assert.equal(
      existsSync(`${fixture.root}.harness-anything-writer.lock`),
      false,
      "stop exit must release the workspace writer lock",
    );
    assert.equal(
      existsSync(localUserDaemonEndpoint(fixture.userRoot, "default")),
      false,
      "stop exit must remove the socket",
    );

    // A clean restart takes the slot back over: no wedge, no stale incumbent.
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "status"]).ok, true);
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "stop"]).ok, true);
  } finally {
    stop(fixture.userRoot);
    cleanup(fixture.parent);
  }
});

// The resident-daemon stop outage (#1653): a daemon serving a build that predates daemon.stop
// answers "Method not found", the CLI's stop used to be a blind write, and the timeout hint pointed
// at a lifecycle log that had nothing to say. These fixtures pin the ladder end to end: a
// pre-daemon.stop daemon stops through the SIGTERM fallback, a wedged daemon produces a hint that
// reports what was observed and names --force, and --force never signals through stale bookkeeping.
test("a daemon that rejects daemon.stop still stops through the signal fallback", async () => {
  const fixture = await spawnLegacyDaemon("legacy");
  try {
    const status = runTarget(fixture, ["daemon", "status", "--json"]);
    assert.equal(status.ok, true, JSON.stringify(status));
    const stopped = runTarget(fixture, ["daemon", "stop", "--json"]);
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    assert.notEqual(stopped.code, "daemon_stop_timeout");
    await waitForExit(fixture.daemonPid);
    assert.equal(
      existsSync(daemonPidPath(fixture.userRoot, fixture.daemonId)),
      false,
      "the fallback stop must still clear the pid file",
    );
  } finally {
    await stopCleanup(fixture);
  }
});

test("a wedged daemon reports observed state in the timeout and stops through --force", async () => {
  const fixture = await spawnLegacyDaemon("wedge");
  try {
    const timedOut = runRaw(fixture, ["daemon", "stop", "--json"]);
    assert.equal(timedOut.status, 1, "a wedged daemon must fail the cooperative stop");
    const receipt = JSON.parse(timedOut.stdout) as { readonly code?: string; readonly nextAction?: string };
    assert.equal(receipt.code, "daemon_stop_timeout");
    const hint = String(receipt.nextAction);
    assert.match(hint, /process alive/u, hint);
    assert.match(hint, /never answered the handshake/u, hint);
    assert.match(hint, /ha daemon stop --force/u, "the hint must name the supported escalation");
    assert.ok(
      existsSync(daemonPidPath(fixture.userRoot, fixture.daemonId)),
      "a timeout must not clear bookkeeping the process still holds",
    );

    const forced = runTarget(fixture, ["daemon", "stop", "--force", "--json"]);
    assert.equal(forced.ok, true, JSON.stringify(forced));
    assert.equal(forced.forced, true);
    await waitForExit(fixture.daemonPid);
    assert.equal(
      existsSync(daemonPidPath(fixture.userRoot, fixture.daemonId)),
      false,
      "force must release the pid file",
    );
  } finally {
    await stopCleanup(fixture);
  }
});

test("force refuses to signal a pid the daemon slot no longer claims", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-stop-replaced-"));
  const userRoot = path.join(parent, "user"),
    daemonId = "replaced";
  try {
    const innocent = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"]);
    assert.ok(innocent.pid, "the innocent stand-in must have a pid");
    mkdirSync(userRoot, { recursive: true });
    writeFileSync(daemonPidPath(userRoot, daemonId), `${innocent.pid}\n`, "utf8");
    writeFileSync(path.join(userRoot, `daemon-${daemonId}.singleton.lock`), "4194304\n", "utf8");
    const refused = runRaw({ userRoot, daemonId }, ["daemon", "stop", "--force", "--json"]);
    assert.equal(refused.status, 1);
    const receipt = JSON.parse(refused.stdout) as { readonly code?: string };
    assert.equal(receipt.code, "daemon_replaced");
    assert.equal(await alive(innocent.pid), true, "a pid the slot no longer claims must not be signalled");
    innocent.kill("SIGKILL");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

// Codex uses stdin EOF to delimit its `-` prompt, so the provider stand-in starts emitting only
// after EOF. A second child deliberately keeps daemon-owned stdio open and must exit when those
// pipes close; that positive control proves the fixture can distinguish process-group survival
// from the worker-host's durable output path.
test(
  "force stopping the daemon leaves its detached runtime worker alive",
  { skip: process.platform === "win32" ? "requires POSIX detached process-group semantics" : false },
  async () => {
    const fixture = await spawnRuntimeOwningDaemon();
    try {
      await waitForTextCount(fixture.streamPath, '"kind":"provider_event"', 1);
      assert.equal(await alive(fixture.workerPid), true, "the runtime worker must be live before daemon stop");
      assert.equal(await alive(fixture.coupledPid), true, "the stdio-coupled control must be live before daemon stop");
      const forced = runTarget(fixture, ["daemon", "stop", "--force", "--json"]);
      assert.equal(forced.ok, true, JSON.stringify(forced));
      assert.match(String(forced.summary), /SIGKILL/u, "the fixture must exercise forceStopDaemon's SIGKILL path");
      await waitForExit(fixture.daemonPid);
      await waitForExit(fixture.coupledPid);
      const providerEventsAfterDaemonExit = textCount(fixture.streamPath, '"kind":"provider_event"');
      assert.equal(
        await alive(fixture.workerPid),
        true,
        "the detached runtime worker must keep persisting provider output after daemon SIGKILL",
      );
      await waitForTextCount(fixture.streamPath, '"kind":"provider_event"', providerEventsAfterDaemonExit + 1);
    } finally {
      try {
        process.kill(-fixture.workerPid, "SIGTERM");
      } catch {
        // The worker may have exited between the assertion and stopCleanup.
      }
      try {
        process.kill(fixture.coupledPid, "SIGKILL");
      } catch {
        /* the positive control already exited */
      }
      await stopCleanup(fixture);
    }
  },
);

// Shutdown used to close the socket first and release the pid file and the singleton lock after the
// WAL drain. For the whole length of that drain the four bookkeeping surfaces contradicted each other
// -- endpoint gone, pid file present, lock held, process alive -- and three separate observers each
// guessed differently: `daemon stop` called it a timeout, every other command called it
// daemon_unavailable, and autostart read the dying generation as a starting one and waited out
// readyTimeoutMs * 6. These fixtures pin the window itself: one drain longer than the stop budget,
// one shorter, and the lifecycle read that used to mistake an exited generation for a starting one.
test("a drain longer than the stop budget is reported as draining, not as a timeout", async () => {
  const fixture = await spawnDrainingDaemon("drain-slow", drainMs);
  try {
    const stopStartedAt = Date.now(),
      stop = runCli(fixture, ["daemon", "stop", "--json"]);
    // The lifecycle observation marks the drain as begun, so everything below is inside the window.
    const stopping = await waitForStoppingObservation(fixture),
      inWindow = await snapshot(fixture),
      status = await runCli(fixture, ["daemon", "status", "--json"]);
    const stopped = JSON.parse((await stop).stdout) as Record<string, unknown>;

    assert.notEqual(stopped.code, "daemon_stop_timeout", JSON.stringify(stopped));
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    assert.equal(stopped.draining, true, JSON.stringify(stopped));
    assert.equal(
      JSON.stringify(inWindow),
      JSON.stringify({ socketAccepting: true, pidFilePid: fixture.daemonPid, lockPid: fixture.daemonPid, alive: true }),
      "the drain window must show one consistent daemon, not a socket that disagrees with the pid file",
    );

    const reported = JSON.parse(status.stdout) as Record<string, unknown>;
    assert.equal(reported.ok, true, JSON.stringify(reported));
    assert.match(String(reported.summary), /Stopping: draining \d+ live runtime session\(s\)/u);
    assert.ok(
      stopping.elapsedMs < drainMs,
      `a draining daemon must answer at once, not be waited out: ${stopping.elapsedMs}ms`,
    );

    await waitForRelease(fixture);
    assert.ok(Date.now() - stopStartedAt >= drainMs, "the fixture must have exercised a drain longer than the budget");
  } finally {
    await drainCleanup(fixture);
  }
});

test("a drain shorter than the stop budget still reports a plain stop and leaves nothing behind", async () => {
  const fixture = await spawnDrainingDaemon("drain-fast", 0);
  try {
    const stop = await runCli(fixture, ["daemon", "stop", "--json"]),
      stopped = JSON.parse(stop.stdout) as Record<string, unknown>;
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    assert.equal(stopped.draining, undefined, "a drain inside the budget is a completed stop, not a draining one");
    assert.ok(stop.elapsedMs < 5_000, `a fast drain must not spend the whole budget: ${stop.elapsedMs}ms`);
    await waitForRelease(fixture);
  } finally {
    await drainCleanup(fixture);
  }
});

test("a generation that recorded its exit is not read as a starting daemon", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-drain-progress-")),
    userRoot = path.join(parent, "user"),
    daemonId = "exited-generation",
    // The pid is this live test process: without the exit record, liveness alone reads as "starting".
    lifecycle = openDaemonLifecycleLog({ userRoot, daemonId });
  try {
    lifecycle.record({ event: "process_start", endpoint: "endpoint" });
    lifecycle.record({ event: "socket_bound", endpoint: "endpoint" });
    assert.notEqual(readDaemonStartProgress(launchSpec(userRoot, daemonId), 0), null);
    lifecycle.record({ event: "process_exit", outcome: "stop_requested" });
    assert.equal(readDaemonStartProgress(launchSpec(userRoot, daemonId), 0), null);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

const unusedLaunch = (): DaemonLaunchSpec => ({ command: process.execPath, args: [], env: {} });
test("daemon_stopping waits for the replacement generation and resends exactly once", async () => {
  const daemonId = "restart-ready",
    parent = mkdtempSync(path.join(tmpdir(), "ha-restart-ready-")),
    socketPath = localUserDaemonEndpoint(parent, daemonId),
    pidPath = daemonPidPath(parent, daemonId),
    server = createServer(),
    receipts = [
      { ok: false, code: "daemon_stopping" },
      { ok: true, outcome: "applied" },
    ],
    request = async () => receipts.shift()!;
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  writeFileSync(pidPath, "111\n");
  const replace = setTimeout(() => {
    writeFileSync(pidPath, "222\n");
    server.listen(socketPath);
  }, 20);
  try {
    const result = await withAutostart(request, unusedLaunch, socketPath, {
      autostart: true,
      env: {},
      invokingRoot: process.cwd(),
      userRoot: parent,
      daemonId,
      restartBudgetMs: 1_000,
      commandCategory: "operation",
    });
    assert.equal(result.outcome, "applied");
    assert.deepEqual(result.daemonRestart, {
      waitedMs: (result.daemonRestart as { waitedMs: number }).waitedMs,
      retries: 1,
    });
    assert.equal(receipts.length, 0, "the original request is resent exactly once");
  } finally {
    clearTimeout(replace);
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    rmSync(parent, { recursive: true, force: true });
  }
});

test("restart budget exhaustion returns daemon_restarting without resending", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-restart-timeout-")),
    daemonId = "restart-timeout",
    calls: number[] = [];
  writeFileSync(daemonPidPath(parent, daemonId), "111\n");
  try {
    const result = await withAutostart(
      async () => {
        calls.push(Date.now());
        return { ok: false, code: "daemon_stopping" };
      },
      unusedLaunch,
      path.join(parent, "missing.sock"),
      {
        autostart: true,
        env: {},
        invokingRoot: process.cwd(),
        userRoot: parent,
        daemonId,
        restartBudgetMs: 25,
        commandCategory: "operation",
      },
    );
    assert.equal(result.code, "daemon_restarting");
    assert.match(String((result.error as { hint: string }).hint), /old build -> new build.*waited 1s/u);
    assert.deepEqual(result.daemonRestart, {
      waitedMs: (result.daemonRestart as { waitedMs: number }).waitedMs,
      retries: 0,
    });
    assert.equal(calls.length, 1);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("daemon lifecycle commands preserve daemon_stopping without waiting or resending", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-restart-lifecycle-")),
    daemonId = "restart-lifecycle";
  writeFileSync(daemonPidPath(parent, daemonId), "111\n");
  let calls = 0;
  try {
    const result = await withAutostart(
      async () => {
        calls += 1;
        return { ok: false, code: "daemon_stopping" };
      },
      unusedLaunch,
      path.join(parent, "daemon.sock"),
      {
        autostart: true,
        env: {},
        invokingRoot: process.cwd(),
        userRoot: parent,
        daemonId,
        restartBudgetMs: 1_000,
        commandCategory: "daemon-lifecycle",
      },
    );
    assert.equal(result.code, "daemon_stopping");
    assert.equal(calls, 1);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

const serveOutput = new WeakMap<ChildProcess, string>();
function spawnServe(userRoot: string): ChildProcess {
  const child = spawn(
    process.execPath,
    [daemonServeEntry(), "serve", "--user-root", userRoot, "--daemon-id", "default", "--json"],
    { env: cliEnv(userRoot, userRoot) },
  );
  serveOutput.set(child, "");
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (chunk: Buffer) =>
      serveOutput.set(child, `${serveOutput.get(child) ?? ""}${chunk.toString("utf8")}`),
    );
  return child;
}
async function firstDeferral(
  children: readonly ChildProcess[],
): Promise<{ readonly ok?: boolean; readonly outcome?: string; readonly incumbent?: { readonly pid?: number } }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const child of children) if (child.exitCode === 0) return parseReceipt(child);
    await delay(50);
  }
  throw new Error("neither serve deferred within 30s");
}
async function firstExit(children: readonly ChildProcess[]): Promise<{ readonly code: number | null }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const exited = children.find((child) => child.exitCode !== null);
    if (exited) return { code: exited.exitCode };
    await delay(50);
  }
  throw new Error("no serve exited within 30s");
}
function parseReceipt(child: ChildProcess): {
  readonly ok?: boolean;
  readonly outcome?: string;
  readonly incumbent?: { readonly pid?: number };
} {
  const line = (serveOutput.get(child) ?? "").split("\n").find((candidate) => candidate.startsWith("{"));
  return line
    ? (JSON.parse(line) as Record<string, unknown> as { ok?: boolean; outcome?: string; incumbent?: { pid?: number } })
    : {};
}
async function residentPid(userRoot: string): Promise<number> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const pid = readDaemonPid(userRoot, "default");
    if (pid !== null) return pid;
    await delay(50);
  }
  throw new Error("no resident daemon pid appeared");
}
async function waitForImportProgress(root: string, minimumRevisions: number): Promise<void> {
  for (let attempt = 0; attempt < 12_000; attempt += 1) {
    if (makeTaskEventReader({ rootDir: root, repoId: "singleton-import" }).read().revision >= minimumRevisions) return;
    await delay(5);
  }
  throw new Error("migration replay did not make SQLite-accepted progress");
}

async function waitForProcessExit(pid: number, boundMs: number): Promise<void> {
  for (const deadline = Date.now() + boundMs; Date.now() < deadline; ) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await delay(50);
  }
  throw new Error(`process ${pid} did not exit within ${boundMs}ms`);
}
function closeOf(
  child: ChildProcess,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null)
      resolve({ code: child.exitCode, signal: child.signalCode });
    else child.once("close", (code, signal) => resolve({ code, signal }));
  });
}
function reap(child: ChildProcess): void {
  void closeOf(child).then(
    () => undefined,
    () => undefined,
  );
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}
function cliEnv(root: string, userRoot: string): NodeJS.ProcessEnv {
  const { HARNESS_ACTOR: _actor, ...base } = process.env;
  return {
    ...base,
    HOME: path.join(root, ".home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    HARNESS_DAEMON_USER_ROOT: userRoot,
  };
}
function setup(): { parent: string; root: string; userRoot: string } {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-singleton-cli-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user");
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "README.md"), "# Fixture\n", "utf8");
  writeFileSync(path.join(root, "harness/harness.yaml"), "layout:\n  authoredRoot: harness\n", "utf8");
  writeFileSync(
    path.join(root, "harness/people.yaml"),
    `schema: harness-people/v1\npeople:\n  - personId: owner\n    displayName: Owner\n    primaryEmail: owner@example.test\n    roles: [owner]\n    credentials:\n      - kind: unix-socket-owner-boundary\n        issuer: host:${hostname()}\n        subject: ${process.getuid?.() ?? 0}\nroles:\n  - roleId: owner\n    commandClasses: [admin, repo-write, repo-read, arbiter]\n`,
    "utf8",
  );
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Singleton Test");
  git(root, "config", "user.email", "singleton@example.test");
  git(root, "add", "README.md", "harness/harness.yaml", "harness/people.yaml");
  git(root, "commit", "--quiet", "-m", "fixture");
  return { parent, root, userRoot };
}
function legacyFixture(root: string, taskCount: number): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    "utf8",
  );
  for (let index = 0; index < taskCount; index += 1) {
    const taskId = `task_legacy_bulk_${index}`,
      taskRoot = path.join(root, "harness/tasks", taskId);
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(
      path.join(taskRoot, "INDEX.md"),
      `---\nschema: task-package/v2\ntask_id: ${taskId}\ntitle: Bulk legacy task ${index}\nlifecycle:\n  status: done\n  engine: local\n  bindingCreatedAt: 2026-01-0${1 + (index % 8)}T00:00:00.000Z\n---\n\n# Bulk legacy task ${index}\n`,
      "utf8",
    );
  }
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Legacy Fixture");
  git(root, "config", "user.email", "legacy@example.test");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "legacy bulk fixture");
  writeFileSync(path.join(root, ".git/info/exclude"), ".harness/\n", { flag: "a" });
  buildProjectionOracle(root);
}
function register(root: string, userRoot: string, repoId: string): void {
  seedSettingsEvent({ rootDir: root, repoId });
  assert.equal(
    run(root, userRoot, ["daemon", "repo", "register", "--repo-id", repoId, "--root", root, "--no-link"]).ok,
    true,
  );
}
function run(root: string, userRoot: string, args: readonly string[]): Record<string, unknown> {
  const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], {
    encoding: "utf8",
    env: cliEnv(root, userRoot),
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
function stop(userRoot: string): void {
  const pid = readDaemonPid(userRoot, "default");
  if (pid === null) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  // A killed daemon leaves its pid file and socket file behind; remove both so
  // a failure-path cleanup cannot leak a stale endpoint into the next run.
  rmSync(daemonPidPath(userRoot, "default"), { force: true });
  rmSync(localUserDaemonEndpoint(userRoot, "default"), { force: true });
}
function cleanup(parent: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(parent, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 10) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
function waitForDaemonDown(userRoot: string): void {
  const socketPath = localUserDaemonEndpoint(userRoot, "default");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (readDaemonPid(userRoot, "default") === null && !existsSync(socketPath)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  throw new Error("previous daemon did not drain before the next probe");
}
function git(root: string, ...args: string[]): number {
  return Number(execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim());
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface StopFixture {
  readonly parent: string;
  readonly userRoot: string;
  readonly daemonId: string;
  readonly daemonPid: number;
}
interface RuntimeFixture extends StopFixture {
  readonly workerPid: number;
  readonly coupledPid: number;
  readonly streamPath: string;
}

async function spawnRuntimeOwningDaemon(): Promise<RuntimeFixture> {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-stop-runtime-worker-")),
    userRoot = path.join(parent, "user"),
    daemonId = "runtime-worker",
    rootDir = path.join(parent, "repo"),
    workerPidPath = path.join(parent, "worker.pid"),
    coupledPidPath = path.join(parent, "coupled.pid"),
    script = path.join(parent, "runtime-daemon.mjs"),
    launcher = path.join(parent, "launcher.mjs"),
    socketPath = localUserDaemonEndpoint(userRoot, daemonId),
    pidPath = daemonPidPath(userRoot, daemonId),
    streamPath = path.join(rootDir, ".harness", "runtime", "dispatches", "dispatch_111111111111111111111111.jsonl"),
    runtimeModule = pathToFileURL(path.resolve("packages/daemon/src/runtime-spawn-process.ts")).href;
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(path.dirname(socketPath), { recursive: true });
  writeFileSync(
    script,
    `import net from "node:net";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchNative } from ${JSON.stringify(runtimeModule)};
const [socketPath, pidPath, rootDir, workerPidPath, coupledPidPath] = process.argv.slice(2);
const dispatchId = "dispatch_111111111111111111111111";
const streamRoot = path.join(rootDir, ".harness", "runtime", "dispatches");
mkdirSync(streamRoot, { recursive: true });
writeFileSync(path.join(streamRoot, dispatchId + ".jsonl"), "{}\\n");
const providerScript = 'process.stdin.resume(); process.stdin.once("end", () => { let sequence = 0; setInterval(() => process.stdout.write(JSON.stringify({ type: "item.updated", sequence: sequence += 1 }) + "\\\\n"), 20); }); process.stdout.on("error", () => process.exit(3));';
const runtime = launchNative({ executablePath: process.execPath, args: ["-e", providerScript], env: process.env, cwd: rootDir, prompt: "hold" }, { rootDir, dispatchId });
runtime.onOutput((_chunk, persisted) => { if (!persisted) appendFileSync(path.join(streamRoot, dispatchId + ".jsonl"), '{"kind":"provider_event"}\\n'); });
const coupled = spawn(process.execPath, ["-e", 'process.stdin.resume(); process.stdin.once("end", () => process.exit(3)); setInterval(() => process.stdout.write("control\\\\n"), 20); process.stdout.on("error", () => process.exit(3));'], { stdio: ["pipe", "pipe", "ignore"] });
coupled.stdout.resume();
writeFileSync(workerPidPath, String(runtime.pid));
writeFileSync(coupledPidPath, String(coupled.pid));
writeFileSync(pidPath, process.pid + "\\n");
const server = net.createServer(() => undefined);
server.listen(socketPath);
process.on("SIGTERM", () => undefined);
`,
    "utf8",
  );
  writeFileSync(
    launcher,
    `import { spawn } from "node:child_process";
const child = spawn(process.execPath, [${JSON.stringify(script)}, ...process.argv.slice(2)], { stdio: "ignore", detached: true, env: process.env });
child.unref();
`,
    "utf8",
  );
  const nodeOptions = [process.env.NODE_OPTIONS, "--experimental-strip-types"].filter(Boolean).join(" "),
    launched = spawnSync(process.execPath, [launcher, socketPath, pidPath, rootDir, workerPidPath, coupledPidPath], {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
      timeout: 10_000,
    });
  assert.equal(launched.status, 0, launched.stderr);
  const daemonPid = await waitForPidFile(pidPath, socketPath),
    workerPid = await waitForPidFile(workerPidPath),
    coupledPid = await waitForPidFile(coupledPidPath);
  return { parent, userRoot, daemonId, daemonPid, workerPid, coupledPid, streamPath };
}

async function spawnLegacyDaemon(daemonId: string): Promise<StopFixture> {
  const parent = mkdtempSync(path.join(tmpdir(), `ha-stop-${daemonId}-`)),
    userRoot = path.join(parent, "user");
  mkdirSync(userRoot, { recursive: true });
  const script = path.join(parent, "legacy-daemon.mjs"),
    launcher = path.join(parent, "launcher.mjs");
  writeFileSync(script, LEGACY_DAEMON, "utf8");
  // A real resident daemon is started by a launcher that exits (daemon start --service, GUI
  // restart): the daemon is orphaned, parented by init, and reaped the moment it dies. Spawning
  // the stub the same way keeps an exited stub from lingering as a zombie of this test process
  // while it is blocked inside a synchronous CLI call.
  writeFileSync(
    launcher,
    `import { spawn } from "node:child_process";\nconst child = spawn(process.execPath, [${JSON.stringify(script)}, ...process.argv.slice(2)], { stdio: "ignore", detached: true });\nchild.unref();\n`,
    "utf8",
  );
  const socketPath = localUserDaemonEndpoint(userRoot, daemonId);
  mkdirSync(path.dirname(socketPath), { recursive: true });
  const launched = spawnSync(
    process.execPath,
    [launcher, daemonId === "wedge" ? "wedge" : "legacy", socketPath, daemonPidPath(userRoot, daemonId)],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const daemonPid = await new Promise<number>((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const poll = async () => {
      const pid = readDaemonPid(userRoot, daemonId);
      if (pid !== null && (await socketAccepting(socketPath))) resolve(pid);
      else if (Date.now() > deadline) reject(new Error("legacy daemon never became socket-ready"));
      else
        setTimeout(() => {
          void poll();
        }, 20);
    };
    void poll();
  });
  return { parent, userRoot, daemonId, daemonPid };
}
// A daemon speaking the pre-daemon.stop wire: hello answers without a build stamp, everything
// else is "Method not found", and SIGTERM is handled exactly as serve() handles it. The wedge
// variant accepts connections, never answers, and swallows SIGTERM.
const LEGACY_DAEMON = `import net from "node:net";
import { unlinkSync, writeFileSync } from "node:fs";
const [mode, socketPath, pidPath] = process.argv.slice(2);
writeFileSync(pidPath, process.pid + "\\n");
const server = net.createServer((socket) => {
  if (mode === "wedge") return;
  socket.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split("\\n")) {
      if (!line.startsWith("{")) continue;
      const request = JSON.parse(line);
      const answer = request.method === "protocol.hello"
        ? { jsonrpc: "2.0", id: request.id, result: { ok: true, protocolVersion: { major: 1, minor: 0 }, methods: ["protocol.hello", "daemon.status"] } }
        : request.method === "daemon.status"
          ? { jsonrpc: "2.0", id: request.id, result: { ok: true, daemonId: "legacy", pid: process.pid, repos: [], summary: "daemon status: pid=" + process.pid + " repos=0" } }
          : { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } };
      socket.write(JSON.stringify(answer) + "\\n");
    }
  });
});
// Keep the real daemon's pid-before-bind gap wide enough that the fixture helper must prove socket
// readiness instead of mistaking process bookkeeping for a server that can already answer.
setTimeout(() => server.listen(socketPath), 2_000);
// A real serve() releases its pid file and endpoint as its last cooperative acts; the stub must
// do the same on TERM or the CLI waits out its budget on an exited-but-unreaped child.
process.on("SIGTERM", () => { if (mode === "wedge") return; server.close(); try { unlinkSync(socketPath); } catch {} try { unlinkSync(pidPath); } catch {} process.exit(0); });
`;
type Target = { readonly userRoot: string; readonly daemonId: string };
function controlEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.HARNESS_DAEMON_USER_ROOT;
  delete env.HARNESS_DAEMON_ID;
  return env;
}
function runRaw(target: Target, args: readonly string[]) {
  return spawnSync(process.execPath, [cli, ...args, "--user-root", target.userRoot, "--daemon-id", target.daemonId], {
    encoding: "utf8",
    timeout: 60_000,
    env: controlEnv(),
  });
}
function runTarget(target: Target, args: readonly string[]): Record<string, unknown> {
  const result = runRaw(target, args);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
function socketAccepting(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    const settle = (ready: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}
async function alive(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      process.kill(pid, 0);
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}
async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (!(await alive(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`process ${pid} did not exit`);
}
async function waitForPidFile(target: string, socketPath?: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const pid = existsSync(target) ? Number(readFileSync(target, "utf8")) : 0;
    if (Number.isInteger(pid) && pid > 0 && (!socketPath || (await socketAccepting(socketPath)))) return pid;
    if (Date.now() >= deadline) throw new Error(`process pid never appeared in ${target}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function textCount(target: string, pattern: string): number {
  return readFileSync(target, "utf8").split(pattern).length - 1;
}
async function waitForTextCount(target: string, pattern: string, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (textCount(target, pattern) < count) {
    if (Date.now() >= deadline) throw new Error(`${target} never contained ${count} occurrences of ${pattern}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function stopCleanup(fixture: StopFixture): Promise<void> {
  try {
    process.kill(fixture.daemonPid, "SIGKILL");
  } catch {
    /* already gone */
  }
  rmSync(daemonPidPath(fixture.userRoot, fixture.daemonId), { force: true });
  rmSync(localUserDaemonEndpoint(fixture.userRoot, fixture.daemonId), { force: true });
  rmSync(fixture.parent, { recursive: true, force: true });
}

interface DrainFixture {
  readonly parent: string;
  readonly rootDir: string;
  readonly userRoot: string;
  readonly daemonId: string;
  readonly daemonPid: number;
}

function launchSpec(userRoot: string, daemonId: string): DaemonLaunchSpec {
  return {
    command: process.execPath,
    args: ["index.ts", "serve", "--user-root", userRoot, "--daemon-id", daemonId],
    env: {},
  };
}

// A real startDaemon() whose single repository cell takes a controlled time to close, which is where
// the WAL drain lives. Nothing else about the daemon is stubbed, so the socket, the pid file and the
// singleton lock are released by the production shutdown path.
const DRAINING_DAEMON = `import path from "node:path";
import { pathToFileURL } from "node:url";
const [repoRoot, userRoot, daemonId, closeDelayMs] = process.argv.slice(2);
const load = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const { startDaemon } = await load("packages/daemon/src/runtime.ts");
const { openBootstrappedRepoCell } = await load("packages/daemon/test/repo-settings.fixture.ts");
let stopping = null, daemon;
const requestStop = () => {
  stopping ??= (async () => {
    if (daemon && "stop" in daemon) await daemon.stop();
  })();
};
daemon = await startDaemon({
  userRoot,
  daemonId,
  shutdownRequested: () => stopping !== null,
  requestShutdown: requestStop,
  openCell: async (input) => {
    const cell = await openBootstrappedRepoCell(input);
    const closeCell = cell.close.bind(cell);
    return Object.assign(Object.create(cell), {
      close: async () => {
        await new Promise((resolve) => setTimeout(resolve, Number(closeDelayMs)));
        await closeCell();
      },
    });
  },
});
process.on("SIGTERM", requestStop);
process.on("SIGINT", requestStop);
if (stopping) await stopping;
`;

async function spawnDrainingDaemon(daemonId: string, closeDelayMs: number): Promise<DrainFixture> {
  const parent = mkdtempSync(path.join(tmpdir(), `ha-${daemonId}-`)),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    script = path.join(parent, "draining-daemon.mjs"),
    launcher = path.join(parent, "launcher.mjs"),
    endpoint = localUserDaemonEndpoint(userRoot, daemonId);
  rosterRepo(rootDir, daemonId);
  registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId: daemonId, userRoot, createConvenienceLinks: false });
  writeFileSync(script, DRAINING_DAEMON, "utf8");
  // The resident daemon is orphaned by a launcher that exits, exactly as `daemon start --service`
  // leaves it, so an exited fixture is reaped instead of lingering as a zombie of this test process.
  writeFileSync(
    launcher,
    `import { spawn } from "node:child_process";\nconst child = spawn(process.execPath, [${JSON.stringify(
      script,
    )}, ...process.argv.slice(2)], { stdio: "ignore", detached: true, env: process.env });\nchild.unref();\n`,
    "utf8",
  );
  mkdirSync(path.dirname(endpoint), { recursive: true });
  const nodeOptions = [process.env.NODE_OPTIONS, "--experimental-strip-types"].filter(Boolean).join(" "),
    launched = spawnSync(process.execPath, [launcher, repoRoot, userRoot, daemonId, String(closeDelayMs)], {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
      timeout: 30_000,
    });
  assert.equal(launched.status, 0, launched.stderr);
  const deadline = Date.now() + 60_000;
  let fixture: DrainFixture;
  for (;;) {
    const pid = readDaemonPid(userRoot, daemonId);
    if (pid !== null && (await socketAccepting(endpoint))) {
      fixture = { parent, rootDir, userRoot, daemonId, daemonPid: pid };
      break;
    }
    if (Date.now() > deadline) throw new Error(`fixture daemon ${daemonId} never became socket-ready`);
    await delay(50);
  }
  // The drain these fixtures measure is the cell close, so the repository must be attached first.
  while (!(await attached(fixture))) {
    if (Date.now() > deadline) throw new Error(`fixture daemon ${daemonId} never attached its repository`);
    await delay(100);
  }
  return fixture;
}

async function attached(fixture: DrainFixture): Promise<boolean> {
  const probe = await runCli(fixture, ["daemon", "status", "--json"]);
  const receipt = JSON.parse(probe.stdout) as { readonly repos?: readonly { readonly state?: string }[] };
  return receipt.repos?.[0]?.state === "attached";
}

async function snapshot(
  fixture: DrainFixture,
): Promise<{ socketAccepting: boolean; pidFilePid: number | null; lockPid: number | null; alive: boolean }> {
  const lockPath = daemonSingletonLockPath(fixture.userRoot, fixture.daemonId);
  return {
    socketAccepting: await socketAccepting(localUserDaemonEndpoint(fixture.userRoot, fixture.daemonId)),
    pidFilePid: readDaemonPid(fixture.userRoot, fixture.daemonId),
    lockPid: existsSync(lockPath) ? Number(readFileSync(lockPath, "utf8").trim()) : null,
    alive: daemonProcessAlive(fixture.daemonPid),
  };
}

// Before the stop request lands the daemon still serves normally, so the fixture waits for the first
// lifecycle observation rather than assuming a freshly spawned `daemon stop` has already reached it.
async function waitForStoppingObservation(fixture: DrainFixture): Promise<CliRun> {
  const deadline = Date.now() + drainMs;
  for (;;) {
    // A normal repository command intentionally waits for a replacement generation during
    // daemon_stopping. Probe through the daemon lifecycle surface instead: lifecycle commands
    // must report the active drain immediately and must never trigger restart-window recovery.
    const run = await runCli(fixture, ["daemon", "status", "--json"]),
      receipt = JSON.parse(run.stdout) as { readonly summary?: string };
    if (/Stopping: draining/u.test(receipt.summary ?? "")) return run;
    if (Date.now() > deadline) throw new Error(`daemon ${fixture.daemonId} never reported its drain: ${run.stdout}`);
    await delay(50);
  }
}
async function waitForRelease(fixture: DrainFixture): Promise<void> {
  const deadline = Date.now() + drainMs + 20_000;
  for (;;) {
    const state = await snapshot(fixture);
    if (!state.socketAccepting && state.pidFilePid === null && state.lockPid === null && !state.alive) return;
    if (Date.now() > deadline) throw new Error(`daemon ${fixture.daemonId} never released: ${JSON.stringify(state)}`);
    await delay(50);
  }
}

interface CliRun {
  readonly elapsedMs: number;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

// Workspace commands take their target from the environment, control commands from flags; both must
// run without this process's own harness environment, which would otherwise refuse an autostart.
function runCli(fixture: DrainFixture, args: readonly string[], target: "flags" | "env" = "flags"): Promise<CliRun> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("HARNESS_")) delete env[key];
  if (target === "env")
    Object.assign(env, { HARNESS_DAEMON_USER_ROOT: fixture.userRoot, HARNESS_DAEMON_ID: fixture.daemonId });
  const flags = target === "flags" ? ["--user-root", fixture.userRoot, "--daemon-id", fixture.daemonId] : [],
    startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args, ...flags], { env, cwd: fixture.rootDir });
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (status) => resolve({ elapsedMs: Date.now() - startedAt, status, stdout, stderr }));
  });
}

function rosterRepo(rootDir: string, repoId: string): void {
  mkdirSync(rootDir, { recursive: true });
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.name", "Daemon Stop Drain Window Test"],
    ["config", "user.email", "daemon-stop-drain-window@example.invalid"],
    ["config", "gc.auto", "0"],
    ["commit", "--allow-empty", "--quiet", "-m", "fixture base"],
  ])
    execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" });
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
  execFileSync("git", ["-C", rootDir, "add", "harness"], { encoding: "utf8" });
  execFileSync("git", ["-C", rootDir, "commit", "--quiet", "-m", "add roster fixture"], { encoding: "utf8" });
}

async function drainCleanup(fixture: Fixture): Promise<void> {
  try {
    process.kill(fixture.daemonPid, "SIGKILL");
  } catch {
    /* already gone */
  }
  rmSync(daemonPidPath(fixture.userRoot, fixture.daemonId), { force: true });
  rmSync(localUserDaemonEndpoint(fixture.userRoot, fixture.daemonId), { force: true });
  rmSync(fixture.parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
