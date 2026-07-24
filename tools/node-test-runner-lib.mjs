import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { DEFAULT_LOCAL_TEST_CONCURRENCY } from "./local-resource-governance.mjs";

export const testFilePattern = /\.(test|spec)\.(?:mjs|js|ts)$/u;
export const ignoredDirectoryNames = new Set(["node_modules", "dist", "out", "coverage", ".git"]);
export const DEFAULT_TEST_TIMEOUT_MS = 180_000;

export function parsePosixProcessGroupLine(line, platform = process.platform) {
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/u.exec(line);
  if (match === null) return null;
  const [, pidText, ppidText, pgidText, , , tail] = match;
  if (platform === "darwin") {
    return { pid: Number(pidText), ppid: Number(ppidText), pgid: Number(pgidText), waitChannel: null, command: tail.trim() };
  }
  const waitMatch = /^(\S+)\s+(.+)$/u.exec(tail);
  if (waitMatch === null) return null;
  return {
    pid: Number(pidText),
    ppid: Number(ppidText),
    pgid: Number(pgidText),
    waitChannel: waitMatch[1],
    command: waitMatch[2].trim()
  };
}

export function hasIsolationWedgeSignature(member) {
  return /^futex(?:_|$)/u.test(member.waitChannel ?? "") || member.command.startsWith("ha-node-test-wedge ");
}

export function testFilesFromProcessCommand(command, repoRoot) {
  return command.split(/\s+/u)
    .map((token) => token.startsWith(`${repoRoot}/`) ? token.slice(repoRoot.length + 1) : token)
    .filter((token) => /\.(?:test|fixture)\.(?:ts|tsx|mjs|cjs|js)$/u.test(token));
}

export function parseRunnerArgs(args, tierNames) {
  const options = {
    tier: "all",
    list: false,
    slowThresholdMs: 1000,
    slowLimit: 10,
    testTimeoutMs: DEFAULT_TEST_TIMEOUT_MS,
    concurrency: undefined,
    shard: undefined,
    prefixes: [],
    fixtures: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--tier") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("--tier requires a value");
      options.tier = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--tier=")) {
      options.tier = arg.slice("--tier=".length);
      continue;
    }
    if (arg === "--list") {
      options.list = true;
      continue;
    }
    if (arg === "--slow-threshold-ms") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("--slow-threshold-ms requires a value");
      options.slowThresholdMs = parsePositiveInteger(value, "--slow-threshold-ms");
      index += 1;
      continue;
    }
    if (arg.startsWith("--slow-threshold-ms=")) {
      options.slowThresholdMs = parsePositiveInteger(arg.slice("--slow-threshold-ms=".length), "--slow-threshold-ms");
      continue;
    }
    if (arg === "--slow-limit") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("--slow-limit requires a value");
      options.slowLimit = parsePositiveInteger(value, "--slow-limit");
      index += 1;
      continue;
    }
    if (arg.startsWith("--slow-limit=")) {
      options.slowLimit = parsePositiveInteger(arg.slice("--slow-limit=".length), "--slow-limit");
      continue;
    }
    if (arg === "--test-timeout") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("--test-timeout requires a value");
      options.testTimeoutMs = parseStrictPositiveInteger(value, "--test-timeout");
      index += 1;
      continue;
    }
    if (arg.startsWith("--test-timeout=")) {
      options.testTimeoutMs = parseStrictPositiveInteger(arg.slice("--test-timeout=".length), "--test-timeout");
      continue;
    }
    if (arg === "--concurrency") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("--concurrency requires a value");
      options.concurrency = parsePositiveInteger(value, "--concurrency");
      index += 1;
      continue;
    }
    if (arg.startsWith("--concurrency=")) {
      options.concurrency = parsePositiveInteger(arg.slice("--concurrency=".length), "--concurrency");
      continue;
    }
    if (arg === "--shard") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("--shard requires a value");
      options.shard = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--shard=")) {
      options.shard = arg.slice("--shard=".length);
      continue;
    }
    if (arg === "--prefix") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("--prefix requires a value");
      options.prefixes.push(normalizeTestPrefix(value));
      index += 1;
      continue;
    }
    if (arg.startsWith("--prefix=")) {
      options.prefixes.push(normalizeTestPrefix(arg.slice("--prefix=".length)));
      continue;
    }
    if (arg === "--fixture") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("--fixture requires a value");
      options.fixtures.push(normalizeRunnerFixture(value));
      index += 1;
      continue;
    }
    if (arg.startsWith("--fixture=")) {
      options.fixtures.push(normalizeRunnerFixture(arg.slice("--fixture=".length)));
      continue;
    }

    throw new Error(`unknown run-node-tests option: ${arg}`);
  }

  if (options.tier !== "all" && !tierNames.includes(options.tier)) {
    throw new Error(`unknown test tier: ${options.tier}; expected all, ${tierNames.join(", ")}`);
  }
  if (options.shard !== undefined && options.tier !== "integration") {
    throw new Error("--shard is only supported with --tier integration");
  }
  if (
    options.fixtures.length > 0
    && (
      options.tier !== "all"
      || options.list
      || options.shard !== undefined
      || options.prefixes.length > 0
    )
  ) {
    throw new Error("--fixture cannot be combined with tier, list, shard, or prefix selection");
  }

  return options;
}

function normalizeTestPrefix(value) {
  if (!value || value.startsWith("/") || value.split("/").includes("..") || value.includes("\\")) {
    throw new Error(`--prefix must be a POSIX repository-relative path; received ${JSON.stringify(value)}`);
  }
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeRunnerFixture(value) {
  if (
    !/^tools\/test-fixtures\/\.runner-(?:stall|timeout)\//u.test(value)
    || value.startsWith("/")
    || value.split("/").includes("..")
    || value.includes("\\")
    || !value.endsWith(".test.mjs")
  ) {
    throw new Error(`--fixture must name a hidden tools/test-fixtures/.runner-*/*.test.mjs file; received ${JSON.stringify(value)}`);
  }
  return value;
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function parseStrictPositiveInteger(value, label) {
  const parsed = parsePositiveInteger(value, label);
  if (parsed === 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export async function collectTestFiles(repoRoot, roots) {
  const testFiles = (
    await Promise.all(roots.map((root) => collectFromDirectory(resolve(repoRoot, root), repoRoot)))
  ).flat().sort();

  return testFiles;
}

async function collectFromDirectory(directory, repoRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") || ignoredDirectoryNames.has(entry.name)) {
      continue;
    }

    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFromDirectory(entryPath, repoRoot));
      continue;
    }

    if (entry.isFile() && testFilePattern.test(entry.name)) {
      files.push(relative(repoRoot, entryPath).split("\\").join("/"));
    }
  }

  return files;
}

export function selectTestFiles(testFiles, manifest, tier) {
  const validation = validateManifest(testFiles, manifest);
  if (validation.errors.length > 0) {
    return { files: [], errors: validation.errors };
  }

  if (tier === "all") {
    return { files: testFiles, errors: [] };
  }

  return { files: [...manifest[tier]].sort(), errors: [] };
}

export function filterTestFilesByPrefixes(files, prefixes) {
  if (prefixes.length === 0) return [...files];
  return files.filter((file) => prefixes.some((prefix) => file.startsWith(prefix)));
}

export function validateManifest(testFiles, manifest) {
  const actual = new Set(testFiles);
  const seen = new Map();
  const errors = [];

  for (const [tier, files] of Object.entries(manifest)) {
    for (const file of files) {
      if (!actual.has(file)) {
        errors.push(`test tier manifest references missing file: ${tier}: ${file}`);
      }
      const previous = seen.get(file);
      if (previous !== undefined) {
        errors.push(`test file appears in multiple tiers: ${file} (${previous}, ${tier})`);
      }
      seen.set(file, tier);
    }
  }

  for (const file of testFiles) {
    if (!seen.has(file)) {
      errors.push(`test file missing from tier manifest: ${file}`);
    }
  }

  return { errors };
}

/**
 * Resolve the effective `--test-concurrency` value.
 *
 * Precedence: explicit `--concurrency` flag wins; then `HARNESS_TEST_CONCURRENCY`
 * env; then, only in a non-CI environment, the fixed per-session budget. In CI
 * (`env.CI` set) with no explicit signal, we return
 * `undefined` so node --test keeps its own default (cores-1) — CI runners are
 * sized for it and we must not change CI test semantics.
 *
 * @param {object} params
 * @param {number|undefined} params.flagConcurrency parsed `--concurrency` value
 * @param {string|undefined} params.envConcurrency raw `HARNESS_TEST_CONCURRENCY`
 * @param {boolean} params.isCi whether this is a CI environment
 * @returns {number|undefined} concurrency to pass, or undefined for node default
 */
export function resolveTestConcurrency({ flagConcurrency, envConcurrency, isCi }) {
  if (flagConcurrency !== undefined && Number.isInteger(flagConcurrency) && flagConcurrency > 0) {
    return flagConcurrency;
  }

  if (envConcurrency !== undefined && envConcurrency !== "") {
    const parsed = Number.parseInt(envConcurrency, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  if (isCi) {
    return undefined;
  }

  return DEFAULT_LOCAL_TEST_CONCURRENCY;
}

export function parseCompletedTestLine(line) {
  const normalized = stripAnsi(line).trim();
  const match = normalized.match(/^✔ (.+) \((\d+(?:\.\d+)?)ms\)$/u);
  if (match === null) return null;
  return { name: match[1], durationMs: Number(match[2]) };
}

export function stripAnsi(value) {
  return value.replace(/\u001B\[[0-9;]*m/gu, "");
}

export function collectSlowTests(output, thresholdMs) {
  return output
    .split(/\r?\n/u)
    .map(parseCompletedTestLine)
    .filter((entry) => entry !== null && entry.durationMs >= thresholdMs)
    .sort((left, right) => right.durationMs - left.durationMs);
}

export function formatSlowTestSummary(slowTests, thresholdMs, limit) {
  const visible = slowTests.slice(0, limit);
  if (visible.length === 0) {
    return `Slow test summary: no tests at or above ${thresholdMs}ms.`;
  }

  return [
    `Slow test summary: top ${visible.length} tests at or above ${thresholdMs}ms`,
    ...visible.map((test, index) => `${index + 1}. ${test.durationMs.toFixed(3)}ms ${test.name}`)
  ].join("\n");
}

export function formatTestTimeoutGuidance(output, timeoutMs) {
  const timedOutTests = collectTimedOutTestNames(output);
  if (timedOutTests.length === 0) return null;

  return [
    "Timeout next steps:",
    `Timed out ${timedOutTests.length === 1 ? "test" : "tests"}: ${timedOutTests.join(", ")}`,
    "A daemon test may be blocked by another local daemon using its socket.",
    "Inspect lingering daemon processes:",
    "  ps -axo pid,ppid,etime,command | rg '[h]arness-anything.*daemon serve'",
    "Re-run the timed-out file with an isolated daemon profile:",
    `  env -u HARNESS_DAEMON_USER_ROOT HARNESS_DAEMON_PROFILE=isolated node --test --test-timeout=${timeoutMs} <test-file>`
  ].join("\n");
}

function collectTimedOutTestNames(output) {
  const lines = output.split(/\r?\n/u).map((line) => stripAnsi(line).trim());
  const names = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    if (!/test timed out after \d+ms/u.test(lines[index] ?? "")) continue;
    for (let candidate = index - 1; candidate >= Math.max(0, index - 3); candidate -= 1) {
      const match = lines[candidate]?.match(/^✖ (.+) \(\d+(?:\.\d+)?ms\)$/u);
      if (match !== null && match !== undefined) {
        names.add(match[1]);
        break;
      }
    }
  }
  return [...names];
}
