// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDaemonStartProgress, type DaemonLaunchSpec } from "../../daemon/src/client/daemon-autostart.ts";
import { localUserDaemonEndpoint } from "../../daemon/src/client/local-daemon-target.ts";
import { daemonProcessAlive, daemonSingletonLockPath } from "../../daemon/src/daemon-singleton.ts";
import { openDaemonLifecycleLog } from "../../daemon/src/lifecycle-log.ts";
import { daemonPidPath, readDaemonPid } from "../../daemon/src/runtime.ts";
import { registerBootstrappedDaemonRepo } from "../../daemon/test/repo-settings.fixture.ts";

const cli = path.resolve("packages/cli/src/index.ts"),
  repoRoot = path.resolve("."),
  drainMs = 8_000;

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
    await cleanup(fixture);
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
    await cleanup(fixture);
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

interface Fixture {
  readonly parent: string;
  readonly rootDir: string;
  readonly userRoot: string;
  readonly daemonId: string;
  readonly daemonPid: number;
}

function launchSpec(userRoot: string, daemonId: string): DaemonLaunchSpec {
  return {
    command: process.execPath,
    args: ["index.ts", "daemon", "serve", "--user-root", userRoot, "--daemon-id", daemonId],
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

async function spawnDrainingDaemon(daemonId: string, closeDelayMs: number): Promise<Fixture> {
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
  let fixture: Fixture;
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

async function attached(fixture: Fixture): Promise<boolean> {
  const probe = await runCli(fixture, ["daemon", "status", "--json"]);
  const receipt = JSON.parse(probe.stdout) as { readonly repos?: readonly { readonly state?: string }[] };
  return receipt.repos?.[0]?.state === "attached";
}

async function snapshot(
  fixture: Fixture,
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
async function waitForStoppingObservation(fixture: Fixture): Promise<CliRun> {
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
async function waitForRelease(fixture: Fixture): Promise<void> {
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
function runCli(fixture: Fixture, args: readonly string[], target: "flags" | "env" = "flags"): Promise<CliRun> {
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

function socketAccepting(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath),
      settle = (ready: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ready);
      };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function cleanup(fixture: Fixture): Promise<void> {
  try {
    process.kill(fixture.daemonPid, "SIGKILL");
  } catch {
    /* already gone */
  }
  rmSync(daemonPidPath(fixture.userRoot, fixture.daemonId), { force: true });
  rmSync(localUserDaemonEndpoint(fixture.userRoot, fixture.daemonId), { force: true });
  rmSync(fixture.parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
