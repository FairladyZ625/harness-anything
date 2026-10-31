#!/usr/bin/env node
// One command for the data-migration review's real old-data copy evidence: copy the live
// canonical ledger to a temp workspace, attach an isolated daemon from a chosen build, read
// through the build's own production functions, cold-rebuild the projection from zero, and
// print one pasteable JSON receipt. The canonical daemon and canonical data are never opened
// for writing; the only reads of canonical are APFS clones and sqlite3 .backup source handles.
// The loaded build must be stamped with the checkout's HEAD (a stale dist is rebuilt, and a
// daemon whose commit differs from its loaded dist is recorded as a failure, so the receipt
// can never attribute evidence to a build that did not run). SIGINT/SIGTERM at any stage stop
// the isolated daemon, delete the temp copy, and exit non-zero without printing a receipt.
//   node tools/old-data-copy-evidence.mjs [--source <repo-root>] [--build <worktree|sha>]
//        [--out <dir>] [--keep] [--reuse-workspace <ws>] [--cold-attach] [--attach-timeout-ms <ms>]
//        [--medium-submit]
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  renameSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveHarnessLayout } from "../packages/kernel/src/layout/index.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Derived dirs that attach and the cold rebuild never open; copying them is how earlier
// hand-rolled runs walked into a 28G restore-drills copy.
const HARNESS_COPY_DIRS = ["wal", "generated", "presets"];
const HARNESS_COPY_FILES = ["settings.local.json"];
const TERMINAL_ATTACH_EVENTS = new Set([
  "repo_attach_completed",
  "repo_attach_failed",
  "repo_attach_timed_out",
  "repo_attach_discarded",
]);

export function parseArgs(argv) {
  const option = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const args = {
    source: option("--source"),
    build: option("--build"),
    out: option("--out"),
    keep: argv.includes("--keep"),
    mediumSubmit: argv.includes("--medium-submit"),
    reuseWorkspace: option("--reuse-workspace"),
    coldAttach: argv.includes("--cold-attach"),
    attachTimeoutMs: Number(option("--attach-timeout-ms") ?? 900_000),
  };
  if (!Number.isInteger(args.attachTimeoutMs) || args.attachTimeoutMs < 1000)
    throw new Error("--attach-timeout-ms must be an integer >= 1000");
  return args;
}

/** The source workspace holding the real old data: --source, else the main checkout that owns
 *  this worktree (git-common-dir's parent), so a worker in any worktree needs no extra flags.
 *  Stays synchronous: it resolves before the temp root exists, so there is nothing to
 *  interrupt and nothing to clean up. */
export function resolveSourceRoot(explicit, cwd = repoRoot) {
  if (explicit) return path.resolve(explicit);
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  });
  if (result.status !== 0 || result.error)
    throw new Error(
      `git rev-parse --git-common-dir failed under ${cwd}: ${result.stderr ?? ""}${result.error?.message ?? ""}`,
    );
  return path.resolve(path.dirname(result.stdout.trim()));
}

/** Everything a dispatched worker carries that must not reach an isolated forensic daemon:
 *  all HARNESS_* injections plus provider/runtime session keys (CEO ruling 2026-10-22 22:40 —
 *  local identity is the sanctioned way to attach a temporary copy). */
export function forensicEnv(base) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith("HARNESS_")) continue;
    if (
      [
        "CODEX_HOME",
        "CLAUDE_CONFIG_DIR",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "CLAUDE_CODE_SESSION_ID",
        "CODEX_THREAD_ID",
        "CODEX_SESSION_ID",
      ].includes(key)
    )
      continue;
    env[key] = value;
  }
  // Same heap ceiling the production daemon runs with; without it a full-ledger attach dies
  // with ERR_WORKER_OUT_OF_MEMORY (task_e37fdc67 first-run evidence, 2026-10-22).
  env.NODE_OPTIONS = "--max-old-space-size=8192";
  // Tie the forensic daemon to this script's lifetime: even a crash between start and stop
  // cannot leak a detached daemon holding a socket inside the temp root.
  env.HARNESS_DAEMON_OWNER_PID = String(process.pid);
  return env;
}

/** The daemon's JSON receipts can be preceded by plain-text progress lines; take the last
 *  top-level JSON object printed. */
export function parseLastJsonObject(text) {
  for (const line of text.trim().split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      continue;
    }
  }
  return null;
}

export function parsePeakRssBytes(timeStderr, platform = process.platform) {
  // darwin /usr/bin/time -l puts the byte count before the label; GNU time -v puts kbytes after it.
  const match =
    platform === "darwin"
      ? timeStderr.match(/(\d+)\s+maximum resident set size/u)
      : timeStderr.match(/Maximum resident set size \(kbytes\):\s+(\d+)/u);
  if (!match) return null;
  return Number(match[1]) * (platform === "darwin" ? 1 : 1024);
}

/** Tree-copy flags: clone blocks instead of rewriting them wherever the filesystem supports it
 *  (APFS clonefile on darwin, reflink on linux filesystems that have it). */
export function copyTreeArgs(platform = process.platform) {
  if (platform === "darwin") return ["-cR"];
  if (platform === "linux") return ["-a", "--reflink=auto"];
  return ["-a"];
}

export function copyTreeMethod(platform = process.platform) {
  return copyTreeArgs(platform).join(" ");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every long-running child runs here as a tracked, detached process group. Node cannot run a
// JS signal handler while it blocks inside spawnSync/Atomics.wait, so a signal arriving during
// an npm ci or a multi-gigabyte copy would otherwise sit unprocessed until the child finished
// on its own — and a throw from the old-style handler never reached the finally block. With
// tracked async children the event loop stays free between steps, the interrupt handler kills
// whole child groups immediately, and cleanup always runs.
const liveChildren = new Set();

function killChildTree(child) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

async function run(command, args, options = {}) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    liveChildren.add(child);
    let stdout = "",
      stderr = "",
      settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      liveChildren.delete(child);
      resolve({ ...result, stdout, stderr });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => finish({ status: null, error: error.message }));
    child.on("close", (status, signal) => finish({ status, signal, error: null }));
  });
}

async function runText(command, args, cwd, env) {
  const result = await run(command, args, { cwd, env });
  if (result.status !== 0 || result.error)
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}${result.error ?? ""}`,
    );
  return result.stdout;
}

/** Generations 1 and 2 are offline conversion inputs and can still carry activation files of
 *  their own; ordinary readers and writers only ever open generation 3 (kernel
 *  resolveActiveGeneration), so the live ledger to snapshot is exactly that one. */
function activeGeneration(sourceGenerations) {
  const generation = "3",
    ledger = path.join(sourceGenerations, generation, "ledger.sqlite");
  if (!existsSync(ledger))
    throw new Error(
      `no active generation-3 ledger at ${ledger} (generations present: ${readdirSync(sourceGenerations).join(", ") || "none"})`,
    );
  return generation;
}

/** Where the source repository's own `harness.yaml` says its local ledger lives. Deriving this
 *  (instead of hardcoding `.harness`) is what lets the command serve a repository that renamed
 *  `layout.localRoot`: the copy must receive the data under the same relative root the copy's own
 *  config resolves to, or attach would open an empty ledger next to untouched data and print a
 *  meaningless green receipt. `--source` may name the project root or anything inside it; the
 *  config's project root is authoritative, and a source with no discoverable config is refused
 *  rather than defaulted — defaulting is the exact bug this command exists to avoid. */
export function copyLayout(sourceRoot) {
  const requested = path.resolve(sourceRoot),
    layout = resolveHarnessLayout(requested),
    projectRoot = layout.rootDir;
  if (layout.configPath === undefined)
    throw new Error(
      `no harness.yaml found for --source ${requested} (searched up to ${projectRoot}); ` +
        `pass the repository root that owns its layout`,
    );
  const relative = (target) => path.relative(projectRoot, target).split(path.sep).join("/");
  return {
    requested,
    projectRoot,
    localRoot: layout.localRoot,
    localRootRelative: relative(layout.localRoot),
    configPath: layout.configPath,
    configRelative: relative(layout.configPath),
  };
}

/** The ledger's own identity, read from the generation-3 activation certificate the store wrote.
 *  A copy registered under any other id is a different repository to the attach path: the
 *  certificate's repoId is checked against the registered one and attach fails closed with
 *  "generation 3 activation certificate differs". The copy therefore has to keep the identity it
 *  was written with — the id a node happens to use is not part of the data being reviewed. */
export function copyRepoId(sourceRoot) {
  const layout = copyLayout(sourceRoot),
    certificate = `${path.join(layout.localRoot, "store", "generations", "3", "ledger.sqlite")}.activation.json`;
  if (!existsSync(certificate))
    throw new Error(`no generation-3 activation certificate at ${certificate}; the ledger would not attach`);
  let value;
  try {
    value = JSON.parse(readFileSync(certificate, "utf8"));
  } catch (error) {
    throw new Error(`${certificate} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof value?.repoId !== "string" || value.repoId.length === 0)
    throw new Error(`${certificate} carries no repoId`);
  return {
    repoId: value.repoId,
    certificate,
    // The cut the certificate was published with; the live head is read from the store later.
    activationRevision: value.acceptedCut?.revision ?? null,
  };
}

/** A harness sub-repository in the copy serves exactly two consumers: `resolveHarnessLayout`
 *  reads the working-tree `harness.yaml` (the live config is copied verbatim below, uncommitted
 *  values included), and the daemon's ledger probes run `git rev-parse`/`config`/hook writes
 *  inside the repository. Neither opens a tracked source file, so the clone transfers objects
 *  without materializing the authored tree — the checkout was 1.92 GB and 17-21 s of every
 *  snapshot (cow-compare.md §5), all of it unread. */
export function harnessCloneArgs(sourceRoot, targetRoot) {
  return ["clone", "--quiet", "--no-checkout", sourceRoot, targetRoot];
}

export async function snapshotRepository(sourceRoot, workspace) {
  const layout = copyLayout(sourceRoot),
    sourceProjectRoot = layout.projectRoot,
    sourceLocalRoot = layout.localRoot,
    workspaceLocalRoot = path.join(workspace, ...layout.localRootRelative.split("/")),
    storeGenerations = path.join(sourceLocalRoot, "store", "generations");
  if (!existsSync(storeGenerations))
    throw new Error(`no ${layout.localRootRelative}/store/generations under ${sourceProjectRoot}`);
  const generation = activeGeneration(storeGenerations);
  mkdirSync(workspace, { recursive: true });
  const steps = [];
  const harnessSource = path.join(sourceProjectRoot, "harness");
  if (existsSync(harnessSource)) {
    await runText("git", harnessCloneArgs(harnessSource, path.join(workspace, "harness")));
    steps.push({ item: "harness", method: "git local clone --no-checkout (no working tree)" });
  }
  // The clone carries committed state only, but the live daemon resolves the config from the
  // working tree. A repository whose localRoot rename is not committed yet (the motivating
  // shape) would otherwise get data under the renamed root and a config naming the old one:
  // attach would then create an empty ledger and the receipt would be green about nothing.
  if (layout.configPath !== undefined && layout.configRelative !== undefined) {
    const target = path.join(workspace, ...layout.configRelative.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(layout.configPath, target);
    steps.push({ item: layout.configRelative, method: "live working-tree copy (may be uncommitted)" });
  }
  const placed = copyLayout(workspace);
  if (placed.localRoot !== workspaceLocalRoot)
    throw new Error(
      `copied config resolves localRoot to ${placed.localRoot}, but the snapshot placed data at ${workspaceLocalRoot}`,
    );
  mkdirSync(path.join(workspaceLocalRoot, "store"), { recursive: true });
  // Cache cuts precede the ledger snapshot, and the object tree follows it. Content objects
  // are immutable once written, so every object referenced by the captured ledger exists
  // before the object clone starts. Reversing these two snapshots can capture a new event but
  // miss the blob it names when a writer commits during the multi-minute tree clone.
  const sourceCache = path.join(sourceLocalRoot, "cache");
  if (existsSync(sourceCache)) {
    mkdirSync(path.join(workspaceLocalRoot, "cache"), { recursive: true });
    for (const name of ["task.sqlite", "projections.sqlite"]) {
      const file = path.join(sourceCache, name);
      if (!existsSync(file)) continue;
      await snapshotCacheDatabase(file, path.join(workspaceLocalRoot, "cache", name), steps);
    }
  }

  const sourceLedger = path.join(storeGenerations, generation, "ledger.sqlite"),
    copiedGenerations = path.join(workspaceLocalRoot, "store", "generations"),
    copiedLedger = path.join(copiedGenerations, generation, "ledger.sqlite"),
    ledgerSnapshot = path.join(workspace, ".ledger-snapshot.sqlite");
  await sqliteBackup(sourceLedger, ledgerSnapshot);
  steps.push({ item: `store/generations/${generation}/ledger.sqlite`, method: "VACUUM INTO before object clone" });

  await runText("cp", [...copyTreeArgs(), storeGenerations, copiedGenerations]);
  // The clone carries the live ledger's main file plus stale -wal/-shm; replace that trio
  // with the earlier self-contained snapshot so the event cut and object tree are coherent.
  rmSync(copiedLedger, { force: true, maxRetries: 5, retryDelay: 20 });
  rmSync(`${copiedLedger}-wal`, { force: true });
  rmSync(`${copiedLedger}-shm`, { force: true });
  renameSync(ledgerSnapshot, copiedLedger);
  steps.push({ item: `store/generations/${generation} objects and retired generations`, method: copyTreeMethod() });
  for (const dir of HARNESS_COPY_DIRS) {
    const from = path.join(sourceLocalRoot, dir);
    if (existsSync(from)) {
      await runText("cp", [...copyTreeArgs(), from, path.join(workspaceLocalRoot, dir)]);
      steps.push({ item: dir, method: copyTreeMethod() });
    }
  }
  for (const name of HARNESS_COPY_FILES) {
    const from = path.join(sourceLocalRoot, name);
    if (existsSync(from)) {
      copyFileSync(from, path.join(workspaceLocalRoot, name));
      steps.push({ item: name, method: "copy" });
    }
  }
  return {
    generation,
    localRootRelative: layout.localRootRelative,
    configRelative: layout.configRelative,
    steps,
    excluded: [
      "restore-drills",
      "operations",
      "runtime",
      "requests",
      "replica",
      "recovery",
      "credentials",
      ".harness (default root, never read when localRoot names another directory)",
      "store/imports",
      "store/retired",
      "cache/completion-conversion-verification.sqlite",
    ],
  };
}

/** Cache databases are derived state, so they take the cheap block clone instead of a full
 *  VACUUM rewrite. A block clone of a live WAL pair can still be torn at block granularity,
 *  and the projection readers rethrow corruption they do not recognize — so recovery is forced
 *  on the copy (checkpoint) and verified; a torn copy is discarded rather than trusted, which
 *  only costs attach a catch-up from the ledger. The -shm sidecar is a live shared-memory
 *  index and is never copied; every sqlite open rebuilds it. */
async function snapshotCacheDatabase(sourceFile, targetFile, steps) {
  const sources = [sourceFile, `${sourceFile}-wal`].filter((candidate) => existsSync(candidate));
  await runText("cp", [...copyTreeArgs(), ...sources, path.dirname(targetFile)]);
  const recovered = await run(process.execPath, ["-e", CHECKPOINT_CLONE, targetFile], {
    cwd: path.dirname(targetFile),
  });
  const healthy = recovered.status === 0 && (recovered.stdout ?? "").trim() === "ok";
  if (healthy) {
    steps.push({
      item: path
        .relative(path.dirname(path.dirname(targetFile)), targetFile)
        .split(path.sep)
        .join("/"),
      method: `${copyTreeMethod()} + checkpoint`,
    });
    return;
  }
  rmSync(targetFile, { force: true, maxRetries: 5, retryDelay: 20 });
  rmSync(`${targetFile}-wal`, { force: true });
  rmSync(`${targetFile}-shm`, { force: true });
  steps.push({
    item: path
      .relative(path.dirname(path.dirname(targetFile)), targetFile)
      .split(path.sep)
      .join("/"),
    method: `${copyTreeMethod()} (torn clone discarded; attach will catch up)`,
    discarded: true,
    raw: `${recovered.stdout ?? ""}${recovered.stderr ?? ""}`.trim(),
  });
}

const CHECKPOINT_CLONE = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
try {
  db.exec("PRAGMA busy_timeout = 10000; PRAGMA wal_checkpoint(TRUNCATE)");
  const check = db.prepare("PRAGMA quick_check").get();
  if (String(check?.quick_check ?? "") !== "ok") throw new Error("quick_check: " + JSON.stringify(check));
  console.log("ok");
} finally { db.close(); }
`;

/** The same snapshot technique the kernel's own ledger backup uses (ledger-backup.ts
 *  vacuumSqlite): read-only open of the live database, VACUUM INTO a fresh self-contained
 *  file. No sqlite3 CLI dependency — the isolated test hosts do not ship the binary. */
async function sqliteBackup(from, to) {
  const sqlTarget = to.replace(/'/gu, "''");
  const code =
    `const { DatabaseSync } = require("node:sqlite");\n` +
    `const db = new DatabaseSync(process.argv[1], { readOnly: true });\n` +
    `try { db.exec("VACUUM INTO '" + ${JSON.stringify(sqlTarget)} + "'"); } finally { db.close(); }\n`;
  await runText(process.execPath, ["-e", code, from]);
}

async function resolveBuild(buildArg, tempRoot) {
  if (!buildArg) return { root: repoRoot, requested: "<invoking checkout>", createdWorktree: false };
  if (existsSync(buildArg)) return { root: path.resolve(buildArg), requested: buildArg, createdWorktree: false };
  const sha = (
    await runText("git", ["-C", repoRoot, "rev-parse", "--verify", `${buildArg}^{commit}`], repoRoot)
  ).trim();
  const checkout = path.join(tempRoot, "build-checkout");
  await runText("git", ["-C", repoRoot, "worktree", "add", "--detach", "--quiet", checkout, sha], repoRoot);
  return { root: checkout, requested: buildArg, resolvedSha: sha, createdWorktree: true };
}

function readMarkerOrNull(markerPath) {
  if (!existsSync(markerPath)) return null;
  const value = readFileSync(markerPath, "utf8").trim();
  return value || null;
}

function headCommitOrNull(buildRoot) {
  const result = spawnSync("git", ["-C", buildRoot, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" });
  const value = result.status === 0 ? result.stdout.trim() : null;
  return value || null;
}

/** Pure decision half of dist provisioning, so the trust table is testable without a build:
 *  whenever the checkout names a commit, the daemon dist must be stamped with that same commit,
 *  and a dist left behind by an older HEAD — the normal state of a worktree after a rebase — is
 *  rebuilt, never trusted. Tests must exercise this as the pure function, never by poisoning a
 *  real checkout's marker: daemons concurrently running from that dist exit for build
 *  supersession (the invariant smoke-identity.integration.test.mjs asserts). */
export function planDaemonDistSteps({ nodeModules, distEntry, head, marker }) {
  const steps = [];
  if (!nodeModules) steps.push({ command: "npm", args: ["ci"] });
  if (!distEntry || (head !== null && marker !== head))
    steps.push({ command: "npm", args: ["run", "build", "--workspace", "@harness-anything/daemon"] });
  return steps;
}

async function ensureDaemonDist(buildRoot) {
  const head = headCommitOrNull(buildRoot);
  const plan = planDaemonDistSteps({
    nodeModules: existsSync(path.join(buildRoot, "node_modules")),
    distEntry: existsSync(path.join(buildRoot, "packages", "daemon", "dist", "index.js")),
    head,
    marker: readMarkerOrNull(path.join(buildRoot, "packages", "daemon", "dist", "build-id.txt")),
  });
  for (const step of plan) await runText(step.command, step.args, buildRoot);
  return { steps: plan.map((step) => [step.command, ...step.args].join(" ")), head };
}

/** The forensic env strips worker injections, so every CLI call restores the isolated daemon
 *  target explicitly instead of resolving the default ~/.harness endpoint. */
export function cliInvocation(buildRoot, args, env, workspaceRoot, identity) {
  return {
    command: process.execPath,
    args: [path.join(buildRoot, "packages", "cli", "src", "index.ts"), "--root", workspaceRoot, "--json", ...args],
    // User-root is a daemon-control flag, not a global task-command option. Keep the isolated
    // endpoint explicit through the supported environment contract while selecting the daemon
    // ID on each invocation.
    options: {
      env: {
        ...env,
        HARNESS_DAEMON_USER_ROOT: identity.userRoot,
        HARNESS_DAEMON_ID: identity.daemonId,
      },
      cwd: workspaceRoot,
    },
  };
}

function interpretCli(result) {
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    receipt: parseLastJsonObject(result.stdout ?? ""),
  };
}

async function cli(buildRoot, args, env, workspaceRoot, identity) {
  const invocation = cliInvocation(buildRoot, args, env, workspaceRoot, identity);
  return interpretCli(await run(invocation.command, invocation.args, invocation.options));
}

function requireAppliedCli(result, phase) {
  if (result.status !== 0 || !["applied", "no_changes"].includes(result.receipt?.outcome))
    throw new Error(`${phase} failed: ${result.stdout}${result.stderr}`);
  return result.receipt;
}

function taskShowPayload(receipt, phase) {
  if (typeof receipt.evidence !== "string") throw new Error(`${phase} returned no task-show evidence`);
  try {
    return JSON.parse(receipt.evidence);
  } catch (error) {
    throw new Error(`${phase} returned invalid task-show evidence: ${String(error)}`);
  }
}

async function createAndSubmitMediumEvidenceTask(buildRoot, workspace, env, identity) {
  const title = `Medium risk-tier evidence task_${randomBytes(12).toString("hex")}`,
    created = requireAppliedCli(
      await cli(
        buildRoot,
        [
          "task",
          "create",
          "--title",
          title,
          "--kind",
          "test",
          "--risk-tier",
          "medium",
          "--preset",
          "docs-task",
          "--locale",
          "en-US",
        ],
        env,
        workspace,
        identity,
      ),
      "medium task create",
    ),
    createPayload = taskShowPayload(created, "medium task create"),
    taskId = createPayload.taskId;
  if (typeof taskId !== "string" || !/^task_[A-Za-z0-9_-]+$/u.test(taskId))
    throw new Error(`medium task create returned an invalid task id: ${String(taskId)}`);
  const createdPayload = taskShowPayload(
      requireAppliedCli(await cli(buildRoot, ["task", "show", taskId], env, workspace, identity), "created task show"),
      "created task show",
    ),
    packagePath = createdPayload.packagePath;
  if (typeof packagePath !== "string" || !/^tasks\/[A-Za-z0-9_-]+$/u.test(packagePath))
    throw new Error(`medium task has an invalid package path: ${String(packagePath)}`);
  const packageRoot = path.join(workspace, "harness", packagePath),
    artifactRelative = `${packagePath}/artifacts/medium-submit-evidence.md`,
    artifactPath = path.join(workspace, "harness", artifactRelative),
    closeoutPath = path.join(packageRoot, "closeout.md");
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(
    artifactPath,
    `# Medium submit evidence\n\nTemporary-copy probe for ${taskId}; no repository source files were changed.\n`,
    "utf8",
  );
  writeFileSync(
    closeoutPath,
    `# Closeout\n\n## Summary\n\nSubmitted an isolated medium-tier evidence task in the copied ledger.\n\n## Verification\n\nThe task submit receipt must contain a task-risk-tier-assessment/v1 assessment with declared and effective tier medium.\n`,
    "utf8",
  );
  const started = requireAppliedCli(
      await cli(buildRoot, ["task", "start", taskId], env, workspace, identity),
      "medium task start",
    ),
    synced = requireAppliedCli(
      await cli(
        buildRoot,
        [
          "doc",
          "sync",
          "--submit",
          "--task",
          taskId,
          "--path",
          `harness/${packagePath}/closeout.md`,
          "--path",
          `harness/${artifactRelative}`,
        ],
        env,
        workspace,
        identity,
      ),
      "medium task document sync",
    ),
    submitted = requireAppliedCli(
      await cli(buildRoot, ["task", "submit", taskId], env, workspace, identity),
      "medium task submit",
    ),
    shown = requireAppliedCli(
      await cli(buildRoot, ["task", "show", taskId], env, workspace, identity),
      "submitted task show",
    ),
    task = taskShowPayload(shown, "submitted task show"),
    execution = Array.isArray(task.executions)
      ? task.executions.find((candidate) => candidate && typeof candidate === "object" && candidate.submission)
      : null,
    assessment = execution?.submission?.riskTierAssessment;
  if (assessment?.schema !== "task-risk-tier-assessment/v1" || assessment.declaredTier !== "medium")
    throw new Error(
      `medium task show did not contain the expected submission assessment: ${JSON.stringify(assessment)}`,
    );
  return {
    taskId,
    executionId: execution.executionId ?? null,
    packagePath,
    create: created,
    start: started,
    documentSync: synced,
    submit: submitted,
    taskShow: shown,
    riskTierAssessment: assessment,
  };
}

/** Sync twin for the interrupt path only: the signal handler must stop the daemon before the
 *  temp root goes away and cannot await. */
function cliSync(buildRoot, args, env, workspaceRoot, identity) {
  const invocation = cliInvocation(buildRoot, args, env, workspaceRoot, identity);
  const result = spawnSync(invocation.command, invocation.args, { ...invocation.options, encoding: "utf8" });
  return interpretCli(result);
}

function daemonLifecyclePath(userRoot, daemonId) {
  const safe = daemonId.replace(/[^A-Za-z0-9_.-]/gu, "-");
  return path.join(userRoot, "logs", `daemon-${safe}-lifecycle.jsonl`);
}

function readLifecycle(pathname) {
  if (!existsSync(pathname)) return [];
  return readFileSync(pathname, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((record) => record !== null);
}

function processRssBytes(pid) {
  const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  const value = Number((result.stdout ?? "").trim());
  return Number.isFinite(value) && value > 0 ? value * 1024 : null;
}

function processAlive(pid) {
  return processRssBytes(pid) !== null;
}

/** Wait until the lifecycle log carries a terminal attach record for this workspace, the
 *  daemon pid dies, or the deadline passes. Monotonic: elapsed time; terminal signal: the
 *  daemon's own lifecycle records, never a fixed sleep count. The daemon records the
 *  realpath of the workspace (/var -> /private/var on macOS), so both spellings match.
 *  The wait uses real async sleeps so the event loop — and with it the interrupt handler —
 *  stays responsive for the whole (default 15-minute) attach budget. */
async function awaitAttach(userRoot, daemonId, workspace, pid, timeoutMs, sampleDaemonRss) {
  const lifecycle = daemonLifecyclePath(userRoot, daemonId);
  const spellings = new Set([path.resolve(workspace), realpathSync.native(workspace)]);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    sampleDaemonRss();
    const terminal = readLifecycle(lifecycle).find(
      (record) => TERMINAL_ATTACH_EVENTS.has(record.event) && spellings.has(path.resolve(String(record.rootDir ?? ""))),
    );
    if (terminal) return { outcome: "terminal-record", record: terminal };
    if (!processAlive(pid)) return { outcome: "daemon-exited" };
    if (Date.now() > deadline) return { outcome: "timeout" };
    await sleep(500);
  }
}

async function awaitDaemonDown(pid, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) await sleep(500);
  return !processAlive(pid);
}

/** Sync twin with a tighter cap for the interrupt path: it must not sit in an uninterruptible
 *  wait; if the daemon ignores a clean stop it is left to the owner-pid watchdog. */
function awaitDaemonDownSync(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  return !processAlive(pid);
}

const DIRECT_RUNNER = String.raw`
const { appendFileSync } = await import("node:fs");
const path = await import("node:path");
const { pathToFileURL } = await import("node:url");
const toUrl = (p) => pathToFileURL(path.resolve(p)).href;
const record = (step, value) => {
  const line = JSON.stringify({ step, at: new Date().toISOString(), value });
  appendFileSync(OUT_FILE, line + "\n");
  console.log(line);
};
let projection = null;
try {
  const kernel = await import(toUrl(path.join(BUILD_ROOT, "packages/kernel/src/index.ts")));
  const storage = await import(toUrl(path.join(BUILD_ROOT, "packages/storage/src/index.ts")));
  const { readTaskDispatches } = await import(toUrl(path.join(BUILD_ROOT, "packages/daemon/src/dispatch-read.ts")));
  // Record the root the build itself resolves, so the receipt shows the data it read is the data
  // the copy actually holds — not an empty default directory next to it.
  const layout = kernel.resolveHarnessLayout(WORKSPACE);
  record("layout", {
    localRoot: layout.localRoot,
    localRootRelative: path.relative(WORKSPACE, layout.localRoot).split(path.sep).join("/"),
    configPath: layout.configPath ?? null,
    taskProjectionPath: layout.taskProjectionPath,
  });
  const store = storage.makeTaskEventReader({ repoId: REPO_ID, rootDir: WORKSPACE });
  record("store-head", store.readHead() ?? null);
  projection = storage.makeTaskProjection({ rootDir: WORKSPACE, eventStore: store, catchUpLimit: 32 });
  record("attach-catch-up", projection.catchUp?.() ?? "async-only");
  const index = projection.readTaskIndex({ limit: 5 });
  const rows = index.rows ?? [];
  record("task-index", { count: rows.length, first: rows.map((row) => ({ taskId: row.taskId, title: row.title ?? null })) });
  if (rows.length > 0) {
    const dispatches = readTaskDispatches({ projection, rootDir: WORKSPACE, taskId: rows[0].taskId });
    const dispatchRows = dispatches.rows ?? [];
    record("task-dispatches", { taskId: rows[0].taskId, count: dispatches.length ?? dispatchRows.length, sample: dispatchRows.slice(0, 3).map((row) => ({ dispatchId: row.dispatchId, outcome: row.outcome ?? null })) });
  }
  record("event-read", store.queryEvents({ limit: 3 }).map((event) => ({ schema: event.schema, type: event.type, revision: event.workspaceRevision })));
  const startedAt = Date.now();
  const rebuilt = projection.rebuild();
  const sourceRevision = store.readHead()?.revision ?? 0;
  record("cold-rebuild-receipt", {
    watermark: rebuilt.watermark,
    sourceRevision,
    stateDigest: rebuilt.stateDigest,
    metrics: rebuilt.metrics,
    elapsedMs: Date.now() - startedAt,
  });
  const after = projection.readTaskIndex({ limit: 5 });
  record("post-rebuild-task-index", { count: (after.rows ?? []).length, watermark: rebuilt.watermark });
} catch (error) {
  record("fatal", { message: String(error instanceof Error ? error.message : error), stack: error instanceof Error ? (error.stack ?? null) : null });
  process.exitCode = 1;
} finally {
  try {
    projection?.close?.();
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
  }
}
`;

async function runDirectEvidence(buildRoot, workspace, tempRoot, env, repoId) {
  const outFile = path.join(tempRoot, "logs", "direct-evidence.jsonl");
  const runnerPath = path.join(tempRoot, "direct-evidence-runner.mjs");
  writeFileSync(
    runnerPath,
    `const OUT_FILE = ${JSON.stringify(outFile)};\nconst BUILD_ROOT = ${JSON.stringify(buildRoot)};\nconst WORKSPACE = ${JSON.stringify(workspace)};\nconst REPO_ID = ${JSON.stringify(repoId)};\n` +
      DIRECT_RUNNER,
    "utf8",
  );
  const timeBinary = existsSync("/usr/bin/time") ? "/usr/bin/time" : null;
  const command = timeBinary ?? process.execPath;
  const args = timeBinary ? [process.platform === "darwin" ? "-l" : "-v", process.execPath, runnerPath] : [runnerPath];
  const result = await run(command, args, { env, cwd: tempRoot });
  const steps = existsSync(outFile)
    ? readFileSync(outFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  return {
    status: result.status,
    steps,
    peakRssBytes: timeBinary ? parsePeakRssBytes(result.stderr ?? "") : null,
    stderr: result.stderr ?? "",
  };
}

function boundedRm(target) {
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(tmpdir()))) throw new Error(`refusing to remove outside tmpdir: ${resolved}`);
  rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

export async function main(argv, session = {}) {
  const args = parseArgs(argv);
  const sourceRoot = resolveSourceRoot(args.source);
  const label = `ha-oldcopy-${randomBytes(4).toString("hex")}`;
  const tempRoot = mkdtempSync(path.join(tmpdir(), `${label}-`));
  const daemonId = `oldcopy-${randomBytes(4).toString("hex")}`;
  const userRoot = path.join(tempRoot, "user-root");
  mkdirSync(path.join(tempRoot, "logs"), { recursive: true });
  const receipt = {
    schema: "old-data-copy-evidence/v1",
    at: new Date().toISOString(),
    ok: false,
    source: { root: sourceRoot, repository: null, identity: null },
    build: null,
    copy: null,
    attach: null,
    reads: null,
    coldRebuild: null,
    mediumSubmission: null,
    peakRss: null,
    failures: [],
  };
  let createdWorktree = null;
  let daemonStopReceipt = null;
  let daemonHandle = null;
  const env = forensicEnv(process.env);
  session.tempRoot = tempRoot;
  session.keep = args.keep;
  session.env = env;
  session.daemonHandle = null;
  session.createdWorktree = null;
  // Any error between start and the in-flow stop must not leak a detached daemon holding a
  // socket inside the temp root we are about to delete.
  const stopDaemonBestEffort = async () => {
    if (daemonHandle === null || !processAlive(daemonHandle.pid)) return;
    try {
      const stopped = await cli(daemonHandle.buildRoot, ["daemon", "stop"], env, daemonHandle.workspace, daemonHandle);
      if (daemonStopReceipt === null) daemonStopReceipt = stopped.receipt;
    } catch {
      // The finally block reports the leftover pid; nothing here may mask the primary failure.
    }
    await awaitDaemonDown(daemonHandle.pid);
  };
  try {
    // 1. Build resolution and daemon dist. A stale dist (older HEAD than the checkout) is
    //    rebuilt here, before anything can run it.
    const build = await resolveBuild(args.build, tempRoot);
    createdWorktree = build.createdWorktree ? { root: build.root, sha: build.resolvedSha } : null;
    session.createdWorktree = createdWorktree;
    const { steps: buildSteps, head } = await ensureDaemonDist(build.root);
    // 2. Snapshot (or reuse a kept workspace for negative-control arms on the same copy). The
    //    copy keeps the ledger's own identity: registering it under a different id makes attach
    //    reject the copy's activation certificate, which would be a fact about the harness's
    //    registry, not about the data under review.
    let workspace;
    if (args.reuseWorkspace) {
      workspace = path.resolve(args.reuseWorkspace);
      const reused = copyLayout(workspace);
      if (!existsSync(path.join(reused.localRoot, "store")))
        throw new Error(`--reuse-workspace has no ${reused.localRootRelative}/store: ${workspace}`);
      receipt.copy = { reused: args.reuseWorkspace, sourceRevision: null, localRootRelative: reused.localRootRelative };
    } else {
      workspace = path.join(tempRoot, "ws");
      receipt.copy = { reused: null, ...(await snapshotRepository(sourceRoot, workspace)) };
    }
    const identity = copyRepoId(workspace);
    receipt.source.repository = identity.repoId;
    receipt.source.identity = {
      certificate: path.relative(workspace, identity.certificate).split(path.sep).join("/"),
      activationRevision: identity.activationRevision,
    };
    if (!path.resolve(workspace).startsWith(path.resolve(tmpdir())))
      throw new Error(`workspace must live under the system temp dir, got ${workspace}`);
    if (args.coldAttach) {
      const projectionPath = path.join(copyLayout(workspace).localRoot, "cache", "task.sqlite");
      for (const suffix of ["", "-wal", "-shm"])
        rmSync(`${projectionPath}${suffix}`, { force: true, maxRetries: 5, retryDelay: 20 });
      receipt.copy.coldAttach = true;
      receipt.copy.steps ??= [];
      receipt.copy.steps.push({
        item: "cache/task.sqlite",
        method: "removed before attach for cold projection",
        discarded: true,
      });
    }
    receipt.build = {
      requested: build.requested,
      root: build.root,
      createdWorktree: build.createdWorktree,
      headCommit: head,
      prepared: buildSteps,
    };
    // 3. Isolated daemon: fresh user root and daemon id hash to their own socket, so the
    //    production daemon's endpoint namespace is untouched by construction.
    const started = await cli(build.root, ["daemon", "start", "--service"], env, workspace, { userRoot, daemonId });
    writeFileSync(path.join(tempRoot, "logs", "daemon-start.txt"), started.stdout + started.stderr, "utf8");
    if (!started.receipt?.ok) {
      receipt.failures.push({ phase: "daemon-start", raw: started.stdout + started.stderr });
      throw new Error("daemon start failed; see failures[0].raw");
    }
    // The start receipt carries entry ("dist"/"source") at its top level and the build ids
    // inside .build; both belong in the evidence receipt's build section.
    receipt.build = {
      ...receipt.build,
      ...started.receipt.build,
      entry: started.receipt.entry,
      pid: started.receipt.pid,
      daemonId,
    };
    // The invariant behind "the build the receipt names is the build that ran": the daemon's
    // own commit stamp and the loaded dist marker are two independent sources that must agree
    // no matter how the dist was provisioned. (Both are null/absent only in a tree with no git,
    // where there is nothing to compare.)
    if (
      typeof receipt.build.commit === "string" &&
      typeof receipt.build.loadedBuildId === "string" &&
      receipt.build.commit !== receipt.build.loadedBuildId
    )
      receipt.failures.push({
        phase: "build-identity",
        message: `daemon ran commit ${receipt.build.commit} but the loaded dist is ${receipt.build.loadedBuildId}`,
      });
    const pid = started.receipt.pid;
    daemonHandle = { pid, userRoot, daemonId, buildRoot: build.root, workspace };
    session.daemonHandle = daemonHandle;
    let daemonPeakRss = processRssBytes(pid) ?? 0;
    const sampleDaemonRss = () => {
      const rss = processRssBytes(pid);
      if (rss !== null && rss > daemonPeakRss) daemonPeakRss = rss;
    };
    // 4. Register the copy; attach is the daemon's own opening path.
    const registered = await cli(
      build.root,
      ["daemon", "repo", "register", "--repo-id", receipt.source.repository, "--root", workspace],
      env,
      workspace,
      { userRoot, daemonId },
    );
    writeFileSync(
      path.join(tempRoot, "logs", "daemon-repo-register.txt"),
      registered.stdout + registered.stderr,
      "utf8",
    );
    if (!registered.receipt?.ok) {
      receipt.failures.push({ phase: "daemon-repo-register", raw: registered.stdout + registered.stderr });
      throw new Error("daemon repo register failed; see failures[0].raw");
    }
    const awaited = await awaitAttach(userRoot, daemonId, workspace, pid, args.attachTimeoutMs, sampleDaemonRss);
    const status = await cli(build.root, ["daemon", "status"], env, workspace, { userRoot, daemonId });
    writeFileSync(path.join(tempRoot, "logs", "daemon-status.txt"), status.stdout + status.stderr, "utf8");
    const repoStatus = (status.receipt?.repos ?? [])[0] ?? null;
    // This daemon id is exclusive to the run, so every repo_attach_* record in its lifecycle
    // belongs to this workspace; intermediate records (a hit attach budget that later
    // completed, a discarded attempt) are evidence too, not noise.
    const history = readLifecycle(daemonLifecyclePath(userRoot, daemonId)).filter((record) =>
      String(record.event ?? "").startsWith("repo_attach"),
    );
    receipt.attach = {
      outcome: awaited.outcome,
      record: awaited.record ?? null,
      history,
      daemonStatusRepo: repoStatus,
      daemonPeakRssBytes: daemonPeakRss,
      daemonRssMethod: "ps -o rss= polled every 500ms",
    };
    if (awaited.outcome !== "terminal-record" || awaited.record.event !== "repo_attach_completed")
      receipt.failures.push({
        phase: "attach",
        outcome: awaited.outcome,
        record: awaited.record ?? null,
        daemonStatusRepo: repoStatus,
      });
    if (args.mediumSubmit) {
      try {
        receipt.mediumSubmission = await createAndSubmitMediumEvidenceTask(build.root, workspace, env, {
          userRoot,
          daemonId,
        });
      } catch (error) {
        // A fresh forensic user root has no Keycloak session. Preserve the exact refusal while
        // still collecting direct reads and cold-rebuild evidence from the same attached copy.
        receipt.failures.push({
          phase: "medium-submission",
          message: String(error instanceof Error ? error.message : error),
        });
      }
    }
    // 5. Stop the daemon before the direct phase so the cold rebuild owns its SQLite locks.
    const stopped = await cli(build.root, ["daemon", "stop"], env, workspace, { userRoot, daemonId });
    daemonStopReceipt = stopped.receipt;
    if (await awaitDaemonDown(pid)) daemonHandle = null;
    // 6. Direct reads and full cold rebuild through the build's own production functions.
    const direct = await runDirectEvidence(build.root, workspace, tempRoot, env, receipt.source.repository);
    const byStep = new Map(direct.steps.map((step) => [step.step, step]));
    const observedLayout = byStep.get("layout")?.value ?? null;
    receipt.reads = {
      layout: observedLayout,
      storeHead: byStep.get("store-head")?.value ?? null,
      catchUp: byStep.get("attach-catch-up")?.value ?? null,
      taskIndex: byStep.get("task-index")?.value ?? null,
      taskDispatches: byStep.get("task-dispatches")?.value ?? null,
      events: byStep.get("event-read")?.value ?? null,
    };
    receipt.coldRebuild = byStep.get("cold-rebuild-receipt")?.value ?? null;
    receipt.peakRss = {
      daemonBytes: daemonPeakRss,
      daemonMethod: "ps -o rss= polled every 500ms",
      rebuildBytes: direct.peakRssBytes,
      rebuildMethod: direct.peakRssBytes === null ? null : "/usr/bin/time maximum resident set size",
    };
    if (byStep.has("fatal")) receipt.failures.push({ phase: "direct-evidence", record: byStep.get("fatal").value });
    // The receipt must not be green about data the build never opened: if the build resolves a
    // different local root than the one the snapshot filled, the reads below came from an empty
    // directory and the run proves nothing.
    if (observedLayout !== null && observedLayout.localRootRelative !== receipt.copy.localRootRelative)
      receipt.failures.push({
        phase: "layout-mismatch",
        message: `build resolved localRoot ${observedLayout.localRootRelative}, snapshot filled ${receipt.copy.localRootRelative}`,
      });
    // The task's own invariant, measured on real data: a renamed local root must never make the
    // default `.harness` appear, not even as an empty directory created by the attach path. It is
    // only an invariant under a rename — the default layout owns `.harness` by definition.
    receipt.copy.defaultHarnessPresent = existsSync(path.join(workspace, ".harness"));
    if (receipt.copy.localRootRelative !== ".harness" && receipt.copy.defaultHarnessPresent)
      receipt.failures.push({ phase: "default-local-root", message: `${workspace}/.harness exists after attach` });
    const rebuild = receipt.coldRebuild;
    receipt.ok =
      receipt.failures.length === 0 &&
      receipt.attach?.outcome === "terminal-record" &&
      receipt.attach?.record?.event === "repo_attach_completed" &&
      rebuild !== null &&
      rebuild.watermark === rebuild.sourceRevision;
    receipt.copy.sourceRevision = receipt.reads.storeHead?.revision ?? rebuild?.sourceRevision ?? null;
  } catch (error) {
    receipt.failures.push({ phase: "orchestrator", message: String(error instanceof Error ? error.message : error) });
  } finally {
    await stopDaemonBestEffort();
    if (createdWorktree) {
      try {
        await runText("git", ["-C", repoRoot, "worktree", "remove", "--force", createdWorktree.root], repoRoot);
        await runText("git", ["-C", repoRoot, "worktree", "prune"], repoRoot);
      } catch (error) {
        receipt.failures.push({
          phase: "worktree-cleanup",
          message: String(error instanceof Error ? error.message : error),
        });
      }
    }
    receipt.cleanup = { kept: args.keep, tempRoot, daemonStopped: daemonStopReceipt?.ok === true };
  }
  // Raw evidence files move to --out before the temp root goes away; the receipt itself is
  // printed last so even a cleanup failure is part of it.
  if (args.out) {
    mkdirSync(path.resolve(args.out), { recursive: true });
    for (const name of ["daemon-start.txt", "daemon-repo-register.txt", "daemon-status.txt", "direct-evidence.jsonl"]) {
      const from = path.join(tempRoot, "logs", name);
      if (existsSync(from)) copyFileSync(from, path.join(args.out, name));
    }
    const lifecycle = daemonLifecyclePath(userRoot, daemonId);
    if (existsSync(lifecycle)) copyFileSync(lifecycle, path.join(args.out, "daemon-lifecycle.jsonl"));
  }
  if (!args.keep) {
    try {
      boundedRm(tempRoot);
    } catch (error) {
      receipt.failures.push({ phase: "temp-cleanup", message: String(error instanceof Error ? error.message : error) });
      receipt.ok = false;
    }
  } else console.error(`kept temp root: ${tempRoot}`);
  const receiptText = JSON.stringify(receipt, null, 2);
  console.log(receiptText);
  if (args.out) writeFileSync(path.join(args.out, "old-data-copy-evidence-receipt.json"), `${receiptText}\n`, "utf8");
  return receipt.ok ? 0 : 1;
}

/** The interrupt path owns the same cleanup contract as the normal exit, executed
 *  synchronously from the signal handler: kill tracked child groups first (they write into
 *  the temp root), stop the isolated daemon, release a temporary build worktree, delete the
 *  temp root, exit non-zero without printing a receipt. A signal before the temp root exists
 *  finds the session empty and just exits. */
function installInterruptHandlers(session) {
  let interrupted = false;
  const handler = (signal) => {
    const exitCode = signal === "SIGINT" ? 130 : 143;
    if (interrupted) process.exit(exitCode);
    interrupted = true;
    for (const child of liveChildren) killChildTree(child);
    const notes = [];
    const handle = session.daemonHandle;
    if (handle && processAlive(handle.pid)) {
      try {
        cliSync(handle.buildRoot, ["daemon", "stop"], session.env, handle.workspace, handle);
        if (awaitDaemonDownSync(handle.pid)) notes.push("daemon stopped");
        else notes.push(`daemon pid ${handle.pid} left to the owner-pid watchdog`);
      } catch {
        notes.push(`daemon pid ${handle.pid} left to the owner-pid watchdog`);
      }
    }
    if (session.createdWorktree) {
      try {
        spawnSync("git", ["-C", repoRoot, "worktree", "remove", "--force", session.createdWorktree.root]);
        spawnSync("git", ["-C", repoRoot, "worktree", "prune"]);
      } catch {
        notes.push(`build worktree left: ${session.createdWorktree.root}`);
      }
    }
    if (session.tempRoot) {
      try {
        boundedRm(session.tempRoot);
        notes.push(`temp root removed: ${session.tempRoot}`);
      } catch (error) {
        notes.push(`temp root removal failed: ${String(error instanceof Error ? error.message : error)}`);
      }
    }
    console.error(`interrupted by ${signal}: ${notes.join("; ")}`);
    process.exit(exitCode);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

// Node resolves the invoked entry through realpath (the isolated test snapshot reaches this
// file through symlinks), so both sides are compared after realpath or a symlinked invocation
// would silently skip main and exit 0.
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const session = {};
  installInterruptHandlers(session);
  process.exitCode = await main(process.argv.slice(2), session);
}
