// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonAutostartError, daemonLaunchOutputPath, ensureLocalDaemonRunning, isDaemonUnreachable, type DaemonAutostartResult, type DaemonLaunchSpec } from "../src/client/daemon-autostart.ts";
import { daemonLifecycleLogPath } from "../src/lifecycle-log.ts";
import { startDetachedProcessChecked } from "../src/process-port.ts";

function coded(code: string): Error & { code: string } { const error = Object.assign(new Error(`connect ${code}`), { code }); return error; }
const launch = (): DaemonLaunchSpec => ({ command: "node", args: ["index.ts", "daemon", "serve", "--user-root", "/tmp/ha-user", "--daemon-id", "default"], env: {} });

test("unreachable daemon is started once and the ready socket is used without a second attempt", async () => {
  const launches: DaemonLaunchSpec[] = [];
  const result = await ensureLocalDaemonRunning({ socketPath: "/tmp/ha-autostart.sock", launch: () => { const spec = launch(); launches.push(spec); return spec; },
    probe: async () => launches.length > 0, spawnDetached: async () => undefined, probeIntervalMs: 1, retryDelayMs: 1, readyTimeoutMs: 50 });
  assert.equal(result.ok, true); assert.equal(result.attempts, 1); assert.equal(launches.length, 1);
});

test("two failed start attempts stop retrying and classify the failure as a bind timeout", async () => {
  let spawns = 0;
  const result = await ensureLocalDaemonRunning({ socketPath: "/tmp/ha-autostart-timeout.sock", launch, probe: async () => false,
    spawnDetached: async () => { spawns += 1; }, probeIntervalMs: 1, retryDelayMs: 1, readyTimeoutMs: 5 });
  assert.equal(result.ok, false); assert.equal(result.code, "daemon_bind_timeout"); assert.equal(result.attempts, 2); assert.equal(spawns, 2);
  assert.match(result.hint, /did not accept connections/u); assert.match(result.hint, /\/tmp\/ha-autostart-timeout\.sock/u); assert.match(result.hint, /node index\.ts daemon serve/u);
});

test("a launcher that is missing fails fast as daemon_spawn_not_found without a second attempt", async () => {
  let spawns = 0;
  const result = await ensureLocalDaemonRunning({ socketPath: "/tmp/ha-autostart-enoent.sock", launch, probe: async () => false,
    spawnDetached: async () => { spawns += 1; throw coded("ENOENT"); }, probeIntervalMs: 1, retryDelayMs: 1, readyTimeoutMs: 5 });
  assert.equal(result.ok, false); assert.equal(result.code, "daemon_spawn_not_found"); assert.equal(result.attempts, 1); assert.equal(spawns, 1);
  assert.match(result.hint, /ENOENT/u);
});

test("a permission-denied launcher is classified as daemon_spawn_permission", async () => {
  const result = await ensureLocalDaemonRunning({ socketPath: "/tmp/ha-autostart-eacces.sock", launch, probe: async () => false,
    spawnDetached: async () => { throw coded("EACCES"); }, probeIntervalMs: 1, retryDelayMs: 1, readyTimeoutMs: 5 });
  assert.equal(result.ok, false); assert.equal(result.code, "daemon_spawn_permission"); assert.match(result.hint, /EACCES/u);
});

test("a non-OS launcher failure is classified as daemon_start_failed", async () => {
  const result = await ensureLocalDaemonRunning({ socketPath: "/tmp/ha-autostart-other.sock", launch, probe: async () => false,
    spawnDetached: async () => { throw new Error("spawn helper exploded"); }, probeIntervalMs: 1, retryDelayMs: 1, readyTimeoutMs: 5 });
  assert.equal(result.ok, false); assert.equal(result.code, "daemon_start_failed"); assert.match(result.hint, /spawn helper exploded/u);
});

test("only connection-level failures count as unreachable so protocol rejections never autostart", () => {
  assert.equal(isDaemonUnreachable(coded("ECONNREFUSED")), true);
  assert.equal(isDaemonUnreachable(coded("ENOENT")), true);
  assert.equal(isDaemonUnreachable(coded("ETIMEDOUT")), true);
  assert.equal(isDaemonUnreachable(new Error("daemon_unavailable")), true);
  assert.equal(isDaemonUnreachable(new Error("workspace is not registered; run ha daemon repo register")), false);
  assert.equal(isDaemonUnreachable(new Error("daemon returned non-object result for repo.tasks.list")), false);
  assert.equal(isDaemonUnreachable("string error"), false);
});

test("DaemonAutostartError carries the classified code for CLI/GUI receipt rendering", () => {
  const result: DaemonAutostartResult = { ok: false, code: "daemon_bind_timeout", hint: "The daemon did not accept connections.", attempts: 2 };
  const error = new DaemonAutostartError(result);
  assert.equal(error instanceof Error, true); assert.equal(error.code, "daemon_bind_timeout"); assert.equal(error.attempts, 2); assert.equal(error.message, result.hint);
});

test("daemon launch output path is derived from the explicit serve target", () => {
  const userRoot = path.join(tmpdir(), "ha-output-target");
  assert.equal(daemonLaunchOutputPath({ command: "node", args: ["index.js", "daemon", "serve", "--user-root", userRoot, "--daemon-id", "blue"], env: {} }), daemonLifecycleLogPath(userRoot, "blue"));
  assert.equal(daemonLaunchOutputPath({ command: "node", args: ["index.js", "task", "list"], env: {} }), undefined);
});

test("detached stdout, stderr, and a fatal stack land in the daemon output log", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-detached-output-")), outputPath = path.join(root, "daemon.log");
  try {
    await startDetachedProcessChecked(process.execPath, ["-e", "console.log('stdout witness'); console.error('stderr witness'); throw new Error('fatal witness')"], process.env, outputPath);
    for (let attempt = 0; attempt < 100 && !readFileSync(outputPath, "utf8").includes("fatal witness"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const output = readFileSync(outputPath, "utf8"); assert.match(output, /stdout witness/u); assert.match(output, /stderr witness/u); assert.match(output, /Error: fatal witness/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
