import assert from "node:assert/strict";
import test from "node:test";
import { collectSlowTests, formatSlowTestSummary, parseCompletedTestLine, parseRunnerArgs, selectTestFiles, validateManifest } from "./node-test-runner-lib.mjs";
import { testTierManifest, testTierNames } from "./test-tier-manifest.mjs";

test("parseRunnerArgs accepts tier and slow summary options", () => {
  assert.deepEqual(parseRunnerArgs(["--tier", "fast", "--slow-threshold-ms", "250", "--slow-limit=3"], testTierNames), {
    tier: "fast",
    list: false,
    slowThresholdMs: 250,
    slowLimit: 3
  });
});

test("parseRunnerArgs rejects unknown tiers and options", () => {
  assert.throws(() => parseRunnerArgs(["--tier", "unit"], testTierNames), /unknown test tier/u);
  assert.throws(() => parseRunnerArgs(["--bogus"], testTierNames), /unknown run-node-tests option/u);
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

test("selectTestFiles returns sorted tier files from the repository manifest", () => {
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
