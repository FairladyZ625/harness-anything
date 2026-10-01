import { linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, posix, relative, resolve } from "node:path";
import { parseToolOptions, runNodeTestsCommand, toolOption, toolValue, toolValues } from "./tool-command-contract.mjs";

export const testFilePattern = /\.(test|spec)\.(?:mjs|js|ts)$/u;
export const ignoredDirectoryNames = new Set(["node_modules", "dist", "out", "coverage", ".git"]);

export function parseRunnerArgs(args) {
  const parsed = parseToolOptions(runNodeTestsCommand, args);
  if (parsed.help) return { help: true };
  const options = {
    tier: toolValue(parsed, "--tier") ?? toolOption(runNodeTestsCommand, "--tier").defaultValue,
    list: parsed.booleans.has("--list"),
    slowThresholdMs: Number(
      toolValue(parsed, "--slow-threshold-ms") ?? toolOption(runNodeTestsCommand, "--slow-threshold-ms").defaultValue,
    ),
    slowLimit: Number(
      toolValue(parsed, "--slow-limit") ?? toolOption(runNodeTestsCommand, "--slow-limit").defaultValue,
    ),
    concurrency: optionalNumber(toolValue(parsed, "--concurrency")),
    shard: toolValue(parsed, "--shard"),
    coverage: toolValue(parsed, "--coverage"),
    prefixes: toolValues(parsed, "--prefix").map(normalizeTestPrefix),
    files: toolValues(parsed, "--file").map(normalizeTestFile),
  };
  return options;
}

export function coverageReporterArgs(coveragePath) {
  return coveragePath === undefined
    ? []
    : ["--experimental-test-coverage", "--test-reporter=lcov", `--test-reporter-destination=${coveragePath}`];
}

function optionalNumber(value) {
  return value === undefined ? undefined : Number(value);
}

function normalizeTestPrefix(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeTestFile(value) {
  return value;
}

export async function collectTestFiles(repoRoot, roots) {
  const testFiles = (await Promise.all(roots.map((root) => collectFromDirectory(resolve(repoRoot, root), repoRoot))))
    .flat()
    .sort();

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
      files.push(...(await collectFromDirectory(entryPath, repoRoot)));
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

export function filterTestFilesByNames(files, names) {
  if (names.length === 0) return [...files];
  const selected = new Set(names);
  return files.filter((file) => selected.has(file));
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
 * env; then, only in a non-CI environment, a fixed per-session budget of two.
 * In CI (`env.CI` set) with no explicit signal, we return
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

  return 2;
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
    ...visible.map((test, index) => `${index + 1}. ${test.durationMs.toFixed(3)}ms ${test.name}`),
  ].join("\n");
}

// The CLI launches the daemon from packages/daemon/dist, never from packages/daemon/src, so a
// test that runs the CLI measures that build. Such a test has to name the CLI entry to run it,
// in its own text or in a test-support file it imports; production sources are not followed.
const cliEntryPattern = /cli\/(?:src\/index\.ts|dist\/cli\/src\/index\.js)/u;
const relativeImportPattern = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+\.(?:ts|mjs|js))["']/gu;

export function runsCliEntry(files, readSource) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return false;
    seen.add(file);
    const source = readSource(file);
    if (source === undefined) return false;
    if (cliEntryPattern.test(source)) return true;
    return [...source.matchAll(relativeImportPattern)]
      .map((match) => posix.normalize(posix.join(posix.dirname(file), match[1])))
      .filter((imported) => !/(?:^|\/)src\//u.test(imported))
      .some(visit);
  };
  return files.some(visit);
}

/**
 * Build once when the marker the build writes last is missing or older than any build input.
 * Two runs in one checkout share the output directory, so the build is serialized on a lock
 * file holding its owner's pid; a lock whose owner is gone is taken over.
 * @returns {"fresh"|"built"}
 */
export function ensureFreshBuild({ markerPath, lockPath, listInputs, build }) {
  if (!buildIsStale(markerPath, listInputs())) return "fresh";
  mkdirSync(dirname(lockPath), { recursive: true });
  while (!tryAcquireBuildLock(lockPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  try {
    // The run that held the lock may have built exactly what this one was about to.
    if (!buildIsStale(markerPath, listInputs())) return "fresh";
    build();
    return "built";
  } finally {
    rmSync(lockPath, { force: true });
  }
}

function buildIsStale(markerPath, inputs) {
  const builtAt = statSync(markerPath, { throwIfNoEntry: false })?.mtimeMs;
  // No input list means the lister itself failed; the build reports why.
  if (builtAt === undefined || inputs === undefined) return true;
  return inputs.some((input) => (statSync(input, { throwIfNoEntry: false })?.mtimeMs ?? 0) > builtAt);
}

function tryAcquireBuildLock(lockPath) {
  // Linking a file that already holds the pid makes the lock appear with its owner in one step.
  const claim = `${lockPath}.${process.pid}`;
  writeFileSync(claim, `${process.pid}\n`);
  try {
    linkSync(claim, lockPath);
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  } finally {
    rmSync(claim, { force: true });
  }
  if (!buildLockOwnerAlive(lockPath)) rmSync(lockPath, { force: true });
  return false;
}

function buildLockOwnerAlive(lockPath) {
  let owner;
  try {
    owner = Number(readFileSync(lockPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return true;
  }
  if (!Number.isSafeInteger(owner) || owner <= 0) return false;
  try {
    process.kill(owner, 0);
    return true;
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    return false;
  }
}
