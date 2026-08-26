// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { localUserDaemonEndpoint } from "../../daemon/src/client/local-daemon-target.ts";
import { daemonPidPath, readDaemonPid } from "../../daemon/src/runtime.ts";

const cli = path.resolve("packages/cli/src/index.ts");

// The resident-daemon stop outage (#1653): a daemon serving a build that predates daemon.stop
// answers "Method not found", the CLI's stop used to be a blind write, and the timeout hint pointed
// at a lifecycle log that had nothing to say. These fixtures pin the ladder end to end: a
// pre-daemon.stop daemon stops through the SIGTERM fallback, a wedged daemon produces a hint that
// reports what was observed and names --force, and --force never signals through stale bookkeeping.
test("a daemon that rejects daemon.stop still stops through the signal fallback", async () => {
  const fixture = await spawnLegacyDaemon("legacy");
  try {
    const status = run(fixture, ["daemon", "status", "--json"]);
    assert.equal(status.ok, true, JSON.stringify(status));
    const stopped = run(fixture, ["daemon", "stop", "--json"]);
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    assert.notEqual(stopped.code, "daemon_stop_timeout");
    await waitForExit(fixture.daemonPid);
    assert.equal(
      existsSync(daemonPidPath(fixture.userRoot, fixture.daemonId)),
      false,
      "the fallback stop must still clear the pid file",
    );
  } finally {
    await cleanup(fixture);
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

    const forced = run(fixture, ["daemon", "stop", "--force", "--json"]);
    assert.equal(forced.ok, true, JSON.stringify(forced));
    assert.equal(forced.forced, true);
    await waitForExit(fixture.daemonPid);
    assert.equal(
      existsSync(daemonPidPath(fixture.userRoot, fixture.daemonId)),
      false,
      "force must release the pid file",
    );
  } finally {
    await cleanup(fixture);
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
      const forced = run(fixture, ["daemon", "stop", "--force", "--json"]);
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
        // The worker may have exited between the assertion and cleanup.
      }
      try {
        process.kill(fixture.coupledPid, "SIGKILL");
      } catch {
        /* the positive control already exited */
      }
      await cleanup(fixture);
    }
  },
);

interface Fixture {
  readonly parent: string;
  readonly userRoot: string;
  readonly daemonId: string;
  readonly daemonPid: number;
}
interface RuntimeFixture extends Fixture {
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

async function spawnLegacyDaemon(daemonId: string): Promise<Fixture> {
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
function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.HARNESS_DAEMON_USER_ROOT;
  delete env.HARNESS_DAEMON_ID;
  return env;
}
function runRaw(target: Target, args: readonly string[]) {
  return spawnSync(process.execPath, [cli, ...args, "--user-root", target.userRoot, "--daemon-id", target.daemonId], {
    encoding: "utf8",
    timeout: 60_000,
    env: cliEnv(),
  });
}
function run(target: Target, args: readonly string[]): Record<string, unknown> {
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
async function cleanup(fixture: Fixture): Promise<void> {
  try {
    process.kill(fixture.daemonPid, "SIGKILL");
  } catch {
    /* already gone */
  }
  rmSync(daemonPidPath(fixture.userRoot, fixture.daemonId), { force: true });
  rmSync(localUserDaemonEndpoint(fixture.userRoot, fixture.daemonId), { force: true });
  rmSync(fixture.parent, { recursive: true, force: true });
}
