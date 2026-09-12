// harness-test-tier: integration
import assert from "node:assert/strict";

import { spawnSync } from "node:child_process";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import path from "node:path";

import { makeTaskEventStore } from "../../kernel/src/index.ts";

import { writeProviderExecutable } from "../../daemon/test/fixtures/runtime-stub.ts";

import { realizedTaskPlan as realizedPlan } from "../../../tools/fixtures/task-plan.mjs";

const cli = path.resolve("packages/cli/src/index.ts");

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

// Writes return at durable acceptance; a test that reads Git or the worktree waits for both followers explicitly.
function published(root: string, env: NodeJS.ProcessEnv, receipt: Record<string, unknown>): Record<string, unknown> {
  const wait = ["--wait", "git_verified,worktree_visible", "--timeout-ms", "5000"];
  return run(root, env, ["receipt", "show", String(receipt.opId), ...wait]);
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

function writeResidentProvider(target: string, ledgerPath: string): void {
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
let acceptedAtLaunch = null;
if (initialLeader) {
  const db = new (require("node:sqlite").DatabaseSync)(${JSON.stringify(ledgerPath)}, { readOnly: true });
  const row = db.prepare("SELECT e.op_id, e.event_json, c.status FROM event e JOIN command_outcome c ON c.op_id=e.op_id WHERE json_extract(e.event_json, '$.type')='runtime_dispatch_requested' ORDER BY e.revision DESC LIMIT 1").get();
  if (!row || row.status !== "accepted_durable") throw new Error("leader launched before dispatch acceptance");
  acceptedAtLaunch = { opId: row.op_id, runtimeSessionId: JSON.parse(row.event_json).payload.runtimeSessionId };
  db.close();
}
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
    acceptedAtLaunch,
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

export {
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
};
