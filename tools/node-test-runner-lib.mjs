import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

export const testFilePattern = /\.(test|spec)\.(?:mjs|js|ts)$/u;
export const ignoredDirectoryNames = new Set(["node_modules", "dist", "out", "coverage", ".git"]);

export function parseRunnerArgs(args, tierNames) {
  const options = {
    tier: "all",
    list: false,
    slowThresholdMs: 1000,
    slowLimit: 10,
    concurrency: undefined
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

    throw new Error(`unknown run-node-tests option: ${arg}`);
  }

  if (options.tier !== "all" && !tierNames.includes(options.tier)) {
    throw new Error(`unknown test tier: ${options.tier}; expected all, ${tierNames.join(", ")}`);
  }

  return options;
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
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
 * env; then, only in a non-CI environment, a laptop-friendly default derived from
 * available cores. In CI (`env.CI` set) with no explicit signal, we return
 * `undefined` so node --test keeps its own default (cores-1) — CI runners are
 * sized for it and we must not change CI test semantics.
 *
 * @param {object} params
 * @param {number|undefined} params.flagConcurrency parsed `--concurrency` value
 * @param {string|undefined} params.envConcurrency raw `HARNESS_TEST_CONCURRENCY`
 * @param {boolean} params.isCi whether this is a CI environment
 * @param {number} params.availableParallelism available logical cores
 * @returns {number|undefined} concurrency to pass, or undefined for node default
 */
export function resolveTestConcurrency({ flagConcurrency, envConcurrency, isCi, availableParallelism }) {
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

  const cores = Number.isInteger(availableParallelism) && availableParallelism > 0 ? availableParallelism : 1;
  return Math.min(6, Math.max(2, cores - 2));
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
