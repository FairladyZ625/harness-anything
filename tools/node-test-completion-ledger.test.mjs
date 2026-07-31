// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import {
  canIgnoreReapedFileFailures,
  completedIsolationFile,
  parseCompletionLedger
} from "./node-test-completion-ledger.mjs";

const repoRoot = "/repo";
const file = "packages/cli/test/daemon-control-replacement-safety.test.ts";
const workspaceRoot = path.resolve(import.meta.dirname, "..");

test("file summary marks an isolation child complete only after a terminated reporter record", () => {
  const ledger = parseCompletionLedger(`${JSON.stringify({
    type: "test-file-summary",
    file: `${repoRoot}/${file}`,
    success: true,
    counts: counts({ tests: 9, passed: 9 })
  })}\n`, repoRoot);

  assert.deepEqual(completedIsolationFile(ledger, [file]), {
    file,
    summary: {
      success: true,
      counts: counts({ tests: 9, passed: 9 })
    }
  });
});

test("missing or incomplete reporter records fail closed", () => {
  const incomplete = parseCompletionLedger(
    `{"type":"test-file-summary","file":"${repoRoot}/${file}"`,
    repoRoot
  );

  assert.equal(incomplete.valid, true);
  assert.equal(incomplete.incompleteTrailingRecord, true);
  assert.equal(completedIsolationFile(incomplete, [file]), null);
  assert.equal(completedIsolationFile(parseCompletionLedger("", repoRoot), [file]), null);
  assert.equal(completedIsolationFile(parseCompletionLedger("not-json\n", repoRoot), [file]), null);
  assert.equal(completedIsolationFile(parseCompletionLedger("", repoRoot), [file, "packages/other.test.ts"]), null);
});

test("result override requires every selected file and only synthetic forced-termination failures", () => {
  const other = "packages/kernel/test/healthy.test.ts";
  const records = [
    fileSummary(file),
    fileSummary(other),
    {
      type: "test-failure",
      file: `${repoRoot}/${file}`,
      name: file,
      signal: "SIGKILL"
    },
    {
      type: "test-run-summary",
      success: false,
      counts: counts({ tests: 3, passed: 2, failed: 1 })
    }
  ];
  const ledger = parseCompletionLedger(
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    repoRoot
  );

  assert.equal(canIgnoreReapedFileFailures({
    ledger,
    selectedFiles: [file, other],
    reapedFiles: new Set([file])
  }), true);
  const signalLessLedger = parseCompletionLedger(
    `${records.map((record) => JSON.stringify(record.type === "test-failure"
      ? { ...record, signal: null, exitCode: 1 }
      : record)).join("\n")}\n`,
    repoRoot
  );
  assert.equal(canIgnoreReapedFileFailures({
    ledger: signalLessLedger,
    selectedFiles: [file, other],
    reapedFiles: new Set([file])
  }), true);
  assert.equal(canIgnoreReapedFileFailures({
    ledger,
    selectedFiles: [file, other, "packages/missing.test.ts"],
    reapedFiles: new Set([file])
  }), false);
});

test("result override recognizes a Windows file-level failure name", () => {
  const records = [
    fileSummary(file),
    {
      type: "test-failure",
      file: `${repoRoot}/${file}`,
      name: file.replaceAll("/", "\\"),
      signal: null,
      exitCode: 1
    },
    {
      type: "test-run-summary",
      success: false,
      counts: counts({ tests: 2, passed: 1, failed: 1 })
    }
  ];
  const ledger = parseCompletionLedger(
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    repoRoot
  );

  assert.equal(canIgnoreReapedFileFailures({
    ledger,
    selectedFiles: [file],
    reapedFiles: new Set([file])
  }), true);
  const realFailureLedger = parseCompletionLedger(
    `${records.map((record) => JSON.stringify(record.type === "test-failure"
      ? { ...record, name: "real test failure" }
      : record)).join("\n")}\n`,
    repoRoot
  );
  assert.equal(canIgnoreReapedFileFailures({
    ledger: realFailureLedger,
    selectedFiles: [file],
    reapedFiles: new Set([file])
  }), false);
});

test("completion reporter flushes every proof record before its consumer can exit", () => {
  const result = spawnSync(process.execPath, [
    "tools/test-fixtures/.runner-stall/completion-reporter-flush.mjs"
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15_000
  });
  const ledger = parseCompletionLedger(result.output[3] ?? "", repoRoot);

  assert.equal(result.error, undefined, result.output[2] ?? "");
  assert.equal(result.status, 0, result.output[2] ?? "");
  assert.equal(ledger.valid, true, ledger.error);
  assert.equal(ledger.incompleteTrailingRecord, false);
  assert.equal(ledger.fileSummaries.size, 20_000);
  assert.deepEqual(ledger.runSummary, {
    success: true,
    counts: counts({ tests: 20_000, passed: 20_000 })
  });
});

function fileSummary(relativeFile) {
  return {
    type: "test-file-summary",
    file: `${repoRoot}/${relativeFile}`,
    success: true,
    counts: counts({ tests: 1, passed: 1 })
  };
}

function counts(overrides = {}) {
  return {
    tests: 0,
    failed: 0,
    passed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    ...overrides
  };
}
