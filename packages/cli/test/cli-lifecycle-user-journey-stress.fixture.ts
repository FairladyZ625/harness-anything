// harness-test-tier: integration
import { after } from "node:test";
import { spawnKeycloak, signInAt } from "../../daemon/test/keycloak.fixtures.ts";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import assert from "node:assert/strict";

import { execFileSync, spawn } from "node:child_process";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import path from "node:path";

import { seedSettingsEvent } from "../../daemon/test/repo-settings.fixture.ts";
import { localUserDaemonEndpoint } from "@harness-anything/daemon/internal/client/local-daemon-target";
import { readDaemonPid } from "@harness-anything/daemon/internal/runtime";

import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";

const cli = path.resolve("packages/cli/src/index.ts"),
  clientCount = 8,
  chainsPerClient = 3;

const realm = await spawnKeycloak();
after(() => realm.close());
await realm.control({ op: "account", personId: "owner" });
for (let index = 0; index < 14; index++)
  await realm.control({
    op: "permit",
    personId: "owner",
    resource: `cli-stress-repo-${index}`,
    actions: effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"),
  });

type Fixture = {
  readonly parent: string;
  readonly root: string;
  readonly userRoot: string;
  readonly daemonId: string;
  readonly repoId: string;
  daemonPid: number | null;
};

type RunResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

async function runClient(fixture: Fixture, clientIndex: number): Promise<ChainOutcome[] & { actor: string }> {
  const actor = actorLabel(clientIndex),
    outcomes: ChainOutcome[] = [];
  for (let chainIndex = 0; chainIndex < chainsPerClient; chainIndex += 1)
    outcomes.push(await runChain(fixture, clientIndex, chainIndex, actor));
  return Object.assign(outcomes, { actor });
}

type ChainOutcome = {
  readonly taskId: string;
  readonly status: string;
  readonly elapsedMs: number;
};

async function runChain(
  fixture: Fixture,
  clientIndex: number,
  chainIndex: number,
  actor: string,
): Promise<ChainOutcome> {
  const taskId = `task-cli-stress-${clientIndex}-${chainIndex}`,
    executionId = `execution-cli-stress-${clientIndex}-${chainIndex}`,
    // Keep lifecycle transport coverage independent of CI ingestion; the docs preset has no CI gate.
    standard = false,
    preset = "docs-task",
    workerEnvironment = actorEnvironment(fixture, clientIndex, actor),
    reviewerEnvironment = actorEnvironment(fixture, clientIndex, `agent:reviewer-${clientIndex}-${chainIndex}`),
    startedAt = Date.now();
  const created = await expectApplied(
      fixture,
      [
        "task",
        "create",
        "--id",
        taskId,
        "--title",
        `CLI stress ${clientIndex}-${chainIndex}`,
        "--preset",
        preset,
        "--vertical",
        "software/coding",
        "--kind",
        standard ? "test" : "docs",
        "--admin",
      ],
      workerEnvironment,
    ),
    packagePath = String(created.workspacePackagePath),
    packageRoot = path.join(fixture.root, packagePath),
    planPath = path.join(packageRoot, "task_plan.md"),
    closeoutPath = path.join(packageRoot, "closeout.md"),
    artifactPath = path.join(packageRoot, "artifacts", "chain.txt");
  await published(fixture, created, workerEnvironment);
  writeFileSync(planPath, realizedTaskPlan(`CLI stress ${clientIndex}-${chainIndex}`));
  writeFileSync(artifactPath, `synthetic chain ${clientIndex}-${chainIndex}\n`);
  await expectApplied(
    fixture,
    ["doc", "sync", "--submit", "--path", packagePathFor(packagePath, "task_plan.md")],
    workerEnvironment,
  );
  await expectApplied(
    fixture,
    [
      "fact",
      "record",
      "--task",
      taskId,
      "--statement",
      "A synthetic CLI lifecycle chain reached its execution lease.",
      "--source",
      `test:cli-lifecycle-stress/${taskId}`,
      "--confidence",
      "high",
    ],
    workerEnvironment,
  );
  await expectApplied(fixture, ["task", "start", taskId, "--execution-id", executionId], workerEnvironment);
  await expectNoop(fixture, ["task", "start", taskId, "--execution-id", executionId], workerEnvironment);
  const rejectedProgress = await runResult(
    fixture,
    ["task", "progress", "append", taskId, "--text", "unauthorized checkpoint"],
    reviewerEnvironment,
  );
  assert.notEqual(rejectedProgress.status, 0, rejectedProgress.stdout);
  assert.match(rejectedProgress.stdout, /progress_lease_required|actor_unauthorized|lease/u);
  await expectApplied(
    fixture,
    [
      "task",
      "progress",
      "append",
      taskId,
      "--text",
      "checkpoint",
      "--evidence",
      `test:${packagePathFor(packagePath, "artifacts/chain.txt")}:synthetic chain evidence`,
    ],
    workerEnvironment,
  );
  const artifactSync = await expectApplied(fixture, ["doc", "sync", "--submit", "--task", taskId], workerEnvironment);
  writeFileSync(
    closeoutPath,
    `# Closeout\n\n## Summary\n\nSynthetic chain complete: artifact:${packagePath}/artifacts/chain.txt@${artifactSync.revision}\n\n` +
      "## Verification\n\nCLI stress path.\n\n## Residual Risk\n\nNone.\n\n" +
      "## Same Mechanism Elsewhere\n\nNo production behavior changed.\n",
  );
  await expectApplied(fixture, ["doc", "sync", "--submit", "--task", taskId], workerEnvironment);
  await expectApplied(fixture, ["task", "submit", taskId], workerEnvironment);
  mkdirSync(path.join(packageRoot, "artifacts", "reports"), { recursive: true });
  writeFileSync(
    path.join(packageRoot, "artifacts", "reports", `${taskId}.md`),
    `# Review review-${taskId}\n\nIndependent synthetic reviewer checked the submitted execution.\n`,
  );
  await expectApplied(
    fixture,
    [
      "task",
      "review-execution",
      taskId,
      "--execution-id",
      executionId,
      "--review-id",
      `review-${taskId}`,
      "--json-input",
      JSON.stringify({
        verdict: "approved",
        reason: "Independent synthetic reviewer checked the submitted execution.",
        evidenceChecked: [packagePathFor(packagePath, "artifacts/chain.txt")],
        findings: [],
        resolutions: [],
      }),
    ],
    reviewerEnvironment,
  );
  await expectApplied(
    fixture,
    ["task", "review-consent", taskId, "--execution-id", executionId, "--review-id", `review-${taskId}`],
    workerEnvironment,
  );
  await expectApplied(fixture, ["task", "complete", taskId], workerEnvironment);
  const final = await expectApplied(fixture, ["task", "show", taskId], workerEnvironment),
    finalEvidence = JSON.parse(String(final.evidence)) as { readonly task?: { readonly status?: string } };
  assert.equal(finalEvidence.task?.status, "done");
  return { taskId, status: finalEvidence.task?.status ?? "missing", elapsedMs: Date.now() - startedAt };
}

async function startClient(fixture: Fixture): Promise<void> {
  const started = await runResult(fixture, ["daemon", "start", "--service"], actorEnvironment(fixture, 0, null));
  if (started.status === 0) {
    await rememberDaemonPid(fixture, parseCliReceipt(started, "daemon start"));
    await expectApplied(
      fixture,
      ["daemon", "repo", "register", "--repo-id", fixture.repoId, "--root", fixture.root, "--no-link"],
      actorEnvironment(fixture, 0, null),
    );
    await waitForAttached(fixture);
    await configureReviewRequiredProfile(fixture);
    return;
  }
  // A Windows host that misses the CLI's 10s bind window can still finish starting; the
  // lifecycle case under test is the write/stop boundary, not that budget. Poll the daemon's
  // own status instead of failing on the first start receipt.
  assert.match(started.stdout, /daemon_starting|daemon_bind_timeout/u, started.stderr);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await runResult(fixture, ["daemon", "status"], actorEnvironment(fixture, 0, null));
    if (status.status === 0) {
      await rememberDaemonPid(fixture);
      await expectApplied(
        fixture,
        ["daemon", "repo", "register", "--repo-id", fixture.repoId, "--root", fixture.root, "--no-link"],
        actorEnvironment(fixture, 0, null),
      );
      await waitForAttached(fixture);
      await configureReviewRequiredProfile(fixture);
      return;
    }
    await delay(50);
  }
  throw new Error(`daemon did not become ready for ${fixture.daemonId}`);
}

async function rememberDaemonPid(fixture: Fixture, receipt?: Record<string, unknown>): Promise<void> {
  const fromReceipt = receipt?.pid,
    parsed = typeof fromReceipt === "number" ? fromReceipt : Number(fromReceipt);
  if (Number.isInteger(parsed) && parsed > 0) {
    fixture.daemonPid = parsed;
    return;
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pid = readDaemonPid(fixture.userRoot, fixture.daemonId);
    if (pid !== null) {
      fixture.daemonPid = pid;
      return;
    }
    await delay(10);
  }
}

async function configureReviewRequiredProfile(fixture: Fixture): Promise<void> {
  const result = await runResult(
      fixture,
      ["settings", "update", "--closeout-profile", "strict"],
      actorEnvironment(fixture, 0, null),
    ),
    receipt = parseCliReceipt(result, "settings update");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(receipt.outcome === "applied" || receipt.outcome === "no_changes", JSON.stringify(receipt));
}

async function waitForAttached(fixture: Fixture): Promise<void> {
  let lastStatus = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await runResult(fixture, ["daemon", "status"], actorEnvironment(fixture, 0, null));
    lastStatus = status.stdout;
    const receipt = parseCliReceipt(status, "daemon status");
    if (repoRows(receipt).some((repo) => repo.repoId === fixture.repoId && repo.state === "attached")) return;
    await delay(50);
  }
  throw new Error(`repository ${fixture.repoId} did not attach: ${lastStatus}`);
}

const DEFAULT_STOP_DEADLINE_MS = 30_000;

function stopDeadlineMs(): number {
  const configured = Number(process.env.HARNESS_CLI_STRESS_STOP_DEADLINE_MS);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_STOP_DEADLINE_MS;
}

export async function waitForDaemonExit(input: {
  readonly pid: () => number | null;
  readonly deadline: number;
  readonly alive: (pid: number) => boolean;
  readonly endpointExists: () => boolean;
  readonly onStalled?: () => void;
  readonly delayMs?: number;
}): Promise<void> {
  for (;;) {
    const pid = input.pid(),
      alive = pid !== null && input.alive(pid);
    if (!alive && !input.endpointExists()) return;
    if (Date.now() >= input.deadline)
      throw new Error(`daemon-stop deadline exceeded (pid ${String(pid)} still owns its endpoint)`);
    input.onStalled?.();
    await delay(input.delayMs ?? 10);
  }
}

async function stopClient(fixture: Fixture): Promise<void> {
  if (!existsSync(fixture.userRoot)) return;
  // `daemon stop` returns when the stop is accepted; a draining daemon keeps its pid file,
  // endpoint and SQLite/Git handles until its write queues empty. This fixture has already
  // observed every write it needs, so end the drain explicitly before the test removes the
  // temporary root (EPERM on Windows). Every child call and the wait share one deadline.
  const deadline = Date.now() + stopDeadlineMs(),
    environment = actorEnvironment(fixture, 0, null),
    boundedRun = async (args: readonly string[]): Promise<RunResult> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`daemon-stop deadline exceeded before ${args.join(" ")}`);
      return runResult(fixture, args, environment, undefined, remaining);
    };
  const daemonPid = readDaemonPid(fixture.userRoot, fixture.daemonId) ?? fixture.daemonPid;
  const stopped = await boundedRun(["daemon", "stop"]);
  const receipt = parseCliReceipt(stopped, "daemon stop");
  if (receipt.draining === true) await boundedRun(["daemon", "stop", "--force"]);
  const receiptPid = typeof receipt.pid === "number" ? receipt.pid : Number(receipt.pid),
    endpoint = localUserDaemonEndpoint(fixture.userRoot, fixture.daemonId);
  let pid = Number.isInteger(receiptPid) && receiptPid > 0 ? receiptPid : daemonPid;
  if (process.platform === "win32") {
    // `daemon start --service` registers a Task Scheduler launcher that relaunches the daemon on
    // the supersession exit code. Stopping the daemon alone leaves that launcher alive, so the
    // temporary root stays open. Remove the unit and end the launcher's process tree before
    // waiting on the daemon pid.
    await boundedRun(["daemon", "service", "uninstall"]);
    pid ??= windowsDaemonPid(fixture);
    if (pid !== null) killWindowsDaemonTree(pid);
  }
  let gracefulAt = Date.now() + 2_000;
  const forceAt = Date.now() + 4_000;
  await waitForDaemonExit({
    pid: () => pid,
    deadline,
    alive: (value) => processAlive(value),
    endpointExists: () => existsSync(endpoint),
    onStalled: () => {
      if (pid === null && process.platform === "win32") pid = windowsDaemonPid(fixture);
      if (pid === null) return;
      const now = Date.now();
      if (now >= forceAt) terminate(pid, true);
      else if (now >= gracefulAt) {
        terminate(pid, false);
        gracefulAt = Number.POSITIVE_INFINITY;
      }
    },
  });
}

function terminate(pid: number, force: boolean): void {
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    // A process that exited between the probe and the signal is already the desired state.
  }
}

function killWindowsDaemonTree(pid: number): void {
  if (process.platform !== "win32") return;
  try {
    const query =
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
      'if ($p) { $pp = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"; ' +
      "if ($pp -and $pp.Name -eq 'powershell.exe') { [Console]::Out.Write($pp.ProcessId) } }";
    const parent = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", query], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    if (parent) execFileSync("taskkill", ["/PID", parent, "/T", "/F"], { stdio: "ignore", timeout: 5_000 });
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 5_000 });
  } catch {
    // The bounded wait below reports a daemon that refused to exit; taskkill on an already
    // exited pid is the only expected failure here.
  }
}

function windowsDaemonPid(fixture: Fixture): number | null {
  if (process.platform !== "win32") return null;
  const output = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -like '*--user-root ${fixture.userRoot}*' -and $_.CommandLine -like '*--daemon-id ${fixture.daemonId}*' } | Select-Object -First 1 -ExpandProperty ProcessId`,
    ],
    { encoding: "utf8", timeout: 5_000 },
  ).trim();
  const pid = Number(output);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function setup(index: number): Fixture {
  const parent = mkdtempSync(path.join(tmpdir(), `ha-cli-stress-${index}-`)),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    daemonId = `cli-stress-${index}`,
    repoId = `cli-stress-repo-${index}`;
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "README.md"), "# CLI lifecycle stress fixture\n");
  writeFileSync(path.join(root, "harness/harness.yaml"), "layout:\n  authoredRoot: harness\n");
  realm.bind(userRoot);
  signInAt(userRoot, "owner");
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "CLI lifecycle stress");
  git(root, "config", "user.email", "cli-lifecycle-stress@example.test");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "fixture");
  seedSettingsEvent({ rootDir: root, repoId });
  return { parent, root, userRoot, daemonId, repoId, daemonPid: null };
}

function actorLabel(index: number): string {
  return index % 3 === 0 ? "codex-auto" : index % 3 === 1 ? "claude-auto" : "explicit-agent";
}

function actorEnvironment(fixture: Fixture, index: number, actor: string | null): NodeJS.ProcessEnv {
  const {
    HARNESS_ACTOR: _actor,
    HARNESS_DAEMON_ENDPOINT: _endpoint,
    HARNESS_DAEMON_REPO_ID: _repo,
    HARNESS_DAEMON_ID: _daemon,
    CLAUDE_CODE_SESSION_ID: _claude,
    CODEX_THREAD_ID: _thread,
    CODEX_SESSION_ID: _session,
    ...base
  } = process.env;
  const identity =
    actor === null
      ? {}
      : actor === "codex-auto"
        ? { CODEX_THREAD_ID: `codex-stress-${index}` }
        : actor === "claude-auto"
          ? { CLAUDE_CODE_SESSION_ID: `claude-stress-${index}` }
          : { HARNESS_ACTOR: actor.startsWith("agent:") ? actor : `agent:stress-${index}` };
  return {
    ...base,
    HOME: path.join(fixture.parent, "home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    HARNESS_DAEMON_USER_ROOT: fixture.userRoot,
    HARNESS_DAEMON_ID: fixture.daemonId,
    ...identity,
  };
}

function packagePathFor(packagePath: string, relative: string): string {
  return path.posix.join(packagePath.replaceAll(path.sep, "/"), relative);
}

function createArgs(taskId: string, title: string): readonly string[] {
  return [
    "task",
    "create",
    "--id",
    taskId,
    "--title",
    title,
    "--preset",
    "docs-task",
    "--vertical",
    "software/coding",
    "--kind",
    "docs",
    "--admin",
  ];
}

function facetState(receipt: Record<string, unknown>, facet: "git" | "worktree" | "projection"): string | null {
  const value = receipt[facet];
  return value !== null && typeof value === "object" ? ((value as { readonly state?: string }).state ?? null) : null;
}

function docScanRows(evidence: unknown): readonly { readonly path: string; readonly state: string }[] {
  const text = String(evidence ?? "");
  assert.match(text, /^doc-scan:/u);
  return (
    JSON.parse(text.slice("doc-scan:".length)) as {
      readonly rows: readonly { readonly path: string; readonly state: string }[];
    }
  ).rows;
}

async function waitForMaterializationFailure(
  fixture: Fixture,
): Promise<{ readonly status: number | null; readonly stdout: string; readonly receipt: Record<string, unknown> }> {
  const observed: string[] = [];
  let last = "",
    lastState = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await runResult(fixture, ["daemon", "status"], actorEnvironment(fixture, 0, null));
    last = result.stdout;
    const receipt = parseCliReceipt(result, "daemon status"),
      state = materializationState(receipt);
    if (lastState !== state) {
      observed.push(`attempt ${attempt}: ${state}`);
      lastState = state;
    }
    if (receipt.code === "materialization_failed") return { status: result.status, stdout: result.stdout, receipt };
    await delay(50);
  }
  throw new Error(
    `daemon status never reported a failed materialization; observed [${observed.join(", ")}]; last: ${last}`,
  );
}

// A poll iteration whose CLI died without printing a receipt must fail naming the command, exit
// status, and stderr — a bare JSON SyntaxError from JSON.parse names none of them.
function parseCliReceipt(result: RunResult, command: string): Record<string, unknown> {
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`${command} produced no receipt (exit ${result.status ?? "signal"}): ${result.stderr}`);
  }
}

type RepoStatusRow = {
  readonly repoId?: string;
  readonly state?: string;
  readonly materialization?: { readonly state?: string };
};

function repoRows(receipt: Record<string, unknown>): readonly RepoStatusRow[] {
  return Array.isArray(receipt.repos) ? (receipt.repos as readonly RepoStatusRow[]) : [];
}

function materializationState(receipt: Record<string, unknown>): string {
  const states = repoRows(receipt).map((repo) => repo.materialization?.state ?? "none");
  return states.length > 0 ? states.join("/") : "no-repos";
}

async function expectApplied(
  fixture: Fixture,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const result = await runResult(fixture, args, environment);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(receipt.outcome, "applied", result.stdout);
  return receipt;
}

// Writes return at durable acceptance; a test that reads Git or the worktree waits for the followers explicitly.
function published(
  fixture: Fixture,
  receipt: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
  wait = "git_verified,worktree_visible",
): Promise<Record<string, unknown>> {
  return expectApplied(
    fixture,
    ["receipt", "show", String(receipt.opId), "--wait", wait, "--timeout-ms", "5000"],
    environment,
  );
}

async function expectNoop(
  fixture: Fixture,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const result = await runResult(fixture, args, environment);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(receipt.outcome, "no_changes", result.stdout);
  return receipt;
}

function runResult(
  fixture: Fixture,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  input?: string,
  timeoutMs = 120_000,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--root", fixture.root, "--json", ...args], {
      cwd: fixture.root,
      env: environment,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI command timed out after ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export {
  assert,
  execFileSync,
  spawn,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  tmpdir,
  path,
  seedSettingsEvent,
  realizedTaskPlan,
  cli,
  clientCount,
  chainsPerClient,
  runClient,
  runChain,
  startClient,
  waitForAttached,
  stopClient,
  setup,
  actorLabel,
  actorEnvironment,
  packagePathFor,
  createArgs,
  facetState,
  docScanRows,
  waitForMaterializationFailure,
  parseCliReceipt,
  expectApplied,
  published,
  expectNoop,
  runResult,
  git,
  delay,
};
