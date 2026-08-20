#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { selectIntegrationShardFiles } from "./integration-test-shards.mjs";
import { collectSlowTests, filterTestFilesByPrefixes, formatSlowTestSummary, parseRunnerArgs, resolveTestConcurrency, selectTestFiles } from "./node-test-runner-lib.mjs";
import { discoverTestTierManifest, testTierNames } from "./test-tier-manifest.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const DEFAULT_TEST_FILE_TIMEOUT_MS = 900_000;
const PROCESS_TREE_KILL_GRACE_MS = 1_000;

// Reuse type-strip/compile output across the test host and every CLI
// subprocess it spawns (integration tests cold-start `node src/index.ts` per
// assertion). Native Node compile cache — no build step. Children inherit the
// env, so the cache is shared. Lives under node_modules/.cache (already
// git-ignored).
process.env.NODE_COMPILE_CACHE ||= resolve(repoRoot, "node_modules/.cache/harness-node-compile");
process.env.HARNESS_ACTOR ||= "agent:harness-test";
process.env.HARNESS_GIT_AUTHOR_NAME ||= "Harness Test";
process.env.HARNESS_GIT_AUTHOR_EMAIL ||= "harness@example.test";

let options;
try {
  options = parseRunnerArgs(process.argv.slice(2), testTierNames);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const testTierManifest = discoverTestTierManifest(repoRoot);
const testFiles = Object.values(testTierManifest).flat().sort();
const selection = selectTestFiles(testFiles, testTierManifest, options.tier);

if (selection.errors.length > 0) {
  for (const error of selection.errors) {
    console.error(error);
  }
  process.exit(1);
}

if (options.shard !== undefined) {
  selection.files = selectIntegrationShardFiles(options.shard, selection.files);
}
const beforePrefixes = selection.files.length;
selection.files = filterTestFilesByPrefixes(selection.files, options.prefixes);

// A prefix that selects nothing is a typo, not an empty tier. Exiting 0 here
// would report "ran clean" for a run that executed no assertions at all.
if (options.prefixes.length > 0 && selection.files.length === 0) {
  console.error(
    `No test file in tier ${options.tier} starts with any of: ${options.prefixes.join(", ")} (${beforePrefixes} files were available before filtering).`
  );
  process.exit(1);
}

if (selection.files.length === 0) {
  console.log(`No node test files found for tier ${options.tier}.`);
  process.exit(0);
}

if (options.list) {
  for (const file of selection.files) {
    console.log(file);
  }
  process.exit(0);
}

// Cap process fan-out so full runs don't exhaust memory on developer laptops.
// --concurrency wins; else HARNESS_TEST_CONCURRENCY; else, off CI, a
// fixed per-session budget; in CI, node's own default.
const concurrency = resolveTestConcurrency({
  flagConcurrency: options.concurrency,
  envConcurrency: process.env.HARNESS_TEST_CONCURRENCY,
  isCi: Boolean(process.env.CI)
});
const concurrencyArgs =
  concurrency && Number.isInteger(concurrency) && concurrency > 0 ? [`--test-concurrency=${concurrency}`] : [];
const fileTimeoutMs = positiveIntegerOrDefault(process.env.HARNESS_TEST_FILE_TIMEOUT_MS, DEFAULT_TEST_FILE_TIMEOUT_MS);
const activityRoot = mkdtempSync(join(tmpdir(), "ha-node-test-watchdog-"));
const activityPath = join(activityRoot, "activity.jsonl");
const reporterUrl = pathToFileURL(resolve(import.meta.dirname, "node-test-file-activity-reporter.mjs")).href;
// Arm the stall report inside each test child before the watchdog kills it from outside. The
// watchdog can say which test never returned; only the child itself can say which handle it is
// still holding, and a remote runner offers no second chance to ask.
const stallReportUrl = pathToFileURL(resolve(import.meta.dirname, "node-test-stall-report.mjs")).href;
const stallReportMs = Math.max(1_000, Math.floor(fileTimeoutMs * 0.9));
const child = spawn(process.execPath, [
  "--test",
  "--test-reporter=spec",
  "--test-reporter-destination=stdout",
  `--test-reporter=${reporterUrl}`,
  `--test-reporter-destination=${activityPath}`,
  `--import=${stallReportUrl}`,
  ...concurrencyArgs,
  ...selection.files
], {
  cwd: repoRoot,
  env: { ...process.env, HARNESS_TEST_STALL_REPORT_MS: String(stallReportMs) },
  detached: process.platform !== "win32",
  stdio: ["inherit", "pipe", "pipe"],
  windowsHide: true
});

let output = "";
let activityOffset = 0;
let activityTail = "";
const lastTestByFile = new Map();
const openTestsByFile = new Map();
let timedOutFiles = [];
let termination = Promise.resolve();
const activeFiles = new Map();
const removeSignalForwarding = installSignalForwarding(child);
const watchdog = setInterval(() => {
  refreshActivity();
  if (timedOutFiles.length > 0) return;
  const now = Date.now();
  const overdue = [...activeFiles].filter(([, startedAt]) => now - startedAt >= fileTimeoutMs).map(([file]) => file);
  if (overdue.length === 0) return;
  timedOutFiles = overdue;
  console.error(`[node-test-watchdog] test file exceeded ${fileTimeoutMs}ms: ${overdue.map(stalledFileReport).join(", ")}`);
  termination = terminateProcessTree(child);
}, Math.min(1_000, Math.max(25, Math.floor(fileTimeoutMs / 4))));

child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
});
child.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stderr.write(text);
});

const exitCode = await new Promise((resolveRun) => {
  let settled = false;
  const finish = (code) => {
    if (settled) return;
    settled = true;
    clearInterval(watchdog);
    removeSignalForwarding();
    void termination.then(() => {
      rmSync(activityRoot, { recursive: true, force: true });
      resolveRun(code);
    });
  };
  child.once("error", (error) => {
    console.error(error.message);
    finish(1);
  });
  child.once("close", (code, signal) => {
    if (signal !== null && timedOutFiles.length === 0) console.error(`node --test terminated by signal ${signal}`);
    finish(timedOutFiles.length > 0 || signal !== null ? 1 : code ?? 1);
  });
});
const slowTests = collectSlowTests(output, options.slowThresholdMs);
console.log(formatSlowTestSummary(slowTests, options.slowThresholdMs, options.slowLimit));
process.exit(exitCode);

function positiveIntegerOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Subtest events carry an absolute path while file-level events carry the repo-relative name the
// watchdog keys on. Without this the two never join and the report silently loses the test name.
function repoRelativeTestFile(file) {
  const root = `${repoRoot.replaceAll("\\", "/")}/`;
  return file.startsWith(root) ? file.slice(root.length) : file;
}

// Naming the file is not enough to route a fix: a stalled file has several tests and the spec
// reporter prints none of them. Name the test that started and never returned.
function stalledFileReport(file) {
  const last = lastTestByFile.get(file);
  if (last === undefined) return file;
  const open = openTestsByFile.get(file) ?? 0;
  return open > 0
    ? `${file} (hung inside: ${last})`
    : `${file} (every test finished, last was ${last}; the process did not exit -- look for an open handle, not a slow test)`;
}

function refreshActivity() {
  if (!existsSync(activityPath)) return;
  const source = readFileSync(activityPath, "utf8");
  if (source.length < activityOffset) {
    activityOffset = 0;
    activityTail = "";
    activeFiles.clear();
  }
  const lines = `${activityTail}${source.slice(activityOffset)}`.split(/\r?\n/u);
  activityOffset = source.length;
  activityTail = lines.pop() ?? "";
  for (const line of lines) {
    if (!line) continue;
    const event = JSON.parse(line);
    if (event.state === "started" && typeof event.file === "string" && Number.isFinite(event.at)) activeFiles.set(event.file, event.at);
    if (event.state === "progress" && typeof event.file === "string" && typeof event.name === "string") {
      const owner = repoRelativeTestFile(event.file);
      lastTestByFile.set(owner, event.name);
      openTestsByFile.set(owner, (openTestsByFile.get(owner) ?? 0) + 1);
    }
    if (event.state === "test-finished" && typeof event.file === "string") {
      const owner = repoRelativeTestFile(event.file);
      openTestsByFile.set(owner, (openTestsByFile.get(owner) ?? 0) - 1);
    }
    if (event.state === "finished" && typeof event.file === "string") { activeFiles.delete(event.file); lastTestByFile.delete(event.file); openTestsByFile.delete(event.file); }
  }
}

async function terminateProcessTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    await new Promise((resolveKiller) => {
      killer.once("close", resolveKiller);
      killer.once("error", resolveKiller);
    });
    if (child.exitCode === null) child.kill("SIGKILL");
    return;
  }
  signalProcessGroup(child.pid, "SIGTERM");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, PROCESS_TREE_KILL_GRACE_MS));
  signalProcessGroup(child.pid, "SIGKILL");
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function installSignalForwarding(child) {
  const handlers = new Map();
  const remove = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = async () => {
      remove();
      if (process.platform === "win32") await terminateProcessTree(child);
      else if (child.pid !== undefined) signalProcessGroup(child.pid, signal);
      process.kill(process.pid, signal);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return remove;
}
