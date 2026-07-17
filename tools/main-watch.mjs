#!/usr/bin/env node

import { execFile, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const ansiEscapePattern = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const durationSuffixPattern = / \(\d+(?:\.\d+)?ms\)$/u;
const logTimestampPattern = /^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*/u;
const registryEntryFields = Object.freeze(["testName", "file", "anchoredTask", "firstSeen", "notes"]);
const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const registryPath = path.join(repoRoot, "tools/flake-registry.json");

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateRegistry(registry) {
  if (registry?.schema !== "harness-anything/flake-registry/v1") {
    throw new Error("flake registry schema must be harness-anything/flake-registry/v1");
  }
  if (!Array.isArray(registry.entries)) {
    throw new Error("flake registry entries must be an array");
  }

  const testNames = new Set();
  for (const [index, entry] of registry.entries.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`flake registry entry ${index} must be an object`);
    }
    for (const field of registryEntryFields) {
      if (!nonEmptyString(entry[field])) {
        throw new Error(`flake registry entry ${index} requires non-empty ${field}`);
      }
    }
    if (!/^task_[A-Z0-9]+$/u.test(entry.anchoredTask)) {
      throw new Error(`flake registry entry ${index} anchoredTask must be a task id`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(entry.firstSeen)) {
      throw new Error(`flake registry entry ${index} firstSeen must be YYYY-MM-DD`);
    }
    if (testNames.has(entry.testName)) {
      throw new Error(`flake registry has duplicate testName: ${entry.testName}`);
    }
    testNames.add(entry.testName);
  }
  return registry;
}

function parseLogLine(line) {
  const columns = line.split("\t");
  const hasGithubPrefix = columns.length >= 3;
  const message = hasGithubPrefix ? columns.slice(2).join("\t").replace(logTimestampPattern, "") : line;
  return {
    job: hasGithubPrefix ? columns[0] : "__unprefixed__",
    message: message.replace(ansiEscapePattern, "").replace(/^\uFEFF/u, "")
  };
}

export function parseFailedLogs(log) {
  const failingTests = [];
  const jobs = new Map();

  for (const line of log.split(/\r?\n/u)) {
    if (!line) continue;
    const { job, message: rawMessage } = parseLogLine(line);
    const message = rawMessage.trim();
    const state = jobs.get(job) ?? { inFailingTests: false, failingTestCount: 0 };
    jobs.set(job, state);
    if (message === "✖ failing tests:") {
      state.inFailingTests = true;
      continue;
    }
    if (message.startsWith("Slow test summary:") || message.startsWith("##[error]")) {
      state.inFailingTests = false;
    }
    if (!state.inFailingTests || !message.startsWith("✖ ")) continue;
    const testName = message.slice(2).replace(durationSuffixPattern, "").trim();
    if (testName) {
      failingTests.push(testName);
      state.failingTestCount += 1;
    }
  }

  return {
    failingTests: [...new Set(failingTests)],
    hasUnparsedFailedJob: jobs.size === 0 || [...jobs.values()].some((state) => state.failingTestCount === 0)
  };
}

export function extractFailingTests(log) {
  return parseFailedLogs(log).failingTests;
}

function result(code, classification, runUrl = "-", failingTests = []) {
  return { code, classification, runUrl, failingTests };
}

async function classifyCompletedRun(run, registry, github) {
  if (run.conclusion === "success") return result(0, "green", run.url);
  if (run.conclusion === "cancelled") {
    const newerRuns = await github.listNewerMainRuns();
    const supersedingRun = newerRuns.find((candidate) => candidate.createdAt > run.createdAt);
    return {
      ...result(50, "superseded", run.url),
      supersedingRunUrl: supersedingRun?.url ?? "-"
    };
  }
  if (run.conclusion !== "failure") return result(40, "unavailable", run.url);

  const parsedLogs = parseFailedLogs(await github.readFailedLogs(run.databaseId));
  const { failingTests } = parsedLogs;
  const registeredNames = new Set(registry.entries.map((entry) => entry.testName));
  const allRegistered = !parsedLogs.hasUnparsedFailedJob && failingTests.length > 0 &&
    failingTests.every((testName) => registeredNames.has(testName));
  return result(allRegistered ? 20 : 30, allRegistered ? "flake" : "regression", run.url, failingTests);
}

const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function watchMain({
  commitSha,
  registry,
  github,
  intervalMs = 60_000,
  timeoutMs = 5_400_000,
  dryRun = false,
  now = Date.now,
  sleep = defaultSleep
}) {
  const startedAt = now();
  let lastRun;

  while (true) {
    const runs = await github.listRuns(commitSha);
    lastRun = runs.find((candidate) => candidate.event === "push" && candidate.headSha === commitSha);
    if (lastRun?.status === "completed") {
      return classifyCompletedRun(lastRun, registry, github);
    }
    if (dryRun) {
      return result(40, lastRun ? "pending" : "run-missing", lastRun?.url);
    }

    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      return result(40, "timeout", lastRun?.url);
    }
    await sleep(Math.min(intervalMs, timeoutMs - elapsedMs));
  }
}

function flagValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveSeconds(value, flag) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`${flag} must be a positive number`);
  return seconds * 1_000;
}

export function parseMainWatchArgs(args) {
  const commitSha = args[0];
  if (!commitSha || commitSha.startsWith("--")) {
    throw new Error("usage: node tools/main-watch.mjs <merge-commit-sha> [--repo owner/name] [--interval seconds] [--timeout seconds] [--dry-run]");
  }
  if (!/^[0-9a-f]{7,40}$/iu.test(commitSha)) throw new Error("merge commit SHA must be 7 to 40 hexadecimal characters");

  const options = { commitSha, repo: null, intervalMs: 60_000, timeoutMs: 5_400_000, dryRun: false };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--repo") {
      options.repo = flagValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--interval") {
      options.intervalMs = positiveSeconds(flagValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--timeout") {
      options.timeoutMs = positiveSeconds(flagValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    throw new Error(`unknown main-watch option: ${arg}`);
  }
  return options;
}

export function resolveCommitSha(commitSha) {
  const resolved = spawnSync("git", ["rev-parse", `${commitSha}^{commit}`], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  const fullSha = resolved.stdout?.trim();
  if (resolved.status !== 0 || !/^[0-9a-f]{40}$/iu.test(fullSha ?? "")) {
    throw new Error(`merge commit SHA ${commitSha} could not be resolved locally; run git fetch and try again`);
  }
  return fullSha;
}

async function runGh(args) {
  const { stdout } = await execFileAsync("gh", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout;
}

export function createGithubClient(repo) {
  const repoArgs = repo ? ["--repo", repo] : [];
  return {
    async listRuns(commitSha) {
      const output = await runGh([
        "run", "list",
        "--workflow", "rewrite-ci",
        "--branch", "main",
        "--commit", commitSha,
        "--limit", "20",
        "--json", "databaseId,event,headSha,status,conclusion,createdAt,url",
        ...repoArgs
      ]);
      return JSON.parse(output);
    },
    async listNewerMainRuns() {
      const output = await runGh([
        "run", "list",
        "--workflow", "rewrite-ci",
        "--branch", "main",
        "--limit", "20",
        "--json", "databaseId,headSha,createdAt,url",
        ...repoArgs
      ]);
      return JSON.parse(output);
    },
    async readFailedLogs(runId) {
      return runGh(["run", "view", String(runId), "--log-failed", ...repoArgs]);
    }
  };
}

export function formatResultLine(watchResult) {
  if (watchResult.classification === "superseded") {
    return `RESULT: ${watchResult.code} ${watchResult.classification} ${watchResult.runUrl} ${watchResult.supersedingRunUrl}`;
  }
  const failingTests = watchResult.failingTests.length > 0 ? watchResult.failingTests.join(" | ") : "-";
  return `RESULT: ${watchResult.code} ${watchResult.classification} ${watchResult.runUrl} ${failingTests}`;
}

async function main(argv) {
  try {
    const options = parseMainWatchArgs(argv);
    options.commitSha = resolveCommitSha(options.commitSha);
    const registry = validateRegistry(JSON.parse(await readFile(registryPath, "utf8")));
    const watchResult = await watchMain({
      ...options,
      registry,
      github: createGithubClient(options.repo)
    });
    console.log(formatResultLine(watchResult));
    return watchResult.code;
  } catch (error) {
    console.error(`main-watch failed: ${error instanceof Error ? error.message : String(error)}`);
    console.log(formatResultLine(result(40, "unavailable")));
    return 40;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
