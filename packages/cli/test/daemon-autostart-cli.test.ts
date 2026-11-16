// harness-test-tier: integration
import { fixtureDaemonHello } from "../../daemon/test/fixtures/daemon-hello.ts";
import test from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { daemonStoppedMarkerPath } from "@harness-anything/daemon/internal/client/daemon-autostart";
import { perUserSocketRoot } from "@harness-anything/daemon/internal/client/local-daemon-target";
import { createRuntimeCallbackRelay } from "@harness-anything/daemon/internal/runtime-callback-relay";
import * as shared from "./daemon-autostart-cli.fixture.ts";

const {
  assert,
  assertValidWriteReceipt,
  chmodSync,
  clearDaemonStoppedMarker,
  cli,
  cliDaemonServeLaunch,
  cliEnv,
  createServer,
  existsSync,
  localUserDaemonEndpoint,
  mkdirSync,
  openDaemonLifecycleLog,
  path,
  readDaemonLifecycleRecords,
  readDaemonPid,
  realpathSync,
  register,
  registerDaemonRepo,
  registerSeeded,
  requestDaemonJsonRpcAt,
  run,
  seedLegacyTask,
  seedSettingsEvent,
  setup,
  setupRepository,
  spawn,
  spawnCli,
  spawnSync,
  waitForDaemonDown,
  writeFileSync,
} = shared;

test("resident daemon autostart strips worker routing and execution credentials", () => {
  const keys = ["HARNESS_DAEMON_RELAY", "HARNESS_EXECUTION_CREDENTIAL", "HARNESS_EXECUTION_EXPIRES_AT"],
    previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = "worker-only";
    const launch = cliDaemonServeLaunch("/daemon-user", "worker");
    for (const key of keys) assert.equal(launch.env[key], undefined, key);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test(
  "daemon status names a build_superseded self-exit and its recovery once the daemon is down",
  { timeout: 30_000 },
  async () => {
    const fixture = setup(),
      endpoint = localUserDaemonEndpoint(fixture.userRoot, "default"),
      runtimeRoot = path.join(fixture.parent, "runtime"),
      runtimeFile = builtRuntime(runtimeRoot, "build-a"),
      buildIdPath = path.join(runtimeRoot, "packages/cli/dist/build-id.txt");
    const child = fork(
      new URL("./daemon-superseded-child.fixture.ts", import.meta.url),
      [fixture.userRoot, runtimeFile, endpoint],
      {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: cliEnv(fixture.root, fixture.userRoot),
      },
    );
    const exited = once(child, "exit");
    let stderr = "";
    child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
    try {
      await Promise.race([
        once(child, "message"),
        exited.then(() => {
          throw new Error(`daemon exited before startup: ${stderr}`);
        }),
      ]);
      writeFileSync(buildIdPath, "build-b\n", "utf8");
      // One reportStaleBuild request lets the daemon observe the drift; with nothing live to drain
      // it self-exits, leaving exactly the state status must speak for: no daemon, no operator stop
      // marker, and a lifecycle log whose final record is the exit.
      await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 2_000, 2_000, undefined, true);
      // Status independently checks OS liveness. A closed in-process host would leave the test's
      // own pid alive, so use a resident child and witness its actual exit before asserting "down".
      assert.deepEqual(await exited, [0, null], stderr);
      assert.equal(
        readDaemonLifecycleRecords(fixture.userRoot, "default").some(
          (record) => record.event === "process_exit" && record.outcome === "build_superseded",
        ),
        true,
      );
      assert.equal(existsSync(daemonStoppedMarkerPath(fixture.userRoot, "default")), false);
      const statusRun = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "daemon", "status"], {
        encoding: "utf8",
        env: cliEnv(fixture.root, fixture.userRoot),
      });
      assert.notEqual(statusRun.status, 0, `${statusRun.stderr}\n${statusRun.stdout}`);
      const receipt = JSON.parse(statusRun.stdout) as { summary?: string; nextAction?: string };
      assert.match(String(receipt.summary), /not running \(exited build_superseded at \d{4}-\d{2}-\d{2}T/u);
      assert.match(String(receipt.nextAction), /autostart/u);
      assert.match(String(receipt.nextAction), /ha daemon start --service/u);
      assert.equal(readDaemonPid(fixture.userRoot, "default"), null, "status must remain read-only");
      // A first init in a clone uses the same autostart path as other ordinary commands.
      register(fixture.root, fixture.userRoot, "autostart");
      const successorPid = readDaemonPid(fixture.userRoot, "default");
      assert.ok(successorPid && successorPid !== child.pid, "init must start a successor without an explicit start");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  },
);

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

test("task-bound runtime identity cannot autostart the shared daemon", (context) => {
  const fixture = setup(),
    repoId = "clean-autostart",
    endpoint = localUserDaemonEndpoint(fixture.userRoot, "default"),
    workerHome = path.join(fixture.parent, "worker", "home"),
    workerEnv = {
      ...cliEnv(fixture.root, fixture.userRoot),
      HOME: workerHome,
      PATH: [path.join(fixture.parent, "worker", "arg0"), process.env.PATH ?? ""].join(path.delimiter),
      CODEX_HOME: path.join(workerHome, ".codex"),
      CLAUDE_CONFIG_DIR: path.join(workerHome, ".claude"),
      ANTHROPIC_API_KEY: "worker-anthropic-secret",
      ANTHROPIC_BASE_URL: "https://anthropic.worker.invalid",
      OPENAI_API_KEY: "worker-openai-secret",
      OPENAI_BASE_URL: "https://openai.worker.invalid",
      CLAUDE_CODE_SESSION_ID: "claude-worker-session",
      CODEX_THREAD_ID: "codex-worker-thread",
      CODEX_SESSION_ID: "codex-worker-session",
      HARNESS_ACTOR: "agent:runtime-session:worker-env",
      HARNESS_DAEMON_ENDPOINT: endpoint,
      HARNESS_DAEMON_ID: "default",
      HARNESS_DAEMON_REPO_ID: repoId,
      HARNESS_TASK_BOUND: "1",
    };

  seedSettingsEvent({ rootDir: fixture.root, repoId });
  registerDaemonRepo({
    canonicalRoot: fixture.root,
    repoId,
    userRoot: fixture.userRoot,
    createConvenienceLinks: false,
  });
  const denied = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "task", "list"], {
    encoding: "utf8",
    env: workerEnv,
  });
  assert.notEqual(denied.status, 0, `${denied.stderr}\n${denied.stdout}`);
  const refusal = JSON.parse(denied.stdout) as { readonly error?: { readonly code?: string } };
  assert.equal(refusal.error?.code, "daemon_start_runtime_forbidden");
  assert.equal(readDaemonPid(fixture.userRoot, "default"), null, "a runtime caller must not claim the daemon slot");

  const explicitStart = spawnSync(
    process.execPath,
    [cli, "--root", fixture.root, "--json", "daemon", "start", "--service"],
    { encoding: "utf8", env: workerEnv },
  );
  assert.notEqual(explicitStart.status, 0);
  assert.equal(
    (JSON.parse(explicitStart.stdout) as { readonly error?: { readonly code?: string } }).error?.code,
    "daemon_start_runtime_forbidden",
  );
  assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
  const available = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "task", "list"], {
    encoding: "utf8",
    env: workerEnv,
  });
  assert.equal(available.status, 0, `${available.stderr}\n${available.stdout}`);
  assert.equal((JSON.parse(available.stdout) as { readonly outcome?: string }).outcome, "applied");
  context.diagnostic(`task-bound refusal=${refusal.error?.code}; existing daemon request=applied`);
});

test("repo-admin backup routes through the injected runtime callback relay", async () => {
  const previousTemp = process.env.TMPDIR;
  process.env.TMPDIR = "/tmp";
  const fixture = setup(),
    repoId = "relay-admin",
    dispatchId = `dispatch_${randomBytes(12).toString("hex")}`,
    canonicalRoot = realpathSync.native(fixture.root),
    endpoint = localUserDaemonEndpoint(fixture.userRoot, "default"),
    relayPath = path.join(perUserSocketRoot(), `r-${dispatchId.slice("dispatch_".length)}.sock`),
    workerHome = path.join(fixture.parent, "worker", "home"),
    backupDir = path.join(fixture.root, "tmp", "relay-backup"),
    {
      HARNESS_DAEMON_USER_ROOT: _stripped,
      HARNESS_DAEMON_RELAY: _relay,
      ...workerEnv
    } = cliEnv(fixture.root, fixture.userRoot);
  seedSettingsEvent({ rootDir: fixture.root, repoId });
  registerDaemonRepo({
    canonicalRoot: fixture.root,
    repoId,
    userRoot: fixture.userRoot,
    createConvenienceLinks: false,
  });
  assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
  mkdirSync(workerHome, { recursive: true });
  const relay = createRuntimeCallbackRelay({
    dispatchId,
    route: { userRoot: fixture.userRoot, daemonId: "default", endpoint },
    relayPath,
  });
  await relay.start();
  try {
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [cli, "--root", fixture.root, "--json", "backup", backupDir], {
        env: {
          ...workerEnv,
          HOME: workerHome,
          HARNESS_ACTOR: "agent:runtime-session:relay-admin",
          HARNESS_TASK_BOUND: "1",
          HARNESS_DAEMON_ENDPOINT: relayPath,
          HARNESS_DAEMON_RELAY: "1",
          HARNESS_CANONICAL_ROOT: canonicalRoot,
          HARNESS_DAEMON_REPO_ID: repoId,
          HARNESS_DAEMON_ID: "default",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const receipt = JSON.parse(result.stdout) as { readonly ok?: boolean };
    assert.equal(receipt.ok, true);
    assert.equal(existsSync(path.join(backupDir, "manifest.json")), true);
  } finally {
    await relay.stop();
    if (previousTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTemp;
  }
});

test("repo-admin backup waits through transient repo_warming over the runtime callback relay", async () => {
  const previousTemp = process.env.TMPDIR;
  process.env.TMPDIR = "/tmp";
  const fixture = setup(false),
    repoId = "relay-warming",
    dispatchId = `dispatch_${randomBytes(12).toString("hex")}`,
    canonicalRoot = realpathSync.native(fixture.root),
    endpoint = localUserDaemonEndpoint(fixture.userRoot, "default"),
    relayPath = path.join(perUserSocketRoot(), `r-${dispatchId.slice("dispatch_".length)}.sock`),
    workerHome = path.join(fixture.parent, "worker", "home"),
    backupDir = path.join(fixture.root, "tmp", "relay-warming-backup"),
    {
      HARNESS_DAEMON_USER_ROOT: _stripped,
      HARNESS_DAEMON_RELAY: _relay,
      ...workerEnv
    } = cliEnv(fixture.root, fixture.userRoot);
  mkdirSync(workerHome, { recursive: true });
  let requests = 0,
    helloRequests = 0;
  const server = createServer((socket) => {
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += String(chunk);
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const request = JSON.parse(line) as { id: number; method: string };
        if (request.method === "protocol.hello") helloRequests += 1;
        else {
          assert.equal(request.method, "daemon.repo.backup");
          requests += 1;
        }
        const result =
          request.method === "protocol.hello"
            ? fixtureDaemonHello()
            : requests >= 3
              ? {
                  ok: true,
                  schema: "ledger-backup-receipt/v1",
                  exitCode: 0,
                  backupDir,
                }
              : {
                  schema: "command-receipt/v2",
                  ok: false,
                  command: "daemon.repo.backup",
                  outcome: "op_rejected",
                  opId: "N/A",
                  origin: "daemon",
                  code: "repo_warming",
                  evidence: "rejection:repo_warming",
                  rejectionExplanation: `Repository ${repoId} is still warming; waiting for recovering to complete.`,
                  error: { code: "repo_warming" },
                };
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      }
    });
  });
  let relay: ReturnType<typeof createRuntimeCallbackRelay> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    relay = createRuntimeCallbackRelay({
      dispatchId,
      route: { userRoot: fixture.userRoot, daemonId: "default", endpoint },
      relayPath,
    });
    await relay.start();
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [cli, "--root", fixture.root, "--json", "backup", backupDir], {
        env: {
          ...workerEnv,
          HOME: workerHome,
          HARNESS_ACTOR: "agent:runtime-session:relay-warming",
          HARNESS_TASK_BOUND: "1",
          HARNESS_DAEMON_ENDPOINT: relayPath,
          HARNESS_DAEMON_RELAY: "1",
          HARNESS_CANONICAL_ROOT: canonicalRoot,
          HARNESS_DAEMON_REPO_ID: repoId,
          HARNESS_DAEMON_ID: "default",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const receipt = JSON.parse(result.stdout) as { readonly ok?: boolean; readonly schema?: string };
    assert.equal(receipt.ok, true);
    assert.equal(receipt.schema, "ledger-backup-receipt/v1");
    assert.equal(requests, 3, "repo-admin backup must poll twice after the initial repo_warming receipt");
    assert.equal(helloRequests, 2, "the warming polls must share one JSON-RPC connection");
  } finally {
    await relay?.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTemp;
  }
});

test("repo-admin backup rejects an injected relay endpoint outside the sealed canonical root", () => {
  const fixture = setup(),
    repoId = "relay-conflict",
    canonicalRoot = realpathSync.native(fixture.root),
    foreignRelay = path.join(fixture.parent, "foreign", ".harness", "r-0123456789abcdef01234567.sock"),
    workerHome = path.join(fixture.parent, "worker", "home"),
    { HARNESS_DAEMON_USER_ROOT: _stripped, ...workerEnv } = cliEnv(fixture.root, fixture.userRoot);
  seedSettingsEvent({ rootDir: fixture.root, repoId });
  registerDaemonRepo({
    canonicalRoot: fixture.root,
    repoId,
    userRoot: fixture.userRoot,
    createConvenienceLinks: false,
  });
  mkdirSync(workerHome, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [cli, "--root", fixture.root, "--json", "backup", path.join(fixture.root, "tmp", "relay-backup")],
    {
      encoding: "utf8",
      env: {
        ...workerEnv,
        HOME: workerHome,
        HARNESS_ACTOR: "agent:runtime-session:relay-conflict",
        HARNESS_TASK_BOUND: "1",
        HARNESS_DAEMON_ENDPOINT: foreignRelay,
        HARNESS_DAEMON_RELAY: "1",
        HARNESS_CANONICAL_ROOT: canonicalRoot,
        HARNESS_DAEMON_REPO_ID: repoId,
        HARNESS_DAEMON_ID: "default",
      },
    },
  );
  assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const receipt = JSON.parse(result.stdout) as { readonly error?: { readonly code?: string } };
  assert.equal(receipt.error?.code, "daemon_target_conflict");
});

test("repo bootstrap reaches an injected daemon endpoint across an isolated runtime temp directory", () => {
  const previousTemp = process.env.TMPDIR;
  process.env.TMPDIR = "/tmp";
  const fixture = setup(),
    bootstrapRoot = setupRepository(fixture.parent, "bootstrap-repo"),
    endpoint = localUserDaemonEndpoint(fixture.userRoot, "default"),
    runtimeTemp = path.join(fixture.parent, "runtime", "isolated", "tmp");
  try {
    mkdirSync(runtimeTemp, { recursive: true });
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "--root",
        bootstrapRoot,
        "--json",
        "init",
        "--repo-id",
        "runtime-bootstrap",
        "--person-id",
        "owner",
        "--display-name",
        "Owner",
      ],
      {
        encoding: "utf8",
        env: {
          ...cliEnv(bootstrapRoot, fixture.userRoot),
          HARNESS_DAEMON_ENDPOINT: endpoint,
          TMPDIR: runtimeTemp,
        },
      },
    );
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const receipt = JSON.parse(result.stdout) as { readonly ok?: boolean; readonly repoId?: string };
    assert.equal(receipt.ok, true);
    assert.equal(receipt.repoId, "runtime-bootstrap");
  } finally {
    if (previousTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTemp;
  }
});

test("receipt show diagnoses a missing daemon without starting one", () => {
  const fixture = setup();

  seedSettingsEvent({ rootDir: fixture.root, repoId: "diagnostic" });
  registerDaemonRepo({
    canonicalRoot: fixture.root,
    repoId: "diagnostic",
    userRoot: fixture.userRoot,
    createConvenienceLinks: false,
  });
  const result = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "receipt", "show", "op-missing"], {
    encoding: "utf8",
    env: cliEnv(fixture.root, fixture.userRoot),
  });
  assert.notEqual(result.status, 0);
  const receipt = JSON.parse(result.stdout) as { error: { code: string } };
  assert.equal(receipt.error.code, "daemon_unavailable");
  assert.equal(readDaemonPid(fixture.userRoot, "default"), null, "a diagnostic read must not autostart the daemon");
});

test("receipt show waits for independent SQLite, projection, Git, and worktree facets", () => {
  const fixture = setup(),
    repoId = "receipt-wait";

  assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
  assert.equal(
    run(fixture.root, fixture.userRoot, [
      "init",
      "--repo-id",
      repoId,
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
    ]).ok,
    true,
  );
  const accepted = run(fixture.root, fixture.userRoot, [
    "task",
    "create",
    "--id",
    "task-receipt-wait",
    "--admin",
    "--title",
    "Receipt wait",
  ]);
  assert.equal(accepted.status, "accepted_durable", JSON.stringify(accepted));
  assertValidWriteReceipt(accepted);

  const settled = run(fixture.root, fixture.userRoot, [
    "receipt",
    "show",
    String(accepted.opId),
    "--wait",
    "accepted_durable,projection_visible,git_verified,worktree_visible",
    "--timeout-ms",
    "5000",
  ]);
  assert.equal(settled.status, "accepted_durable", JSON.stringify(settled));
  assert.deepEqual(settled.wait, { state: "satisfied", unsatisfied: [] });
  assert.equal((settled.git as { readonly state?: unknown }).state, "verified");
  assert.equal((settled.worktree as { readonly state?: unknown }).state, "verified");

  for (const args of [
    ["receipt", "show", String(accepted.opId), "--wait", "git_visible"],
    ["receipt", "show", String(accepted.opId), "--timeout-ms", "60001"],
  ] as const) {
    const rejected = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", ...args], {
      encoding: "utf8",
      env: cliEnv(fixture.root, fixture.userRoot),
    });
    assert.notEqual(rejected.status, 0);
    const body = JSON.parse(rejected.stdout) as {
      readonly code?: string;
      readonly error?: { readonly code?: string };
    };
    assert.ok(
      body.code === "unsupported_wait_condition" ||
        body.code === "invalid_field" ||
        body.error?.code === "unsupported_wait_condition" ||
        body.error?.code === "invalid_field",
      rejected.stdout,
    );
  }
});

test("CLI reports lifecycle attach progress and waits through a slow warming repository", async () => {
  const fixture = setup(),
    repoId = "slow-warming",
    socketPath = localUserDaemonEndpoint(fixture.userRoot, "default"),
    lifecycle = openDaemonLifecycleLog({ userRoot: fixture.userRoot, daemonId: "default" });
  seedSettingsEvent({ rootDir: fixture.root, repoId });
  registerDaemonRepo({
    canonicalRoot: fixture.root,
    repoId,
    userRoot: fixture.userRoot,
    createConvenienceLinks: false,
  });
  lifecycle.record({ event: "process_start", endpoint: socketPath });
  lifecycle.record({ event: "socket_bound", endpoint: socketPath });
  lifecycle.record({ event: "repo_attach_started", repoId, attachIndex: 2, attachTotal: 5 });
  let requests = 0,
    helloRequests = 0;
  const server = createServer((socket) => {
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += String(chunk);
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const request = JSON.parse(line) as { id: number; method: string };
        if (request.method === "protocol.hello") helloRequests += 1;
        else requests += 1;
        if (requests === 3)
          lifecycle.record({
            event: "repo_attach_completed",
            repoId,
            attachIndex: 2,
            attachTotal: 5,
            durationMs: 1_000,
          });
        const result =
          request.method === "protocol.hello"
            ? fixtureDaemonHello()
            : requests >= 3
              ? {
                  schema: "command-receipt/v2",
                  ok: true,
                  command: "task-list",
                  outcome: "applied",
                  summary: "task list: 0",
                }
              : {
                  schema: "command-receipt/v2",
                  ok: false,
                  command: "task-list",
                  outcome: "op_rejected",
                  code: "repo_warming",
                  nextAction: "wait for attach",
                };
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const result = await spawnCli(fixture.root, fixture.userRoot, ["task", "list"]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal((JSON.parse(result.stdout) as { outcome: string }).outcome, "applied");
    assert.equal(requests, 3, "the original command must poll twice after the warming receipt");
    assert.equal(helloRequests, 2, "the warming polls must share one JSON-RPC connection");
    assert.match(result.stderr, /daemon is starting; waited \d+s \(repo 2\/5: slow-warming\)/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("dry-run contract migration prints each manual task once", async () => {
  const fixture = setup(),
    repoId = "contract-receipt",
    taskId = "task_legacy_l1";

  await seedLegacyTask(fixture.root, fixture.userRoot, repoId, taskId);
  assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
  registerSeeded(fixture.root, fixture.userRoot, repoId);
  const result = spawnSync(
    process.execPath,
    [cli, "--root", fixture.root, "task", "contract", "migrate", "--dry-run", "--task", taskId],
    { encoding: "utf8", env: cliEnv(fixture.root, fixture.userRoot) },
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal((result.stdout.match(new RegExp(taskId, "gu")) ?? []).length, 1, result.stdout);
  const receipt = run(fixture.root, fixture.userRoot, ["task", "contract", "migrate", "--dry-run", "--task", taskId]);
  const evidence = JSON.parse(String(receipt.evidence)) as {
    report: readonly { taskId: string; status: string; reason: string }[];
    manual: readonly { taskId: string; status: string; reason: string }[];
  };
  assert.deepEqual(evidence.manual, [evidence.report[0]], "JSON keeps the manual subset for machine consumers");
});

test(
  "autostart fails fast when its single-flight lock cannot be created",
  {
    skip:
      process.platform === "win32" || process.getuid?.() === 0 ? "requires POSIX non-root permission semantics" : false,
  },
  () => {
    const fixture = setup();
    try {
      assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
      register(fixture.root, fixture.userRoot, "autostart-fail");
      assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "stop"]).ok, true);
      waitForDaemonDown(fixture.userRoot);
      clearDaemonStoppedMarker(fixture.userRoot, "default");
      // The lock is the first mutating step. A read-only user root must fail there
      // with the permission cause instead of spawning or waiting for a bind timeout.
      chmodSync(fixture.userRoot, 0o555);
      const result = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "task", "list"], {
        encoding: "utf8",
        env: cliEnv(fixture.root, fixture.userRoot),
      });
      assert.notEqual(result.status, 0);
      const receipt = JSON.parse(result.stdout) as { ok: boolean; error: { code: string } };
      assert.equal(receipt.ok, false);
      assert.equal(receipt.error.code, "daemon_spawn_permission");
      assert.equal(
        readDaemonPid(fixture.userRoot, "default"),
        null,
        "no daemon may claim to be resident after failed starts",
      );
    } finally {
      chmodSync(fixture.userRoot, 0o755);
    }
  },
);
