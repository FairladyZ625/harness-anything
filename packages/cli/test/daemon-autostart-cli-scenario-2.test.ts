// harness-test-tier: integration
import test from "node:test";
import * as shared from "./daemon-autostart-cli.fixture.ts";

const {
  assert,
  spawnSync,
  chmodSync,
  existsSync,
  rmSync,
  writeFileSync,
  createServer,
  path,
  JsonRpcLineClient,
  connectSocket,
  requestDaemonJsonRpcAt,
  localUserDaemonEndpoint,
  clearDaemonStoppedMarker,
  openDaemonLifecycleLog,
  currentDaemonProtocolVersion,
  readDaemonPid,
  seedSettingsEvent,
  registerDaemonRepo,
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
  statusOf,
  seedLegacyTask,
  spawnCli,
} = shared;

test("disconnecting a blocked vertical script client terminates its child after same-repo writes advance", async (context) => {
  const fixture = setup(),
    otherRoot = setupRepository(fixture.parent, "other-repo"),
    blockedRepoId = "vertical-disconnect",
    otherRepoId = "vertical-unaffected",
    taskId = "task-vertical-disconnect",
    blocker = path.join(fixture.parent, "vertical-disconnect.block"),
    started = `${blocker}.started`,
    endpoint = localUserDaemonEndpoint(fixture.userRoot, "default");
  let actionSocket: Socket | undefined,
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
    assert.equal(launched.status, 0, `${launched.stderr}\n${launched.stdout}`);
    register(fixture.root, fixture.userRoot, blockedRepoId);
    register(otherRoot, fixture.userRoot, otherRepoId);
    assert.equal(
      run(fixture.root, fixture.userRoot, [
        "task",
        "create",
        "--id",
        taskId,
        "--admin",
        "--title",
        "Vertical Disconnect",
      ]).outcome,
      "applied",
    );

    actionSocket = await connectSocket(endpoint, 2_000);
    const actionClient = new JsonRpcLineClient(actionSocket, actionSocket);
    await actionClient.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, 2_000);
    scriptRequest = actionClient.request("repo.script.run", {
      repo: { repoId: blockedRepoId },
      payload: { scriptId: "vertical:software-coding:repository-audit", taskId, inputs: {}, dryRun: true },
    }) as Promise<Record<string, unknown>>;
    void scriptRequest.catch(() => undefined);
    const childPid = Number(await waitForFileContent(started));
    assert.equal(Number.isSafeInteger(childPid) && childPid > 0, true, `invalid vertical child pid: ${childPid}`);
    assert.equal(processAlive(childPid), true, `vertical child ${childPid} must be alive before disconnect`);

    const unaffected = await requestDaemonJsonRpcAt(
      endpoint,
      "repo.tasks.list",
      { repo: { repoId: otherRepoId }, payload: {} },
      2_000,
      500,
    );
    context.diagnostic(
      `other-repo read while vertical script blocked: ${JSON.stringify({ status: unaffected.status, rowCount: Array.isArray(unaffected.rows) ? unaffected.rows.length : null })}`,
    );
    assert.equal(unaffected.status, "ready");

    const queuedSocket = await connectSocket(endpoint, 2_000);
    queuedClient = new JsonRpcLineClient(queuedSocket, queuedSocket);
    await queuedClient.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, 2_000);
    queuedWrite = queuedClient.request("repo.task.create", {
      repo: { repoId: blockedRepoId },
      payload: { taskId: "task-after-disconnect", title: "After Disconnect" },
    }) as Promise<Record<string, unknown>>;
    const beforeDisconnect = await Promise.race([
      queuedWrite.then(() => "settled" as const),
      delay(2_000, "pending" as const),
    ]);
    context.diagnostic(`same-repo write before client disconnect: ${JSON.stringify({ state: beforeDisconnect })}`);
    assert.equal(beforeDisconnect, "settled");

    actionSocket.destroy();
    await waitForProcessExit(childPid);
    const writeReceipt = await queuedWrite;
    context.diagnostic(
      `vertical child after client disconnect: ${JSON.stringify({ writeOutcome: writeReceipt.outcome, blockerStillPresent: existsSync(blocker), childAlive: processAlive(childPid) })}`,
    );
    assert.equal(
      existsSync(blocker),
      true,
      "the test blocker must still be present when cancellation terminates the child",
    );
    assert.equal(processAlive(childPid), false, "the disconnected client's vertical child must be terminated");
    assert.equal(writeReceipt.outcome, "applied");
  } finally {
    actionSocket?.destroy();
    rmSync(blocker, { force: true });
    await queuedWrite?.catch(() => undefined);
    queuedClient?.close();
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
            ? { protocolVersion: { major: 1, minor: 0 } }
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

test("semantic sources and agent execution cross the daemon before transport-bound human review completes", () => {
  const fixture = setup(),
    taskId = "task-executor-axis",
    executionId = "exec-executor-axis",
    reviewId = "review-executor-axis";

  assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
  register(fixture.root, fixture.userRoot, "executor-axis");
  const created = run(fixture.root, fixture.userRoot, [
    "task",
    "create",
    "--id",
    taskId,
    "--admin",
    "--title",
    "Executor Axis",
    "--preset",
    "docs-task",
  ]);
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  assert.equal(
    run(fixture.root, fixture.userRoot, [
      "fact",
      "record",
      "--task",
      taskId,
      "--statement",
      "The executor and review actor axes remain distinct across the daemon.",
      "--source",
      "test:executor-axis",
    ]).outcome,
    "applied",
  );
  const packagePath = String(created.packagePath),
    closeoutPath = `${packagePath}/closeout.md`;
  const planPath = `${packagePath}/task_plan.md`;
  writeFileSync(path.join(fixture.root, "harness", planPath), realizedTaskPlan("Executor Axis"));
  assert.equal(run(fixture.root, fixture.userRoot, ["doc", "sync", "--submit", "--path", planPath]).outcome, "applied");

  assert.equal(
    run(fixture.root, fixture.userRoot, ["task", "start", taskId, "--execution-id", executionId], "agent:claude-code")
      .outcome,
    "applied",
  );
  writeFileSync(
    path.join(fixture.root, "harness", packagePath, "artifacts", "executor-axis.txt"),
    "Executor and review actor axes remain distinct.\n",
  );
  const closeoutSync = run(
    fixture.root,
    fixture.userRoot,
    ["doc", "sync", "--submit", "--task", taskId],
    "agent:claude-code",
  );
  assert.equal(closeoutSync.outcome, "applied");
  published(fixture.root, fixture.userRoot, closeoutSync);
  writeFileSync(
    path.join(fixture.root, "harness", closeoutPath),
    `# Closeout\n\n## Summary\n\nExecutor attribution restored: artifact:${packagePath}/artifacts/executor-axis.txt@${closeoutSync.revision}\n\n` +
      "## Verification\n\nEnd-to-end daemon flow.\n\n## Residual Risk\n\nNone.\n\n" +
      "## Same Mechanism Elsewhere\n\nNot applicable to this fixture.\n",
  );
  assert.equal(
    run(fixture.root, fixture.userRoot, ["task", "submit", taskId, "--execution-id", executionId], "agent:claude-code")
      .outcome,
    "applied",
  );
  assert.equal(
    run(
      fixture.root,
      fixture.userRoot,
      ["task", "code-doc", "reconcile", taskId, "--path", `${packagePath}/artifacts/executor-axis.txt`],
      "agent:claude-code",
    ).outcome,
    "applied",
  );

  writeFileSync(
    path.join(fixture.root, "review.json"),
    JSON.stringify({
      verdict: "approved",
      reason: "Human review accepted the agent execution.",
      evidenceChecked: ["end-to-end daemon flow"],
    }),
  );
  const reviewed = run(fixture.root, fixture.userRoot, [
    "task",
    "review-execution",
    taskId,
    "--execution-id",
    executionId,
    "--review-id",
    reviewId,
    "--from-file",
    "review.json",
  ]);
  assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
  assert.equal(
    run(fixture.root, fixture.userRoot, [
      "task",
      "review-consent",
      taskId,
      "--execution-id",
      executionId,
      "--review-id",
      reviewId,
    ]).outcome,
    "applied",
  );
  assert.equal(run(fixture.root, fixture.userRoot, ["task", "complete", taskId]).outcome, "applied");

  const shown = run(fixture.root, fixture.userRoot, ["task", "show", taskId]),
    snapshot = JSON.parse(String(shown.evidence)) as {
      task: { status: string; createdBy: unknown };
      executions: { actor: unknown }[];
      reviews: { actor: unknown }[];
    };
  assert.equal(snapshot.task.status, "done");
  assert.deepEqual(snapshot.task.createdBy, { principal: { personId: "owner" }, executor: null });
  assert.deepEqual(snapshot.executions[0]?.actor, {
    principal: { personId: "owner" },
    executor: { kind: "agent", id: "claude-code" },
  });
  assert.deepEqual(snapshot.reviews[0]?.actor, { principal: { personId: "owner" }, executor: null });
  assert.equal(
    run(
      fixture.root,
      fixture.userRoot,
      ["task", "create", "--id", "task-source", "--admin", "--title", "Source"],
      "agent:codex",
    ).outcome,
    "applied",
  );
  const sourceTask = JSON.parse(
    String(run(fixture.root, fixture.userRoot, ["task", "show", "task-source"]).evidence),
  ) as { task: { createdBy: unknown } };
  assert.deepEqual(sourceTask.task.createdBy, {
    principal: { personId: "owner" },
    executor: { kind: "agent", id: "codex" },
  });
  writeFileSync(path.join(fixture.root, "artifact.md"), "# Artifact\n", "utf8");
  assert.equal(
    run(fixture.root, fixture.userRoot, [
      "task",
      "artifact",
      "add",
      "task-source",
      "--source",
      "artifact.md",
      "--destination",
      "proof.md",
    ]).outcome,
    "applied",
  );
  assert.equal(
    run(fixture.root, fixture.userRoot, ["relation", "list", "--source", "task/task-source"]).outcome,
    "applied",
  );
});

test("cancelled task reinstates to planned through the CLI and daemon", () => {
  const fixture = setup(),
    taskId = "task-reinstate";

  assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
  register(fixture.root, fixture.userRoot, "reinstate");
  assert.equal(
    run(fixture.root, fixture.userRoot, ["task", "create", "--id", taskId, "--admin", "--title", "Reinstate"]).outcome,
    "applied",
  );
  assert.equal(
    run(fixture.root, fixture.userRoot, [
      "task",
      "transition",
      taskId,
      "cancelled",
      "--force",
      "--reason",
      "Erroneous batch cleanup",
    ]).outcome,
    "applied",
  );
  assert.equal(statusOf(fixture.root, fixture.userRoot, taskId), "cancelled");

  // A reinstate without the auditable reason is refused by the CLI before it can reach the daemon.
  const bare = spawnSync(
    process.execPath,
    [cli, "--root", fixture.root, "--json", "task", "transition", taskId, "planned"],
    { encoding: "utf8", env: cliEnv(fixture.root, fixture.userRoot) },
  );
  assert.equal(bare.status, 2, `${bare.stderr}\n${bare.stdout}`);
  const bareReceipt = JSON.parse(bare.stdout) as { ok: boolean; error?: { code: string } };
  assert.equal(bareReceipt.ok, false);
  assert.equal(bareReceipt.error?.code, "missing_field");

  const reinstated = run(fixture.root, fixture.userRoot, [
    "task",
    "transition",
    taskId,
    "planned",
    "--reason",
    "Owner adjudicated rollback of the batch cancellation",
  ]);
  assert.equal(reinstated.outcome, "applied", JSON.stringify(reinstated));
  assert.equal(statusOf(fixture.root, fixture.userRoot, taskId), "planned");
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
