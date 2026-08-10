// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { makeRunDirectoryWritable } from "./evidence.mjs";
import { validateRunRecord } from "./schema-validator.mjs";

const driver = path.resolve("tools/coldstart-bench/driver.mjs");
const negativeControl = path.resolve("tools/coldstart-bench/negative-control.mjs");

test("scripted subject proves the complete pipeline and the missing-receipt negative control", { timeout: 180_000 }, () => {
  const parent = mkdtempSync(path.join(tmpdir(), "coldstart-bench-e2e-"));
  const positiveDir = path.join(parent, "positive");
  const negativeDir = path.join(parent, "negative");
  try {
    const positive = run(driver, ["--run-dir", positiveDir, "--seed", "104729"]);
    assert.equal(positive.status, 0, positive.stderr);
    const positiveSummary = JSON.parse(positive.stdout);
    const positiveRecord = JSON.parse(readFileSync(positiveSummary.runRecord, "utf8"));
    assert.equal(positiveRecord.status, "complete");
    assert.equal(positiveRecord.outcome, "passed");
    assert.equal(positiveRecord.validity.status, "valid");
    assert.equal(positiveRecord.environment.workspaceKind, "git-worktree");
    assert.equal(positiveRecord.environment.workspaceEvaluatorFilesPresent, false);
    assert.equal(positiveRecord.reconciliation.runtimeEventsUsedForVerdict, false);
    assert.deepEqual(validateRunRecord(positiveRecord), { ok: true, errors: [] });
    assert.equal(statSync(positiveSummary.runRecord).mode & 0o222, 0);

    const negative = run(negativeControl, [
      "--source-run-dir", positiveDir,
      "--run-dir", negativeDir,
      "--omit", "cliReceipts"
    ]);
    assert.equal(negative.status, 0, negative.stderr);
    const negativeSummary = JSON.parse(negative.stdout);
    const negativeRecord = JSON.parse(readFileSync(negativeSummary.runRecord, "utf8"));
    assert.equal(negativeRecord.status, "incomplete");
    assert.equal(negativeRecord.outcome, "unknown");
    assert.equal(negativeRecord.validity.status, "invalid");
    assert.equal(negativeRecord.reconciliation.issues.includes("missing-required-channel:cliReceipts"), true);
    assert.equal(existsSync(path.join(negativeDir, "evidence/cli-receipts.jsonl")), false);
    assert.deepEqual(validateRunRecord(negativeRecord), { ok: true, errors: [] });
  } finally {
    for (const directory of [positiveDir, negativeDir]) if (existsSync(directory)) makeRunDirectoryWritable(directory);
    rmSync(parent, { recursive: true, force: true });
  }
});

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, NODE_OPTIONS: "", HARNESS_CLI_TEST_FIXTURE_PRELOAD: "" },
    encoding: "utf8",
    timeout: 170_000,
    maxBuffer: 32 * 1024 * 1024
  });
}
