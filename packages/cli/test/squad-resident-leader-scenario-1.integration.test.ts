// harness-test-tier: integration
import test from "node:test";
import * as shared from "./squad-resident-leader.fixture.ts";

const {
  assert,
  spawnSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  tmpdir,
  path,
  makeTaskEventStore,
  writeProviderExecutable,
  realizedPlan,
  cli,
  pollSquadStatus,
  pollSquadUntil,
  run,
  published,
  runMaybe,
  isolatedDaemonEnvironment,
  daemonSocketTemp,
  writeIdentity,
  writeMixedLeaderProvider,
  writeBlockingWorkerProvider,
  writeResidentProvider,
  writeApiKeyProvider,
  writeCredentialTool,
} = shared;

test("each worker outcome calls back into a new leader turn and a failed worker can be reassigned", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-squad-resident-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    binRoot = path.join(parent, "bin"),
    providerLog = path.join(userRoot, "runtime-instances", "resident-worker", "home", ".codex", "provider.jsonl");
  mkdirSync(root, { recursive: true });
  mkdirSync(binRoot, { recursive: true });
  mkdirSync(path.join(parent, "tmp"), { recursive: true });
  writeResidentProvider(path.join(binRoot, "codex"), path.join(root, ".harness/store/generations/2/ledger.sqlite"));
  const env = isolatedDaemonEnvironment({
    HOME: path.join(parent, "home"),
    TMPDIR: daemonSocketTemp(parent),
    TEMP: daemonSocketTemp(parent),
    TMP: daemonSocketTemp(parent),
    PATH: [
      binRoot,
      ...(process.env.PATH ?? "")
        .split(path.delimiter)
        .filter((entry) => ["codex", "codex.cmd", "codex.exe"].every((name) => !existsSync(path.join(entry, name)))),
    ].join(path.delimiter),
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_ID: "squad-resident-test",
    HARNESS_ACTOR: "agent:squad-resident-test",
  });
  try {
    run(root, env, ["daemon", "start", "--service"]);
    run(root, env, ["init", "--repo-id", "squad-resident", "--person-id", "owner", "--display-name", "Owner"]);
    for (const id of ["fable", "terra", "luna"]) {
      const source = path.join(parent, id);
      writeIdentity(source, id, id === "fable" ? "Fable" : id === "terra" ? "Terra" : "Luna");
      run(root, env, ["agent", "install", "--source", source]);
    }
    const squadSource = path.join(parent, "core-squad");
    mkdirSync(squadSource, { recursive: true });
    writeFileSync(
      path.join(squadSource, "squad.json"),
      JSON.stringify({
        schema: "squad-declaration/v1",
        id: "core-squad",
        name: "Core Squad",
        leader: "fable",
        workers: ["terra", "luna"],
        leaderTurnBudget: 8,
        roster: "terra -> backend\nluna -> frontend\nsynthesis -> artifacts/reports/{squadRunId}.md",
      }),
    );
    run(root, env, ["squad", "install", "--source", squadSource]);
    run(root, env, [
      "runtime",
      "instance",
      "create",
      "--id",
      "resident-worker",
      "--name",
      "Resident Worker",
      "--kind",
      "codex",
      "--provider",
      "openai",
      "--model",
      "runtime-test-model",
      "--auth",
      "subscription",
    ]);
    const residentTask = run(root, env, [
        "task",
        "create",
        "--id",
        "resident-task",
        "--admin",
        "--title",
        "Resident Squad",
      ]),
      residentPackage = String(residentTask.packagePath);
    published(root, env, residentTask);
    writeFileSync(path.join(root, "harness", residentPackage, "task_plan.md"), realizedPlan("Resident Squad"));
    run(root, env, ["doc", "sync", "--submit", "--path", `${residentPackage}/task_plan.md`]);
    mkdirSync(path.join(root, "squadwork"));

    const runArgs = [
        "squad",
        "run",
        "core-squad",
        "--detach",
        "--instance",
        "resident-worker",
        "--cwd",
        "squadwork",
        "--task",
        "resident-task",
      ] as const,
      started = run(root, env, runArgs);
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.outcome, "completed", JSON.stringify(started));
    assert.equal(started.schema, "squad-control-result/v1", JSON.stringify(started));
    assert.equal(started.phase, "leader_running", JSON.stringify(started));
    for (const field of ["opId", "acceptance", "proof", "status"]) assert.equal(Object.hasOwn(started, field), false);
    assert.match(String(started.squadRunId), /^squad_[a-f0-9]{24}$/u);
    const duplicate = runMaybe(root, env, runArgs);
    assert.equal(duplicate.status, 1, JSON.stringify(duplicate));
    assert.equal(duplicate.receipt.code, "squad_run_active", JSON.stringify(duplicate));
    for (const field of ["opId", "acceptance", "proof", "status"])
      assert.equal(Object.hasOwn(duplicate.receipt, field), false);
    assert.ok(
      (duplicate.receipt.nextActions as unknown[]).some((next) => String(next).includes(String(started.squadRunId))),
      JSON.stringify(duplicate),
    );

    const current = pollSquadStatus(root, env, String(started.squadRunId));
    assert.equal(current.status, "converged", JSON.stringify(current));
    assert.equal(current.workerCallbackCount, 3, JSON.stringify(current));
    assert.equal(Array.isArray(current.leaders), true);
    const leaderRuntimeSessionIds = current.leaderRuntimeSessionIds as string[];
    assert.equal(leaderRuntimeSessionIds.length, 4, JSON.stringify(current));
    assert.equal(new Set(leaderRuntimeSessionIds).size, 4);

    const workers = current.workers as Array<Record<string, unknown>>;
    assert.equal(workers.length, 3, JSON.stringify(current));
    assert.equal(workers.filter((worker) => worker.agentId === "terra").length, 2, JSON.stringify(current));
    assert.equal(
      workers.some((worker) => worker.agentId === "terra" && worker.status === "failed"),
      true,
      JSON.stringify(current),
    );
    assert.equal(
      workers.every(
        (worker) =>
          typeof worker.reportPath === "string" &&
          typeof worker.resultRef === "string" &&
          typeof worker.exitCode === "number",
      ),
      true,
      JSON.stringify(current),
    );

    const calls = readFileSync(providerLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
      callbackLeaders = calls.filter(
        (call) =>
          call.kind === "leader-callback" && Array.isArray(call.args) && (call.args as unknown[]).includes("resume"),
      );
    const acceptedAtLaunch = calls.find((call) => call.kind === "leader-initial")?.acceptedAtLaunch as {
      opId: string;
      runtimeSessionId: string;
    };
    assert.match(acceptedAtLaunch.opId, /^runtime-spawn-/u);
    assert.equal(acceptedAtLaunch.runtimeSessionId, started.leaderRuntimeSessionId);
    assert.equal(callbackLeaders.length, 3, JSON.stringify(calls));
    assert.equal(
      calls.every((call) => String(call.cwd).endsWith(`${path.sep}squadwork`)),
      true,
      JSON.stringify(calls),
    );
    assert.match(String(calls.find((call) => call.kind === "leader-initial")?.prompt), /Your task package is/u);

    run(root, env, ["daemon", "stop"]);
    const synthesisBody = "# Squad synthesis\n\nWorker receipts verified.\n",
      synthesisPath = `${residentPackage}/artifacts/reports/${String(started.squadRunId)}.md`,
      synthesisEvent = makeTaskEventStore({ repoId: "squad-resident", rootDir: root })
        .read()
        .events.findLast(
          (event) =>
            event.schema === "doc-event/v1" && event.payload.changes.some((change) => change.path === synthesisPath),
        );
    assert.equal(readFileSync(path.join(root, "harness", synthesisPath), "utf8"), synthesisBody);
    assert.equal(synthesisEvent?.schema, "doc-event/v1");
    assert.equal(synthesisEvent?.actor.executor?.id, `runtime-session:${leaderRuntimeSessionIds.at(-1)}`);
    rmSync(path.join(root, ".harness", "cache", "task.sqlite"), { force: true });
    run(root, env, ["daemon", "start", "--service"]);
    const afterRestart = run(root, env, ["squad", "status", String(started.squadRunId)]);
    assert.equal(afterRestart.status, "converged", JSON.stringify(afterRestart));
    assert.equal(afterRestart.workerCallbackCount, 3);
    process.stdout.write(
      `squad-event-flow ${JSON.stringify({
        squadRunId: current.squadRunId,
        status: current.status,
        workerCallbackCount: current.workerCallbackCount,
        leaderRuntimeSessionIds,
        workers: workers.map((worker) => ({
          attemptId: worker.attemptId,
          agentId: worker.agentId,
          dispatchId: worker.dispatchId,
          runtimeSessionId: worker.runtimeSessionId,
          status: worker.status,
          exitCode: worker.exitCode,
          resultRef: worker.resultRef,
          reportPath: worker.reportPath,
        })),
        afterRestart: afterRestart.status,
      })}\n`,
    );
  } finally {
    runMaybe(root, env, ["daemon", "stop"]);
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a Claude leader dispatches Codex workers by each worker declaration and reports a missing kind", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-squad-mixed-runtime-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    binRoot = path.join(parent, "bin"),
    leaderLog = path.join(root, ".mixed-leader-provider.jsonl");
  mkdirSync(root, { recursive: true });
  mkdirSync(binRoot, { recursive: true });
  mkdirSync(path.join(parent, "tmp"), { recursive: true });
  writeMixedLeaderProvider(path.join(binRoot, "claude"));
  writeBlockingWorkerProvider(path.join(binRoot, "codex"));
  const env = isolatedDaemonEnvironment({
    HOME: path.join(parent, "home"),
    USERPROFILE: path.join(parent, "home"),
    TMPDIR: daemonSocketTemp(parent),
    TEMP: daemonSocketTemp(parent),
    TMP: daemonSocketTemp(parent),
    PATH: [
      binRoot,
      ...(process.env.PATH ?? "")
        .split(path.delimiter)
        .filter((entry) =>
          ["claude", "claude.cmd", "claude.exe", "codex", "codex.cmd", "codex.exe"].every(
            (name) => !existsSync(path.join(entry, name)),
          ),
        ),
    ].join(path.delimiter),
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_ID: "squad-mixed-runtime-test",
    HARNESS_ACTOR: "agent:squad-mixed-runtime-test",
  });
  try {
    run(root, env, ["daemon", "start", "--service"]);
    run(root, env, ["init", "--repo-id", "squad-mixed-runtime", "--person-id", "owner", "--display-name", "Owner"]);
    for (const [id, name, runtimeType, model] of [
      ["mixed-leader", "Mixed Leader", "claude", "fable"],
      ["mixed-reconcile", "Mixed Reconcile", "codex", "gpt-5.6-terra"],
      ["mixed-discrimination", "Mixed Discrimination", "codex", "gpt-5.6-sol"],
      ["mixed-errorexit", "Mixed Error Exit", "codex", "gpt-5.6-terra"],
      ["mixed-missing", "Mixed Missing", "agy", "agy-model"],
    ] as const) {
      const source = path.join(parent, id);
      writeIdentity(source, id, name, runtimeType, model);
      run(root, env, ["agent", "install", "--source", source]);
    }
    for (const [id, workers] of [
      ["mixed-positive", ["mixed-reconcile", "mixed-discrimination", "mixed-errorexit"]],
      ["mixed-negative", ["mixed-missing"]],
    ] as const) {
      const source = path.join(parent, id);
      mkdirSync(source, { recursive: true });
      writeFileSync(
        path.join(source, "squad.json"),
        JSON.stringify({
          schema: "squad-declaration/v1",
          id,
          name: id,
          leader: "mixed-leader",
          workers,
          leaderTurnBudget: 4,
          roster: `${workers.join(" -> ")}\nsynthesis -> artifacts/reports/{squadRunId}.md`,
        }),
      );
      run(root, env, ["squad", "install", "--source", source]);
    }
    run(root, env, [
      "runtime",
      "instance",
      "create",
      "--id",
      "claude-lee",
      "--name",
      "Claude Leader",
      "--kind",
      "claude",
      "--provider",
      "anthropic",
      "--model",
      "fable",
      "--auth",
      "subscription",
    ]);
    run(root, env, [
      "runtime",
      "instance",
      "create",
      "--id",
      "test-codex-sol",
      "--name",
      "Codex Workers",
      "--kind",
      "codex",
      "--provider",
      "openai",
      "--model",
      "gpt-5.6-terra",
      "--model",
      "gpt-5.6-sol",
      "--auth",
      "subscription",
    ]);
    for (const [taskId, title] of [
      ["mixed-positive-task", "Mixed positive"],
      ["mixed-negative-task", "Mixed negative"],
    ] as const) {
      const created = run(root, env, ["task", "create", "--id", taskId, "--admin", "--title", title]),
        packagePath = String(created.packagePath);
      published(root, env, created);
      writeFileSync(path.join(root, "harness", packagePath, "task_plan.md"), realizedPlan(title));
      run(root, env, ["doc", "sync", "--submit", "--path", `${packagePath}/task_plan.md`]);
    }

    const positive = run(root, env, [
        "squad",
        "run",
        "mixed-positive",
        "--detach",
        "--instance",
        "claude-lee",
        "--model",
        "fable",
        "--task",
        "mixed-positive-task",
        "--cwd",
        ".",
        "--prompt",
        "positive mixed mission",
      ]),
      positiveStatus = pollSquadUntil(
        root,
        env,
        String(positive.squadRunId),
        (status) => status.status === "workers_running" && (status.workers as unknown[] | undefined)?.length === 3,
      ),
      positiveWorkers = positiveStatus.workers as Array<Record<string, unknown>>;
    assert.deepEqual(
      positiveWorkers.map(({ workerId, instanceId, provider, rejection }) => ({
        workerId,
        instanceId,
        model: (provider as Record<string, unknown>).model,
        rejection,
      })),
      [
        { workerId: "mixed-reconcile", instanceId: "test-codex-sol", model: "gpt-5.6-terra", rejection: null },
        {
          workerId: "mixed-discrimination",
          instanceId: "test-codex-sol",
          model: "gpt-5.6-sol",
          rejection: null,
        },
        { workerId: "mixed-errorexit", instanceId: "test-codex-sol", model: "gpt-5.6-terra", rejection: null },
      ],
      JSON.stringify(positiveStatus),
    );
    assert.equal((positiveStatus.leaders as Array<Record<string, unknown>>)[0]?.instanceId, "claude-lee");
    assert.equal(
      ((positiveStatus.leaders as Array<Record<string, unknown>>)[0]?.provider as Record<string, unknown>).model,
      "fable",
    );
    const positiveCancellation = run(root, env, ["squad", "cancel", String(positive.squadRunId)]);
    assert.equal(positiveCancellation.outcome, "completed");
    for (const field of ["opId", "acceptance", "proof", "status"])
      assert.equal(Object.hasOwn(positiveCancellation, field), false);

    const negative = run(root, env, [
        "squad",
        "run",
        "mixed-negative",
        "--detach",
        "--instance",
        "claude-lee",
        "--model",
        "fable",
        "--task",
        "mixed-negative-task",
        "--cwd",
        ".",
        "--prompt",
        "negative mixed mission",
      ]),
      negativeStatus = pollSquadUntil(root, env, String(negative.squadRunId), (status) => {
        const workers = status.workers as Array<Record<string, unknown>> | undefined;
        return (status.leaders as unknown[] | undefined)?.length === 2 && workers?.[0]?.rejection !== null;
      }),
      rejection = String((negativeStatus.workers as Array<Record<string, unknown>>)[0]?.rejection),
      leaderCalls = readFileSync(leaderLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
      callback = leaderCalls.find(
        (call) => call.kind === "callback" && String(call.prompt).includes(String(negative.squadRunId)),
      );
    assert.equal(rejection, "Agent mixed-missing requires agy, but no enabled agy instance is available on this node.");
    assert.deepEqual((negativeStatus.leaders as Array<Record<string, unknown>>)[1]?.trigger, {
      kind: "worker_rejected",
      attemptId: "worker-1",
    });
    assert.match(String(callback?.prompt), /worker_rejected/u);
    assert.match(String(callback?.prompt), /no enabled agy instance is available on this node/u);
    const negativeCancellation = run(root, env, ["squad", "cancel", String(negative.squadRunId)]);
    assert.equal(negativeCancellation.outcome, "completed");
    for (const field of ["opId", "acceptance", "proof", "status"])
      assert.equal(Object.hasOwn(negativeCancellation, field), false);
    process.stdout.write(
      `squad-mixed-runtime-flow ${JSON.stringify({
        positive: { squadRunId: positive.squadRunId, status: positiveStatus.status, workers: positiveWorkers },
        negative: {
          squadRunId: negative.squadRunId,
          status: negativeStatus.status,
          rejection,
          trigger: (negativeStatus.leaders as Array<Record<string, unknown>>)[1]?.trigger,
        },
      })}\n`,
    );
  } finally {
    runMaybe(root, env, ["daemon", "stop"]);
    rmSync(parent, { recursive: true, force: true });
  }
});

test(
  "same-instance API-key squad workers reuse the materialized bearer",
  { skip: process.platform !== "linux" ? "requires the Linux secret-tool credential backend" : false },
  () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-squad-api-key-")),
      root = path.join(parent, "repo"),
      userRoot = path.join(parent, "user"),
      binRoot = path.join(parent, "bin");
    mkdirSync(root, { recursive: true });
    mkdirSync(binRoot, { recursive: true });
    mkdirSync(path.join(parent, "tmp"), { recursive: true });
    writeApiKeyProvider(path.join(binRoot, "codex"));
    const credentialTool = writeCredentialTool(path.join(binRoot, "secret-tool"));
    const env = isolatedDaemonEnvironment({
      HOME: path.join(parent, "home"),
      TMPDIR: daemonSocketTemp(parent),
      TEMP: daemonSocketTemp(parent),
      TMP: daemonSocketTemp(parent),
      PATH: [
        binRoot,
        ...(process.env.PATH ?? "")
          .split(path.delimiter)
          .filter((entry) =>
            ["codex", "codex.cmd", "codex.exe", "secret-tool"].every((name) => !existsSync(path.join(entry, name))),
          ),
      ].join(path.delimiter),
      HARNESS_DAEMON_USER_ROOT: userRoot,
      HARNESS_DAEMON_ID: "squad-api-key-test",
      HARNESS_ACTOR: "agent:squad-api-key-test",
    });
    try {
      const stored = spawnSync(credentialTool, ["store", "squad-key"], {
        encoding: "utf8",
        env,
        input: "squad-secret",
      });
      assert.equal(stored.status, 0, stored.stderr);
      run(root, env, ["daemon", "start", "--service"]);
      run(root, env, ["init", "--repo-id", "squad-api-key", "--person-id", "owner", "--display-name", "Owner"]);
      for (const id of ["fable", "terra", "luna"]) {
        const source = path.join(parent, id);
        writeIdentity(source, id, id === "fable" ? "Fable" : id === "terra" ? "Terra" : "Luna");
        run(root, env, ["agent", "install", "--source", source]);
      }
      const squadSource = path.join(parent, "core-squad");
      mkdirSync(squadSource, { recursive: true });
      writeFileSync(
        path.join(squadSource, "squad.json"),
        JSON.stringify({
          schema: "squad-declaration/v1",
          id: "core-squad",
          name: "Core Squad",
          leader: "fable",
          workers: ["terra", "luna"],
          leaderTurnBudget: 8,
          roster: "terra -> backend\nluna -> frontend\nsynthesis -> artifacts/reports/{squadRunId}.md",
        }),
      );
      run(root, env, ["squad", "install", "--source", squadSource]);
      run(root, env, [
        "runtime",
        "instance",
        "create",
        "--id",
        "squad-api",
        "--name",
        "Squad API",
        "--kind",
        "codex",
        "--provider",
        "codex_local_access",
        "--model",
        "runtime-test-model",
        "--base-url",
        "http://127.0.0.1:1/v1",
        "--wire-api",
        "responses",
        "--requires-openai-auth",
        "--auth",
        "api-key",
        "--credential-ref",
        "credential:v1:squad-key",
      ]);
      const apiTask = run(root, env, [
        "task",
        "create",
        "--id",
        "squad-api-task",
        "--admin",
        "--title",
        "Squad API run",
      ]);
      const placeholderPlan = runMaybe(root, env, [
        "squad",
        "run",
        "core-squad",
        "--detach",
        "--instance",
        "squad-api",
        "--cwd",
        ".",
        "--task",
        "squad-api-task",
        "--prompt",
        "ship without lease",
      ]);
      assert.equal(placeholderPlan.status, 1, JSON.stringify(placeholderPlan));
      assert.equal(placeholderPlan.receipt.code, "plan_placeholder");
      const apiPackage = String(apiTask.packagePath);
      writeFileSync(path.join(root, "harness", apiPackage, "task_plan.md"), realizedPlan("Squad API run"));
      run(root, env, ["doc", "sync", "--submit", "--path", `${apiPackage}/task_plan.md`]);
      const started = run(root, env, [
        "squad",
        "run",
        "core-squad",
        "--detach",
        "--instance",
        "squad-api",
        "--cwd",
        ".",
        "--task",
        "squad-api-task",
      ]);
      assert.equal(started.ok, true, JSON.stringify(started));
      assert.equal(started.outcome, "completed", JSON.stringify(started));
      assert.equal(started.schema, "squad-control-result/v1", JSON.stringify(started));
      assert.equal(started.phase, "leader_running", JSON.stringify(started));
      for (const field of ["opId", "acceptance", "proof", "status"]) assert.equal(Object.hasOwn(started, field), false);
      const current = pollSquadStatus(root, env, String(started.squadRunId));
      assert.equal(current.status, "converged", JSON.stringify(current));
      const workers = current.workers as Array<Record<string, unknown>>;
      assert.deepEqual(
        workers.map((worker) => worker.workerId),
        ["terra", "luna"],
      );
      assert.equal(
        workers.every((worker) => worker.status === "succeeded" && worker.exitCode === 0),
        true,
      );
      const configPath = path.join(userRoot, "runtime-instances", "squad-api", "home", ".codex", "config.toml");
      assert.match(readFileSync(configPath, "utf8"), /experimental_bearer_token = "squad-secret"/u);
      process.stdout.write(`squad-api-key-flow ${JSON.stringify({ squadRunId: current.squadRunId, workers })}\n`);
    } finally {
      runMaybe(root, env, ["daemon", "stop"]);
      rmSync(parent, { recursive: true, force: true });
    }
  },
);
