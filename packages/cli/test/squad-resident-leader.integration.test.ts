// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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
  writeResidentProvider(path.join(binRoot, "codex"));
  const env = {
    ...process.env,
    HOME: path.join(parent, "home"),
    PATH: [
      binRoot,
      ...(process.env.PATH ?? "")
        .split(path.delimiter)
        .filter((entry) => ["codex", "codex.cmd", "codex.exe"].every((name) => !existsSync(path.join(entry, name)))),
    ].join(path.delimiter),
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_ID: "squad-resident-test",
    HARNESS_ACTOR: "agent:squad-resident-test",
  };
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
        roster: "terra -> backend\nluna -> frontend",
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
    writeApiKeyProvider(path.join(binRoot, "codex"));
    const credentialTool = writeCredentialTool(path.join(binRoot, "secret-tool"));
    const env = {
      ...process.env,
      HOME: path.join(parent, "home"),
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
    };
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
          roster: "terra -> backend\nluna -> frontend",
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
        "--prompt",
        "ship the API-key mission",
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
  const deadline = Date.now() + 20_000;
  do {
    const current = run(root, env, ["squad", "status", squadRunId]);
    if (current.status === "converged") return current;
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

function writeIdentity(target: string, id: string, name: string): void {
  mkdirSync(target, { recursive: true });
  writeFileSync(
    path.join(target, "agent.json"),
    JSON.stringify({
      schema: "agent-declaration/v1",
      id,
      name,
      instructions: `${name} instructions`,
      runtime_type: "codex",
      skills: [],
      prompts: [],
      preset: "standard-task",
    }),
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
const callbackLeader = prompt.includes("# Squad worker callback");
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
            instance: "resident-worker",
            to: "terra",
            prompt: "Terra first mission",
          },
          {
            instance: "resident-worker",
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
          instance: "resident-worker",
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
      text: JSON.stringify({ schema: "runtime-batch/v1", dispatches: [] }),
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
const leader = prompt.includes("# Squad dispatch protocol") || prompt.includes("# Squad worker callback");
const terra = prompt.includes("# Agent Identity: Terra (terra)");
const luna = prompt.includes("# Agent Identity: Luna (luna)");
frame({ type: "thread.started", thread_id: leader ? "leader-api-session" : terra ? "terra-api-session" : "luna-api-session" });
if (prompt.includes("# Squad dispatch protocol")) {
  frame({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ schema: "runtime-batch/v1", dispatches: [{ instance: "squad-api", to: "terra", prompt: "terra API mission" }, { instance: "squad-api", to: "luna", prompt: "luna API mission" }] }) } });
} else if (prompt.includes("# Squad worker callback")) {
  const running = /^worker .*status=running/mu.test(prompt);
  frame({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(running ? { schema: "runtime-batch/v1", dispatches: [] } : { schema: "squad-decision/v1", action: "converged" }) } });
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
