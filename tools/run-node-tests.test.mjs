// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { allowedNodeTestV8Flags, collectSlowTests, DEFAULT_TEST_TIMEOUT_MS, filterTestFilesByPrefixes, formatSlowTestSummary, hasIsolationWedgeSignature, parseCompletedTestLine, parseNodeTestV8Flags, parsePosixProcessGroupLine, parseRunnerArgs, resolveTestConcurrency, selectTestFiles, testFilesFromProcessCommand, validateManifest } from "./node-test-runner-lib.mjs";
import { defaultTestTierNames, deriveTestTierManifest, discoverTestTierManifest, parseTestTierMarker, testTierNames } from "./test-tier-manifest.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

function assertNamedStallTermination(output, expectedFile) {
  // Deterministic policy tests own which evidence reaches the threshold first.
  // Process integration owns the stable product outcome shared by every valid
  // path: bounded termination with the responsible file attributed.
  assert.equal(
    output.includes("--test-timeout cannot fire here, so the runner is terminating the test process tree"),
    true,
    output
  );
  assert.equal(
    output.includes(`[node-test-stall] stalled test file(s): ${expectedFile}`),
    true,
    output
  );
  assert.match(output, /\[node-test-stall\] pre-kill diagnostics: report target pid=\d+; grace=2000ms/u);
  assert.match(output, /\[node-test-stall\] sent SIGUSR2 to pid=\d+/u);
  assert.match(
    output,
    /\[node-test-stall\] diagnostic report: no new file within 2000ms|\[node-test-stall\] diagnostic report file:/u
  );
  assert.match(output, /process tree kill completed within 3000ms budget/u);
}

test("parseRunnerArgs accepts tier and slow summary options", () => {
  assert.deepEqual(parseRunnerArgs(["--tier", "fast", "--slow-threshold-ms", "250", "--slow-limit=3"], testTierNames), {
    tier: "fast",
    list: false,
    slowThresholdMs: 250,
    slowLimit: 3,
    testTimeoutMs: DEFAULT_TEST_TIMEOUT_MS,
    concurrency: undefined,
    shard: undefined,
    prefixes: [],
    fixtures: []
  });
});

test("parseRunnerArgs accepts a concurrency cap", () => {
  assert.equal(parseRunnerArgs(["--concurrency", "4"], testTierNames).concurrency, 4);
  assert.equal(parseRunnerArgs(["--concurrency=2"], testTierNames).concurrency, 2);
  assert.throws(() => parseRunnerArgs(["--concurrency", "x"], testTierNames), /--concurrency/u);
});

test("test timeout defaults to three minutes and cannot be disabled", () => {
  assert.equal(DEFAULT_TEST_TIMEOUT_MS, 180_000);
  assert.equal(parseRunnerArgs(["--test-timeout", "240000"], testTierNames).testTimeoutMs, 240_000);
  assert.equal(parseRunnerArgs(["--test-timeout=360000"], testTierNames).testTimeoutMs, 360_000);
  assert.throws(() => parseRunnerArgs(["--test-timeout", "0"], testTierNames), /positive integer/u);
  assert.throws(() => parseRunnerArgs(["--test-timeout=x"], testTierNames), /--test-timeout/u);
});

test("experimental V8 mitigation accepts only the #54918 allowlist", () => {
  assert.deepEqual(parseNodeTestV8Flags(undefined), []);
  assert.deepEqual(parseNodeTestV8Flags(JSON.stringify(allowedNodeTestV8Flags)), allowedNodeTestV8Flags);
  assert.throws(() => parseNodeTestV8Flags("--no-concurrent-recompilation"), /JSON array/u);
  assert.throws(
    () => parseNodeTestV8Flags('["--max-old-space-size=4096"]'),
    /unsupported flag/u
  );
  assert.throws(
    () => parseNodeTestV8Flags('["--no-concurrent-recompilation","--no-concurrent-recompilation"]'),
    /duplicates/u
  );
});

test("runner bounds a non-terminating test and prints timeout next steps", () => {
  const childEnv = {
    ...process.env,
    HARNESS_RUNNER_TIMEOUT_FIXTURE: "child",
    HARNESS_TEST_CONCURRENCY: "1",
    HARNESS_TEST_STALL_DIAGNOSTIC_MS: "250"
  };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "tools/run-node-tests.mjs",
    "--fixture", "tools/test-fixtures/.runner-timeout/intentional-hang.test.mjs",
    "--test-timeout", "1000"
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: childEnv,
    timeout: 15_000
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.equal(result.signal, null, output);
  assert.equal(result.error, undefined, output);
  assert.match(output, /runner timeout fixture becomes intentionally non-terminating/u);
  assert.match(output, /Timeout next steps:/u);
  assert.match(output, /ps -axo pid,ppid,etime,command/u);
  assert.match(output, /HARNESS_DAEMON_PROFILE=isolated/u);
  assert.match(output, /--test-timeout=1000/u);
  assert.match(output, /terminating its process tree/u);
  assert.match(output, /\[node-test-stall\] no test output for \d+ms/u);
  assert.match(output, /\[node-test-stall\] runner active resources:/u);
  // The process-group dump is POSIX-only; Windows keeps its existing taskkill
  // path and prints no `ps` output, so asserting it there would fail closed on
  // a platform the probe deliberately leaves alone.
  if (process.platform === "win32") {
    assert.doesNotMatch(output, /\[node-test-stall\] process group/u);
  } else {
    assert.match(output, /\[node-test-stall\] process group \(pid ppid pgid stat elapsed (?:wait-channel )?argv\):/u);
  }
  const fixtureChildPid = Number(output.match(/runner timeout fixture child pid: (\d+)/u)?.[1]);
  assert.equal(Number.isSafeInteger(fixtureChildPid), true, output);
  assert.throws(() => process.kill(fixtureChildPid, 0), { code: "ESRCH" });
});

test("runner ends a run wedged outside any test body and names what it caught", {
  // The wedge this escalation targets was observed on POSIX CI runners (a
  // futex-blocked child), and naming the stalled file inspects the POSIX
  // process group. Windows keeps its existing taskkill timeout path.
  skip: process.platform === "win32"
    ? "stalled-file naming inspects the POSIX process group; Windows keeps its taskkill path"
    : false
}, () => {
  const childEnv = {
    ...process.env,
    HARNESS_RUNNER_STALL_FIXTURE: "wedge",
    HARNESS_TEST_CONCURRENCY: "1",
    HARNESS_TEST_STALL_DIAGNOSTIC_MS: "250",
    HARNESS_TEST_STALL_ABORT_WINDOWS: "2"
  };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "tools/run-node-tests.mjs",
    "--fixture", "tools/test-fixtures/.runner-stall/wedged-module.test.mjs",
    "--test-timeout", "1000"
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: childEnv,
    timeout: 30_000
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 1, output);
  // The wedge happens before any test is registered, so node never reports a
  // timeout. Asserting its absence is what makes this a test of the escalation
  // rather than of `--test-timeout`.
  assert.doesNotMatch(output, /test timed out after \d+ms/u);
  assertNamedStallTermination(
    output,
    "tools/test-fixtures/.runner-stall/wedged-module.test.mjs"
  );
});

test("runner detects a wedged isolation child while another file keeps producing output", {
  skip: process.platform === "win32"
    ? "stalled-file naming inspects the POSIX process group"
    : false
}, () => {
  const childEnv = {
    ...process.env,
    HARNESS_RUNNER_STALL_FIXTURE: "chatter",
    HARNESS_TEST_CONCURRENCY: "2",
    HARNESS_TEST_STALL_DIAGNOSTIC_MS: "250",
    HARNESS_TEST_STALL_ABORT_WINDOWS: "2"
  };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "tools/run-node-tests.mjs",
    "--fixture", "tools/test-fixtures/.runner-stall/chatter.test.mjs",
    "--fixture", "tools/test-fixtures/.runner-stall/wedged-module.test.mjs",
    "--test-timeout", "1000"
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: childEnv,
    timeout: 15_000
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 1, output);
  assert.match(output, /runner chatter \d+/u);
  assertNamedStallTermination(
    output,
    "tools/test-fixtures/.runner-stall/wedged-module.test.mjs"
  );
});

test("runner preserves a real test failure without classifying it as a wedge", () => {
  const childEnv = {
    ...process.env,
    HARNESS_RUNNER_STALL_FIXTURE: "failing-only",
    HARNESS_TEST_CONCURRENCY: "1",
    HARNESS_TEST_STALL_DIAGNOSTIC_MS: "250",
    HARNESS_TEST_STALL_ABORT_WINDOWS: "2"
  };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "tools/run-node-tests.mjs",
    "--fixture", "tools/test-fixtures/.runner-stall/failing-then-wedge.test.mjs",
    "--test-timeout", "1000"
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: childEnv,
    timeout: 10_000
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 1, output);
  assert.match(output, /✖ runner failing-wedge probe exposes a real failure before shutdown/u);
  assert.match(output, /intentional real failure before shutdown wedge/u);
  assert.doesNotMatch(output, /isolation child pid=\d+ remained wedged/u);
});

test("failed runs preserve stall reports and the completion ledger for workflow upload", () => {
  const diagnosticRoot = mkdtempSync(path.join(tmpdir(), "ha-node-test-diagnostics-"));
  try {
    const childEnv = {
      ...process.env,
      HARNESS_NODE_TEST_DIAGNOSTIC_DIR: diagnosticRoot,
      HARNESS_RUNNER_STALL_FIXTURE: "failing-only",
      HARNESS_TEST_CONCURRENCY: "1"
    };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
      "tools/run-node-tests.mjs",
      "--fixture", "tools/test-fixtures/.runner-stall/failing-then-wedge.test.mjs",
      "--test-timeout", "1000"
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      env: childEnv,
      timeout: 10_000
    });
    const output = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.error, undefined, output);
    assert.equal(result.status, 1, output);
    assert.match(output, /preserved failure diagnostics/u);
    const runDirectories = readdirSync(diagnosticRoot);
    assert.equal(runDirectories.length, 1, output);
    const runRoot = path.join(diagnosticRoot, runDirectories[0]);
    assert.equal(existsSync(path.join(runRoot, "completion-ledger.jsonl")), true);
    assert.equal(readdirSync(runRoot).some((entry) => entry.startsWith("stall-reports-")), true);
    const metadata = JSON.parse(readFileSync(path.join(runRoot, "run.json"), "utf8"));
    assert.equal(metadata.schema, "node-test-failure-diagnostics/v1");
    assert.equal(metadata.taskId, "task_01KY284MZV4KXJP6RV06E3NTN1");
    assert.equal(metadata.result.exitCode, 1);
    assert.deepEqual(metadata.selection.files, [
      "tools/test-fixtures/.runner-stall/failing-then-wedge.test.mjs"
    ]);
  } finally {
    rmSync(diagnosticRoot, { recursive: true, force: true });
  }
});

test("runner treats a real failure hidden by a shutdown wedge as a named wedge failure", {
  skip: process.platform === "win32"
    ? "stalled-file naming inspects the POSIX process group"
    : false
}, () => {
  const childEnv = {
    ...process.env,
    HARNESS_RUNNER_STALL_FIXTURE: "failing-wedge",
    HARNESS_TEST_CONCURRENCY: "1",
    HARNESS_TEST_STALL_DIAGNOSTIC_MS: "250",
    HARNESS_TEST_STALL_ABORT_WINDOWS: "2"
  };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "tools/run-node-tests.mjs",
    "--fixture", "tools/test-fixtures/.runner-stall/failing-then-wedge.test.mjs",
    "--test-timeout", "1000"
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: childEnv,
    timeout: 10_000
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 1, output);
  assertNamedStallTermination(
    output,
    "tools/test-fixtures/.runner-stall/failing-then-wedge.test.mjs"
  );
});

test("runner reaps a completed isolation child without POSIX process inspection", () => {
  const childEnv = {
    ...process.env,
    HARNESS_RUNNER_STALL_FIXTURE: "post-complete-wedge",
    HARNESS_TEST_CONCURRENCY: "1",
    HARNESS_TEST_STALL_DIAGNOSTIC_MS: "250",
    HARNESS_TEST_STALL_ABORT_WINDOWS: "2"
  };
  if (process.platform !== "win32") childEnv.PATH = path.dirname(process.execPath);
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "tools/run-node-tests.mjs",
    "--fixture", "tools/test-fixtures/.runner-stall/post-complete-wedge.test.mjs",
    "--test-timeout", "1000"
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: childEnv,
    timeout: 15_000
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 0, output);
  assert.match(output, /✔ post-complete wedge fixture passes before native-style exit deadlock/u);
  assert.match(output, /\[node-test-stall\] reaped post-completion child pid=\d+ file=tools\/test-fixtures\/\.runner-stall\/post-complete-wedge\.test\.mjs termination=(?:SIGKILL|taskkill)/u);
  assert.match(output, /accepted 1 completed file result\(s\); ignoring only the host-generated forced-termination file failure/u);
});

test("runner preserves a failed proof when the direct worker wedges during exit", () => {
  const childEnv = {
    ...process.env,
    HARNESS_FILE_WORKER_FIXTURE: "failure-post-complete-wedge",
    HARNESS_NODE_TEST_EVENT_TRACE: "1",
    HARNESS_TEST_CONCURRENCY: "1",
    HARNESS_TEST_STALL_DIAGNOSTIC_MS: "250",
    HARNESS_TEST_STALL_ABORT_WINDOWS: "2"
  };
  if (process.platform !== "win32") childEnv.PATH = path.dirname(process.execPath);
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "tools/run-node-tests.mjs",
    "--fixture", "tools/test-fixtures/.runner-stall/failure-post-complete-wedge.test.mjs",
    "--test-timeout", "1000"
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: childEnv,
    timeout: 15_000
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 1, output);
  assert.match(output, /intentional production failure before exit wedge/u);
  assert.match(output, /"phase":"proof-flushed"[^\n]+"success":false/u);
  assert.match(output, /"phase":"settled"[^\n]+"outcome":"failed-after-reap"/u);
  assert.doesNotMatch(output, /accepted 1 completed file result/u);
});

test("runner fails a test file with an unclosed publication reader and names its root", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "publication-reader-runner-leak-"));
  context.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const fixture = "tools/test-fixtures/.runner-stall/post-complete-wedge.test.mjs";
  const childEnv = {
    ...process.env,
    HARNESS_PUBLICATION_READER_FIXTURE_ROOT: root,
    HARNESS_TEST_CONCURRENCY: "1"
  };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "tools/run-node-tests.mjs",
    "--fixture", fixture,
    "--test-timeout", "5000"
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: childEnv,
    timeout: 15_000
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 1, output);
  assert.match(output, /PUBLICATION_READER_LEAK/u);
  assert.match(output, /file=tools\/test-fixtures\/\.runner-stall\/post-complete-wedge\.test\.mjs/u);
  assert.match(output, /readers=1/u);
  const canonicalRoot = realpathSync.native(root);
  assert.match(output, new RegExp(`root=${canonicalRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
});

test("runner waits for an in-flight reap record before accepting the host result", () => {
  const childEnv = {
    ...process.env,
    HARNESS_RUNNER_STALL_FIXTURE: "post-complete-close-before-reap",
    HARNESS_TEST_CONCURRENCY: "1",
    HARNESS_TEST_STALL_DIAGNOSTIC_MS: "250",
    HARNESS_TEST_STALL_ABORT_WINDOWS: "2"
  };
  if (process.platform !== "win32") childEnv.PATH = path.dirname(process.execPath);
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "tools/run-node-tests.mjs",
    "--fixture", "tools/test-fixtures/.runner-stall/post-complete-wedge.test.mjs",
    "--test-timeout", "1000"
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: childEnv,
    timeout: 15_000
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 0, output);
  assert.match(output, /\[node-test-stall\] reaped post-completion child pid=\d+ file=tools\/test-fixtures\/\.runner-stall\/post-complete-wedge\.test\.mjs termination=(?:SIGKILL|taskkill)/u);
  assert.match(output, /accepted 1 completed file result\(s\); ignoring only the host-generated forced-termination file failure/u);
});

test("parseRunnerArgs accepts safe repository-relative test prefixes", () => {
  assert.deepEqual(parseRunnerArgs(["--prefix", "tools", "--prefix=packages/kernel/"], testTierNames).prefixes, [
    "tools/",
    "packages/kernel/"
  ]);
  assert.throws(() => parseRunnerArgs(["--prefix", "../outside"], testTierNames), /repository-relative/u);
});

test("parseRunnerArgs accepts only explicit runner fixture paths", () => {
  assert.deepEqual(
    parseRunnerArgs([
      "--fixture",
      "tools/test-fixtures/.runner-stall/wedged-module.test.mjs"
    ], testTierNames).fixtures,
    ["tools/test-fixtures/.runner-stall/wedged-module.test.mjs"]
  );
  assert.throws(
    () => parseRunnerArgs(["--fixture", "packages/kernel/test/domain.test.ts"], testTierNames),
    /tools\/test-fixtures/u
  );
  assert.throws(
    () => parseRunnerArgs([
      "--fixture",
      "tools/test-fixtures/.runner-stall/wedged-module.test.mjs",
      "--prefix",
      "tools"
    ], testTierNames),
    /cannot be combined/u
  );
});

test("Linux process snapshots distinguish a futex-wedged isolation child", () => {
  const member = parsePosixProcessGroupLine(
    " 8774 2519 2519 Sl 06:11 futex_do_wait /opt/node/bin/node --test-isolation=process tools/graph-panorama.test.mjs",
    "linux"
  );
  assert.deepEqual(member, {
    pid: 8774,
    ppid: 2519,
    pgid: 2519,
    waitChannel: "futex_do_wait",
    command: "/opt/node/bin/node --test-isolation=process tools/graph-panorama.test.mjs"
  });
  assert.equal(hasIsolationWedgeSignature(member), true);
  assert.deepEqual(testFilesFromProcessCommand(member.command, repoRoot), ["tools/graph-panorama.test.mjs"]);
  const healthy = parsePosixProcessGroupLine(
    " 8775 2519 2519 Sl 00:01 ep_poll /opt/node/bin/node --test-isolation=process tools/healthy.test.mjs",
    "linux"
  );
  assert.equal(hasIsolationWedgeSignature(healthy), false);
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
    resolveTestConcurrency({ flagConcurrency: 3, envConcurrency: "8", isCi: false }),
    3
  );
  assert.equal(
    resolveTestConcurrency({ flagConcurrency: 12, envConcurrency: undefined, isCi: true }),
    12
  );
});

test("resolveTestConcurrency honors HARNESS_TEST_CONCURRENCY when no flag is given", () => {
  assert.equal(
    resolveTestConcurrency({ flagConcurrency: undefined, envConcurrency: "8", isCi: false }),
    8
  );
  // A blank or invalid env value falls through to the default path.
  assert.equal(
    resolveTestConcurrency({ flagConcurrency: undefined, envConcurrency: "", isCi: true }),
    undefined
  );
  assert.equal(
    resolveTestConcurrency({ flagConcurrency: undefined, envConcurrency: "0", isCi: true }),
    undefined
  );
});

test("resolveTestConcurrency keeps node's default in CI with no explicit signal", () => {
  assert.equal(
    resolveTestConcurrency({ flagConcurrency: undefined, envConcurrency: undefined, isCi: true }),
    undefined
  );
});

test("resolveTestConcurrency uses a fixed local per-session budget of two", () => {
  assert.equal(
    resolveTestConcurrency({ flagConcurrency: undefined, envConcurrency: undefined, isCi: false }),
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

test("inline test tier markers derive the manifest", () => {
  const manifest = deriveTestTierManifest(
    ["fast.test.ts", "contract.test.ts", "new.test.ts"],
    (file) => `// harness-test-tier: ${file === "new.test.ts" ? "integration" : file.split(".")[0]}\n`
  );
  assert.deepEqual(manifest, {
    fast: ["fast.test.ts"],
    contract: ["contract.test.ts"],
    integration: ["new.test.ts"],
    nightly: []
  });
});

test("inline test tier markers fail closed when missing, repeated, or invalid", () => {
  assert.throws(() => parseTestTierMarker("import test from \"node:test\";\n", "missing.test.ts"), /test tier marker missing: missing\.test\.ts/u);
  assert.throws(
    () => parseTestTierMarker("// harness-test-tier: fast\n// harness-test-tier: contract\n", "duplicate.test.ts"),
    /multiple test tier markers: duplicate\.test\.ts/u
  );
  assert.throws(
    () => parseTestTierMarker("// harness-test-tier: slow\n", "invalid.test.ts"),
    /invalid test tier marker: invalid\.test\.ts/u
  );
  assert.throws(
    () => parseTestTierMarker("import test from \"node:test\";\n// harness-test-tier: fast\n", "late.test.ts"),
    /test tier marker must be the first line: late\.test\.ts/u
  );
  assert.throws(
    () => parseTestTierMarker(`// harness-test-tier: fast\n${"\n".repeat(20)}// harness-test-tier: contract\n`, "distant-duplicate.test.ts"),
    /multiple test tier markers: distant-duplicate\.test\.ts/u
  );
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

test("intentional runner hang fixtures stay outside every production test tier", () => {
  const manifest = discoverTestTierManifest(repoRoot);
  const discovered = Object.values(manifest).flat();
  const fixtures = [
    "tools/test-fixtures/.runner-stall/chatter.test.mjs",
    "tools/test-fixtures/.runner-stall/failing-then-wedge.test.mjs",
    "tools/test-fixtures/.runner-stall/wedged-module.test.mjs",
    "tools/test-fixtures/.runner-timeout/intentional-hang.test.mjs"
  ];

  assert.deepEqual(discovered.filter((file) => fixtures.includes(file)), []);
});

test("list output survives stdout backpressure", () => {
  const manifest = discoverTestTierManifest(repoRoot);
  const childEnv = {
    ...process.env,
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      `--import=${pathToFileURL(path.join(repoRoot, "tools/test-fixtures/delayed-stdout.mjs")).href}`
    ].filter(Boolean).join(" ")
  };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["tools/run-node-tests.mjs", "--tier", "integration", "--list"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: childEnv
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/u), manifest.integration);
});

test("nightly tests run only when explicitly selected", () => {
  const manifest = discoverTestTierManifest(repoRoot);
  const nightly = spawnSync(process.execPath, ["tools/run-node-tests.mjs", "--tier", "nightly", "--list"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(nightly.status, 0, nightly.stderr);
  assert.deepEqual(nightly.stdout.trim().split(/\r?\n/u), manifest.nightly);

  const defaultRun = spawnSync(process.execPath, ["tools/run-node-tests.mjs", "--list"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(defaultRun.status, 0, defaultRun.stderr);
  const expected = defaultTestTierNames.flatMap((tier) => manifest[tier]).sort();
  assert.deepEqual(defaultRun.stdout.trim().split(/\r?\n/u), expected);
  assert.equal(expected.some((file) => manifest.nightly.includes(file)), false);
});

test("selectTestFiles returns sorted tier files from the derived repository manifest", () => {
  const testTierManifest = discoverTestTierManifest(repoRoot);
  const allFiles = Object.values(testTierManifest).flat().sort();
  const result = selectTestFiles(allFiles, testTierManifest, "fast");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.files, [...testTierManifest.fast].sort());
});

test("test prefix filtering reuses the manifest selection without bypassing discovery", () => {
  assert.deepEqual(
    filterTestFilesByPrefixes(
      ["packages/kernel/test/a.test.ts", "packages/cli/test/b.test.ts", "tools/c.test.mjs"],
      ["packages/kernel/", "tools/"]
    ),
    ["packages/kernel/test/a.test.ts", "tools/c.test.mjs"]
  );
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
