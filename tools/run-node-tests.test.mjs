import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { collectSlowTests, formatSlowTestSummary, parseCompletedTestLine, parseRunnerArgs, resolveTestConcurrency, selectTestFiles, validateManifest } from "./node-test-runner-lib.mjs";
import { deriveTestTierManifest, discoverTestTierManifest, testTierNames } from "./test-tier-manifest.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("parseRunnerArgs accepts tier and slow summary options", () => {
  assert.deepEqual(parseRunnerArgs(["--tier", "fast", "--slow-threshold-ms", "250", "--slow-limit=3"], testTierNames), {
    tier: "fast",
    list: false,
    slowThresholdMs: 250,
    slowLimit: 3,
    concurrency: undefined,
    shard: undefined
  });
});

test("parseRunnerArgs accepts a concurrency cap", () => {
  assert.equal(parseRunnerArgs(["--concurrency", "4"], testTierNames).concurrency, 4);
  assert.equal(parseRunnerArgs(["--concurrency=2"], testTierNames).concurrency, 2);
  assert.throws(() => parseRunnerArgs(["--concurrency", "x"], testTierNames), /--concurrency/u);
});

test("parseRunnerArgs accepts integration shards only for the integration tier", () => {
  assert.equal(parseRunnerArgs(["--tier", "integration", "--shard", "3"], testTierNames).shard, "3");
  assert.equal(parseRunnerArgs(["--tier=integration", "--shard=2"], testTierNames).shard, "2");
  assert.throws(() => parseRunnerArgs(["--tier", "fast", "--shard", "1"], testTierNames), /--shard is only supported/u);
});

test("parseRunnerArgs rejects unknown tiers and options", () => {
  assert.throws(() => parseRunnerArgs(["--tier", "unit"], testTierNames), /unknown test tier/u);
  assert.throws(() => parseRunnerArgs(["--bogus"], testTierNames), /unknown run-node-tests option/u);
});

test("resolveTestConcurrency prefers the explicit flag over env and defaults", () => {
  assert.equal(
    resolveTestConcurrency({ flagConcurrency: 3, envConcurrency: "8", isCi: false, availableParallelism: 16 }),
    3
  );
  assert.equal(
    resolveTestConcurrency({ flagConcurrency: 12, envConcurrency: undefined, isCi: true, availableParallelism: 16 }),
    12
  );
});

test("resolveTestConcurrency honors HARNESS_TEST_CONCURRENCY when no flag is given", () => {
  assert.equal(
    resolveTestConcurrency({ flagConcurrency: undefined, envConcurrency: "8", isCi: false, availableParallelism: 16 }),
    8
  );
  // A blank or invalid env value falls through to the default path.
  assert.equal(
    resolveTestConcurrency({ flagConcurrency: undefined, envConcurrency: "", isCi: true, availableParallelism: 16 }),
    undefined
  );
  assert.equal(
    resolveTestConcurrency({ flagConcurrency: undefined, envConcurrency: "0", isCi: true, availableParallelism: 16 }),
    undefined
  );
});

test("resolveTestConcurrency keeps node's default in CI with no explicit signal", () => {
  assert.equal(
    resolveTestConcurrency({ flagConcurrency: undefined, envConcurrency: undefined, isCi: true, availableParallelism: 16 }),
    undefined
  );
});

test("resolveTestConcurrency caps the non-CI default to min(6, max(2, cores-2))", () => {
  // 16 cores -> min(6, 14) = 6
  assert.equal(
    resolveTestConcurrency({ flagConcurrency: undefined, envConcurrency: undefined, isCi: false, availableParallelism: 16 }),
    6
  );
  // 4 cores -> min(6, max(2, 2)) = 2
  assert.equal(
    resolveTestConcurrency({ flagConcurrency: undefined, envConcurrency: undefined, isCi: false, availableParallelism: 4 }),
    2
  );
  // 8 cores -> min(6, max(2, 6)) = 6
  assert.equal(
    resolveTestConcurrency({ flagConcurrency: undefined, envConcurrency: undefined, isCi: false, availableParallelism: 8 }),
    6
  );
  // 1 core -> floor at 2
  assert.equal(
    resolveTestConcurrency({ flagConcurrency: undefined, envConcurrency: undefined, isCi: false, availableParallelism: 1 }),
    2
  );
});

test("selectTestFiles fails closed when a test file is unclassified", () => {
  const result = selectTestFiles(["known.test.ts", "missing.test.ts"], { fast: ["known.test.ts"] }, "all");
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.errors, ["test file missing from tier manifest: missing.test.ts"]);
});

test("validateManifest rejects duplicates and missing manifest entries", () => {
  const validation = validateManifest(["a.test.ts"], {
    fast: ["a.test.ts"],
    contract: ["a.test.ts", "gone.test.ts"]
  });
  assert.deepEqual(validation.errors, [
    "test file appears in multiple tiers: a.test.ts (fast, contract)",
    "test tier manifest references missing file: contract: gone.test.ts"
  ]);
});

test("unregistered test files default to the integration tier", () => {
  const manifest = deriveTestTierManifest(
    ["fast.test.ts", "contract.test.ts", "new.test.ts"],
    { fast: ["fast.test.ts"], contract: ["contract.test.ts"] }
  );
  assert.deepEqual(manifest, {
    fast: ["fast.test.ts"],
    contract: ["contract.test.ts"],
    integration: ["new.test.ts"]
  });
});

test("integration discovery equals the files executed by the CI runner", () => {
  const manifest = discoverTestTierManifest(repoRoot);
  const result = spawnSync(process.execPath, ["tools/run-node-tests.mjs", "--tier", "integration", "--list"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/u), manifest.integration);
});

test("selectTestFiles returns sorted tier files from the derived repository manifest", () => {
  const testTierManifest = discoverTestTierManifest(repoRoot);
  const allFiles = Object.values(testTierManifest).flat().sort();
  const result = selectTestFiles(allFiles, testTierManifest, "fast");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.files, [...testTierManifest.fast].sort());
});

test("slow test summary parses node test output and formats top entries", () => {
  assert.deepEqual(parseCompletedTestLine("✔ CLI task delete (4765.862208ms)"), {
    name: "CLI task delete",
    durationMs: 4765.862208
  });

  const slow = collectSlowTests([
    "✔ fast thing (3.2ms)",
    "✔ slow thing (1200.5ms)",
    "✔ slower thing (2200ms)"
  ].join("\n"), 1000);

  assert.deepEqual(slow.map((entry) => entry.name), ["slower thing", "slow thing"]);
  assert.equal(formatSlowTestSummary(slow, 1000, 1), [
    "Slow test summary: top 1 tests at or above 1000ms",
    "1. 2200.000ms slower thing"
  ].join("\n"));
});
