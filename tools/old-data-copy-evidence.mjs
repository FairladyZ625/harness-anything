#!/usr/bin/env node
// One command for the data-migration review's real old-data copy evidence: copy the live
// canonical ledger to a temp workspace, attach an isolated daemon from a chosen build, read
// through the build's own production functions, cold-rebuild the projection from zero, and
// print one pasteable JSON receipt. The canonical daemon and canonical data are never opened
// for writing; the only reads of canonical are APFS clones and sqlite3 .backup source handles.
//   node tools/old-data-copy-evidence.mjs [--source <repo-root>] [--build <worktree|sha>]
//        [--out <dir>] [--keep] [--reuse-workspace <ws>] [--attach-timeout-ms <ms>]
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  cpSync,
  rmSync,
  readdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ID = "canonical";
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
    reuseWorkspace: option("--reuse-workspace"),
    attachTimeoutMs: Number(option("--attach-timeout-ms") ?? 900_000),
  };
  if (!Number.isInteger(args.attachTimeoutMs) || args.attachTimeoutMs < 1000)
    throw new Error("--attach-timeout-ms must be an integer >= 1000");
  return args;
}

/** The source workspace holding the real old data: --source, else the main checkout that owns
 *  this worktree (git-common-dir's parent), so a worker in any worktree needs no extra flags. */
export function resolveSourceRoot(explicit, cwd = repoRoot) {
  if (explicit) return path.resolve(explicit);
  const common = runText("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  return path.resolve(path.dirname(common.trim()));
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
  env.HARNESS_WRITER_READY_WATCHDOG_MS = "600000";
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

function runText(command, args, cwd, env) {
  const result = spawnSync(command, args, { encoding: "utf8", cwd, env });
  if (result.status !== 0 || result.error)
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`,
    );
  return result.stdout;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

/** Snapshot the source repository into the workspace. Consistency order: projection caches
 *  first, ledger last, so the copied projection watermark can never be ahead of the copied
 *  ledger (the attach guard rejects exactly that state). */
function snapshotRepository(sourceRoot, workspace) {
  const storeGenerations = path.join(sourceRoot, ".harness", "store", "generations");
  if (!existsSync(storeGenerations)) throw new Error(`no .harness/store/generations under ${sourceRoot}`);
  const generation = activeGeneration(storeGenerations);
  mkdirSync(workspace, { recursive: true });
  const steps = [];
  const harnessSource = path.join(sourceRoot, "harness");
  if (existsSync(harnessSource)) {
    runText("git", ["clone", "--quiet", harnessSource, path.join(workspace, "harness")]);
    steps.push({ item: "harness", method: "git local clone" });
  }
  mkdirSync(path.join(workspace, ".harness", "store"), { recursive: true });
  const clone = process.platform === "darwin" ? ["cp", "-cR"] : ["cp", "-a"];
  spawnSyncOrThrow(...clone, storeGenerations, path.join(workspace, ".harness", "store", "generations"));
  // The APFS clone carries the live ledger's main file plus stale -wal/-shm; replace that trio
  // with one self-contained sqlite3 .backup taken from the live source.
  const sourceLedger = path.join(storeGenerations, generation, "ledger.sqlite"),
    copiedLedger = path.join(workspace, ".harness", "store", "generations", generation, "ledger.sqlite");
  rmSync(copiedLedger, { force: true, maxRetries: 5, retryDelay: 20 });
  rmSync(`${copiedLedger}-wal`, { force: true });
  rmSync(`${copiedLedger}-shm`, { force: true });
  steps.push({
    item: `store/generations/${generation} objects and retired generations`,
    method: process.platform === "darwin" ? "APFS clone" : "cp -a",
  });

  const sourceCache = path.join(sourceRoot, ".harness", "cache");
  if (existsSync(sourceCache)) {
    mkdirSync(path.join(workspace, ".harness", "cache"), { recursive: true });
    for (const name of ["task.sqlite", "projections.sqlite"]) {
      const file = path.join(sourceCache, name);
      if (!existsSync(file)) continue;
      sqliteBackup(file, path.join(workspace, ".harness", "cache", name));
      steps.push({ item: `cache/${name}`, method: "VACUUM INTO (before ledger)" });
    }
  }
  sqliteBackup(sourceLedger, copiedLedger);
  steps.push({ item: `store/generations/${generation}/ledger.sqlite`, method: "VACUUM INTO (after caches)" });
  for (const dir of HARNESS_COPY_DIRS) {
    const from = path.join(sourceRoot, ".harness", dir);
    if (existsSync(from)) {
      cpSync(from, path.join(workspace, ".harness", dir), { recursive: true });
      steps.push({ item: dir, method: "copy" });
    }
  }
  for (const name of HARNESS_COPY_FILES) {
    const from = path.join(sourceRoot, ".harness", name);
    if (existsSync(from)) {
      copyFileSync(from, path.join(workspace, ".harness", name));
      steps.push({ item: name, method: "copy" });
    }
  }
  return {
    generation,
    steps,
    excluded: [
      "restore-drills",
      "operations",
      "runtime",
      "requests",
      "replica",
      "recovery",
      "credentials",
      "store/imports",
      "store/retired",
      "cache/completion-conversion-verification.sqlite",
    ],
  };
}

/** The same snapshot technique the kernel's own ledger backup uses (ledger-backup.ts
 *  vacuumSqlite): read-only open of the live database, VACUUM INTO a fresh self-contained
 *  file. No sqlite3 CLI dependency — the isolated test hosts do not ship the binary. */
function sqliteBackup(from, to) {
  const sqlTarget = to.replace(/'/gu, "''");
  const code =
    `const { DatabaseSync } = require("node:sqlite");\n` +
    `const db = new DatabaseSync(process.argv[1], { readOnly: true });\n` +
    `try { db.exec("VACUUM INTO '" + ${JSON.stringify(sqlTarget)} + "'"); } finally { db.close(); }\n`;
  runText(process.execPath, ["-e", code, from]);
}

function spawnSyncOrThrow(command, ...args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
}

function resolveBuild(buildArg, tempRoot) {
  if (!buildArg) return { root: repoRoot, requested: "<invoking checkout>", createdWorktree: false };
  if (existsSync(buildArg)) return { root: path.resolve(buildArg), requested: buildArg, createdWorktree: false };
  const sha = runText("git", ["-C", repoRoot, "rev-parse", "--verify", `${buildArg}^{commit}`], repoRoot).trim();
  const checkout = path.join(tempRoot, "build-checkout");
  runText("git", ["-C", repoRoot, "worktree", "add", "--detach", "--quiet", checkout, sha], repoRoot);
  return { root: checkout, requested: buildArg, resolvedSha: sha, createdWorktree: true };
}

function ensureDaemonDist(buildRoot) {
  const steps = [];
  if (!existsSync(path.join(buildRoot, "node_modules"))) {
    runText("npm", ["ci"], buildRoot);
    steps.push("npm ci");
  }
  if (!existsSync(path.join(buildRoot, "packages", "daemon", "dist", "index.js"))) {
    runText("npm", ["run", "build", "--workspace", "@harness-anything/daemon"], buildRoot);
    steps.push("npm run build --workspace @harness-anything/daemon");
  }
  return steps;
}

/** The forensic env strips HARNESS_DAEMON_USER_ROOT (a worker injection), so EVERY CLI call
 *  must name the isolated daemon explicitly — without the flags the CLI resolves the default
 *  ~/.harness endpoint and talks to a socket that does not exist. */
function cli(buildRoot, args, env, workspaceRoot, identity) {
  const entry = path.join(buildRoot, "packages", "cli", "src", "index.ts");
  const result = spawnSync(
    process.execPath,
    [
      entry,
      "--root",
      workspaceRoot,
      "--json",
      ...args,
      "--user-root",
      identity.userRoot,
      "--daemon-id",
      identity.daemonId,
    ],
    {
      encoding: "utf8",
      env,
      cwd: workspaceRoot,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    receipt: parseLastJsonObject(result.stdout ?? ""),
  };
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
 *  realpath of the workspace (/var -> /private/var on macOS), so both spellings match. */
function awaitAttach(userRoot, daemonId, workspace, pid, timeoutMs, sampleDaemonRss) {
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
    sleepSync(500);
  }
}

function awaitDaemonDown(pid, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) sleepSync(500);
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
  const { readTaskDispatches } = await import(toUrl(path.join(BUILD_ROOT, "packages/daemon/src/dispatch-read.ts")));
  const store = kernel.makeTaskEventReader({ repoId: REPO_ID, rootDir: WORKSPACE });
  record("store-head", store.readHead() ?? null);
  projection = kernel.makeTaskProjection({ rootDir: WORKSPACE, eventStore: store, catchUpLimit: 32 });
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

function runDirectEvidence(buildRoot, workspace, tempRoot, env) {
  const outFile = path.join(tempRoot, "logs", "direct-evidence.jsonl");
  const runnerPath = path.join(tempRoot, "direct-evidence-runner.mjs");
  writeFileSync(
    runnerPath,
    `const OUT_FILE = ${JSON.stringify(outFile)};\nconst BUILD_ROOT = ${JSON.stringify(buildRoot)};\nconst WORKSPACE = ${JSON.stringify(workspace)};\nconst REPO_ID = ${JSON.stringify(REPO_ID)};\n` +
      DIRECT_RUNNER,
    "utf8",
  );
  const timeBinary = existsSync("/usr/bin/time") ? "/usr/bin/time" : null;
  const command = timeBinary ?? process.execPath;
  const args = timeBinary ? [process.platform === "darwin" ? "-l" : "-v", process.execPath, runnerPath] : [runnerPath];
  const result = spawnSync(command, args, { encoding: "utf8", env, cwd: tempRoot, maxBuffer: 64 * 1024 * 1024 });
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

export async function main(argv) {
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
    source: { root: sourceRoot, repository: REPO_ID },
    build: null,
    copy: null,
    attach: null,
    reads: null,
    coldRebuild: null,
    peakRss: null,
    failures: [],
  };
  let createdWorktree = null;
  let daemonStopReceipt = null;
  let daemonHandle = null;
  const env = forensicEnv(process.env);
  // Any error between start and the in-flow stop must not leak a detached daemon holding a
  // socket inside the temp root we are about to delete.
  const stopDaemonBestEffort = () => {
    if (daemonHandle === null || !processAlive(daemonHandle.pid)) return;
    try {
      const stopped = cli(daemonHandle.buildRoot, ["daemon", "stop"], env, daemonHandle.workspace, daemonHandle);
      if (daemonStopReceipt === null) daemonStopReceipt = stopped.receipt;
    } catch {
      // The finally block reports the leftover pid; nothing here may mask the primary failure.
    }
    awaitDaemonDown(daemonHandle.pid);
  };
  try {
    // 1. Build resolution and daemon dist.
    const build = resolveBuild(args.build, tempRoot);
    createdWorktree = build.createdWorktree ? { root: build.root, sha: build.resolvedSha } : null;
    const buildSteps = ensureDaemonDist(build.root);
    // 2. Snapshot (or reuse a kept workspace for negative-control arms on the same copy).
    let workspace;
    if (args.reuseWorkspace) {
      workspace = path.resolve(args.reuseWorkspace);
      if (!existsSync(path.join(workspace, ".harness", "store")))
        throw new Error(`--reuse-workspace has no .harness/store: ${workspace}`);
      receipt.copy = { reused: args.reuseWorkspace, sourceRevision: null };
    } else {
      workspace = path.join(tempRoot, "ws");
      receipt.copy = { reused: null, ...snapshotRepository(sourceRoot, workspace) };
    }
    if (!path.resolve(workspace).startsWith(path.resolve(tmpdir())))
      throw new Error(`workspace must live under the system temp dir, got ${workspace}`);
    receipt.build = {
      requested: build.requested,
      root: build.root,
      createdWorktree: build.createdWorktree,
      prepared: buildSteps,
    };
    // 3. Isolated daemon: fresh user root and daemon id hash to their own socket, so the
    //    production daemon's endpoint namespace is untouched by construction.
    const started = cli(build.root, ["daemon", "start", "--service"], env, workspace, { userRoot, daemonId });
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
    const pid = started.receipt.pid;
    daemonHandle = { pid, userRoot, daemonId, buildRoot: build.root, workspace };
    let daemonPeakRss = processRssBytes(pid) ?? 0;
    const sampleDaemonRss = () => {
      const rss = processRssBytes(pid);
      if (rss !== null && rss > daemonPeakRss) daemonPeakRss = rss;
    };
    // 4. Register the copy; attach is the daemon's own opening path.
    const registered = cli(
      build.root,
      ["daemon", "repo", "register", "--repo-id", REPO_ID, "--root", workspace],
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
    const awaited = awaitAttach(userRoot, daemonId, workspace, pid, args.attachTimeoutMs, sampleDaemonRss);
    const status = cli(build.root, ["daemon", "status"], env, workspace, { userRoot, daemonId });
    writeFileSync(path.join(tempRoot, "logs", "daemon-status.txt"), status.stdout + status.stderr, "utf8");
    const repoStatus = (status.receipt?.repos ?? [])[0] ?? null;
    receipt.attach = {
      outcome: awaited.outcome,
      record: awaited.record ?? null,
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
    // 5. Stop the daemon before the direct phase so the cold rebuild owns its SQLite locks.
    const stopped = cli(build.root, ["daemon", "stop"], env, workspace, { userRoot, daemonId });
    daemonStopReceipt = stopped.receipt;
    if (awaitDaemonDown(pid)) daemonHandle = null;
    // 6. Direct reads and full cold rebuild through the build's own production functions.
    const direct = runDirectEvidence(build.root, workspace, tempRoot, env);
    const byStep = new Map(direct.steps.map((step) => [step.step, step]));
    receipt.reads = {
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
    stopDaemonBestEffort();
    if (createdWorktree) {
      try {
        runText("git", ["-C", repoRoot, "worktree", "remove", "--force", createdWorktree.root], repoRoot);
        runText("git", ["-C", repoRoot, "worktree", "prune"], repoRoot);
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

// Node resolves the invoked entry through realpath (the isolated test snapshot reaches this
// file through symlinks), so both sides are compared after realpath or a symlinked invocation
// would silently skip main and exit 0.
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  process.on("SIGINT", () => {
    throw new Error("interrupted");
  });
  process.exitCode = await main(process.argv.slice(2));
}
