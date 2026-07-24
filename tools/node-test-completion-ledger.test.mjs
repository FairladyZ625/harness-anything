// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  canIgnoreReapedFileFailures,
  completedIsolationFile,
  parseCompletionLedger
} from "./node-test-completion-ledger.mjs";

const repoRoot = "/repo";
const file = "packages/cli/test/daemon-control-replacement-safety.test.ts";

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

test("result override requires every selected file and only synthetic reaped SIGKILL failures", () => {
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
  assert.equal(canIgnoreReapedFileFailures({
    ledger,
    selectedFiles: [file, other, "packages/missing.test.ts"],
    reapedFiles: new Set([file])
  }), false);
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
