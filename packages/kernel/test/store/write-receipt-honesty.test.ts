// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("cross-process flush receipts reconcile ops committed by another process", async () => {
  const repoRoot = path.resolve(import.meta.dirname, "../../../..");
  const { stdout } = await execFileAsync(process.execPath, ["tools/receipt-honesty-bench.mjs"], {
    cwd: repoRoot,
    maxBuffer: 4 * 1024 * 1024
  });
  const report = JSON.parse(stdout) as {
    readonly totals: {
      readonly attempts: number;
      readonly receiptOk: number;
      readonly durable: number;
      readonly falseNegative: number;
      readonly falsePositive: number;
    };
  };

  assert.deepEqual(report.totals, {
    attempts: 16,
    receiptOk: 16,
    durable: 16,
    falseNegative: 0,
    falsePositive: 0
  });
});
