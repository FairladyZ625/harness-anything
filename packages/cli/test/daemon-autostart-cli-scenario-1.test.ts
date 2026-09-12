// harness-test-tier: integration
import test from "node:test";
import * as shared from "./daemon-autostart-cli.fixture.ts";

const {
  assert,
  execFileSync,
  spawn,
  spawnSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  createServer,
  hostname,
  tmpdir,
  path,
  JsonRpcLineClient,
  connectSocket,
  requestDaemonJsonRpcAt,
  streamAgentRuntimeAt,
  localUserDaemonEndpoint,
  clearDaemonStoppedMarker,
  openDaemonLifecycleLog,
  readDaemonLifecycleRecords,
  currentDaemonProtocolVersion,
  readDaemonPid,
  openPersistentWriterEpoch,
  cliDaemonServeLaunch,
  seedSettingsEvent,
  canonicalEventWritePlan,
  makeTaskEventStore,
  activateEmptyCanonicalGeneration,
  registerDaemonRepo,
  REPLAY_TASK_GRAPH,
  taskLifecycleWritePlan,
  WRITE_RECEIPT_SCHEMA,
  validateWriteReceipt,
  realizedTaskPlan,
  cli,
  assertValidWriteReceipt,
  cliEnv,
  setup,
  setupRepository,
  register,
  registerSeeded,
  run,
  published,
  waitForDaemonDown,
  waitForFileContent,
  waitForProcessExit,
  delay,
  processAlive,
  coded,
  stop,
  statusOf,
  git,
  escapeRegExp,
  seedLegacyTask,
  seedAttachableRuntime,
  probeRuntimeAttach,
  spawnCli,
} = shared;

test("resident daemon autostart strips the worker callback relay marker", () => {
  const previous = process.env.HARNESS_DAEMON_RELAY;
  process.env.HARNESS_DAEMON_RELAY = "1";
  try {
    assert.equal(cliDaemonServeLaunch("/daemon-user", "worker").env.HARNESS_DAEMON_RELAY, undefined);
  } finally {
    if (previous === undefined) delete process.env.HARNESS_DAEMON_RELAY;
    else process.env.HARNESS_DAEMON_RELAY = previous;
  }
});

test("stopping a cold daemon leaves the user root untouched", () => {
  const fixture = setup();
  try {
    const stopped = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "daemon", "stop"], {
      encoding: "utf8",
      env: cliEnv(fixture.root, fixture.userRoot),
    });
    assert.notEqual(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
    const receipt = JSON.parse(stopped.stdout) as { error?: { code?: string } };
    assert.equal(receipt.error?.code, "daemon_unavailable");
    assert.equal(existsSync(fixture.userRoot), false, "a cold stop must not create daemon state");
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("operator stop blocks autostart until explicit start while process death remains recoverable", async (context) => {
  const fixture = setup();
  try {
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    register(fixture.root, fixture.userRoot, "autostart");
    const status = run(fixture.root, fixture.userRoot, ["daemon", "status"]);
    assert.equal(status.entry, "source");
    const sourceCommit = (status.build as { readonly commit?: unknown }).commit;
    const gitCommitResult = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: path.resolve("."),
      encoding: "utf8",
    });
    const expectedSourceCommit = gitCommitResult.status === 0 ? gitCommitResult.stdout.trim() : null;
    if (expectedSourceCommit !== null) {
      assert.match(expectedSourceCommit, /^[0-9a-f]{40}$/u);
      assert.equal(sourceCommit, expectedSourceCommit);
      assert.match(String(status.summary), /entry=source commit=[0-9a-f]{40}/u);
    } else assert.equal(sourceCommit, null, "an isolated source archive has no Git identity to report");
    assert.deepEqual(status.target, {
      endpoint: localUserDaemonEndpoint(fixture.userRoot, "default"),
      daemonId: "default",
      userRoot: fixture.userRoot,
      repoId: "autostart",
      canonicalRoot: realpathSync.native(fixture.root),
    });
    for (const value of Object.values(status.target as Record<string, unknown>))
      assert.match(String(status.summary), new RegExp(escapeRegExp(String(value)), "u"));
    assert.equal(
      run(fixture.root, fixture.userRoot, ["task", "create", "--id", "task-autostart", "--admin", "--title", "Auto"])
        .outcome,
      "applied",
    );
    const previousPid = readDaemonPid(fixture.userRoot, "default");
    assert.ok(previousPid);
    // The autostart seam probes first: a live daemon is reused, never respawned.
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "list"]).outcome, "applied");
    assert.equal(
      readDaemonPid(fixture.userRoot, "default"),
      previousPid,
      "a reachable daemon must not be replaced by a second spawn",
    );
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "stop"]).ok, true);
    assert.equal(readDaemonPid(fixture.userRoot, "default"), null);
    assert.equal(
      existsSync(localUserDaemonEndpoint(fixture.userRoot, "default")),
      false,
      "stop receipt settles only after pid and socket are gone",
    );
    const lifecycle = readDaemonLifecycleRecords(fixture.userRoot, "default");
    const processStart = lifecycle.find((record) => record.event === "process_start");
    assert.equal(processStart?.entry, "source");
    assert.equal(processStart?.commit, expectedSourceCommit);
    assert.equal(
      lifecycle.some((record) => record.event === "socket_bound"),
      true,
    );
    assert.equal(
      lifecycle.some((record) => record.event === "process_exit" && record.outcome === "stop_requested"),
      true,
    );
    const stoppedStatusRun = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "daemon", "status"], {
      encoding: "utf8",
      env: cliEnv(fixture.root, fixture.userRoot),
    });
    // Unavailable answers exit non-zero: the first-run lane polls this exit code to see the daemon gone.
    assert.notEqual(stoppedStatusRun.status, 0, `${stoppedStatusRun.stderr}\n${stoppedStatusRun.stdout}`);
    const stoppedStatus = JSON.parse(stoppedStatusRun.stdout) as Record<string, unknown>;
    assert.match(String(stoppedStatus.summary), /not running \(stopped by operator at \d{4}-\d{2}-\d{2}T/u);
    const worktree = path.join(fixture.root, ".worktrees", "task-list-feature");
    git(fixture.root, "worktree", "add", "--quiet", "--detach", worktree);
    const refused = spawnSync(process.execPath, [cli, "--root", worktree, "--json", "task", "list"], {
      encoding: "utf8",
      env: cliEnv(worktree, fixture.userRoot),
    });
    assert.notEqual(refused.status, 0, `${refused.stderr}\n${refused.stdout}`);
    const refusal = JSON.parse(refused.stdout) as { error?: { code?: string } };
    assert.equal(refusal.error?.code, "daemon_stopped_by_operator");
    assert.equal(readDaemonPid(fixture.userRoot, "default"), null, "the refused worktree must not claim the daemon");

    const blocked = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "task", "list"], {
      encoding: "utf8",
      env: cliEnv(fixture.root, fixture.userRoot),
    });
    assert.notEqual(blocked.status, 0, `${blocked.stderr}\n${blocked.stdout}`);
    const blockedReceipt = JSON.parse(blocked.stdout) as {
      error?: { code?: string };
      diagnostic?: { expectation?: string };
    };
    assert.equal(blockedReceipt.error?.code, "daemon_stopped_by_operator");
    assert.match(String(blockedReceipt.diagnostic?.expectation), /ha daemon start --service/u);
    assert.equal(readDaemonPid(fixture.userRoot, "default"), null, "operator stop must suppress autostart");

    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    const result = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "task", "list"], {
      encoding: "utf8",
      env: cliEnv(fixture.root, fixture.userRoot),
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const receipt = JSON.parse(result.stdout) as { ok: boolean; outcome?: string };
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(receipt.outcome, "applied");
    const restartedPid = readDaemonPid(fixture.userRoot, "default");
    assert.ok(restartedPid, "explicit start must leave a resident daemon pid file");
    assert.notEqual(restartedPid, previousPid);
    const connected = spawnSync(process.execPath, [cli, "--root", worktree, "--json", "task", "list"], {
      encoding: "utf8",
      env: cliEnv(worktree, fixture.userRoot),
    });
    assert.equal(connected.status, 0, `${connected.stderr}\n${connected.stdout}`);
    assert.equal(
      readDaemonPid(fixture.userRoot, "default"),
      restartedPid,
      "the worktree must reuse the resident daemon",
    );
    context.diagnostic(
      `stop refusal=${blockedReceipt.error?.code}; explicit-start pid=${restartedPid}; worktree existing-daemon task-list=ok`,
    );
    const restartedLifecycle = readDaemonLifecycleRecords(fixture.userRoot, "default"),
      generationStart = restartedLifecycle.findLastIndex((record) => record.event === "process_start"),
      bound = restartedLifecycle.findIndex(
        (record, index) => index > generationStart && record.event === "socket_bound",
      ),
      attach = restartedLifecycle.findIndex(
        (record, index) => index > generationStart && record.event === "repo_attach_started",
      );
    assert.ok(
      generationStart >= 0 && bound > generationStart && attach > bound,
      "the resident socket must bind before the cold registry starts attaching",
    );
    process.kill(restartedPid, "SIGKILL");
    await waitForProcessExit(restartedPid);
    const recovered = run(fixture.root, fixture.userRoot, ["task", "list"]);
    assert.equal(recovered.outcome, "applied");
    const recoveredPid = readDaemonPid(fixture.userRoot, "default");
    assert.ok(recoveredPid, "process death without daemon stop must remain autostartable");
    assert.notEqual(recoveredPid, restartedPid);
    context.diagnostic(`SIGKILL negative control autostart pid=${recoveredPid}`);
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "stop"]).ok, true);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

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
  try {
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
  } finally {
    stop(fixture.root, fixture.userRoot);
    rmSync(fixture.parent, { recursive: true, force: true });
  }
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
    stop(fixture.root, fixture.userRoot);
    rmSync(fixture.parent, { recursive: true, force: true });
    if (previousTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTemp;
  }
});

test("a blocked vertical script keeps handshakes, snapshots, and same-repo writes live", async (context) => {
  const fixture = setup(),
    repoId = "vertical-wedge",
    taskId = "task-vertical-wedge",
    blocker = path.join(fixture.parent, "vertical-script.block"),
    started = `${blocker}.started`,
    endpoint = localUserDaemonEndpoint(fixture.userRoot, "default");
  let client: JsonRpcLineClient | undefined,
    readClient: JsonRpcLineClient | undefined,
    queuedClient: JsonRpcLineClient | undefined,
    scriptRequest: Promise<Record<string, unknown>> | undefined,
    queuedWrite: Promise<Record<string, unknown>> | undefined;
  try {
    writeFileSync(blocker, "blocked\n", "utf8");
    const launched = spawnSync(
      process.execPath,
      [cli, "--root", fixture.root, "--json", "daemon", "start", "--service"],
      {
        encoding: "utf8",
        env: { ...cliEnv(fixture.root, fixture.userRoot), HARNESS_TEST_VERTICAL_SCRIPT_BLOCK_FILE: blocker },
      },
    );
    assert.equal(
      launched.status,
      0,
      `${launched.stderr}\n${launched.stdout}\n${existsSync(path.join(fixture.userRoot, "logs", "daemon-default.log")) ? readFileSync(path.join(fixture.userRoot, "logs", "daemon-default.log"), "utf8") : "daemon log missing"}`,
    );
    register(fixture.root, fixture.userRoot, repoId);
    assert.equal(
      run(fixture.root, fixture.userRoot, ["task", "create", "--id", taskId, "--admin", "--title", "Vertical Wedge"])
        .outcome,
      "applied",
    );

    const socket = await connectSocket(endpoint, 2_000);
    client = new JsonRpcLineClient(socket, socket);
    await client.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, 2_000);
    scriptRequest = client.request("repo.script.run", {
      repo: { repoId },
      payload: { scriptId: "vertical:software-coding:repository-audit", taskId, inputs: {}, dryRun: true },
    }) as Promise<Record<string, unknown>>;
    const launch = await Promise.race([
      waitForFileContent(started).then(() => ({ state: "started" as const })),
      scriptRequest.then((receipt) => ({ state: "settled" as const, receipt })),
    ]);
    assert.equal(launch.state, "started", JSON.stringify(launch));

    const probeStarted = performance.now();
    let handshake: Record<string, unknown>;
    try {
      const response = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 2_000, 250);
      handshake = { ok: true, elapsedMs: Math.round(performance.now() - probeStarted), daemonPid: response.pid };
    } catch (error) {
      handshake = {
        ok: false,
        elapsedMs: Math.round(performance.now() - probeStarted),
        code: coded(error),
        message: error instanceof Error ? error.message : String(error),
      };
    }
    context.diagnostic(`blocked vertical script handshake probe: ${JSON.stringify(handshake)}`);
    assert.equal(handshake.ok, true, JSON.stringify(handshake));

    const readSocket = await connectSocket(endpoint, 2_000);
    readClient = new JsonRpcLineClient(readSocket, readSocket);
    await readClient.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, 2_000);
    const readStarted = performance.now(),
      readWhileBlocked = await Promise.race([
        readClient
          .request("repo.tasks.list", { repo: { repoId }, payload: {} })
          .then((receipt) => ({ state: "settled" as const, receipt })),
        delay(250, { state: "pending" as const, receipt: null }),
      ]);
    const snapshotTaskIds = Array.isArray(readWhileBlocked.receipt?.rows)
        ? readWhileBlocked.receipt.rows.map((row) => String((row as Record<string, unknown>).taskId))
        : null,
      snapshotWhileBlocked = {
        state: readWhileBlocked.state,
        elapsedMs: Math.round(performance.now() - readStarted),
        readStatus: readWhileBlocked.receipt?.status,
        taskIds: snapshotTaskIds,
      };
    context.diagnostic(`same-repo snapshot probe while script blocked: ${JSON.stringify(snapshotWhileBlocked)}`);
    assert.deepEqual(
      { state: readWhileBlocked.state, readStatus: readWhileBlocked.receipt?.status },
      { state: "settled", readStatus: "ready" },
      JSON.stringify(snapshotWhileBlocked),
    );
    assert.deepEqual(snapshotTaskIds, [taskId], "the concurrent read must return the committed pre-write snapshot");

    const queuedSocket = await connectSocket(endpoint, 2_000);
    queuedClient = new JsonRpcLineClient(queuedSocket, queuedSocket);
    await queuedClient.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, 2_000);
    queuedWrite = queuedClient.request("repo.task.create", {
      repo: { repoId },
      payload: { taskId: "task-queued-write", title: "Queued Write" },
    }) as Promise<Record<string, unknown>>;
    const orderingStarted = performance.now(),
      beforeRelease = await Promise.race([
        queuedWrite.then(() => "settled" as const),
        delay(2_000, "pending" as const),
      ]),
      orderingWhileBlocked = { state: beforeRelease, elapsedMs: Math.round(performance.now() - orderingStarted) };
    context.diagnostic(`same-repo write ordering probe while script blocked: ${JSON.stringify(orderingWhileBlocked)}`);
    assert.equal(beforeRelease, "settled", JSON.stringify(orderingWhileBlocked));

    rmSync(blocker, { force: true });
    const [scriptReceipt, writeReceipt] = await Promise.all([scriptRequest, queuedWrite]);
    const orderingAfterRelease = {
      scriptOutcome: scriptReceipt.outcome,
      writeOutcome: writeReceipt.outcome,
      writeRevision: writeReceipt.revision,
    };
    context.diagnostic(
      `vertical settlement after independent same-repo write: ${JSON.stringify(orderingAfterRelease)}`,
    );
    assert.deepEqual(
      { scriptOutcome: scriptReceipt.outcome, writeOutcome: writeReceipt.outcome },
      { scriptOutcome: "pending", writeOutcome: "applied" },
    );
    assert.equal(writeReceipt.status, "accepted_durable");
    assertValidWriteReceipt(writeReceipt);
  } finally {
    rmSync(blocker, { force: true });
    await Promise.all([scriptRequest?.catch(() => undefined), queuedWrite?.catch(() => undefined)]);
    client?.close();
    readClient?.close();
    queuedClient?.close();
    stop(fixture.root, fixture.userRoot);
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("runtime stream attach stays live before, during, and after a blocked vertical script", async (context) => {
  const fixture = setup(),
    repoId = "runtime-attach-live",
    taskId = "task-runtime-attach-live",
    runtimeSessionId = "runtime-session-attach-live",
    blocker = path.join(fixture.parent, "vertical-attach.block"),
    started = `${blocker}.started`,
    endpoint = localUserDaemonEndpoint(fixture.userRoot, "default");
  let client: JsonRpcLineClient | undefined, scriptRequest: Promise<Record<string, unknown>> | undefined;
  try {
    register(fixture.root, fixture.userRoot, repoId);
    assert.equal(
      run(fixture.root, fixture.userRoot, [
        "task",
        "create",
        "--id",
        taskId,
        "--admin",
        "--title",
        "Runtime Attach Live",
      ]).outcome,
      "applied",
    );
    stop(fixture.root, fixture.userRoot);
    await seedAttachableRuntime(fixture.root, fixture.userRoot, repoId, runtimeSessionId);
    writeFileSync(blocker, "blocked\n", "utf8");
    const launched = spawnSync(
      process.execPath,
      [cli, "--root", fixture.root, "--json", "daemon", "start", "--service"],
      {
        encoding: "utf8",
        env: { ...cliEnv(fixture.root, fixture.userRoot), HARNESS_TEST_VERTICAL_SCRIPT_BLOCK_FILE: blocker },
      },
    );
    assert.equal(
      launched.status,
      0,
      `${launched.stderr}\n${launched.stdout}\n${existsSync(path.join(fixture.userRoot, "logs", "daemon-default.log")) ? readFileSync(path.join(fixture.userRoot, "logs", "daemon-default.log"), "utf8") : "daemon log missing"}`,
    );
    // Host readiness precedes repository attachment; establish the seeded read before measuring idle attach.
    const ready = await requestDaemonJsonRpcAt(
      endpoint,
      "repo.agentRuntime.sessions.read",
      { repo: { repoId }, payload: { runtimeSessionId } },
      2_000,
      30_000,
    );
    assert.equal((ready.session as Record<string, unknown>).runtimeSessionId, runtimeSessionId, JSON.stringify(ready));
    const idle = await probeRuntimeAttach(endpoint, repoId, runtimeSessionId);

    const socket = await connectSocket(endpoint, 2_000);
    client = new JsonRpcLineClient(socket, socket);
    await client.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, 2_000);
    scriptRequest = client.request("repo.script.run", {
      repo: { repoId },
      payload: { scriptId: "vertical:software-coding:repository-audit", taskId, inputs: {}, dryRun: true },
    }) as Promise<Record<string, unknown>>;
    const launch = await Promise.race([
      waitForFileContent(started).then(() => ({ state: "started" as const })),
      scriptRequest.then((receipt) => ({ state: "settled" as const, receipt })),
    ]);
    assert.equal(launch.state, "started", JSON.stringify(launch));

    const readStarted = performance.now(),
      read = await requestDaemonJsonRpcAt(
        endpoint,
        "repo.agentRuntime.sessions.read",
        { repo: { repoId }, payload: { runtimeSessionId } },
        2_000,
        500,
      ),
      loaded = await probeRuntimeAttach(endpoint, repoId, runtimeSessionId);
    const snapshot = {
      elapsedMs: Math.round(performance.now() - readStarted),
      revision: read.sourceRevision,
      runtimeSessionId: (read.session as Record<string, unknown>).runtimeSessionId,
    };

    rmSync(blocker, { force: true });
    const scriptReceipt = await scriptRequest;
    const recovered = await probeRuntimeAttach(endpoint, repoId, runtimeSessionId);
    context.diagnostic(
      `runtime attach three-point control: ${JSON.stringify({ idle, loaded: { snapshot, attach: loaded }, recovered, scriptOutcome: scriptReceipt.outcome })}`,
    );

    assert.equal(idle.status, "attached", JSON.stringify(idle));
    assert.equal(snapshot.runtimeSessionId, runtimeSessionId, JSON.stringify(snapshot));
    assert.equal(loaded.status, "attached", JSON.stringify(loaded));
    assert.equal(recovered.status, "attached", JSON.stringify(recovered));
  } finally {
    rmSync(blocker, { force: true });
    await scriptRequest?.catch(() => undefined);
    client?.close();
    stop(fixture.root, fixture.userRoot);
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});
