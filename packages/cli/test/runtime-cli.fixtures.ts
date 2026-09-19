import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext } from "node:test";
import { writeProviderExecutable } from "../../daemon/test/fixtures/runtime-stub.ts";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import { localUserDaemonEndpoint } from "../src/daemon/client.ts";
import { realizedTaskPlan as realizedPlan } from "../../../tools/fixtures/task-plan.mjs";

export const cli = path.resolve("packages/cli/src/index.ts");

export function run(root: string, env: NodeJS.ProcessEnv, args: readonly string[]): Record<string, unknown> {
  const result = runMaybe(root, env, args);
  assert.equal(result.status, 0, `${result.stderr}\n${JSON.stringify(result.receipt)}`);
  return result.receipt;
}
// Writes return at durable acceptance; a test that reads Git or the worktree waits for both followers explicitly.
export function published(
  root: string,
  env: NodeJS.ProcessEnv,
  receipt: Record<string, unknown>,
): Record<string, unknown> {
  const wait = ["--wait", "git_verified,worktree_visible", "--timeout-ms", "5000"];
  return run(root, env, ["receipt", "show", String(receipt.opId), ...wait]);
}
export function runMaybe(
  root: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): {
  readonly status: number | null;
  readonly pid: number | undefined;
  readonly receipt: Record<string, unknown>;
  readonly stderr: string;
} {
  const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], { encoding: "utf8", env });
  return {
    status: result.status,
    pid: result.pid,
    receipt: result.stdout.trim() ? (JSON.parse(result.stdout) as Record<string, unknown>) : {},
    stderr: result.stderr,
  };
}
export function runAsync(
  root: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<{
  readonly status: number | null;
  readonly pid: number | undefined;
  readonly receipt: Record<string, unknown>;
  readonly stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--root", root, "--json", ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (status) =>
      resolve({
        status,
        pid: child.pid,
        receipt: stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>) : {},
        stderr,
      }),
    );
  });
}

function writeProvider(target: string, version: string): void {
  writeProviderExecutable(
    target,
    `const fs = require("node:fs");\nconst args = process.argv.slice(2);\nif (args[0] === "--version") { console.log("codex ${version}"); process.exit(0); }\nif (args[0] === "login" && args[1] === "status") process.exit(0);\nconst prompt = fs.readFileSync(0, "utf8"), mission = prompt.split("\\n# Assigned Mission\\n").at(-1), body = mission.startsWith("# 台账查询引导") ? mission.split("\\n\\n").at(-1) : mission, secret = "sk-runtime-secret-1234567890";\nif (body === "failure:empty") process.exit(1);\nif (body === "failure:secret") process.stderr.write("OPENAI_API_KEY=" + secret + "\\n", () => process.exit(1));\nelse if (body === "failure:structured") process.stdout.write([JSON.stringify({ type: "thread.started", thread_id: "provider-cli-session" }), JSON.stringify({ type: "turn.failed", error: { message: "structured provider failure", apiToken: secret } })].join("\\n") + "\\n", () => process.exit(1));\nelse { const resumed = args[0] === "exec" && args[1] === "resume", readOnly = body === "read-only", noAction = body === "no-action";\nif (readOnly && !args.includes("read-only")) process.exit(9);\nconst session = resumed ? args.at(-2) : "provider-cli-session";\nconst batch = body.includes("batch hold"), mark = (event) => { if (batch) fs.appendFileSync(".batch-tracker", event + "\\n"); };\nconst emit = () => { mark("start"); console.log(JSON.stringify({ type: "thread.started", thread_id: session })); if (readOnly) console.log(JSON.stringify({ type: "item.completed", item: { id: "inspect", type: "command_execution", command: "ls packages", aggregated_output: "cli daemon kernel", exit_code: 0, status: "completed" } })); console.log(JSON.stringify({ type: "item.completed", item: { id: "live", type: "agent_message", text: "live:" + prompt } })); if (body === "hold") setInterval(() => {}, 1000); else { if (!readOnly && !noAction) console.log(JSON.stringify({ type: "item.completed", item: { id: "write", type: "file_change", changes: [{ path: "result.txt", kind: "add" }], status: "completed" } })); console.log(JSON.stringify({ type: "item.completed", item: { id: "final", type: "agent_message", text: resumed ? "resumed:" + session + ":" + prompt : "final:" + prompt } })); console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })); mark("end"); } };\nif (body === "stream prompt") setTimeout(emit, 3000); else if (batch) setTimeout(emit, 250); else emit(); }\n`,
  );
}
export function writeProgressProvider(target: string, version: string): void {
  writeProvider(target, version);
  const source = readFileSync(target, "utf8"),
    batchMarker =
      'const batch = body.includes("batch hold"), mark = (event) => { if (batch) fs.appendFileSync(".batch-tracker", event + "\\n"); };\n',
    threadMarker = 'console.log(JSON.stringify({ type: "thread.started", thread_id: session })); if (readOnly)',
    quotaMarker = "else { const resumed",
    quotaFailure =
      'else if (body === "failure:429") process.stdout.write([JSON.stringify({ type: "thread.started", thread_id: "provider-cli-session" }), JSON.stringify({ type: "turn.failed", error: { http_status: 429, code: "insufficient_quota", message: "credit balance exhausted", reset_at: "2026-09-06T05:06:07Z" } })].join("\\n") + "\\n", () => process.exit(1));\nelse { const resumed',
    progressSetup =
      `${batchMarker}const progressTask = body.startsWith("progress-middle:") ? body.slice("progress-middle:".length) : null;\n` +
      'const submitTask = body.startsWith("submit-before-exit:") ? body.slice("submit-before-exit:".length).split(":")[0] : null;\n',
    progressWrite =
      `console.log(JSON.stringify({ type: "thread.started", thread_id: session })); if (progressTask) { for (const text of ["Provider checkpoint one.", "Provider checkpoint two."]) { const result = require("node:child_process").spawnSync(process.execPath, [${JSON.stringify(cli)}, "--root", process.cwd(), "--json", "task", "progress", "append", progressTask, "--text", text, "--evidence", "test:reports/runtime-progress.txt:provider checkpoint"], { encoding: "utf8", env: process.env }); if (result.status !== 0) { process.stderr.write("progress append failed: " + result.stdout + result.stderr); process.exit(8); } } } ` +
      `if (submitTask) { const packageRoot = prompt.split("Task package root: ")[1].split("\\n")[0]; fs.writeFileSync(require("node:path").join(packageRoot, "closeout.md"), "# Closeout\\n\\n## Summary\\n\\nRuntime worker submitted before exit at " + mission.split(":").at(-1) + ".\\n\\n## Verification\\n\\nIntegration runtime submission.\\n\\n## Residual Risk\\n\\nNone.\\n\\n## Same Mechanism Elsewhere\\n\\nRuntime archive lifecycle.\\n"); const result = require("node:child_process").spawnSync(process.execPath, [${JSON.stringify(cli)}, "--root", process.cwd(), "--json", "task", "submit", submitTask], { encoding: "utf8", env: process.env }); if (result.status !== 0) { process.stderr.write("task submit failed: " + result.stdout + result.stderr); process.exit(8); } } if (readOnly)`,
    next = source
      .replace(batchMarker, progressSetup)
      .replace(threadMarker, progressWrite)
      .replace(quotaMarker, quotaFailure);
  if (next === source) throw new Error("runtime progress provider marker changed");
  writeFileSync(target, next);
}

export function createRuntimeFixture(context: TestContext) {
  const parent = mkdtempSync(path.join(process.platform === "win32" ? tmpdir() : "/tmp", "ha-runtime-cli-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    daemonId = `runtime-cli-test-${randomUUID()}`,
    binRoot = path.join(parent, "bin"),
    version = "0.0.0-runtime-cli-fixture",
    {
      HARNESS_DAEMON_ENDPOINT: _endpoint,
      HARNESS_DAEMON_REPO_ID: _repoId,
      HARNESS_DAEMON_ID: _daemonId,
      ...baseEnv
    } = process.env;
  mkdirSync(root, { recursive: true });
  mkdirSync(binRoot, { recursive: true });
  writeProgressProvider(path.join(binRoot, "codex"), version);
  writeProgressProvider(path.join(binRoot, "claude"), version);
  writeProviderExecutable(
    path.join(binRoot, "gh"),
    'if (process.argv[2] !== "run" || process.argv[3] !== "list") process.exit(1); console.log("[]");\n',
  );
  const env = {
    ...baseEnv,
    HOME: path.join(parent, "home"),
    TMPDIR: process.platform === "win32" ? baseEnv.TMPDIR : "/tmp",
    PATH: [
      binRoot,
      ...(process.env.PATH ?? "")
        .split(path.delimiter)
        .filter((entry) =>
          ["codex", "codex.cmd", "codex.exe", "claude", "claude.cmd", "claude.exe"].every(
            (name) => !existsSync(path.join(entry, name)),
          ),
        ),
    ].join(path.delimiter),
    OPENAI_API_KEY: "sk-must-not-reach-notifier",
    HARNESS_NOTIFY_TEST_SECRET: "must-not-reach-notifier",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_ID: daemonId,
    HARNESS_DAEMON_ENDPOINT: localUserDaemonEndpoint(userRoot, daemonId),
    HARNESS_ACTOR: "agent:runtime-cli-test",
  };
  context.after(() => {
    runMaybe(root, env, ["daemon", "stop"]);
    rmSync(parent, { recursive: true, force: true });
  });
  assert.equal(run(root, env, ["daemon", "start", "--service"]).ok, true);
  run(root, env, ["init", "--repo-id", "runtime-cli", "--person-id", "owner", "--display-name", "Owner"]);
  run(root, env, [
    "runtime",
    "instance",
    "create",
    "--id",
    "cli-worker",
    "--name",
    "CLI Worker",
    "--kind",
    "codex",
    "--provider",
    "openai",
    "--model",
    "runtime-test-model",
    "--auth",
    "subscription",
  ]);
  return { parent, root, userRoot, daemonId, env, version };
}

export function seedTask(root: string, env: NodeJS.ProcessEnv, scenario: string) {
  const taskId = `task-runtime-${scenario}`,
    executionId = `exec-runtime-${scenario}`,
    created = run(root, env, ["task", "create", "--id", taskId, "--admin", "--title", scenario]),
    packagePath = String(created.packagePath),
    artifactRoot = path.join(root, "harness", packagePath, "artifacts");
  published(root, env, created);
  writeFileSync(path.join(root, "harness", packagePath, "task_plan.md"), realizedPlan(scenario));
  run(root, env, ["doc", "sync", "--submit", "--path", `${packagePath}/task_plan.md`]);
  return { taskId, executionId, packagePath, artifactRoot };
}

export function installIdentities(parent: string, root: string, env: NodeJS.ProcessEnv) {
  mkdirSync(path.join(root, "harness", "skills", "review"), { recursive: true });
  writeFileSync(
    path.join(root, "harness", "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review\n---\nReview fixture.\n",
  );
  run(root, env, [
    "runtime",
    "instance",
    "create",
    "--id",
    "claude-worker",
    "--name",
    "Claude Worker",
    "--kind",
    "claude",
    "--provider",
    "anthropic",
    "--model",
    "runtime-test-model",
    "--auth",
    "subscription",
  ]);
  const identities = [
      {
        id: "fable",
        name: "Fable",
        instructions: "Lead precisely.",
        runtimes: [{ type: "codex" }],
        instance: "cli-worker",
        role: "commander",
      },
      {
        id: "terra",
        name: "Terra",
        instructions: "Review precisely.",
        runtimes: [{ type: "codex" }],
        instance: "cli-worker",
        role: "worker",
      },
      {
        id: "outsider",
        name: "Outsider",
        instructions: "Work outside the squad.",
        runtimes: [{ type: "codex" }],
        instance: "cli-worker",
        role: "worker",
      },
      {
        id: "opencode-worker",
        name: "OpenCode Worker",
        instructions: "Use OpenCode.",
        runtimes: [{ type: "claude" }],
        instance: "claude-worker",
        role: "worker",
      },
      {
        id: "any-worker",
        name: "Any Worker",
        instructions: "Use any compatible runtime.",
        runtimes: [],
        instance: "cli-worker",
        role: "worker",
      },
    ],
    squadSource = path.join(parent, "core-squad");
  for (const identity of identities) {
    const agentSource = path.join(parent, identity.id);
    writeIdentity(agentSource, {
      id: identity.id,
      title: identity.name,
      kind: "agent",
      agent: {
        ...identity,
        skills: [{ id: "review", path: "skills/review" }],
        prompts: ["prompt://review"],
        preset: "standard-task",
      },
    });
    run(root, env, ["agent", "install", "--source", agentSource]);
  }
  writeIdentity(squadSource, {
    id: "core-squad",
    title: "Core Squad",
    kind: "squad",
    squad: {
      id: "core-squad",
      name: "Core Squad",
      leader: "fable",
      workers: ["terra", "opencode-worker"],
      leaderTurnBudget: 8,
      roster: "# Core Squad\n\nFable delegates to Terra and OpenCode Worker.",
    },
  });
  run(root, env, ["squad", "install", "--source", squadSource]);
  return { squadSource };
}

export function writeIdentity(
  target: string,
  identity: Record<string, unknown> & { agent?: Record<string, unknown>; squad?: Record<string, unknown> },
): void {
  const kind = String(identity.kind) as "agent" | "squad",
    declaration = kind === "agent" ? identity.agent : identity.squad;
  mkdirSync(target, { recursive: true });
  writeFileSync(
    path.join(target, kind === "agent" ? "agent.json" : "squad.json"),
    `${JSON.stringify({ schema: `${kind}-declaration/v1`, ...declaration }, null, 2)}\n`,
  );
}

export async function runtimeInvariantEvidence(
  root: string,
  artifactRoot: string,
  spawned: Record<string, unknown>,
  settled: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const dispatchId = String(spawned.dispatchId),
    runtimeSessionId = String(spawned.runtimeSessionId),
    archivePath = path.join(artifactRoot, "dispatches", `${dispatchId}.json`),
    reportPath = path.join(artifactRoot, "reports", `${dispatchId}.md`),
    archive = JSON.parse(await readPublishedDispatch(archivePath)) as Record<string, unknown>,
    events = makeTaskEventReader({ repoId: "runtime-cli", rootDir: root })
      .read()
      .events.filter(
        (event) => "runtimeSessionId" in event.payload && event.payload.runtimeSessionId === runtimeSessionId,
      ),
    observed = events.filter((event) => event.type === "runtime_session_outcome_observed");
  await eventuallyFile(reportPath);
  return {
    outcome: settled.outcome,
    exitCode: ((settled.session as Record<string, unknown>).activity as Record<string, unknown>).exitCode,
    archiveExists: existsSync(archivePath),
    archiveOutcome: archive.outcome,
    archiveExitCode: archive.exitCode,
    reportExists: existsSync(reportPath),
    exitedEvents: events.filter((event) => event.type === "runtime_session_exited").length,
    observedEvents: observed.length,
    observedOutcome: observed[0]?.type === "runtime_session_outcome_observed" ? observed[0].payload.outcome : null,
    observedExitCode: observed[0]?.type === "runtime_session_outcome_observed" ? observed[0].payload.exitCode : null,
  };
}
export function readDispatchRecords(root: string, dispatchId: string): Record<string, unknown>[] {
  return readFileSync(path.join(root, ".harness", "runtime", "dispatches", `${dispatchId}.jsonl`), "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
export async function eventuallyNotification(
  root: string,
  dispatchId: string,
): Promise<{ readonly started: Record<string, unknown> | undefined; readonly finished: Record<string, unknown> }> {
  let records: Record<string, unknown>[] = [];
  for (let attempt = 0; attempt < 500; attempt += 1) {
    records = readDispatchRecords(root, dispatchId).filter((record) => record.kind === "exit_notification");
    const finished = records.find((record) => record.phase === "finished");
    if (finished) return { started: records.find((record) => record.phase === "started"), finished };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`notification did not settle: ${JSON.stringify(records)}`);
}
export async function readPublishedDispatch(target: string): Promise<string> {
  await eventuallyFile(target);
  return readFileSync(target, "utf8");
}
export async function eventuallyFile(target: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(target)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`file did not appear: ${target}`);
}
export async function eventually<T>(read: () => T): Promise<T> {
  let last: T | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    last = read();
    const rows = (last as Record<string, unknown>).dispatches;
    if (Array.isArray(rows) && rows.some((row) => (row as Record<string, unknown>).status === "cancelled")) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`dispatch did not settle: ${JSON.stringify(last)}`);
}
export async function eventuallyTerminal(
  root: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 100; attempt += 1) {
    last = runMaybe(root, env, args).receipt;
    const rows = last.dispatches;
    if (Array.isArray(rows) && rows.some((row) => (row as Record<string, unknown>).status === "cancelled")) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`dispatch did not settle: ${JSON.stringify(last)}`);
}
export async function eventuallyRuntimeStatus(
  root: string,
  env: NodeJS.ProcessEnv,
  runtimeSessionId: string,
  liveness: string,
): Promise<{ readonly session: Record<string, unknown> & { readonly activity: Record<string, unknown> } }> {
  let last: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 500; attempt += 1) {
    last = run(root, env, ["runtime", "status", runtimeSessionId]);
    const session = last.session as Record<string, unknown> & { readonly activity: Record<string, unknown> };
    if (session.liveness === liveness) return { session };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`runtime status did not reach ${liveness}: ${JSON.stringify(last)}`);
}
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
export async function eventuallyRuntimeReaderReuse(
  userRoot: string,
  daemonId: string,
): Promise<{ readonly conn: string; readonly helloCount: number; readonly statusReads: number }> {
  let observed: Record<string, string[]> = {};
  for (let attempt = 0; attempt < 100; attempt += 1) {
    observed = {};
    const logRoot = path.join(userRoot, "logs"),
      names = existsSync(logRoot)
        ? readdirSync(logRoot).filter((name) => name.startsWith(`daemon-${daemonId}-conn-`) && name.endsWith(".jsonl"))
        : [];
    for (const name of names)
      for (const line of readFileSync(path.join(logRoot, name), "utf8").trim().split("\n").filter(Boolean)) {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.event !== "request" || typeof record.conn !== "string" || typeof record.method !== "string")
          continue;
        const key = `${String(record.pid)}:${record.conn}`;
        (observed[key] ??= []).push(record.method);
      }
    // The wait is one parked sessions.await on one connection; the retired sessions.read polling
    // pattern (2+ reads on a single connection) must not appear anywhere.
    const parked = Object.entries(observed).find(
        ([, methods]) =>
          methods.filter((method) => method === "repo.agentRuntime.sessions.await").length === 1 &&
          methods.filter((method) => method === "protocol.hello").length === 1,
      ),
      polled = Object.entries(observed).find(
        ([, methods]) => methods.filter((method) => method === "repo.agentRuntime.sessions.read").length >= 2,
      );
    if (parked && !polled)
      return {
        conn: parked[0],
        helloCount: 1,
        awaits: parked[1].filter((method) => method === "repo.agentRuntime.sessions.await").length,
      };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`runtime status wait did not park one daemon await: ${JSON.stringify(observed)}`);
}
export function assertTaskMissionPrompt(
  prompt: string,
  expected: {
    readonly repoId: string;
    readonly taskId: string;
    readonly canonicalRoot: string;
    readonly workerRoot: string;
    readonly taskPackageRoot: string;
    readonly daemonUserRoot: string;
    readonly daemonId: string;
    readonly runtimeSessionId: string;
    readonly mission: string;
  },
): void {
  assert.ok(
    prompt.includes(
      `# Dispatch Preconditions\nRepository id: ${expected.repoId}\nRepository registration: enabled\nCanonical repository root: ${expected.canonicalRoot}\nWorker repository root: ${expected.workerRoot}\nCanonical Task ID: ${expected.taskId}\nTask package root: ${expected.taskPackageRoot}\nDaemon user root: ${expected.daemonUserRoot}\nDaemon id: ${expected.daemonId}\nDaemon endpoint: `,
    ),
    prompt,
  );
  assert.ok(prompt.includes(`\nRuntime actor: agent:runtime-session:${expected.runtimeSessionId}\n`), prompt);
  assert.ok(prompt.endsWith(`# Assigned Mission\n${expected.mission}`), prompt);
}
