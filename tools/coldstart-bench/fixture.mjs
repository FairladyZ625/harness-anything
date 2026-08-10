import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashBytes } from "./evidence.mjs";

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = realpathSync(path.resolve(moduleRoot, "../.."));
const cliDistEntryRelative = "packages/cli/dist/cli/src/index.js";
const cliSourceEntryRelative = "packages/cli/src/index.ts";
export const cliEntryRelative = existsSync(path.join(repositoryRoot, cliDistEntryRelative))
  ? cliDistEntryRelative
  : cliSourceEntryRelative;
export const cliEntry = path.join(repositoryRoot, cliEntryRelative);

export function createIsolatedFixture(seed) {
  assertNode24();
  if (!existsSync(cliEntry)) throw new Error(`CLI entry is missing: ${cliEntry}; run npm run build -w @harness-anything/cli or run from a source checkout`);
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-coldstart-bench-")));
  const sourceRoot = privateDirectory(path.join(base, "seed-repository"));
  const subjectRootCandidate = path.join(base, "subject-worktree");
  const home = privateDirectory(path.join(base, "home"));
  const daemonUserRoot = privateDirectory(path.join(base, "daemon-user"));
  const xdgRuntime = privateDirectory(path.join(base, "xdg-runtime"));
  const temp = privateDirectory(path.join(base, "tmp"));
  const gitEnv = isolatedGitEnvironment(home);

  requireSuccess(runProcess("git", ["init", "--initial-branch=main", sourceRoot], { cwd: sourceRoot, env: gitEnv }), "initialize seed repository");
  requireSuccess(runProcess("git", ["-C", sourceRoot, "config", "user.name", "Cold-start Bench"], { env: gitEnv }), "configure seed author name");
  requireSuccess(runProcess("git", ["-C", sourceRoot, "config", "user.email", "coldstart-bench@example.invalid"], { env: gitEnv }), "configure seed author email");
  writeFileSync(path.join(sourceRoot, "README.md"), "# Cold-start subject workspace\n", "utf8");
  requireSuccess(runProcess("git", ["-C", sourceRoot, "add", "README.md"], { env: gitEnv }), "stage seed repository");
  requireSuccess(runProcess("git", ["-C", sourceRoot, "commit", "-m", "test: seed cold-start subject"], { env: gitEnv }), "commit seed repository");
  const branch = `coldstart-subject-${process.pid}-${String(seed)}-${randomUUID().slice(0, 8)}`;
  requireSuccess(runProcess("git", ["-C", sourceRoot, "worktree", "add", "-b", branch, subjectRootCandidate, "HEAD"], { env: gitEnv }), "create subject worktree");
  const root = realpathSync(subjectRootCandidate);
  const daemonNamespace = `coldstart-bench-${process.pid}-${String(seed)}-${randomUUID().slice(0, 8)}`;
  const env = isolatedSubjectEnvironment({ home, daemonUserRoot, daemonNamespace, xdgRuntime, temp });
  const commonDir = runProcess("git", ["-C", root, "rev-parse", "--git-common-dir"], { env: gitEnv });
  requireSuccess(commonDir, "verify linked worktree");
  if (commonDir.stdout.trim() === ".git") throw new Error("subject workspace is a standalone repository, not a linked git worktree");
  if (daemonUserRoot.startsWith(`${root}${path.sep}`) || root.startsWith(`${daemonUserRoot}${path.sep}`)) {
    throw new Error("daemon namespace must be external to the subject worktree");
  }
  return { base, sourceRoot, root, home, daemonUserRoot, daemonNamespace, env, gitEnv, branch };
}

export function prepareFixture(fixture) {
  const records = [];
  const invoke = (label, args, options) => {
    const record = runCli(fixture, args, options);
    records.push({ label, ...record });
    if (record.exitCode !== 0 || !record.receiptOk) {
      throw new Error(`${label} failed: ${record.stdout}${record.stderr}`);
    }
    return record;
  };
  const initialized = invoke("init", ["init", "--name", "coldstart-bench"], { root: fixture.sourceRoot, cwd: fixture.sourceRoot });
  const manifestPath = deepString(initialized.receipt, "manifestPath")
    ?? path.join(fixture.daemonUserRoot, "authority-service-state/authority-production.json");
  invoke("daemon-register", ["daemon", "repo", "register", "--root", fixture.sourceRoot, "--user-root", fixture.daemonUserRoot], { root: fixture.sourceRoot, cwd: fixture.sourceRoot });
  invoke("daemon-start", ["daemon", "start", "--service", "--user-root", fixture.daemonUserRoot, "--authority-manifest", manifestPath], { root: fixture.sourceRoot, cwd: fixture.sourceRoot, timeoutMs: 30_000 });
  const evaluatorFiles = scanWorkspaceForEvaluatorFiles(fixture.root);
  if (evaluatorFiles.length > 0) throw new Error(`subject workspace contains evaluator material: ${evaluatorFiles.join(", ")}`);
  return {
    schema: "coldstart-bench-fixture-setup/v1",
    workspaceKind: "git-worktree",
    daemonNamespace: fixture.daemonNamespace,
    daemonUserRootExternal: !fixture.daemonUserRoot.startsWith(`${fixture.root}${path.sep}`),
    evaluatorFiles,
    records
  };
}

export function runCli(fixture, args, options = {}) {
  const argv = [cliEntry, ...(options.root ? ["--root", options.root] : []), "--json", ...args];
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, argv, {
    cwd: options.cwd ?? fixture.root,
    env: fixture.env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: 32 * 1024 * 1024
  });
  const finishedAt = new Date().toISOString();
  const receipt = parseJson(result.stdout);
  return {
    argv: args,
    commandLine: renderCommand(args, options.root),
    startedAt,
    finishedAt,
    exitCode: result.status,
    signal: result.signal,
    receiptOk: receipt?.ok === true,
    receiptSchema: typeof receipt?.schema === "string" ? receipt.schema : null,
    stdout: result.stdout,
    stderr: result.stderr,
    processError: result.error?.message ?? null,
    receipt
  };
}

export function runSubjectPlan(fixture, subjectScript) {
  const result = spawnSync(process.execPath, [subjectScript], {
    cwd: fixture.root,
    env: fixture.env,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(`scripted subject failed: ${result.stdout}${result.stderr}`);
  const plan = parseJson(result.stdout);
  if (plan?.schema !== "coldstart-bench-subject-actions/v1" || plan.actionLogComplete !== true || !Array.isArray(plan.actions) || plan.actions.length === 0) {
    throw new Error("scripted subject must emit a complete coldstart-bench-subject-actions/v1 document");
  }
  for (const action of plan.actions) validateSubjectAction(action);
  return { ...plan, rawStdout: result.stdout, rawStderr: result.stderr };
}

export function captureDurableState(fixture, taskId) {
  const shown = runCli(fixture, ["task", "show", taskId]);
  const tasksRoot = path.join(fixture.sourceRoot, "harness", "tasks");
  const packageName = existsSync(tasksRoot)
    ? readdirSync(tasksRoot).find((entry) => entry === taskId || entry.startsWith(`${taskId}-`))
    : undefined;
  const packagePath = packageName ? path.join(tasksRoot, packageName) : null;
  const indexPath = packagePath ? path.join(packagePath, "INDEX.md") : null;
  const indexBody = indexPath && existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  const persistedTaskId = /^task_id:\s*(\S+)$/mu.exec(indexBody)?.[1] ?? null;
  const persistedStatus = /^\s{2}status:\s*(\S+)$/mu.exec(indexBody)?.[1] ?? null;
  return {
    schema: "coldstart-bench-durable-state/v1",
    capturedAt: new Date().toISOString(),
    task: {
      taskId: persistedTaskId,
      status: persistedStatus,
      packagePath: packageName ? path.join("harness", "tasks", packageName) : null,
      indexHash: indexBody ? hashBytes(indexBody) : null,
      taskShowReceiptOk: shown.receiptOk,
      taskShowTaskId: deepString(shown.receipt, "taskId")
    },
    checks: [
      {
        id: "task-package-present",
        status: packagePath && existsSync(packagePath) ? "passed" : "failed",
        detail: packagePath ? `task package found at ${path.relative(fixture.sourceRoot, packagePath)}` : "task package was not found"
      },
      {
        id: "task-id-readback",
        status: persistedTaskId === taskId && deepString(shown.receipt, "taskId") === taskId ? "passed" : "failed",
        detail: `expected ${taskId}; INDEX=${String(persistedTaskId)}; task-show=${String(deepString(shown.receipt, "taskId"))}`
      },
      {
        id: "task-status-planned",
        status: persistedStatus === "planned" ? "passed" : "failed",
        detail: `INDEX lifecycle status is ${String(persistedStatus)}`
      }
    ]
  };
}

export function collectRuntimeEventSummary(fixture) {
  const eventFiles = listFiles(fixture.sourceRoot).filter((file) => file.split(path.sep).includes("runtime-events") && file.endsWith(".jsonl"));
  const files = eventFiles.map((file) => {
    const body = readFileSync(file, "utf8");
    const lines = body.split(/\r?\n/u).filter(Boolean);
    let parseErrors = 0;
    for (const line of lines) {
      try {
        JSON.parse(line);
      } catch {
        parseErrors += 1;
      }
    }
    return {
      path: path.relative(fixture.sourceRoot, file),
      sha256: hashBytes(body),
      records: lines.length,
      parseErrors
    };
  });
  return {
    schema: "coldstart-bench-runtime-events-ancillary/v1",
    role: "ancillary-only",
    totalFiles: files.length,
    totalRecords: files.reduce((total, file) => total + file.records, 0),
    parseErrors: files.reduce((total, file) => total + file.parseErrors, 0),
    files
  };
}

export function evaluatorPaths() {
  return listFiles(moduleRoot).map((file) => realpathSync(file));
}

export function sourceMetadata() {
  const commit = runProcess("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { env: process.env });
  const status = runProcess("git", ["-C", repositoryRoot, "status", "--porcelain"], { env: process.env });
  requireSuccess(commit, "read source commit");
  requireSuccess(status, "read source dirty state");
  return { sourceCommit: commit.stdout.trim(), sourceDirty: status.stdout.trim().length > 0 };
}

export function cleanupFixture(fixture) {
  const errors = [];
  const stopped = runCli(
    fixture,
    ["daemon", "stop", "--timeout-ms", "10000", "--user-root", fixture.daemonUserRoot],
    { root: fixture.sourceRoot, cwd: fixture.sourceRoot, timeoutMs: 20_000 }
  );
  const daemonStopped = stopped.exitCode === 0;
  if (!daemonStopped) errors.push(`daemon stop failed: ${stopped.stderr || stopped.stdout}`.trim());
  const removed = runProcess("git", ["-C", fixture.sourceRoot, "worktree", "remove", "--force", fixture.root], { env: fixture.gitEnv });
  const worktreeRemoved = removed.status === 0 && !existsSync(fixture.root);
  if (!worktreeRemoved) errors.push(`git worktree removal failed: ${removed.stderr || removed.stdout}`.trim());
  if (!fixture.base.startsWith(`${realpathSync(tmpdir())}${path.sep}ha-coldstart-bench-`)) {
    errors.push(`refused unsafe fixture cleanup: ${fixture.base}`);
    return { daemonStopped, worktreeRemoved, baseRemoved: false, errors };
  }
  rmSync(fixture.base, { recursive: true, force: true });
  const baseRemoved = !existsSync(fixture.base);
  if (!baseRemoved) errors.push(`fixture base remains: ${fixture.base}`);
  return { daemonStopped, worktreeRemoved, baseRemoved, errors };
}

function isolatedSubjectEnvironment({ home, daemonUserRoot, daemonNamespace, xdgRuntime, temp }) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    USERPROFILE: home,
    HARNESS_USER_HOME: home,
    XDG_RUNTIME_DIR: xdgRuntime,
    TMPDIR: temp,
    LANG: process.env.LANG ?? "C.UTF-8",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    HARNESS_ACTOR: "agent:codex",
    HARNESS_GIT_AUTHOR_NAME: "Cold-start Subject",
    HARNESS_GIT_AUTHOR_EMAIL: "coldstart-subject@example.invalid",
    GIT_AUTHOR_NAME: "Cold-start Subject",
    GIT_AUTHOR_EMAIL: "coldstart-subject@example.invalid",
    GIT_COMMITTER_NAME: "Cold-start Subject",
    GIT_COMMITTER_EMAIL: "coldstart-subject@example.invalid",
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_PROFILE: "isolated",
    HARNESS_DAEMON_USER_ROOT: daemonUserRoot,
    HARNESS_DAEMON_ID: daemonNamespace,
    HARNESS_BOOTSTRAP_AUTHORITY: "1",
    HARNESS_AUTHORITY_MANIFEST: "",
    HARNESS_AUTHORED_ROOT: "",
    HARNESS_DAEMON_REPO_ID: "",
    HARNESS_DIRECT_WRITE_REASON: "",
    HARNESS_CLI_TEST_FIXTURE_PRELOAD: "",
    HARNESS_DAEMON_IDLE_MS: "0",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000",
    HARNESS_DAEMON_MATERIALIZER_POLL_MS: "3600000",
    NODE_OPTIONS: "",
    CODEX_THREAD_ID: "coldstart-scripted-subject",
    CODEX_SESSION_ID: "coldstart-scripted-subject"
  };
}

function isolatedGitEnvironment(home) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_AUTHOR_NAME: "Cold-start Bench",
    GIT_AUTHOR_EMAIL: "coldstart-bench@example.invalid",
    GIT_COMMITTER_NAME: "Cold-start Bench",
    GIT_COMMITTER_EMAIL: "coldstart-bench@example.invalid"
  };
}

function scanWorkspaceForEvaluatorFiles(root) {
  const forbidden = /(?:^|\/)(?:evaluator|scorer|subject-logs|coldstart-bench)(?:\/|$)|(?:bench-metrics|coldstart-bench-report|report-sol-quality-arch|RESEARCH\.md)/iu;
  return listFiles(root)
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .filter((relative) => forbidden.test(relative));
}

function validateSubjectAction(action) {
  if (!action || typeof action !== "object" || typeof action.id !== "string" || typeof action.kind !== "string") {
    throw new Error("every subject action must have string id and kind fields");
  }
  if (action.kind === "cli" && (!Array.isArray(action.argv) || action.argv.some((arg) => typeof arg !== "string"))) {
    throw new Error(`CLI action ${action.id} must provide string argv entries`);
  }
}

function listFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  };
  visit(root);
  return files;
}

function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error(`fixture directory may not be a symlink: ${directory}`);
  return realpathSync(directory);
}

function runProcess(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024
  });
}

function requireSuccess(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stdout}${result.stderr}${result.error?.message ?? ""}`);
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

function deepString(root, key) {
  const queue = [root];
  const seen = new Set();
  while (queue.length > 0) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (typeof value[key] === "string" && value[key].length > 0) return value[key];
    for (const child of Object.values(value)) if (child && typeof child === "object") queue.push(child);
  }
  return null;
}

function renderCommand(args, root) {
  return ["ha", ...(root ? ["--root", root] : []), ...args]
    .map((arg) => /^[A-Za-z0-9_./:@=-]+$/u.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`)
    .join(" ");
}

function assertNode24() {
  if (Number.parseInt(process.versions.node.split(".")[0], 10) !== 24) throw new Error(`Node 24 is required; received ${process.version}`);
}
