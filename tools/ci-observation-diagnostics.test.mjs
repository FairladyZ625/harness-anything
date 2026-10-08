// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { boundedCiSummary } from "./node-test-runner-lib.mjs";
import { ciFailureDiagnostic, ciTestOutcome } from "./node-test-observation-reporter.mjs";

test("failure diagnostics preserve causes and unbounded cold stacks", () => {
  const cause = new Error("assertion failed");
  const wrapper = Object.assign(new Error("test failed", { cause }), { code: "ERR_TEST_FAILURE" });
  assert.equal(ciFailureDiagnostic(wrapper).failureSummary, "assertion failed");
  const error = new Error("", { cause });
  error.stack = "stack".repeat(1000);
  const result = ciFailureDiagnostic(error);
  assert.equal(result.failureSummary, "assertion failed");
  assert.equal(result.error.cause.stack, cause.stack);
  assert.equal(result.error.stack.length, 5000);
  assert.equal(ciFailureDiagnostic(undefined).failureSummary, "unavailable");
});
test("summary budget counts escaped control characters and complete Unicode", () => {
  for (const source of ["😺".repeat(200), "\u0000".repeat(200), "x".repeat(300)]) {
    const result = boundedCiSummary(source);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result.summary).slice(1, -1)) <= 256);
    assert.ok(!result.summary.endsWith("\ud83d"));
  }
  assert.deepEqual(boundedCiSummary("hello"), { summary: "hello", truncated: false });
});
test("skip and todo on pass events take precedence over passed", () => {
  assert.equal(ciTestOutcome("passed", true), "skipped");
  assert.equal(ciTestOutcome("passed", undefined, "later"), "skipped");
  assert.equal(ciTestOutcome("cancelled"), "cancelled");
  assert.throws(() => ciTestOutcome("invented"), /Unknown/);
});

test("Node reporter persists each received event before source termination and separates duplicate names and suites", async () => {
  const { mkdtempSync, readdirSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const reporter = (await import(process.env.CI_REPORTER_PROBE_URL ?? "../tools/node-test-observation-reporter.mjs"))
    .default;
  const root = mkdtempSync(path.join(tmpdir(), "ha-ci-node-probe-"));
  const old = process.env.HARNESS_CI_NODE_TEST_RESULTS;
  process.env.HARNESS_CI_NODE_TEST_RESULTS = process.env.CI_REPORTER_PROBE_URL ? path.join(root, "old.json") : root;
  const data = {
    file: "tools/example.test.mjs",
    name: "same",
    nesting: 1,
    line: 10,
    column: 2,
    details: { duration_ms: 1, error: new Error("assertion", { cause: new Error("cause detail") }) },
  };
  let checkDuringSource;
  async function* source() {
    yield { type: "test:dequeue", data: { file: data.file, name: "suite", nesting: 0, type: "suite" } };
    yield { type: "test:fail", data };
    checkDuringSource = readdirSync(root).filter((name) => name.endsWith(".jsonl")).length > 0;
    yield { type: "test:pass", data: { ...data, skip: true } };
    yield { type: "test:pass", data: { ...data, name: "todo", todo: "later" } };
    yield { type: "test:pass", data: { ...data, details: { type: "suite" } } };
    yield { type: "test:fail", data: { ...data, name: data.file, nesting: 0, line: 1, column: 1 } };
  }
  try {
    for await (const _ of reporter(source())) {
      /* reporter writes observations synchronously */
    }
    const rows = process.env.CI_REPORTER_PROBE_URL
      ? JSON.parse(readFileSync(path.join(root, "old.json"), "utf8"))
      : readdirSync(root).flatMap((file) =>
          readFileSync(path.join(root, file), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        );
    assert.equal(rows[0].failureSummary, "assertion");
    assert.equal(checkDuringSource, true);
    const tests = rows.filter((row) => row.kind === "test");
    assert.equal(tests.length, 3);
    assert.deepEqual(tests[0].suite, ["suite"]);
    assert.notEqual(tests[0].testKey, tests[1].testKey);
    assert.equal(tests[1].status, "skipped");
    assert.equal(tests[2].status, "skipped");
    assert.equal(rows.at(-1).outcome, "crashed");
    assert.equal("retry" in tests[0], false);
  } finally {
    if (old === undefined) delete process.env.HARNESS_CI_NODE_TEST_RESULTS;
    else process.env.HARNESS_CI_NODE_TEST_RESULTS = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Vitest keeps failure messages, duplicate identities and skip/todo semantics", async () => {
  const { normalizeTests } = await import("./write-ci-observation.mjs");
  const rows = normalizeTests({
    testResults: [
      {
        name: "tools/a.test.mjs",
        assertionResults: [
          {
            title: "same",
            ancestorTitles: ["suite"],
            status: "failed",
            failureMessages: ["😺".repeat(300)],
            duration: 2,
          },
          { title: "same", ancestorTitles: ["suite"], status: "passed", duration: 3 },
          { title: "todo", ancestorTitles: [], status: "todo" },
        ],
      },
    ],
  });
  assert.equal(rows.length, 3);
  assert.notEqual(rows[0].testKey, rows[1].testKey);
  assert.equal(rows[0].truncated, true);
  assert.equal(rows[0].error.stack, "😺".repeat(300));
  assert.equal(rows[2].status, "skipped");
  assert.equal("retry" in rows[1], false);
});

test("real parent watchdog persists timeout and collateral cancellation while preserving delivered tests", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { writeCiObservation } = await import("./write-ci-observation.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "ha-ci-watchdog-"));
  try {
    const env = {
      ...process.env,
      HARNESS_CI_NODE_TEST_RESULTS: path.join(root, "fragments"),
      HARNESS_RUNNER_OPEN_HANDLE_FIXTURE: "1",
      HARNESS_TEST_FILE_TIMEOUT_MS: "2000",
      HARNESS_TEST_CONCURRENCY: "3",
    };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(
      process.execPath,
      ["tools/run-node-tests.mjs", "--tier", "fast", "--prefix", "tools/test-fixtures/runner-watchdog"],
      { env, encoding: "utf8", timeout: 20000 },
    );
    assert.equal(run.status, 1, run.stdout + run.stderr);
    const output = writeCiObservation({ ...env, HARNESS_CI_OBSERVATION_OUTPUT: path.join(root, "artifact.json") });
    const artifact = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(artifact.measurementCoverage.status, "partial");
    assert.match(artifact.measurementCoverage.missingReason, /unknown/);
    const outcomes = artifact.detail.fileOutcomes;
    assert.equal(outcomes.find((row) => row.file.endsWith("open-handle.test.mjs")).outcome, "timeout");
    assert.equal(outcomes.find((row) => row.file.endsWith("companion.test.mjs")).outcome, "cancelled");
    assert.ok(
      artifact.detail.tests.some((row) => row.name === "completed before a different file exceeded its deadline"),
    );
    assert.equal(artifact.measurementCoverage.startedFileCount, 3);
    assert.equal(artifact.measurementCoverage.completedFileCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
