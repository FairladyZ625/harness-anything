// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore } from "../../kernel/src/index.ts";
import { writeProviderExecutable } from "../../daemon/test/fixtures/runtime-stub.ts";
import { realizedTaskPlan as realizedPlan } from "../../../tools/fixtures/task-plan.mjs";

const cli = path.resolve("packages/cli/src/index.ts");

test("each worker outcome calls back into a new leader turn and a failed worker can be reassigned", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-squad-resident-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    binRoot = path.join(parent, "bin"),
    providerLog = path.join(userRoot, "runtime-instances", "resident-worker", "home", ".codex", "provider.jsonl");
  mkdirSync(root, { recursive: true });
  mkdirSync(binRoot, { recursive: true });
  mkdirSync(path.join(parent, "tmp"), { recursive: true });
  writeResidentProvider(path.join(binRoot, "codex"));
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
    writeFileSync(path.join(root, "harness", residentPackage, "task_plan.md"), realizedPlan("Resident Squad"));
    run(root, env, ["doc", "sync", "--submit", "--path", `${residentPackage}/task_plan.md`]);
    mkdirSync(path.join(root, "squadwork"));

    const started = run(root, env, [
      "squad",
      "run",
      "core-squad",
      "--instance",
      "resident-worker",
      "--cwd",
      "squadwork",
      "--task",
      "resident-task",
    ]);
    assert.equal(started.outcome, "running", JSON.stringify(started));
    assert.match(String(started.squadRunId), /^squad_[a-f0-9]{24}$/u);

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
      writeFileSync(path.join(root, "harness", packagePath, "task_plan.md"), realizedPlan(title));
      run(root, env, ["doc", "sync", "--submit", "--path", `${packagePath}/task_plan.md`]);
    }

    const positive = run(root, env, [
        "squad",
        "run",
        "mixed-positive",
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
    run(root, env, ["squad", "cancel", String(positive.squadRunId)]);

    const negative = run(root, env, [
        "squad",
        "run",
        "mixed-negative",
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
    run(root, env, ["squad", "cancel", String(negative.squadRunId)]);
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
        "--instance",
        "squad-api",
        "--cwd",
        ".",
        "--task",
        "squad-api-task",
      ]);
      assert.equal(started.outcome, "running", JSON.stringify(started));
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

function pollSquadStatus(root: string, env: NodeJS.ProcessEnv, squadRunId: string): Record<string, unknown> {
  return pollSquadUntil(root, env, squadRunId, (status) => status.status === "converged");
}

function pollSquadUntil(
  root: string,
  env: NodeJS.ProcessEnv,
  squadRunId: string,
  done: (status: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  const deadline = Date.now() + 20_000;
  do {
    const current = run(root, env, ["squad", "status", squadRunId]);
    if (done(current)) return current;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  } while (Date.now() < deadline);
  return run(root, env, ["squad", "status", squadRunId]);
}

function run(root: string, env: NodeJS.ProcessEnv, args: readonly string[]): Record<string, unknown> {
  const result = runMaybe(root, env, args);
  assert.equal(result.status, 0, `${result.stderr}\n${JSON.stringify(result.receipt)}`);
  return result.receipt;
}

function runMaybe(
  root: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): {
  readonly status: number | null;
  readonly receipt: Record<string, unknown>;
  readonly stderr: string;
} {
  const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], { encoding: "utf8", env });
  return {
    status: result.status,
    receipt: result.stdout.trim() ? (JSON.parse(result.stdout) as Record<string, unknown>) : {},
    stderr: result.stderr,
  };
}

function isolatedDaemonEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "HARNESS_CANONICAL_ROOT",
    "HARNESS_DAEMON_ENDPOINT",
    "HARNESS_DAEMON_ID",
    "HARNESS_DAEMON_REPO_ID",
    "HARNESS_DAEMON_USER_ROOT",
    "HARNESS_TASK_BOUND",
  ])
    delete env[key];
  return { ...env, ...overrides };
}

function daemonSocketTemp(parent: string): string {
  return process.platform === "win32" ? path.join(parent, "tmp") : path.join(path.parse(parent).root, "tmp");
}

function writeIdentity(target: string, id: string, name: string, runtimeType = "codex", model?: string): void {
  mkdirSync(target, { recursive: true });
  writeFileSync(
    path.join(target, "agent.json"),
    JSON.stringify({
      schema: "agent-declaration/v1",
      id,
      name,
      instructions: `${name} instructions`,
      runtime_type: runtimeType,
      ...(model ? { model } : {}),
      skills: [],
      prompts: [],
      preset: "standard-task",
    }),
  );
}

function writeMixedLeaderProvider(target: string): void {
  writeProviderExecutable(
    target,
    `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("claude mixed-runtime-test"); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") process.exit(0);
const prompt = fs.readFileSync(0, "utf8");
const callback = prompt.includes("# Squad worker callback") || prompt.includes("# Squad leader retry");
fs.appendFileSync(process.cwd() + "/.mixed-leader-provider.jsonl", JSON.stringify({ kind: callback ? "callback" : "initial", args, prompt }) + "\\n");
const resumedAt = args.indexOf("--resume");
const sessionId = resumedAt === -1 ? "mixed-leader-" + process.pid : args[resumedAt + 1];
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }));
if (callback) setInterval(() => undefined, 1000);
else {
  const negative = prompt.includes("negative mixed mission");
  const dispatches = negative
    ? [{ to: "mixed-missing", prompt: "Missing runtime mission" }]
    : [
        { to: "mixed-reconcile", prompt: "Reconcile mission" },
        { to: "mixed-discrimination", prompt: "Discrimination mission" },
        { to: "mixed-errorexit", prompt: "Error exit mission" },
      ];
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: sessionId, result: JSON.stringify({ schema: "runtime-batch/v1", dispatches }), permission_denials: [] }));
}
`,
  );
}

function writeBlockingWorkerProvider(target: string): void {
  writeProviderExecutable(
    target,
    `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex mixed-runtime-test"); process.exit(0); }
if (args[0] === "login" && args[1] === "status") process.exit(0);
fs.readFileSync(0, "utf8");
console.log(JSON.stringify({ type: "thread.started", thread_id: "mixed-worker-" + process.pid }));
setInterval(() => undefined, 1000);
`,
  );
}

function writeResidentProvider(target: string): void {
  writeProviderExecutable(
    target,
    `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex resident-test");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  process.exit(0);
}
const prompt = fs.readFileSync(0, "utf8");
const frame = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const initialLeader = prompt.includes("# Squad dispatch protocol");
const callbackLeader = prompt.includes("# Squad worker callback") || prompt.includes("# Squad leader retry");
const terra = prompt.includes("# Agent Identity: Terra (terra)");
const luna = prompt.includes("# Agent Identity: Luna (luna)");
const retry = terra && prompt.includes("Terra retry mission");
const rows = prompt.match(/^worker /gmu) || [];
const workerRunning = /^worker .*status=running/mu.test(prompt);
fs.appendFileSync(
  process.env.CODEX_HOME + "/provider.jsonl",
  JSON.stringify({
    kind: initialLeader ? "leader-initial" : callbackLeader ? "leader-callback" : "worker",
    args,
    cwd: process.cwd(),
    prompt,
  }) + "\\n",
);
frame({
  type: "thread.started",
  thread_id: initialLeader || callbackLeader
    ? "leader-resident-session"
    : terra
      ? "terra-resident-session"
      : "luna-resident-session",
});
if (initialLeader) {
  frame({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: JSON.stringify({
        schema: "runtime-batch/v1",
        dispatches: [
          {
            to: "terra",
            prompt: "Terra first mission",
          },
          {
            to: "luna",
            prompt: "Luna mission",
          },
        ],
      }),
    },
  });
} else if (callbackLeader && rows.length === 2) {
  frame({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: JSON.stringify({
        schema: "runtime-batch/v1",
        dispatches: [{
          to: "terra",
          prompt: "Terra retry mission",
        }],
      }),
    },
  });
} else if (callbackLeader && workerRunning) {
  frame({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: JSON.stringify({ schema: "squad-decision/v1", action: "waiting" }),
    },
  });
} else if (callbackLeader) {
  frame({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: JSON.stringify({
        schema: "squad-decision/v1",
        action: "converged",
        report: "# Squad synthesis\\n\\nWorker receipts verified.\\n",
      }),
    },
  });
} else if (terra && !retry) {
  frame({
    type: "item.completed",
    item: { type: "agent_message", text: "worker failed" },
  });
  frame({ type: "turn.failed", error: { message: "worker failure" } });
  process.exitCode = 1;
} else {
  if (luna) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  frame({
    type: "item.completed",
    item: { type: "agent_message", text: "worker succeeded" },
  });
  frame({
    type: "item.completed",
    item: { type: "file_change", status: "completed", changes: [] },
  });
}
frame({ type: "turn.completed" });
`,
  );
}

function writeApiKeyProvider(target: string): void {
  writeProviderExecutable(
    target,
    `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex api-key-test"); process.exit(0); }
const prompt = fs.readFileSync(0, "utf8");
const config = fs.readFileSync((process.env.CODEX_HOME || "") + "/config.toml", "utf8");
if (!config.includes("experimental_bearer_token = \\"squad-secret\\"")) {
  process.stderr.write("HTTP 401 API_KEY_REQUIRED\\n");
  process.exit(1);
}
const frame = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const callback = prompt.includes("# Squad worker callback") || prompt.includes("# Squad leader retry");
const leader = prompt.includes("# Squad dispatch protocol") || callback;
const terra = prompt.includes("# Agent Identity: Terra (terra)");
const luna = prompt.includes("# Agent Identity: Luna (luna)");
frame({ type: "thread.started", thread_id: leader ? "leader-api-session" : terra ? "terra-api-session" : "luna-api-session" });
if (prompt.includes("# Squad dispatch protocol")) {
  frame({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ schema: "runtime-batch/v1", dispatches: [{ to: "terra", prompt: "terra API mission" }, { to: "luna", prompt: "luna API mission" }] }) } });
} else if (callback) {
  const running = /^worker .*status=running/mu.test(prompt);
  if (running) {
    frame({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ schema: "squad-decision/v1", action: "waiting" }) } });
  } else {
    frame({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ schema: "squad-decision/v1", action: "converged", report: "# Squad synthesis\\n\\nWorker receipts verified.\\n" }) } });
  }
} else {
  frame({ type: "item.completed", item: { type: "agent_message", text: "worker output" } });
  frame({ type: "item.completed", item: { type: "file_change", status: "completed", changes: [] } });
}
frame({ type: "turn.completed" });
`,
  );
}

function writeCredentialTool(target: string): string {
  return writeProviderExecutable(
    target,
    `const fs = require("node:fs");
const path = require("node:path");
const file = path.join(path.dirname(process.argv[1]), "credential-store.json");
const id = process.argv.at(-1);
if (process.argv[2] === "store") {
  let value = "";
  process.stdin.on("data", (chunk) => value += chunk);
  process.stdin.on("end", () => { fs.writeFileSync(file, JSON.stringify({ [id]: value })); });
} else if (process.argv[2] === "lookup" && id) {
  const values = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  if (typeof values[id] !== "string") process.exit(1);
  process.stdout.write(values[id]);
} else process.exit(1);
`,
  );
}
