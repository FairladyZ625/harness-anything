// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DaemonAutostartError,
  daemonLaunchOutputPath,
  ensureLocalDaemonRunning,
  isDaemonUnreachable,
  readDaemonStartProgress,
  runtimeDaemonStartRefusal,
  runtimeDaemonStartRefusalForUnavailable,
  type DaemonAutostartResult,
  type DaemonLaunchSpec,
} from "../src/client/daemon-autostart.ts";
import { daemonLifecycleLogPath, openDaemonLifecycleLog } from "../src/lifecycle-log.ts";
import { startDetachedProcessChecked } from "../src/process-port.ts";
import { daemonSingletonLockPath } from "../src/daemon-singleton.ts";

function coded(code: string): Error & { code: string } {
  const error = Object.assign(new Error(`connect ${code}`), { code });
  return error;
}
const launch = (): DaemonLaunchSpec => ({
  command: "node",
  args: ["index.ts", "daemon", "serve", "--user-root", "/tmp/ha-user", "--daemon-id", "default"],
  env: {},
});

test("runtime start refusal requires a runtime actor and an unavailable daemon", async () => {
  let probes = 0;
  const taskBoundOnly = await runtimeDaemonStartRefusal(
    "/tmp/ha-autostart.sock",
    { HARNESS_TASK_BOUND: "1" },
    async () => {
      probes += 1;
      return false;
    },
  );
  assert.equal(taskBoundOnly, null);
  assert.equal(probes, 0, "a task-bound marker alone is not runtime identity");

  const resident = await runtimeDaemonStartRefusal(
    "/tmp/ha-autostart.sock",
    { HARNESS_ACTOR: "agent:runtime-session:worker" },
    async () => true,
  );
  assert.equal(resident, null, "a runtime actor may use a resident daemon");

  const absent = runtimeDaemonStartRefusalForUnavailable({ HARNESS_ACTOR: "agent:runtime-session:worker" });
  assert.equal(absent?.code, "daemon_start_runtime_forbidden");
});

test("unreachable daemon is started once and the ready socket is used without a second attempt", async () => {
  let spawns = 0;
  const result = await ensureLocalDaemonRunning({
    socketPath: "/tmp/ha-autostart.sock",
    launch,
    probe: async () => spawns > 0,
    spawnDetached: async () => {
      spawns += 1;
    },
    probeIntervalMs: 1,
    readyTimeoutMs: 50,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(spawns, 1);
});

test("concurrent callers share one autostart flight and wait for the same socket", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-autostart-flight-"));
  let spawns = 0,
    reachable = false;
  const sharedLaunch = (): DaemonLaunchSpec => ({
    command: "node",
    args: ["index.ts", "daemon", "serve", "--user-root", userRoot, "--daemon-id", "default"],
    env: {},
  });
  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        ensureLocalDaemonRunning({
          socketPath: path.join(userRoot, "daemon.sock"),
          launch: sharedLaunch,
          probe: async () => reachable,
          spawnDetached: async () => {
            spawns += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            reachable = true;
          },
          probeIntervalMs: 1,
          readyTimeoutMs: 100,
        }),
      ),
    );
    assert.equal(
      results.every((result) => result.ok),
      true,
    );
    assert.equal(spawns, 1, "one CLI owns the launch; every concurrent follower only waits");
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("a GUI/CLI peer that already owns the daemon singleton is awaited, not respawned", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-autostart-singleton-peer-"));
  let spawns = 0;
  const sharedLaunch = (): DaemonLaunchSpec => ({
    command: "node",
    args: ["index.ts", "daemon", "serve", "--user-root", userRoot, "--daemon-id", "default"],
    env: {},
  });
  try {
    writeFileSync(daemonSingletonLockPath(userRoot, "default"), `${process.pid}\n`, "utf8");
    const result = await ensureLocalDaemonRunning({
      socketPath: path.join(userRoot, "daemon.sock"),
      launch: sharedLaunch,
      probe: async () => false,
      spawnDetached: async () => {
        spawns += 1;
      },
      probeIntervalMs: 1,
      readyTimeoutMs: 5,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "daemon_bind_timeout");
    assert.equal(result.attempts, 0);
    assert.equal(spawns, 0, "the existing singleton holder is the only writer candidate");
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("one failed start attempt stops without spawning a second daemon", async () => {
  let spawns = 0;
  const result = await ensureLocalDaemonRunning({
    socketPath: "/tmp/ha-autostart-timeout.sock",
    launch,
    probe: async () => false,
    spawnDetached: async () => {
      spawns += 1;
    },
    probeIntervalMs: 1,
    readyTimeoutMs: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "daemon_bind_timeout");
  assert.equal(result.attempts, 1);
  assert.equal(spawns, 1);
  assert.match(result.hint, /Daemon start failed/u);
  assert.match(result.hint, /\/tmp\/ha-autostart-timeout\.sock/u);
  assert.doesNotMatch(result.hint, /did not accept connections/u);
});

test("a live process with lifecycle attach progress reports starting instead of bind timeout", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-autostart-progress-")),
    progress: string[] = [],
    spec = (): DaemonLaunchSpec => ({
      command: "node",
      args: ["index.ts", "daemon", "serve", "--user-root", userRoot, "--daemon-id", "progress"],
      env: {},
    });
  try {
    const result = await ensureLocalDaemonRunning({
      socketPath: path.join(userRoot, "daemon.sock"),
      launch: spec,
      probe: async () => false,
      probeIntervalMs: 1,
      readyTimeoutMs: 5,
      spawnDetached: async () => {
        const log = openDaemonLifecycleLog({ userRoot, daemonId: "progress" });
        log.record({ event: "process_start" });
        log.record({ event: "repo_attach_started", repoId: "repo-c", attachIndex: 3, attachTotal: 5 });
      },
      onProgress: (entry) => progress.push(entry.message),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "daemon_starting");
    assert.match(result.hint, /repo 3\/5: repo-c/u);
    assert.doesNotMatch(result.hint, /bind_timeout|did not accept connections/u);
    assert.equal(
      progress.some((message) => /waited 0s \(repo 3\/5: repo-c\)/u.test(message)),
      true,
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("a launcher that is missing fails fast as daemon_spawn_not_found without a second attempt", async () => {
  let spawns = 0;
  const result = await ensureLocalDaemonRunning({
    socketPath: "/tmp/ha-autostart-enoent.sock",
    launch,
    probe: async () => false,
    spawnDetached: async () => {
      spawns += 1;
      throw coded("ENOENT");
    },
    probeIntervalMs: 1,
    retryDelayMs: 1,
    readyTimeoutMs: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "daemon_spawn_not_found");
  assert.equal(result.attempts, 1);
  assert.equal(spawns, 1);
  assert.match(result.hint, /ENOENT/u);
});

test("a permission-denied launcher is classified as daemon_spawn_permission", async () => {
  const result = await ensureLocalDaemonRunning({
    socketPath: "/tmp/ha-autostart-eacces.sock",
    launch,
    probe: async () => false,
    spawnDetached: async () => {
      throw coded("EACCES");
    },
    probeIntervalMs: 1,
    retryDelayMs: 1,
    readyTimeoutMs: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "daemon_spawn_permission");
  assert.match(result.hint, /EACCES/u);
});

test("a non-OS launcher failure is classified as daemon_start_failed", async () => {
  const result = await ensureLocalDaemonRunning({
    socketPath: "/tmp/ha-autostart-other.sock",
    launch,
    probe: async () => false,
    spawnDetached: async () => {
      throw new Error("spawn helper exploded");
    },
    probeIntervalMs: 1,
    retryDelayMs: 1,
    readyTimeoutMs: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "daemon_start_failed");
  assert.match(result.hint, /spawn helper exploded/u);
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
  const result: DaemonAutostartResult = {
    ok: false,
    code: "daemon_bind_timeout",
    hint: "The daemon did not accept connections.",
    attempts: 2,
  };
  const error = new DaemonAutostartError(result);
  assert.equal(error instanceof Error, true);
  assert.equal(error.code, "daemon_bind_timeout");
  assert.equal(error.attempts, 2);
  assert.equal(error.message, result.hint);
});

test("daemon launch output path is derived from the explicit serve target", () => {
  const userRoot = path.join(tmpdir(), "ha-output-target");
  assert.equal(
    daemonLaunchOutputPath({
      command: "node",
      args: ["index.js", "daemon", "serve", "--user-root", userRoot, "--daemon-id", "blue"],
      env: {},
    }),
    daemonLifecycleLogPath(userRoot, "blue"),
  );
  assert.equal(daemonLaunchOutputPath({ command: "node", args: ["index.js", "task", "list"], env: {} }), undefined);
});

test("start progress stages report the last repository, attach timeouts, prunes, and settled startup", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-autostart-stages-"));
  try {
    const log = openDaemonLifecycleLog({ userRoot, daemonId: "stages" }),
      spec = (): DaemonLaunchSpec => ({
        command: "node",
        args: ["index.ts", "daemon", "serve", "--user-root", userRoot, "--daemon-id", "stages"],
        env: {},
      });
    log.record({ event: "process_start" });
    log.record({ event: "socket_bound" });
    log.record({ event: "repo_attach_started", repoId: "kty-web", attachIndex: 5, attachTotal: 5 });
    log.record({ event: "repo_attach_completed", repoId: "kty-web", attachIndex: 5, attachTotal: 5 });
    const completed = readDaemonStartProgress(spec(), 61_000);
    assert.match(completed?.message ?? "", /all 5 repositories attached; daemon completing startup/u);
    assert.doesNotMatch(completed?.message ?? "", /preparing the next repository/u);
    log.record({ event: "repo_attach_started", repoId: "probe-zombie", attachIndex: 6, attachTotal: 8 });
    log.record({
      event: "repo_attach_timed_out",
      repoId: "probe-zombie",
      attachIndex: 6,
      attachTotal: 8,
      durationMs: 60_000,
    });
    const timedOut = readDaemonStartProgress(spec(), 62_000);
    assert.match(timedOut?.message ?? "", /repository attach exceeded its budget; daemon moved on/u);
    log.record({ event: "repo_registry_pruned", repoId: "probe-zombie", rootDir: "/private/tmp/gone" });
    const pruned = readDaemonStartProgress(spec(), 63_000);
    assert.match(pruned?.message ?? "", /retired a stale registry entry whose root no longer exists/u);
    log.record({ event: "attachments_settled", attachTotal: 8, attached: 5, unavailable: 1, pruned: 1 });
    const settled = readDaemonStartProgress(spec(), 64_000);
    assert.match(
      settled?.message ?? "",
      /all repositories settled \(1 unavailable\) \(1 pruned\); daemon completing startup after attach/u,
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("detached stdout, stderr, and a fatal stack land in the daemon output log", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-detached-output-")),
    outputPath = path.join(root, "daemon.log");
  try {
    await startDetachedProcessChecked(
      process.execPath,
      ["-e", "console.log('stdout witness'); console.error('stderr witness'); throw new Error('fatal witness')"],
      process.env,
      outputPath,
    );
    for (let attempt = 0; attempt < 100 && !readFileSync(outputPath, "utf8").includes("fatal witness"); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const output = readFileSync(outputPath, "utf8");
    assert.match(output, /stdout witness/u);
    assert.match(output, /stderr witness/u);
    assert.match(output, /Error: fatal witness/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
