// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DaemonAutostartError,
  daemonLaunchOutputPath,
  daemonHostStartRefusal,
  ensureLocalDaemonRunning,
  isDaemonUnreachable,
  readDaemonStartProgress,
  runtimeDaemonStartRefusal,
  type DaemonAutostartResult,
  type DaemonLaunchSpec,
} from "../src/client/daemon-autostart.ts";
import {
  DAEMON_LIFECYCLE_LOG_SCHEMA,
  daemonLifecycleLogPath,
  daemonStdioLogPath,
  openDaemonLifecycleLog,
} from "../src/lifecycle-log.ts";
import { startDetachedProcess, startDetachedProcessChecked } from "../src/process-port.ts";
import { daemonSingletonLockPath } from "../src/daemon-singleton.ts";
import { canonicalPath } from "../src/runtime-worker-push.ts";

function coded(code: string): Error & { code: string } {
  const error = Object.assign(new Error(`connect ${code}`), { code });
  return error;
}
const launch = (): DaemonLaunchSpec => ({
  command: "node",
  args: ["index.ts", "serve", "--user-root", "/tmp/ha-user", "--daemon-id", "default"],
  env: {},
});

test("runtime start refusal requires a runtime actor", () => {
  const taskBoundOnly = runtimeDaemonStartRefusal({ HARNESS_TASK_BOUND: "1" });
  assert.equal(taskBoundOnly, null);

  const absent = runtimeDaemonStartRefusal({ HARNESS_ACTOR: "agent:runtime-session:worker" });
  assert.equal(absent?.code, "daemon_start_runtime_forbidden");
});

test("a worktree is refused before spawn while the registered canonical checkout is allowed", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-host-root-")),
    canonical = path.join(parent, "repo"),
    worktree = path.join(canonical, ".worktrees", "feature"),
    independent = path.join(parent, "independent"),
    userRoot = path.join(parent, "user");
  try {
    mkdirSync(path.join(canonical, ".git"), { recursive: true });
    mkdirSync(path.join(canonical, ".git", "worktrees", "feature"), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    mkdirSync(path.join(independent, ".git"), { recursive: true });
    mkdirSync(userRoot);
    writeFileSync(path.join(worktree, ".git"), "gitdir: ../../.git/worktrees/feature\n", "utf8");
    writeFileSync(path.join(canonical, ".git", "worktrees", "feature", "commondir"), "../..\n", "utf8");
    writeFileSync(
      path.join(userRoot, "registry.json"),
      `${JSON.stringify({
        schema: "harness-daemon-registry/v2",
        connections: [{ id: "local", kind: "local", displayName: "This device", state: "enabled" }],
        repos: [
          {
            repoId: "canonical",
            canonicalRoot: canonical,
            displayName: "Canonical",
            authoredBranch: "main",
            mode: "local",
            connectionId: "local",
            state: "enabled",
            registeredAt: "2026-07-07T00:00:00.000Z",
          },
        ],
      })}\n`,
      "utf8",
    );
    assert.equal(await daemonHostStartRefusal({ invokingRoot: path.join(canonical, "packages"), userRoot }), null);
    assert.equal(
      await daemonHostStartRefusal({ invokingRoot: independent, userRoot }),
      null,
      "a different, not-yet-registered repository owns its own checkout identity",
    );
    const refusal = await daemonHostStartRefusal({ invokingRoot: worktree, userRoot });
    assert.equal(refusal?.code, "daemon_start_noncanonical_checkout");
    assert.match(refusal?.hint ?? "", /A worktree may connect to an existing daemon but cannot host it/u);
    assert.match(refusal?.hint ?? "", new RegExp(escapeRegExp(canonicalPath(canonical)), "u"));

    let spawns = 0;
    const result = await ensureLocalDaemonRunning({
      socketPath: path.join(parent, "daemon.sock"),
      invokingRoot: worktree,
      launch: () => ({
        command: "node",
        args: ["index.ts", "serve", "--user-root", userRoot, "--daemon-id", "default"],
        env: {},
      }),
      probe: async () => false,
      spawnDetached: async () => {
        spawns += 1;
      },
    });
    assert.equal(result.code, "daemon_start_noncanonical_checkout");
    assert.equal(result.attempts, 0);
    assert.equal(spawns, 0);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("unreachable daemon is started once and the ready socket is used without a second attempt", async () => {
  let spawns = 0;
  const result = await ensureLocalDaemonRunning({
    socketPath: "/tmp/ha-autostart.sock",
    invokingRoot: process.cwd(),
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
    args: ["index.ts", "serve", "--user-root", userRoot, "--daemon-id", "default"],
    env: {},
  });
  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        ensureLocalDaemonRunning({
          socketPath: path.join(userRoot, "daemon.sock"),
          invokingRoot: process.cwd(),
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
    args: ["index.ts", "serve", "--user-root", userRoot, "--daemon-id", "default"],
    env: {},
  });
  try {
    writeFileSync(daemonSingletonLockPath(userRoot, "default"), `${process.pid}\n`, "utf8");
    const result = await ensureLocalDaemonRunning({
      socketPath: path.join(userRoot, "daemon.sock"),
      invokingRoot: process.cwd(),
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
    invokingRoot: process.cwd(),
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
      args: ["index.ts", "serve", "--user-root", userRoot, "--daemon-id", "progress"],
      env: {},
    });
  try {
    const result = await ensureLocalDaemonRunning({
      socketPath: path.join(userRoot, "daemon.sock"),
      invokingRoot: process.cwd(),
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

test("a bound socket waits for the managed identity resume before reporting write readiness", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-autostart-identity-")),
    daemonId = "identity-ready",
    progress: string[] = [],
    lifecycle = openDaemonLifecycleLog({ userRoot, daemonId }),
    spec = (): DaemonLaunchSpec => ({
      command: "node",
      args: ["index.ts", "serve", "--user-root", userRoot, "--daemon-id", daemonId],
      env: {},
    });
  lifecycle.record({ event: "process_start" });
  lifecycle.record({ event: "socket_bound" });
  // The successor already owns the singleton; only its identity resume is still running.
  writeFileSync(daemonSingletonLockPath(userRoot, daemonId), `${process.pid}\n`, "utf8");
  let probes = 0;
  try {
    const result = await ensureLocalDaemonRunning({
      socketPath: path.join(userRoot, "daemon.sock"),
      invokingRoot: process.cwd(),
      launch: spec,
      probe: async () => {
        probes += 1;
        if (probes === 5) lifecycle.record({ event: "identity_ready" });
        return true;
      },
      probeIntervalMs: 1,
      readyTimeoutMs: 100,
      onProgress: (entry) => progress.push(entry.message),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(
      probes >= 6,
      true,
      "the wait keeps probing past the bound socket until identity settles and then confirms it",
    );
    assert.equal(
      progress.some((message) => /managed identity services are starting/u.test(message)),
      true,
      "the caller is told which startup stage is still running",
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("a failed managed identity resume settles startup so the real refusal is not waited out", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-autostart-identity-failed-")),
    daemonId = "identity-failed",
    lifecycle = openDaemonLifecycleLog({ userRoot, daemonId }),
    spec = (): DaemonLaunchSpec => ({
      command: "node",
      args: ["index.ts", "serve", "--user-root", userRoot, "--daemon-id", daemonId],
      env: {},
    });
  lifecycle.record({ event: "process_start" });
  lifecycle.record({ event: "socket_bound" });
  lifecycle.record({ event: "rbac_resume_failed", error: "postgres exited with 1." });
  writeFileSync(daemonSingletonLockPath(userRoot, daemonId), `${process.pid}\n`, "utf8");
  try {
    const result = await ensureLocalDaemonRunning({
      socketPath: path.join(userRoot, "daemon.sock"),
      invokingRoot: process.cwd(),
      launch: spec,
      probe: async () => true,
      probeIntervalMs: 1,
      readyTimeoutMs: 100,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.attempts, 0, "no new daemon is spawned for a settled identity failure");
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("a startup whose managed identity never settles times out naming that stage", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-autostart-identity-timeout-")),
    daemonId = "identity-timeout",
    lifecycle = openDaemonLifecycleLog({ userRoot, daemonId }),
    spec = (): DaemonLaunchSpec => ({
      command: "node",
      args: ["index.ts", "serve", "--user-root", userRoot, "--daemon-id", daemonId],
      env: {},
    });
  lifecycle.record({ event: "process_start" });
  lifecycle.record({ event: "socket_bound" });
  writeFileSync(daemonSingletonLockPath(userRoot, daemonId), `${process.pid}\n`, "utf8");
  try {
    const result = await ensureLocalDaemonRunning({
      socketPath: path.join(userRoot, "daemon.sock"),
      invokingRoot: process.cwd(),
      launch: spec,
      probe: async () => true,
      probeIntervalMs: 1,
      readyTimeoutMs: 5,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "daemon_starting");
    assert.match(result.hint, /managed identity services are starting/u);
    assert.match(result.hint, /has not become write-ready/u);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("a lifecycle control may stop at the bound socket without waiting for identity", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-autostart-lifecycle-socket-")),
    daemonId = "lifecycle-socket",
    lifecycle = openDaemonLifecycleLog({ userRoot, daemonId }),
    spec = (): DaemonLaunchSpec => ({
      command: "node",
      args: ["index.ts", "serve", "--user-root", userRoot, "--daemon-id", daemonId],
      env: {},
    });
  lifecycle.record({ event: "process_start" });
  lifecycle.record({ event: "socket_bound" });
  writeFileSync(daemonSingletonLockPath(userRoot, daemonId), `${process.pid}\n`, "utf8");
  try {
    const result = await ensureLocalDaemonRunning({
      socketPath: path.join(userRoot, "daemon.sock"),
      invokingRoot: process.cwd(),
      launch: spec,
      probe: async () => true,
      probeIntervalMs: 1,
      readyTimeoutMs: 5,
      requireIdentityReady: false,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("a launcher that is missing fails fast as daemon_spawn_not_found without a second attempt", async () => {
  let spawns = 0;
  const result = await ensureLocalDaemonRunning({
    socketPath: "/tmp/ha-autostart-enoent.sock",
    invokingRoot: process.cwd(),
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

test("a missing spawn cwd is classified as the workspace root being missing, not the launcher", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-autostart-root-missing-")),
    missingRoot = path.join(userRoot, "edge", "workspace");
  try {
    // The default spawn detached path spawns from the invoking root; a root that does not exist
    // reaches Node's spawn as a plain ENOENT on the binary and must not read as a missing launcher.
    const result = await ensureLocalDaemonRunning({
      socketPath: "/tmp/ha-autostart-missing-cwd.sock",
      invokingRoot: missingRoot,
      launch: () => ({
        command: process.execPath,
        args: ["index.ts", "serve", "--user-root", userRoot, "--daemon-id", "missing-root"],
        env: {},
      }),
      probe: async () => false,
      probeIntervalMs: 1,
      readyTimeoutMs: 5,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "daemon_spawn_root_missing");
    assert.equal(result.attempts, 1);
    assert.doesNotMatch(result.hint, /launcher binary was not found/u);
    assert.match(result.hint, new RegExp(missingRoot.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("a permission-denied launcher is classified as daemon_spawn_permission", async () => {
  const result = await ensureLocalDaemonRunning({
    socketPath: "/tmp/ha-autostart-eacces.sock",
    invokingRoot: process.cwd(),
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
    invokingRoot: process.cwd(),
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

test("daemon launch output path is the stdio sink, not the structured lifecycle JSONL", () => {
  const userRoot = path.join(tmpdir(), "ha-output-target");
  assert.equal(
    daemonLaunchOutputPath({
      command: "node",
      args: ["index.js", "--service", "--user-root", userRoot, "--daemon-id", "blue"],
      env: {},
    }),
    daemonStdioLogPath(userRoot, "blue"),
  );
  assert.equal(daemonLaunchOutputPath({ command: "node", args: ["index.js", "task", "list"], env: {} }), undefined);
});

test("start progress stages report the last repository, attach timeouts, prunes, and settled startup", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-autostart-stages-"));
  try {
    const log = openDaemonLifecycleLog({ userRoot, daemonId: "stages" }),
      spec = (): DaemonLaunchSpec => ({
        command: "node",
        args: ["index.ts", "serve", "--user-root", userRoot, "--daemon-id", "stages"],
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

// The readiness probe runs every 50 ms while a CLI waits for a daemon start, so it must parse only
// the current generation. The count is the number of JSON.parse calls, not wall clock: the retained
// history is made larger and the observed work must not change.
test("a readiness probe parses only the current lifecycle generation, not retained history", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-autostart-tail-read-")),
    line = (entry: Readonly<Record<string, unknown>>, daemonId: string): string =>
      JSON.stringify({
        schema: DAEMON_LIFECYCLE_LOG_SCHEMA.id,
        at: "2026-11-04T00:00:00.000Z",
        daemonId,
        pid: process.pid,
        ...entry,
      }),
    history = (daemonId: string, records: number, generation: number): string =>
      `${Array.from({ length: records }, (_, index) =>
        line(
          {
            event: "runtime_spawn",
            runtimeSessionId: `history-${generation}-${index}`,
            pid: 1_000 + generation,
          },
          daemonId,
        ),
      ).join("\n")}\n`;
  const parsedBy = async (historicalRecords: number): Promise<number> => {
    const userRoot = path.join(parent, `history-${historicalRecords}`),
      daemonId = "tail-read",
      logPath = daemonLifecycleLogPath(userRoot, daemonId),
      launchSpec: DaemonLaunchSpec = {
        command: "node",
        args: ["index.ts", "serve", "--user-root", userRoot, "--daemon-id", daemonId],
        env: {},
      };
    mkdirSync(path.dirname(logPath), { recursive: true });
    for (const generation of [3, 2, 1])
      writeFileSync(`${logPath}.${generation}`, history(daemonId, historicalRecords, generation), "utf8");
    writeFileSync(
      logPath,
      `${line({ event: "process_start" }, daemonId)}\n${line({ event: "socket_bound" }, daemonId)}\n` +
        `${line({ event: "identity_ready" }, daemonId)}\n`,
      "utf8",
    );
    const original = JSON.parse;
    let parsed = 0;
    JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
      parsed += 1;
      return original(...args);
    }) as typeof JSON.parse;
    try {
      const result = await ensureLocalDaemonRunning({
        socketPath: path.join(userRoot, "daemon.sock"),
        invokingRoot: process.cwd(),
        launch: () => launchSpec,
        probe: async () => true,
        probeIntervalMs: 1,
        readyTimeoutMs: 100,
      });
      assert.equal(result.ok, true, JSON.stringify(result));
    } finally {
      JSON.parse = original;
    }
    return parsed;
  };
  try {
    assert.equal(await parsedBy(500), 3, "one readiness check parses the three current-generation records");
    assert.equal(await parsedBy(5_000), 3, "the parsed count stays independent of retained history length");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("detached stdout, stderr, and a fatal stack land in the daemon output log", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-detached-output-")),
    outputPath = path.join(root, "daemon.log");
  try {
    await startDetachedProcessChecked(
      process.execPath,
      [
        "-e",
        "console.log('stdout witness'); console.log('cwd witness ' + process.cwd()); console.error('stderr witness'); throw new Error('fatal witness')",
      ],
      process.env,
      outputPath,
      root,
    );
    for (let attempt = 0; attempt < 100 && !readFileSync(outputPath, "utf8").includes("fatal witness"); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const output = readFileSync(outputPath, "utf8");
    assert.match(output, /stdout witness/u);
    assert.match(output, /stderr witness/u);
    assert.match(output, /Error: fatal witness/u);
    assert.match(output, new RegExp(`cwd witness ${escapeRegExp(realpathSync.native(root))}`, "u"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Fire-and-forget callers (the `ha gui` shell launcher) read the pid from the returned child to
// fill their launch receipt, so the unchecked variant must hand the child back, not just void.
test("startDetachedProcess returns the child whose output lands in the output log", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-detached-return-")),
    outputPath = path.join(root, "gui.log");
  try {
    const child = startDetachedProcess(
      process.execPath,
      ["-e", "console.error('stderr witness'); throw new Error('fatal witness')"],
      process.env,
      outputPath,
      root,
    );
    assert.ok(Number.isInteger(child.pid), "the launcher receipt reads the pid synchronously after spawn");
    for (let attempt = 0; attempt < 100 && !readFileSync(outputPath, "utf8").includes("fatal witness"); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const output = readFileSync(outputPath, "utf8");
    assert.match(output, /stderr witness/u);
    assert.match(output, /Error: fatal witness/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
