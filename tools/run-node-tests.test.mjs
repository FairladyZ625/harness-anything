// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";

// A bounded wait whose timer never keeps the test process alive on its own.
function boundedWait(ms) {
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, ms);
    timer.unref();
  });
}
import {
  collectSlowTests,
  filterTestFilesByNames,
  filterTestFilesByPrefixes,
  formatSlowTestSummary,
  parseCompletedTestLine,
  parseRunnerArgs,
  resolveTestConcurrency,
  selectTestFiles,
  validateManifest,
} from "./node-test-runner-lib.mjs";
import {
  deriveTestTierManifest,
  discoverTestFileTimeouts,
  discoverTestTierManifest,
  parseTestFileTimeoutMarker,
  parseTestTierMarker,
  testTierNames,
} from "./test-tier-manifest.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("parseRunnerArgs accepts tier and slow summary options", () => {
  assert.deepEqual(parseRunnerArgs(["--tier", "fast", "--slow-threshold-ms", "250", "--slow-limit=3"], testTierNames), {
    tier: "fast",
    list: false,
    slowThresholdMs: 250,
    slowLimit: 3,
    concurrency: undefined,
    shard: undefined,
    prefixes: [],
    files: [],
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

test("parseRunnerArgs accepts safe repository-relative test prefixes", () => {
  assert.deepEqual(parseRunnerArgs(["--prefix", "tools", "--prefix=packages/kernel/"], testTierNames).prefixes, [
    "tools/",
    "packages/kernel/",
  ]);
  assert.throws(() => parseRunnerArgs(["--prefix", "../outside"], testTierNames), /repository-relative/u);
});

test("parseRunnerArgs accepts safe repository-relative test files", () => {
  assert.deepEqual(
    parseRunnerArgs(
      ["--file", "tools/run-node-tests.test.mjs", "--file=packages/kernel/test/domain/domain-status.test.ts"],
      testTierNames,
    ).files,
    ["tools/run-node-tests.test.mjs", "packages/kernel/test/domain/domain-status.test.ts"],
  );
  assert.throws(
    () => parseRunnerArgs(["--file", "../outside.test.mjs"], testTierNames),
    /repository-relative test file/u,
  );
  assert.throws(
    () => parseRunnerArgs(["--file", "tools/not-a-test.mjs"], testTierNames),
    /repository-relative test file/u,
  );
  assert.throws(
    () => parseRunnerArgs(["--tier", "integration", "--shard", "1", "--file", "tools/a.test.mjs"], testTierNames),
    /cannot be combined/u,
  );
});

test("filterTestFilesByPrefixes keeps only selected repository paths", () => {
  assert.deepEqual(
    filterTestFilesByPrefixes(
      ["tools/a.test.mjs", "packages/kernel/b.test.ts", "packages/gui/c.test.ts"],
      ["tools/", "packages/kernel/"],
    ),
    ["tools/a.test.mjs", "packages/kernel/b.test.ts"],
  );
});

test("filterTestFilesByNames keeps only exact selected repository paths", () => {
  assert.deepEqual(
    filterTestFilesByNames(
      ["tools/a.test.mjs", "packages/kernel/b.test.ts", "packages/gui/c.test.ts"],
      ["packages/kernel/b.test.ts", "tools/a.test.mjs"],
    ),
    ["tools/a.test.mjs", "packages/kernel/b.test.ts"],
  );
});

test("runner watchdog fails and names a file whose process keeps an open handle", () => {
  const childEnv = {
    ...process.env,
    HARNESS_RUNNER_OPEN_HANDLE_FIXTURE: "1",
    HARNESS_TEST_FILE_TIMEOUT_MS: "250",
  };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["tools/run-node-tests.mjs", "--tier", "fast", "--prefix", "tools/test-fixtures/runner-watchdog"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: childEnv,
      timeout: 10_000,
    },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 1, output);
  assert.match(
    output,
    /\[node-test-watchdog\] test file exceeded timeout: tools\/test-fixtures\/runner-watchdog\/open-handle\.test\.mjs/u,
  );
});

function runUnboundedFixture(extraEnv) {
  const childEnv = {
    ...process.env,
    HARNESS_RUNNER_UNBOUNDED_FIXTURE: "1",
    HARNESS_TEST_FILE_TIMEOUT_MS: "250",
  };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.CI;
  Object.assign(childEnv, extraEnv);
  const result = spawnSync(
    process.execPath,
    ["tools/run-node-tests.mjs", "--tier", "fast", "--file", "tools/stress/runner-unbounded-fixture.test.mjs"],
    { cwd: repoRoot, encoding: "utf8", env: childEnv, timeout: 20_000 },
  );
  return { result, output: `${result.stdout}\n${result.stderr}` };
}

test("an unbounded stress marker is honoured outside CI and ignored under CI", () => {
  const local = runUnboundedFixture({});
  assert.equal(local.result.status, 0, local.output);
  assert.doesNotMatch(local.output, /test file exceeded timeout/u);
  const ci = runUnboundedFixture({ CI: "true" });
  assert.equal(ci.result.status, 1, ci.output);
  assert.match(
    ci.output,
    /\[node-test-watchdog\] test file exceeded timeout: tools\/stress\/runner-unbounded-fixture\.test\.mjs/u,
  );
});

test("test file timeout markers allow stress opt-in and numeric values", () => {
  assert.equal(
    parseTestFileTimeoutMarker(
      "// harness-test-tier: integration\n// harness-test-file-timeout: none\n",
      "tools/stress/example.test.mjs",
    ),
    "none",
  );
  assert.equal(
    parseTestFileTimeoutMarker(
      "// harness-test-tier: fast\n// harness-test-file-timeout: 1234\n",
      "tools/example.test.mjs",
    ),
    1234,
  );
  assert.throws(
    () =>
      parseTestFileTimeoutMarker(
        "// harness-test-tier: fast\n// harness-test-file-timeout: none\n",
        "tools/example.test.mjs",
      ),
    /only allowed under tools\/stress/u,
  );
});

test("discoverTestFileTimeouts returns only explicit file overrides", () => {
  assert.deepEqual(
    discoverTestFileTimeouts(repoRoot, {
      roots: ["tools/test-fixtures/runner-watchdog"],
    }),
    { "tools/test-fixtures/runner-watchdog/open-handle.test.mjs": undefined },
  );
});

test("a --prefix that selects nothing fails instead of reporting a clean run", () => {
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  for (const prefix of ["packages/does-not-exist", "tools/run-node-tests.test.mjs"]) {
    const result = spawnSync(process.execPath, ["tools/run-node-tests.mjs", "--tier", "fast", "--prefix", prefix], {
      cwd: repoRoot,
      encoding: "utf8",
      env: childEnv,
      timeout: 30_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.match(output, /No test file in tier fast starts with any of/u);
  }
});

test("resolveTestConcurrency prefers the explicit flag over env and defaults", () => {
  assert.equal(
    resolveTestConcurrency({ flagConcurrency: 3, envConcurrency: "8", isCi: false, availableParallelism: 16 }),
    3,
  );
  assert.equal(
    resolveTestConcurrency({ flagConcurrency: 12, envConcurrency: undefined, isCi: true, availableParallelism: 16 }),
    12,
  );
});

test("resolveTestConcurrency honors HARNESS_TEST_CONCURRENCY when no flag is given", () => {
  assert.equal(
    resolveTestConcurrency({ flagConcurrency: undefined, envConcurrency: "8", isCi: false, availableParallelism: 16 }),
    8,
  );
  // A blank or invalid env value falls through to the default path.
  assert.equal(
    resolveTestConcurrency({ flagConcurrency: undefined, envConcurrency: "", isCi: true, availableParallelism: 16 }),
    undefined,
  );
  assert.equal(
    resolveTestConcurrency({ flagConcurrency: undefined, envConcurrency: "0", isCi: true, availableParallelism: 16 }),
    undefined,
  );
});

test("resolveTestConcurrency keeps node's default in CI with no explicit signal", () => {
  assert.equal(
    resolveTestConcurrency({
      flagConcurrency: undefined,
      envConcurrency: undefined,
      isCi: true,
      availableParallelism: 16,
    }),
    undefined,
  );
});

test("resolveTestConcurrency uses a fixed local per-session budget of two", () => {
  assert.equal(resolveTestConcurrency({ flagConcurrency: undefined, envConcurrency: undefined, isCi: false }), 2);
});

test("selectTestFiles fails closed when a test file is unclassified", () => {
  const result = selectTestFiles(["known.test.ts", "missing.test.ts"], { fast: ["known.test.ts"] }, "all");
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.errors, ["test file missing from tier manifest: missing.test.ts"]);
});

test("validateManifest rejects duplicates and missing manifest entries", () => {
  const validation = validateManifest(["a.test.ts"], {
    fast: ["a.test.ts"],
    contract: ["a.test.ts", "gone.test.ts"],
  });
  assert.deepEqual(validation.errors, [
    "test file appears in multiple tiers: a.test.ts (fast, contract)",
    "test tier manifest references missing file: contract: gone.test.ts",
  ]);
});

test("inline test tier markers derive the manifest", () => {
  const manifest = deriveTestTierManifest(
    ["fast.test.ts", "contract.test.ts", "new.test.ts"],
    (file) => `// harness-test-tier: ${file === "new.test.ts" ? "integration" : file.split(".")[0]}\n`,
  );
  assert.deepEqual(manifest, {
    fast: ["fast.test.ts"],
    contract: ["contract.test.ts"],
    integration: ["new.test.ts"],
  });
});

test("inline test tier markers fail closed when missing, repeated, or invalid", () => {
  assert.throws(
    () => parseTestTierMarker('import test from "node:test";\n', "missing.test.ts"),
    /test tier marker missing: missing\.test\.ts/u,
  );
  assert.throws(
    () => parseTestTierMarker("// harness-test-tier: fast\n// harness-test-tier: contract\n", "duplicate.test.ts"),
    /multiple test tier markers: duplicate\.test\.ts/u,
  );
  assert.throws(
    () => parseTestTierMarker("// harness-test-tier: slow\n", "invalid.test.ts"),
    /invalid test tier marker: invalid\.test\.ts/u,
  );
  assert.throws(
    () => parseTestTierMarker('import test from "node:test";\n// harness-test-tier: fast\n', "late.test.ts"),
    /test tier marker must be the first line: late\.test\.ts/u,
  );
  assert.throws(
    () =>
      parseTestTierMarker(
        `// harness-test-tier: fast\n${"\n".repeat(20)}// harness-test-tier: contract\n`,
        "distant-duplicate.test.ts",
      ),
    /multiple test tier markers: distant-duplicate\.test\.ts/u,
  );
});

test("integration discovery equals the files executed by the CI runner", () => {
  const manifest = discoverTestTierManifest(repoRoot);
  const result = spawnSync(process.execPath, ["tools/run-node-tests.mjs", "--tier", "integration", "--list"], {
    cwd: repoRoot,
    encoding: "utf8",
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
    durationMs: 4765.862208,
  });

  const slow = collectSlowTests(
    ["✔ fast thing (3.2ms)", "✔ slow thing (1200.5ms)", "✔ slower thing (2200ms)"].join("\n"),
    1000,
  );

  assert.deepEqual(
    slow.map((entry) => entry.name),
    ["slower thing", "slow thing"],
  );
  assert.equal(
    formatSlowTestSummary(slow, 1000, 1),
    ["Slow test summary: top 1 tests at or above 1000ms", "1. 2200.000ms slower thing"].join("\n"),
  );
});

test("forwarded failing-test details survive a stdout consumer that lags behind the pipe", async () => {
  const childEnv = { ...process.env, HARNESS_RUNNER_OUTPUT_DRAIN_FIXTURE: "1" };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(
    process.execPath,
    ["tools/run-node-tests.mjs", "--tier", "fast", "--prefix", "tools/test-fixtures/runner-output-drain"],
    { cwd: repoRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  // Read stdout the way a slow CI log consumer does: a throttled pump that stays well behind the
  // fixture's burst, so the OS pipe stays full and the runner's remaining writes sit queued in
  // its userspace buffer. A runner that force-exits drops that queue — the failing-tests recap
  // lives at the very end of it — while a runner that exits naturally cannot exit at all until
  // the pipe drains, so a bounded wait for its exit is what tells the two apart.
  let stdout = "";
  const pump = setInterval(() => {
    const chunk = child.stdout.read(4 * 1024);
    if (chunk !== null) stdout += chunk;
  }, 100);
  await Promise.race([once(child, "exit"), boundedWait(1_500)]);
  clearInterval(pump);
  child.stdout.on("data", (text) => {
    stdout += text;
  });
  child.stdout.resume();
  let guardFired = false;
  const guard = setTimeout(() => {
    guardFired = true;
    child.kill("SIGKILL");
  }, 30_000);
  guard.unref();
  const [status] = await once(child, "close");
  clearTimeout(guard);
  assert.equal(guardFired, false, "runner never exited after stdout drained");
  assert.equal(status, 1, stdout);
  assert.match(stdout, /✖ failing tests:/u, "failing-tests recap was lost to a backpressured pipe");
  assert.match(stdout, /runner output drain fixture assertion/u, "assertion details were lost to a backpressured pipe");
});
