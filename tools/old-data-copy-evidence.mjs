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
import { cp, copyFile } from "node:fs/promises";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  renameSync,
  realpathSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readDaemonRegistry } from "../packages/kernel/src/daemon/registry.ts";
import {
  INITIAL_SETTINGS_V1,
  localSettings,
  parseLocalSettings,
  serializeLocalSettings,
} from "../packages/kernel/src/domain/settings.ts";
import { nodeMaterializationPolicyForMode } from "../packages/kernel/src/domain/task-wip-policy.ts";
import { resolveHarnessLayout } from "../packages/kernel/src/layout/index.ts";
import { writeFileDurably } from "../packages/storage/src/durable-file.ts";
import { cmdShellInvocation } from "../packages/storage/src/store/cmd-command-line.ts";
import { locateFleetEdgeConfig } from "../packages/daemon/src/daemon-host/client/fleet-edge-config.ts";
import { materialize } from "./readonly-checkout.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Derived dirs that attach and the cold rebuild never open; copying them is how earlier
// hand-rolled runs walked into a 28G restore-drills copy.
const HARNESS_COPY_DIRS = ["wal", "generated", "presets"];
const HARNESS_COPY_FILES = ["settings.local.json"];
const MIN_ATTACH_TIMEOUT_MS = 1000;
const MAX_ATTACH_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1000;
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
    timeoutMs: Number(option("--timeout-ms") ?? DEFAULT_TIMEOUT_MS),
  };
  if (
    !Number.isInteger(args.attachTimeoutMs) ||
    args.attachTimeoutMs < MIN_ATTACH_TIMEOUT_MS ||
    args.attachTimeoutMs > MAX_ATTACH_TIMEOUT_MS
  )
    throw new Error(
      `--attach-timeout-ms must be an integer between ${MIN_ATTACH_TIMEOUT_MS} and ${MAX_ATTACH_TIMEOUT_MS}`,
    );
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < MIN_ATTACH_TIMEOUT_MS || args.timeoutMs > MAX_TIMEOUT_MS)
    throw new Error(`--timeout-ms must be an integer between ${MIN_ATTACH_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
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

function stripWorkerGitHooksFromPath(pathValue, platform = process.platform) {
  if (typeof pathValue !== "string" || pathValue.length === 0) return pathValue;
  const delimiter = platform === "win32" ? ";" : ":";
  return pathValue
    .split(delimiter)
    .filter((entry) => !/[\\/]tools[\\/]git-hooks[\\/]?$/iu.test(entry.trim()))
    .join(delimiter);
}

/** Everything a dispatched worker carries that must not reach an isolated forensic daemon:
 *  all HARNESS_* injections, the worker git-hooks PATH wrapper, plus provider/runtime session
 *  keys (CEO ruling 2026-10-22 22:40 — local identity is the sanctioned way to attach a
 *  temporary copy). */
export function forensicEnv(base, platform = process.platform) {
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
    if (key.toUpperCase() === "PATH" && typeof value === "string") {
      env[key] = stripWorkerGitHooksFromPath(value, platform);
      continue;
    }
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
  if (platform === "win32") return [];
  return ["-a"];
}

export function copyTreeMethod(platform = process.platform) {
  if (platform === "win32") return "node fs.cp recursive";
  return copyTreeArgs(platform).join(" ");
}

function joinCrossPlatform(baseDir, ...parts) {
  return baseDir.includes("\\") ? path.win32.join(baseDir, ...parts) : path.join(baseDir, ...parts);
}

function dirnameCrossPlatform(targetPath) {
  return targetPath.includes("\\") ? path.win32.dirname(targetPath) : path.dirname(targetPath);
}

function findWin32NpmEntry(environment, execPath) {
  const pathEnv = environment.PATH ?? environment.Path ?? "";
  for (const dir of pathEnv.split(";").filter(Boolean)) {
    const cliJs = joinCrossPlatform(dir, "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(cliJs)) return { kind: "node-script", scriptPath: cliJs };
    const cmdShim = joinCrossPlatform(dir, "npm.cmd");
    if (existsSync(cmdShim)) return { kind: "cmd-shim", cmdPath: cmdShim };
  }
  if (execPath) {
    const execDir = dirnameCrossPlatform(execPath);
    const besideNodeJs = joinCrossPlatform(execDir, "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(besideNodeJs)) return { kind: "node-script", scriptPath: besideNodeJs };
    const besideNodeCmd = joinCrossPlatform(execDir, "npm.cmd");
    if (existsSync(besideNodeCmd)) return { kind: "cmd-shim", cmdPath: besideNodeCmd };
  }
  return { kind: "cmd-shim", cmdPath: "npm.cmd" };
}

/** Resolve `npm` for the target platform: on Windows, prefer the co-located `npm-cli.js`
 *  entrypoint directly under `node.exe` (avoiding `.cmd` EINVAL and shell quoting entirely), or
 *  wrap an explicit `.cmd` shim with audited BatBadBut `cmd.exe` quoting. */
export function npmInvocation(
  args,
  platform = process.platform,
  environment = process.env,
  execPath = process.execPath,
) {
  if (platform !== "win32") return { command: "npm", args, windowsVerbatimArguments: false };
  const entry = findWin32NpmEntry(environment, execPath);
  if (entry.kind === "node-script") {
    return { command: execPath, args: [entry.scriptPath, ...args], windowsVerbatimArguments: false };
  }
  return cmdShellInvocation(entry.cmdPath, args, environment);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PROGRESS_INTERVAL_MS = 15_000;
const NATIVE_COPY_CONCURRENCY = 16;
const NATIVE_COPY_EXPAND_DEPTH = 4;

function reportProgress(message) {
  console.error(`[old-data-copy] ${message}`);
}

async function withProgressHeartbeat(label, operation, intervalMs = PROGRESS_INTERVAL_MS) {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    reportProgress(`${label} running (${elapsedSec}s elapsed)`);
  }, intervalMs);
  timer.unref?.();
  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
}

// Every long-running child runs here as a tracked, detached process group (or killed via taskkill
// /T /F on Windows). Node cannot run a JS signal handler while it blocks inside
// spawnSync/Atomics.wait, so a signal arriving during an npm ci or a multi-gigabyte copy would
// otherwise sit unprocessed until the child finished on its own — and a throw from the old-style
// handler never reached the finally block. With tracked async children the event loop stays free
// between steps, the interrupt handler kills whole child groups immediately, and cleanup always runs.
const liveChildren = new Set();

function killChildTree(child) {
  try {
    if (process.platform === "win32") {
      if (child.pid)
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      else child.kill();
      return;
    }
    if (child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Child already exited before tree termination ran.
    }
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

/** On a remote-edge mirror (registered as `remote-edge` with `<userRoot>/fleet/edge/<repoId>/fleet-edge.json`),
 *  the workspace's own `<localRoot>` carries no replicated ledger (or only an empty pre-sync shell); the live
 *  generation-3 ledger, content-addressed objects, and warm projection live inside `<viewRoot>/repos/<repoId>/views/<nodeId>`
 *  under the published `fleet-basebackup/v3` pointer (`current.json`). Resolve that store read-only
 *  without ever reading, copying, or logging the edge machine credential. */
export function resolveSourceDataRoot(
  sourceProjectRoot,
  localRoot,
  userRoot = process.env.HARNESS_DAEMON_USER_ROOT || path.join(homedir(), ".harness"),
) {
  const resolvedSource = existsSync(sourceProjectRoot)
      ? realpathSync(sourceProjectRoot)
      : path.resolve(sourceProjectRoot),
    edgeRepo = readDaemonRegistry({ userRoot }).repos.find(
      (repo) =>
        repo.mode === "remote-edge" &&
        repo.canonicalRoot !== null &&
        (existsSync(repo.canonicalRoot) ? realpathSync(repo.canonicalRoot) : path.resolve(repo.canonicalRoot)) ===
          resolvedSource,
    );
  if (!edgeRepo) return { dataLocalRoot: localRoot, replica: null };
  const edgeConfigPath = locateFleetEdgeConfig(userRoot, edgeRepo.repoId, resolvedSource);
  if (!edgeConfigPath) return { dataLocalRoot: localRoot, replica: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(edgeConfigPath, "utf8"));
  } catch (error) {
    throw new Error(
      `fleet-edge.json at ${edgeConfigPath} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const repoId = typeof parsed?.repoId === "string" && parsed.repoId.length > 0 ? parsed.repoId : null,
    nodeId = typeof parsed?.nodeId === "string" && parsed.nodeId.length > 0 ? parsed.nodeId : null,
    viewRootRel = typeof parsed?.viewRoot === "string" && parsed.viewRoot.length > 0 ? parsed.viewRoot : null;
  if (parsed?.schema !== "fleet-edge-config/v1" || !repoId || !nodeId || !viewRootRel)
    throw new Error(`fleet-edge.json at ${edgeConfigPath} is not a valid fleet-edge-config/v1`);
  const viewRoot = path.resolve(sourceProjectRoot, viewRootRel),
    viewDir = path.join(viewRoot, "repos", repoId, "views", nodeId),
    pointerPath = path.join(viewDir, "current.json");
  if (!existsSync(pointerPath))
    throw new Error(
      `remote-edge workspace ${sourceProjectRoot} has no published replica generation at ${pointerPath}; run ha daemon fleet edge sync first`,
    );
  let pointer;
  try {
    pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
  } catch (error) {
    throw new Error(
      `replica pointer at ${pointerPath} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const generationId = typeof pointer?.id === "string" && /^[A-Za-z0-9-]+$/u.test(pointer.id) ? pointer.id : null;
  if (!generationId || pointer?.metadata?.schema !== "fleet-basebackup/v3")
    throw new Error(`replica pointer at ${pointerPath} does not name an active fleet-basebackup/v3 generation`);
  const replicaLocalRoot = path.join(viewDir, "generations", generationId, ".harness");
  if (!existsSync(path.join(replicaLocalRoot, "store", "generations")))
    throw new Error(`replica generation ${generationId} has no store/generations under ${replicaLocalRoot}`);
  return {
    dataLocalRoot: replicaLocalRoot,
    replica: {
      repoId,
      generationId,
      replicaRevision:
        typeof pointer.metadata?.position?.revision === "number" ? pointer.metadata.position.revision : null,
    },
  };
}

/** The ledger's own identity, read from the generation-3 activation certificate the store wrote.
 *  A copy registered under any other id is a different repository to the attach path: the
 *  certificate's repoId is checked against the registered one and attach fails closed with
 *  "generation 3 activation certificate differs". The copy therefore has to keep the identity it
 *  was written with — the id a node happens to use is not part of the data being reviewed. */
export function copyRepoId(sourceRoot, userRoot) {
  const layout = copyLayout(sourceRoot),
    { dataLocalRoot } = resolveSourceDataRoot(layout.projectRoot, layout.localRoot, userRoot),
    certificate = `${path.join(dataLocalRoot, "store", "generations", "3", "ledger.sqlite")}.activation.json`;
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

function excludedHarnessSubtree(harnessSource, entryPath) {
  const rel = path.relative(harnessSource, entryPath);
  if (!rel) return false;
  const topSegment = rel.split(path.sep)[0];
  return topSegment === ".git" || topSegment === "node_modules" || topSegment === "restore-drills";
}

async function initMinimalHarnessGitRepo(harnessTarget, configRelative) {
  await runText("git", ["-C", harnessTarget, "init", "--quiet"], harnessTarget);
  await runText("git", ["-C", harnessTarget, "symbolic-ref", "HEAD", "refs/heads/main"], harnessTarget);
  await runText("git", ["-C", harnessTarget, "config", "core.autocrlf", "false"], harnessTarget);
  const configTarget = configRelative ? path.join(path.dirname(harnessTarget), ...configRelative.split("/")) : null;
  if (configTarget && existsSync(configTarget)) {
    const rel = path.relative(harnessTarget, configTarget);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel))
      await runText("git", ["-C", harnessTarget, "add", "--", rel.split(path.sep).join("/")], harnessTarget);
  }
  await runText(
    "git",
    [
      "-C",
      harnessTarget,
      "-c",
      "user.name=Old Copy Snapshot",
      "-c",
      "user.email=oldcopy@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "old-data-copy snapshot",
    ],
    harnessTarget,
  );
}

function externalCpAvailable(platform = process.platform, environment = process.env) {
  if (platform === "win32") return false;
  const pathEnv = environment.PATH ?? environment.Path ?? "";
  for (const dir of pathEnv.split(":").filter(Boolean)) {
    if (existsSync(path.join(dir, "cp"))) return true;
  }
  return false;
}

function planNativeCopy(sourceDir, targetDir, filter, depth = 0, dirs = [], units = []) {
  if (filter && !filter(sourceDir)) return { dirs, units };
  const stat = lstatSync(sourceDir);
  if (!stat.isDirectory()) {
    units.push({ src: sourceDir, dst: targetDir });
    return { dirs, units };
  }
  const entries = readdirSync(sourceDir, { withFileTypes: true });
  if (depth >= NATIVE_COPY_EXPAND_DEPTH || !entries.some((entry) => entry.isDirectory())) {
    units.push({ src: sourceDir, dst: targetDir });
    return { dirs, units };
  }
  dirs.push(targetDir);
  for (const entry of entries) {
    const childSrc = path.join(sourceDir, entry.name);
    const childDst = path.join(targetDir, entry.name);
    if (filter && !filter(childSrc)) continue;
    if (entry.isDirectory()) planNativeCopy(childSrc, childDst, filter, depth + 1, dirs, units);
    else units.push({ src: childSrc, dst: childDst });
  }
  return { dirs, units };
}

/** Copy a directory tree using platform block-cloning (`cp`) on POSIX and falling back to
 *  Node's `fs.promises.cp` (fanned out across wide bucket directories with bounded progress
 *  heartbeats) on Windows or when external `cp` is unavailable. */
export async function copyTree(sourceDir, targetDir, options = {}) {
  const platform = options.platform ?? process.platform;
  const filter = options.filter;
  const label = options.progressLabel ?? path.basename(targetDir);
  if (platform !== "win32" && !filter && externalCpAvailable(platform)) {
    await withProgressHeartbeat(`cp ${label}`, () => runText("cp", [...copyTreeArgs(platform), sourceDir, targetDir]));
    return copyTreeMethod(platform);
  }
  const { dirs, units } = planNativeCopy(sourceDir, targetDir, filter);
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  const startedAt = Date.now();
  let nextIndex = 0,
    completed = 0;
  const timer = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    reportProgress(`copy ${label}: ${completed}/${units.length} units (${elapsedSec}s elapsed)`);
  }, PROGRESS_INTERVAL_MS);
  timer.unref?.();
  try {
    const workerCount = Math.max(1, Math.min(NATIVE_COPY_CONCURRENCY, units.length));
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < units.length) {
          const unit = units[nextIndex++];
          await cp(unit.src, unit.dst, {
            recursive: true,
            verbatimSymlinks: true,
            ...(filter ? { filter } : {}),
          });
          completed += 1;
        }
      }),
    );
  } finally {
    clearInterval(timer);
  }
  return "node fs.cp recursive";
}

/** Copy individual files into an existing directory, preserving filenames. */
export async function copyFilesIntoDirectory(sources, targetDir, options = {}) {
  const platform = options.platform ?? process.platform;
  const label = options.progressLabel ?? path.basename(targetDir);
  if (platform !== "win32" && externalCpAvailable(platform)) {
    await withProgressHeartbeat(`cp ${label}`, () => runText("cp", [...copyTreeArgs(platform), ...sources, targetDir]));
    return copyTreeMethod(platform);
  }
  await withProgressHeartbeat(`copy ${label}`, () =>
    Promise.all(sources.map((src) => copyFile(src, path.join(targetDir, path.basename(src))))),
  );
  return "node fs.cp recursive";
}

export async function snapshotRepository(sourceRoot, workspace, options = {}) {
  const layout = copyLayout(sourceRoot),
    sourceProjectRoot = layout.projectRoot,
    sourceLocalRoot = layout.localRoot,
    { dataLocalRoot, replica } = resolveSourceDataRoot(sourceProjectRoot, sourceLocalRoot, options.userRoot),
    workspaceLocalRoot = path.join(workspace, ...layout.localRootRelative.split("/")),
    storeGenerations = path.join(dataLocalRoot, "store", "generations");
  if (!existsSync(storeGenerations))
    throw new Error(`no ${layout.localRootRelative}/store/generations under ${sourceProjectRoot}`);
  const generation = activeGeneration(storeGenerations);
  mkdirSync(workspace, { recursive: true });
  const steps = [];
  if (replica !== null) {
    steps.push({
      item: "fleet-edge-replica",
      method: "active fleet-basebackup/v3 replica generation",
      generationId: replica.generationId,
      replicaRevision: replica.replicaRevision,
    });
  }
  const harnessSource = path.join(sourceProjectRoot, "harness");
  const harnessTarget = path.join(workspace, "harness");
  let harnessPlainCopy = false;
  if (existsSync(harnessSource)) {
    if (existsSync(path.join(harnessSource, ".git"))) {
      await runText("git", harnessCloneArgs(harnessSource, harnessTarget));
      steps.push({ item: "harness", method: "git local clone --no-checkout (no working tree)" });
    } else {
      const method = await copyTree(harnessSource, harnessTarget, {
        ...options,
        progressLabel: "harness",
        filter: (entryPath) => !excludedHarnessSubtree(harnessSource, entryPath),
      });
      harnessPlainCopy = true;
      steps.push({ item: "harness", method: `${method} + git init (no nested .git)` });
    }
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
  if (harnessPlainCopy) await initMinimalHarnessGitRepo(harnessTarget, layout.configRelative);
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
  const sourceCache = path.join(dataLocalRoot, "cache");
  if (existsSync(sourceCache)) {
    mkdirSync(path.join(workspaceLocalRoot, "cache"), { recursive: true });
    for (const name of ["task.sqlite", "projections.sqlite"]) {
      const file = path.join(sourceCache, name);
      if (!existsSync(file)) continue;
      await snapshotCacheDatabase(file, path.join(workspaceLocalRoot, "cache", name), steps, {
        ...options,
        progressLabel: `cache/${name}`,
      });
    }
  }

  const sourceLedger = path.join(storeGenerations, generation, "ledger.sqlite"),
    copiedGenerations = path.join(workspaceLocalRoot, "store", "generations"),
    copiedLedger = path.join(copiedGenerations, generation, "ledger.sqlite"),
    ledgerSnapshot = path.join(workspace, ".ledger-snapshot.sqlite");
  await sqliteBackup(sourceLedger, ledgerSnapshot);
  steps.push({ item: `store/generations/${generation}/ledger.sqlite`, method: "VACUUM INTO before object clone" });

  const generationsCopyMethod = await copyTree(storeGenerations, copiedGenerations, {
    ...options,
    progressLabel: `store/generations/${generation}`,
  });
  // The clone carries the live ledger's main file plus stale -wal/-shm; replace that trio
  // with the earlier self-contained snapshot so the event cut and object tree are coherent.
  rmSync(copiedLedger, { force: true, maxRetries: 5, retryDelay: 20 });
  rmSync(`${copiedLedger}-wal`, { force: true });
  rmSync(`${copiedLedger}-shm`, { force: true });
  renameSync(ledgerSnapshot, copiedLedger);
  steps.push({
    item: `store/generations/${generation} objects and retired generations`,
    method: generationsCopyMethod,
  });
  for (const dir of HARNESS_COPY_DIRS) {
    const from = [path.join(dataLocalRoot, dir), path.join(sourceLocalRoot, dir)].find((candidate) =>
      existsSync(candidate),
    );
    if (from) {
      const dirCopyMethod = await copyTree(from, path.join(workspaceLocalRoot, dir), {
        ...options,
        progressLabel: dir,
      });
      steps.push({ item: dir, method: dirCopyMethod });
    }
  }
  for (const name of HARNESS_COPY_FILES) {
    const from = [path.join(dataLocalRoot, name), path.join(sourceLocalRoot, name)].find((candidate) =>
      existsSync(candidate),
    );
    if (from) {
      copyFileSync(from, path.join(workspaceLocalRoot, name));
      steps.push({ item: name, method: "copy" });
    }
  }
  // An isolated evidence copy registers as mode=local without a working tree; leaving
  // nodeTaskMaterializationPolicy unset (or invalid) falls back to include_done and forces the
  // orchestration worker to synchronously read and hash every historical document blob at open.
  configureIsolatedMaterializationPolicy(workspaceLocalRoot, steps);
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

function configureIsolatedMaterializationPolicy(workspaceLocalRoot, steps) {
  const settingsPath = path.join(workspaceLocalRoot, "settings.local.json");
  let base = localSettings(INITIAL_SETTINGS_V1);
  if (existsSync(settingsPath)) {
    const parsed = parseLocalSettings(JSON.parse(readFileSync(settingsPath, "utf8")));
    if (parsed !== null) base = parsed;
  }
  const isolated = localSettings({
    ...base,
    nodeTaskMaterializationPolicy: nodeMaterializationPolicyForMode("remote-center"),
  });
  writeFileDurably(settingsPath, serializeLocalSettings(isolated), 0o600);
  steps.push({
    item: "settings.local.json",
    method: "configured nodeTaskMaterializationPolicy=none for isolated evidence copy",
  });
}

/** Cache databases are derived state, so they take the cheap block clone instead of a full
 *  VACUUM rewrite. A block clone of a live WAL pair can still be torn at block granularity,
 *  and the projection readers rethrow corruption they do not recognize — so recovery is forced
 *  on the copy (checkpoint) and verified; a torn copy is discarded rather than trusted, which
 *  only costs attach a catch-up from the ledger. The -shm sidecar is a live shared-memory
 *  index and is never copied; every sqlite open rebuilds it. */
async function snapshotCacheDatabase(sourceFile, targetFile, steps, options = {}) {
  const sources = [sourceFile, `${sourceFile}-wal`].filter((candidate) => existsSync(candidate));
  const method = await copyFilesIntoDirectory(sources, path.dirname(targetFile), options);
  const label = options.progressLabel ?? path.basename(targetFile);
  const checkpointStartedAt = Date.now();
  const checkpointTimer = setInterval(() => {
    reportProgress(`checkpoint ${label} running (${Math.round((Date.now() - checkpointStartedAt) / 1000)}s elapsed)`);
  }, PROGRESS_INTERVAL_MS);
  checkpointTimer.unref?.();
  const recovered = await run(process.execPath, ["-e", CHECKPOINT_CLONE, targetFile], {
    cwd: path.dirname(targetFile),
  });
  clearInterval(checkpointTimer);
  const [check, witnessJson] = (recovered.stdout ?? "").trim().split("\n");
  const healthy = recovered.status === 0 && check === "ok";
  if (healthy) {
    steps.push({
      item: path
        .relative(path.dirname(path.dirname(targetFile)), targetFile)
        .split(path.sep)
        .join("/"),
      method: `${method} + checkpoint`,
      witness: JSON.parse(witnessJson),
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
    method: `${method} (torn clone discarded; attach will catch up)`,
    discarded: true,
    raw: `${recovered.stdout ?? ""}${recovered.stderr ?? ""}`.trim(),
  });
}

const CHECKPOINT_CLONE = `
const { DatabaseSync } = require("node:sqlite");
const { statSync } = require("node:fs");
const db = new DatabaseSync(process.argv[1]);
try {
  db.exec("PRAGMA busy_timeout = 10000; PRAGMA cache_size = -524288; PRAGMA mmap_size = 2147483648; PRAGMA temp_store = MEMORY; PRAGMA wal_checkpoint(TRUNCATE)");
  const check = db.prepare("PRAGMA quick_check").get();
  if (String(check?.quick_check ?? "") !== "ok") throw new Error("quick_check: " + JSON.stringify(check));
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const identity = statSync(process.argv[1]);
  const meta = tables.has("projection_meta") ? db.prepare("SELECT schema_version,watermark FROM projection_meta WHERE singleton=1").get() : null;
  const archived = tables.has("fact") ? db.prepare("SELECT fact_id FROM fact WHERE json_extract(row_json,'$.archived')=1").all() : [];
  const present = table => tables.has(table) ? db.prepare("SELECT 1 FROM " + table + " WHERE path=?") : null;
  const active = present("document"), history = present("document_history");
  const missing = archived.filter(row => {
    const target = "facts/" + row.fact_id + ".md";
    return !active?.get(target) && !history?.get(target);
  }).length;
  console.log("ok");
  console.log(JSON.stringify({ dev:identity.dev, ino:identity.ino, birthtimeMs:identity.birthtimeMs,
    schemaVersion:meta?.schema_version ?? null, watermark:meta?.watermark ?? null,
    archivedFactCount:archived.length, missingArchivedDescriptors:missing }));
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
    `try { db.exec("PRAGMA cache_size = -524288; PRAGMA mmap_size = 2147483648; VACUUM INTO '" + ${JSON.stringify(sqlTarget)} + "'"); } finally { db.close(); }\n`;
  await withProgressHeartbeat(`sqlite-backup ${path.basename(from)}`, () =>
    runText(process.execPath, ["-e", code, from]),
  );
}

export async function resolveBuild(buildArg, tempRoot, sourceRoot = repoRoot) {
  if (!buildArg) return { root: sourceRoot, requested: "<invoking checkout>", sourceArchive: false };
  if (existsSync(buildArg)) return { root: path.resolve(buildArg), requested: buildArg, sourceArchive: false };
  const archived = materialize({
    rootDir: sourceRoot,
    revision: buildArg,
    out: path.join(tempRoot, "build-checkout"),
  });
  if (!archived.ok) throw new Error(archived.detail);
  return { root: archived.destination, requested: buildArg, resolvedSha: archived.commit, sourceArchive: true };
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

const EXCLUDED_BUILD_PACKAGE_DIRS = new Set([
  "node_modules",
  "test",
  "tests",
  "build-resources",
  "dist-electron",
  ".runtime-cache",
]);

function discoverWorkspacePackages(checkoutRoot) {
  const packagesDir = path.join(checkoutRoot, "packages");
  const map = new Map();
  if (!existsSync(packagesDir)) return map;
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgDir = path.join(packagesDir, entry.name);
    const pkgJsonPath = path.join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    try {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      if (typeof pkgJson?.name === "string" && pkgJson.name.length > 0) map.set(pkgJson.name, pkgDir);
    } catch {
      continue;
    }
  }
  return map;
}

/** True when `<checkoutRoot>/node_modules` has workspace links (`@harness-anything/*`) missing
 *  or resolving outside `checkoutRoot` — the exact shape Windows `.worktrees/<id>` produces when
 *  `mirrorNodeModules` copies absolute NTFS Junctions pointing at canonical `packages/*`. */
export function externalWorkspaceLinks(checkoutRoot) {
  const nodeModules = path.join(checkoutRoot, "node_modules");
  if (!existsSync(nodeModules)) return false;
  const realRoot = realpathSync(checkoutRoot);
  for (const [pkgName] of discoverWorkspacePackages(checkoutRoot)) {
    const linkPath = path.join(nodeModules, ...pkgName.split("/"));
    if (!existsSync(linkPath)) return true;
    const resolved = realpathSync(linkPath);
    if (!isInsideDir(realRoot, resolved)) return true;
  }
  return false;
}

/** Mirror third-party dependencies from `donorRoot/node_modules` into `targetRoot/node_modules`
 *  while pointing every workspace package (`@harness-anything/*`) at `targetRoot/packages/*`.
 *  Never mutates `donorRoot`. */
export function mirrorWorkspaceNodeModules(donorRoot, targetRoot) {
  const workspacePackages = discoverWorkspacePackages(targetRoot);
  const mirrorDir = (relative, scopePrefix = "") => {
    const srcDir = path.join(donorRoot, relative);
    const dstDir = path.join(targetRoot, relative);
    mkdirSync(dstDir, { recursive: true });
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const relChild = path.join(relative, entry.name);
      const srcPath = path.join(donorRoot, relChild);
      const dstPath = path.join(targetRoot, relChild);
      if (entry.isDirectory() && (entry.name.startsWith("@") || entry.name === ".bin")) {
        mirrorDir(relChild, entry.name.startsWith("@") ? `${entry.name}/` : "");
        continue;
      }
      const pkgKey = relative === "node_modules" || scopePrefix ? `${scopePrefix}${entry.name}` : null;
      if (pkgKey && workspacePackages.has(pkgKey)) continue;
      if (!existsSync(srcPath)) continue;
      const resolved = entry.isSymbolicLink() ? realpathSync(srcPath) : srcPath;
      const isDir = statSync(resolved).isDirectory();
      if (!isDir && process.platform === "win32") {
        copyFileSync(resolved, dstPath);
      } else {
        symlinkSync(resolved, dstPath, isDir ? (process.platform === "win32" ? "junction" : "dir") : "file");
      }
    }
  };
  mirrorDir("node_modules");
  for (const [pkgName, pkgDir] of workspacePackages) {
    const dstPath = path.join(targetRoot, "node_modules", ...pkgName.split("/"));
    mkdirSync(path.dirname(dstPath), { recursive: true });
    if (existsSync(dstPath)) continue;
    if (process.platform === "win32") symlinkSync(pkgDir, dstPath, "junction");
    else symlinkSync(path.relative(path.dirname(dstPath), pkgDir), dstPath, "dir");
  }
}

function includedBuildPackageEntry(packagesSrc, entryPath) {
  const rel = path.relative(packagesSrc, entryPath);
  if (!rel) return true;
  const segments = rel.split(path.sep);
  if (segments.some((seg) => EXCLUDED_BUILD_PACKAGE_DIRS.has(seg))) return false;
  if (segments[0] === "gui" && segments.length >= 2 && segments[1] !== "package.json") return false;
  return true;
}

async function prepareRunnableBuild(build, tempRoot, donorRoot = repoRoot) {
  const head = build.resolvedSha ?? headCommitOrNull(build.root);
  const buildNodeModules = path.join(build.root, "node_modules");
  const donorNodeModules = path.join(donorRoot, "node_modules");
  if (!existsSync(buildNodeModules)) {
    const donorLock = path.join(donorRoot, "package-lock.json");
    const buildLock = path.join(build.root, "package-lock.json");
    if (
      existsSync(donorNodeModules) &&
      existsSync(donorLock) &&
      existsSync(buildLock) &&
      readFileSync(donorLock).equals(readFileSync(buildLock))
    ) {
      mirrorWorkspaceNodeModules(donorRoot, build.root);
      return { ...build, requestedRoot: build.root, root: build.root, head, isolatedMirror: true };
    }
    return { ...build, requestedRoot: build.root, root: build.root, head, isolatedMirror: false };
  }
  if (!externalWorkspaceLinks(build.root))
    return { ...build, requestedRoot: build.root, root: build.root, head, isolatedMirror: false };
  const isolatedRoot = path.join(tempRoot, "runnable-build");
  mkdirSync(isolatedRoot, { recursive: true });
  for (const rootFile of ["package.json", "package-lock.json", "tsconfig.json"]) {
    const src = path.join(build.root, rootFile);
    if (existsSync(src)) copyFileSync(src, path.join(isolatedRoot, rootFile));
  }
  const packagesSrc = path.join(build.root, "packages");
  if (existsSync(packagesSrc)) {
    await copyTree(packagesSrc, path.join(isolatedRoot, "packages"), {
      platform: "win32",
      progressLabel: "runnable-build/packages",
      filter: (entryPath) => includedBuildPackageEntry(packagesSrc, entryPath),
    });
  }
  mirrorWorkspaceNodeModules(build.root, isolatedRoot);
  return { ...build, requestedRoot: build.root, root: isolatedRoot, head, isolatedMirror: true };
}

const WIN32_VERBATIM_SPAWN =
  "const { spawnSync } = require('node:child_process');" +
  "const inv = JSON.parse(process.argv[1]);" +
  "const res = spawnSync(inv.command, inv.args, { stdio: 'inherit', windowsVerbatimArguments: Boolean(inv.windowsVerbatimArguments) });" +
  "process.exit(res.status ?? 1);";

async function ensureDaemonDist(buildRoot, head = headCommitOrNull(buildRoot)) {
  const plan = planDaemonDistSteps({
    nodeModules: existsSync(path.join(buildRoot, "node_modules")),
    distEntry: existsSync(path.join(buildRoot, "packages", "daemon", "dist", "index.js")),
    head,
    marker: readMarkerOrNull(path.join(buildRoot, "packages", "daemon", "dist", "build-id.txt")),
  });
  const stepEnv = head ? { ...process.env, HARNESS_BUILD_COMMIT: head } : process.env;
  for (const step of plan) {
    const inv = step.command === "npm" ? npmInvocation(step.args) : { ...step, windowsVerbatimArguments: false };
    await withProgressHeartbeat(`${step.command} ${step.args.join(" ")}`, () =>
      inv.windowsVerbatimArguments
        ? runText(process.execPath, ["-e", WIN32_VERBATIM_SPAWN, JSON.stringify(inv)], buildRoot, stepEnv)
        : runText(inv.command, inv.args, buildRoot, stepEnv),
    );
  }
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
        ...(identity.attachTimeoutMs === undefined
          ? {}
          : { HARNESS_DAEMON_ATTACH_TIMEOUT_MS: String(identity.attachTimeoutMs) }),
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

function buildCliEntry(buildRoot) {
  return path.join(buildRoot, "packages", "cli", "src", "index.ts");
}

function buildCliOptions(env, workspaceRoot, identity) {
  return cliInvocation("", [], env, workspaceRoot, identity).options;
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
    cliOptions = buildCliOptions(env, workspace, identity),
    created = requireAppliedCli(
      interpretCli(
        await run(
          process.execPath,
          [
            buildCliEntry(buildRoot),
            "--root",
            workspace,
            "--json",
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
          cliOptions,
        ),
      ),
      "medium task create",
    ),
    createPayload = taskShowPayload(created, "medium task create"),
    taskId = createPayload.taskId;
  if (typeof taskId !== "string" || !/^task_[A-Za-z0-9_-]+$/u.test(taskId))
    throw new Error(`medium task create returned an invalid task id: ${String(taskId)}`);
  const createdPayload = taskShowPayload(
      requireAppliedCli(
        interpretCli(
          await run(
            process.execPath,
            [buildCliEntry(buildRoot), "--root", workspace, "--json", "task", "show", taskId],
            cliOptions,
          ),
        ),
        "created task show",
      ),
      "created task show",
    ),
    workspacePackagePath = createdPayload.workspacePackagePath;
  // `ha task show` prints workspace-relative paths (`harness/tasks/...`) under
  // `workspacePackagePath`; resolve from the copied workspace root once instead of re-joining the
  // package under a second `harness/`.
  if (typeof workspacePackagePath !== "string" || !/^harness\/tasks\/[A-Za-z0-9_-]+$/u.test(workspacePackagePath))
    throw new Error(`medium task has an invalid package path: ${String(workspacePackagePath)}`);
  const packageRoot = path.join(workspace, workspacePackagePath),
    artifactRelative = `${workspacePackagePath}/artifacts/medium-submit-evidence.md`,
    artifactPath = path.join(workspace, artifactRelative),
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
      interpretCli(
        await run(
          process.execPath,
          [buildCliEntry(buildRoot), "--root", workspace, "--json", "task", "start", taskId],
          cliOptions,
        ),
      ),
      "medium task start",
    ),
    synced = requireAppliedCli(
      interpretCli(
        await run(
          process.execPath,
          [
            buildCliEntry(buildRoot),
            "--root",
            workspace,
            "--json",
            "doc",
            "sync",
            "--submit",
            "--task",
            taskId,
            "--path",
            `${workspacePackagePath}/closeout.md`,
            "--path",
            artifactRelative,
          ],
          cliOptions,
        ),
      ),
      "medium task document sync",
    ),
    submitted = requireAppliedCli(
      interpretCli(
        await run(
          process.execPath,
          [buildCliEntry(buildRoot), "--root", workspace, "--json", "task", "submit", taskId],
          cliOptions,
        ),
      ),
      "medium task submit",
    ),
    shown = requireAppliedCli(
      interpretCli(
        await run(
          process.execPath,
          [buildCliEntry(buildRoot), "--root", workspace, "--json", "task", "show", taskId],
          cliOptions,
        ),
      ),
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
    workspacePackagePath,
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
  const result = spawnSync(invocation.command, invocation.args, {
    ...invocation.options,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
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

export function parseProcessRssBytes(stdout, platform = process.platform) {
  const trimmed = String(stdout ?? "").trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  return platform === "win32" ? value : value * 1024;
}

export function processRssMethod(platform = process.platform) {
  return platform === "win32"
    ? "PowerShell Get-Process WorkingSet64 polled every 500ms"
    : "ps -o rss= polled every 500ms";
}

export function processRssBytes(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const result =
    platform === "win32"
      ? spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`,
          ],
          { encoding: "utf8", windowsHide: true, timeout: 5000 },
        )
      : spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0 || result.error) return null;
  return parseProcessRssBytes(result.stdout ?? "", platform);
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
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
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastProgressAt = startedAt;
  let pollCount = 0;
  for (;;) {
    // On Windows, PowerShell RSS sampling spawns a ~170ms child; sample on entry, on exit, and
    // every 4th poll (2s) so the event loop stays responsive while `ps` on POSIX stays 500ms.
    if (process.platform !== "win32" || pollCount % 4 === 0) sampleDaemonRss();
    pollCount += 1;
    const records = readLifecycle(lifecycle);
    const terminal = records.find(
      (record) => TERMINAL_ATTACH_EVENTS.has(record.event) && spellings.has(path.resolve(String(record.rootDir ?? ""))),
    );
    if (terminal) {
      sampleDaemonRss();
      return { outcome: "terminal-record", record: terminal };
    }
    if (!processAlive(pid)) return { outcome: "daemon-exited" };
    const now = Date.now();
    if (now > deadline) return { outcome: "timeout" };
    if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
      lastProgressAt = now;
      const latestEvent = records.at(-1)?.event ?? "waiting-for-lifecycle";
      reportProgress(
        `awaitAttach pid=${pid} lastEvent=${latestEvent} (${Math.round((now - startedAt) / 1000)}s elapsed)`,
      );
    }
    await sleep(500);
  }
}

async function awaitDaemonDown(pid, timeoutMs = 300_000) {
  return await withProgressHeartbeat(`awaitDaemonDown pid=${pid}`, async () => {
    const deadline = Date.now() + timeoutMs;
    while (processAlive(pid) && Date.now() < deadline) await sleep(500);
    return !processAlive(pid);
  });
}

/** Sync twin with a tighter cap for the interrupt path: it must not sit in an uninterruptible
 *  wait; if the daemon ignores a clean stop it is left to the owner-pid watchdog. */
function awaitDaemonDownSync(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  return !processAlive(pid);
}

const DIRECT_RUNNER = String.raw`
const { DatabaseSync } = await import("node:sqlite");
const { appendFileSync, statSync } = await import("node:fs");
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
  const { readTaskDispatches } = await import(toUrl(path.join(BUILD_ROOT, "packages/daemon/src/daemon-host/dispatch-read.ts")));
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
  record("task-index", { count: rows.length, hasAnyTask: rows.length > 0 });
  if (rows.length > 0) {
    const dispatches = readTaskDispatches({ projection, rootDir: WORKSPACE, taskId: rows[0].taskId });
    const dispatchRows = dispatches.rows ?? [];
    record("task-dispatches", { count: dispatches.length ?? dispatchRows.length });
  }
  record("event-read", store.queryEvents({ limit: 3 }).map((event) => ({ schema: event.schema, type: event.type, revision: event.workspaceRevision })));
  const archivedFactDocuments = () => {
    const db = new DatabaseSync(layout.taskProjectionPath, { readOnly: true });
    try {
      return db.prepare("SELECT fact_id FROM fact WHERE json_extract(row_json,'$.archived')=1 ORDER BY fact_id").all().map(({ fact_id }) => {
        const target = "facts/" + fact_id + ".md";
        const document = projection.readDocument(target).document ?? projection.readDocumentHistory(target).document;
        if (!document) throw new Error("warm/cold archived Fact descriptor is missing: " + target);
        const bytes = store.readContentBlob(document.blobSha256);
        if (!bytes || bytes.byteLength !== document.size || new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== document.body)
          throw new Error("archived Fact content is unreadable: " + target);
        return [target,document.blobSha256,document.size,document.mediaType,document.policyId,document.workspaceRevision];
      });
    } finally { db.close(); }
  };
  const warmArchivedFacts = archivedFactDocuments();
  const identity = statSync(layout.taskProjectionPath);
  record("archived-fact-warm-read", { count: warmArchivedFacts.length, allContentReadable: true,
    projectionIdentity: { dev:identity.dev, ino:identity.ino, birthtimeMs:identity.birthtimeMs } });
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
  const coldArchivedFacts = archivedFactDocuments();
  if (JSON.stringify(warmArchivedFacts) !== JSON.stringify(coldArchivedFacts))
    throw new Error("warm upgrade and cold rebuild disagree on archived Fact descriptors");
  record("archived-fact-warm-cold", { warmCount: warmArchivedFacts.length, coldCount: coldArchivedFacts.length, equal: true, allContentReadable: true });
  const quoteIdentifier = (value) => '"' + value.replaceAll('"', '""') + '"';
  const countRows = (db, table) => Number(db.prepare("SELECT COUNT(*) AS count FROM " + quoteIdentifier(table)).get().count);
  const ledgerDb = new DatabaseSync(path.join(layout.localRoot, "store/generations/3/ledger.sqlite"), { readOnly: true });
  try {
    const schemas = ledgerDb.prepare(
      "SELECT json_extract(event_json, '$.schema') AS schema, COUNT(*) AS count FROM event GROUP BY schema ORDER BY schema",
    ).all();
    const documentCounts = ledgerDb
      .prepare(
        "SELECT CASE WHEN path LIKE '%harness.yaml' THEN 'settings' WHEN path LIKE '%vertical.json' THEN 'vertical' END AS surface, COUNT(*) AS count FROM document_head WHERE path LIKE '%harness.yaml' OR path LIKE '%vertical.json' GROUP BY surface ORDER BY surface",
      )
      .all();
    record("persisted-census-ledger", {
      eventRows: countRows(ledgerDb, "event"),
      eventSchemas: schemas.map((row) => ({ schema: row.schema, count: Number(row.count) })),
      documentHeads: countRows(ledgerDb, "document_head"),
      entityDeclarationHeads: countRows(ledgerDb, "entity_declaration_head"),
      settingsAndVerticalDocumentHeads: documentCounts.map((row) => ({ surface: row.surface, count: Number(row.count) })),
    });
  } finally {
    ledgerDb.close();
  }
  const projectionDb = new DatabaseSync(layout.taskProjectionPath, { readOnly: true });
  try {
    const tables = projectionDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => ({ table: row.name, rows: countRows(projectionDb, row.name) }));
    record("persisted-census-projections", {
      tableCount: tables.length,
      tables,
      presetSnapshotRows: tables.find((table) => table.table === "preset_snapshot")?.rows ?? 0,
    });
  } finally {
    projectionDb.close();
  }
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

function isInsideDir(parentDir, targetPath) {
  const rel = path.relative(path.resolve(parentDir), path.resolve(targetPath));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function boundedRm(target) {
  const resolved = path.resolve(target);
  rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

async function cleanupTempRoot(target) {
  const resolved = path.resolve(target);
  if (!isInsideDir(tmpdir(), resolved) || !path.basename(resolved).startsWith("ha-oldcopy-"))
    throw new Error(`refusing to remove outside an owned ha-oldcopy temp root: ${resolved}`);
  const code =
    "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });";
  await withProgressHeartbeat("temp-cleanup", () => runText(process.execPath, ["-e", code, resolved]));
}

/** Remove only expired ha-oldcopy roots created by this version. A live owner pid always wins
 *  over age. Legacy directories without an embedded owner pid are left for inspection. */
export function cleanupStaleTempRoots({ now = Date.now(), tempDir = tmpdir(), maxAgeMs = STALE_TEMP_AGE_MS } = {}) {
  const removed = [];
  for (const entry of readdirSync(tempDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("ha-oldcopy-")) continue;
    const target = path.resolve(tempDir, entry.name);
    if (dirnameCrossPlatform(target) !== path.resolve(tempDir)) continue;
    const ownerPid = Number(/^ha-oldcopy-(\d+)-/u.exec(entry.name)?.[1]);
    if (!Number.isInteger(ownerPid) || ownerPid <= 0) continue;
    if (now - statSync(target).birthtimeMs < maxAgeMs || processAlive(ownerPid)) continue;
    boundedRm(target);
    removed.push(target);
  }
  return removed;
}

export async function main(argv, session = {}) {
  const args = parseArgs(argv);
  const sourceRoot = resolveSourceRoot(args.source);
  const staleTempRoots = cleanupStaleTempRoots();
  const label = `ha-oldcopy-${process.pid}-${randomBytes(4).toString("hex")}`;
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
    census: null,
    mediumSubmission: null,
    peakRss: null,
    failures: [],
  };
  let daemonStopReceipt = null;
  let daemonHandle = null;
  const env = forensicEnv(process.env);
  session.tempRoot = tempRoot;
  session.keep = args.keep;
  session.timeoutMs = args.timeoutMs;
  session.startedAt = Date.now();
  session.staleTempRoots = staleTempRoots;
  session.env = env;
  session.daemonHandle = null;
  const timeout = session.abort
    ? setTimeout(() => session.abort("SIGTERM", `timed out after ${args.timeoutMs}ms`), args.timeoutMs)
    : null;
  // Any error between start and the in-flow stop must not leak a detached daemon holding a
  // socket inside the temp root we are about to delete.
  const stopDaemonBestEffort = async () => {
    if (daemonHandle === null || !processAlive(daemonHandle.pid)) return;
    try {
      const stopped = interpretCli(
        await run(
          process.execPath,
          [buildCliEntry(daemonHandle.buildRoot), "--root", daemonHandle.workspace, "--json", "daemon", "stop"],
          buildCliOptions(env, daemonHandle.workspace, daemonHandle),
        ),
      );
      let effectiveStop = stopped;
      if (effectiveStop.receipt?.ok !== true && processAlive(daemonHandle.pid)) {
        effectiveStop = cliSync(
          daemonHandle.buildRoot,
          ["daemon", "stop", "--daemon-id", daemonHandle.daemonId],
          env,
          daemonHandle.workspace,
          daemonHandle,
        );
      }
      if (effectiveStop.receipt?.ok !== true && processAlive(daemonHandle.pid)) {
        effectiveStop = cliSync(
          daemonHandle.buildRoot,
          ["daemon", "stop", "--daemon-id", daemonHandle.daemonId, "--force"],
          env,
          daemonHandle.workspace,
          daemonHandle,
        );
      }
      if (daemonStopReceipt === null) daemonStopReceipt = effectiveStop.receipt;
    } catch {
      // The finally block reports the leftover pid; nothing here may mask the primary failure.
    }
    await awaitDaemonDown(daemonHandle.pid);
  };
  try {
    // 1. Build resolution and daemon dist. A stale dist (older HEAD than the checkout) is
    //    rebuilt here, before anything can run it. When a Windows worktree's workspace links
    //    point outside the worktree (or a historical archive shares our lockfile), mirror an
    //    isolated runnable build under tempRoot so every @harness-anything/* import resolves
    //    inside the build under test without mutating any shared node_modules.
    const resolvedBuild = await resolveBuild(args.build, tempRoot);
    const build = await prepareRunnableBuild(resolvedBuild, tempRoot);
    const { steps: buildSteps, head } = await ensureDaemonDist(build.root, build.head);
    if (head) env.HARNESS_BUILD_COMMIT = head;
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
    if (!isInsideDir(tmpdir(), workspace))
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
    const daemonCliOptions = buildCliOptions(env, workspace, {
      userRoot,
      daemonId,
      attachTimeoutMs: args.attachTimeoutMs,
    });
    receipt.build = {
      requested: build.requested,
      root: build.requestedRoot,
      ...(build.isolatedMirror && build.root !== build.requestedRoot ? { runnableRoot: build.root } : {}),
      sourceArchive: build.sourceArchive,
      headCommit: head,
      prepared: buildSteps,
    };
    // 3. Isolated daemon: fresh user root and daemon id hash to their own socket, so the
    //    production daemon's endpoint namespace is untouched by construction.
    const started = interpretCli(
      await run(
        process.execPath,
        [buildCliEntry(build.root), "--root", workspace, "--json", "daemon", "start", "--service"],
        daemonCliOptions,
      ),
    );
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
      typeof receipt.build.headCommit === "string" &&
      typeof receipt.build.loadedBuildId === "string" &&
      receipt.build.headCommit !== receipt.build.loadedBuildId
    )
      receipt.failures.push({
        phase: "build-identity",
        message: `selected build commit ${receipt.build.headCommit} but the loaded dist is ${receipt.build.loadedBuildId}`,
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
    const registered = interpretCli(
      await run(
        process.execPath,
        [
          buildCliEntry(build.root),
          "--root",
          workspace,
          "--json",
          "daemon",
          "repo",
          "register",
          "--repo-id",
          receipt.source.repository,
          "--root",
          workspace,
        ],
        daemonCliOptions,
      ),
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
    const status = interpretCli(
      await run(
        process.execPath,
        [buildCliEntry(build.root), "--root", workspace, "--json", "daemon", "status"],
        daemonCliOptions,
      ),
    );
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
      daemonRssMethod: processRssMethod(),
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
    const stopped = interpretCli(
      await run(
        process.execPath,
        [buildCliEntry(build.root), "--root", workspace, "--json", "daemon", "stop"],
        daemonCliOptions,
      ),
    );
    daemonStopReceipt = stopped.receipt;
    if (await awaitDaemonDown(pid)) daemonHandle = null;
    // 6. Direct reads and full cold rebuild through the build's own production functions.
    const direct = await withProgressHeartbeat("direct-evidence+cold-rebuild", () =>
      runDirectEvidence(build.root, workspace, tempRoot, env, receipt.source.repository),
    );
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
    receipt.archivedFactHistory = byStep.get("archived-fact-warm-cold")?.value ?? null;
    const before =
      receipt.copy.steps?.find((step) => step.item === "cache/task.sqlite" && step.witness)?.witness ?? null;
    const after = byStep.get("archived-fact-warm-read")?.value?.projectionIdentity ?? null;
    receipt.warmProjection = {
      before,
      after,
      preserved:
        !args.coldAttach &&
        before !== null &&
        after !== null &&
        ["dev", "ino", "birthtimeMs"].every((key) => before[key] === after[key]),
    };
    receipt.census = {
      ledger: byStep.get("persisted-census-ledger")?.value ?? null,
      projections: byStep.get("persisted-census-projections")?.value ?? null,
    };
    receipt.peakRss = {
      daemonBytes: daemonPeakRss,
      daemonMethod: processRssMethod(),
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
      receipt.archivedFactHistory?.equal === true &&
      rebuild !== null &&
      rebuild.watermark === rebuild.sourceRevision;
    receipt.copy.sourceRevision = receipt.reads.storeHead?.revision ?? rebuild?.sourceRevision ?? null;
  } catch (error) {
    receipt.failures.push({ phase: "orchestrator", message: String(error instanceof Error ? error.message : error) });
  } finally {
    await stopDaemonBestEffort();
    receipt.cleanup = {
      kept: args.keep,
      tempRoot,
      daemonStopped: daemonStopReceipt?.ok === true,
      staleOrphansRemoved: staleTempRoots.length,
    };
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
      await cleanupTempRoot(tempRoot);
    } catch (error) {
      receipt.failures.push({ phase: "temp-cleanup", message: String(error instanceof Error ? error.message : error) });
      receipt.ok = false;
    }
  } else console.error(`kept temp root: ${tempRoot}`);
  const receiptText = JSON.stringify(receipt, null, 2);
  console.log(receiptText);
  if (args.out) writeFileSync(path.join(args.out, "old-data-copy-evidence-receipt.json"), `${receiptText}\n`, "utf8");
  if (timeout) clearTimeout(timeout);
  return receipt.ok ? 0 : 1;
}

/** The interrupt path owns the same cleanup contract as the normal exit, executed
 *  synchronously from the signal handler: kill tracked child groups first (they write into
 *  the temp root), stop the isolated daemon, delete the temporary build archive and
 *  temp root, exit non-zero without printing a receipt. A signal before the temp root exists
 *  finds the session empty and just exits. */
export function installInterruptHandlers(session) {
  let interrupted = false;
  const handler = (signal, reason = null) => {
    const abortReason = typeof reason === "string" && reason.length > 0 ? reason : null;
    const exitCode = abortReason ? 124 : signal === "SIGINT" ? 130 : 143;
    if (interrupted) process.exit(exitCode);
    interrupted = true;
    for (const child of liveChildren) killChildTree(child);
    const notes = [];
    const handle = session.daemonHandle;
    if (handle && processAlive(handle.pid)) {
      try {
        cliSync(
          handle.buildRoot,
          ["daemon", "stop", "--daemon-id", handle.daemonId],
          session.env,
          handle.workspace,
          handle,
        );
        if (awaitDaemonDownSync(handle.pid)) notes.push("daemon stopped");
        else notes.push(`daemon pid ${handle.pid} left to the owner-pid watchdog`);
      } catch {
        notes.push(`daemon pid ${handle.pid} left to the owner-pid watchdog`);
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
    console.error(`${abortReason ?? `interrupted by ${signal}`}: ${notes.join("; ")}`);
    process.exit(exitCode);
  };
  session.abort = handler;
  // Node passes (signal, signalCode) to signal listeners; wrap so the numeric signalCode
  // is never mistaken for a timeout reason.
  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
}

// Node resolves the invoked entry through realpath (the isolated test snapshot reaches this
// file through symlinks), so both sides are compared after realpath or a symlinked invocation
// would silently skip main and exit 0.
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const session = {};
  installInterruptHandlers(session);
  const result = await main(process.argv.slice(2), session);
  process.exitCode = result;
}
