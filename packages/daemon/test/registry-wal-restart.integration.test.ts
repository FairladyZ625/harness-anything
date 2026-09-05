// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { reproduceRegistryWalRestart } from "./registry-wal-restart.repro.mjs";

for (const arm of ["graceful-stop", "sigkill"] as const) {
  test(`daemon preserves acknowledged WAL writes after ${arm}`, async () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), `ha-registry-wal-test-${arm}-`));
    try {
      const result = await reproduceRegistryWalRestart(arm, { fixtureRoot });
      process.stdout.write(`[registry-wal-restart:${arm}] ${JSON.stringify(result)}\n`);
      assert.equal(result.before.registrySchema, "harness-daemon-registry/v2");
      assert.equal(result.before.receipts.taskReceipt.outcome, "applied");
      assert.equal(result.before.receipts.taskReceipt.commitSha, null);
      assert.equal(result.before.receipts.factReceipt.outcome, "applied");
      assert.equal(result.before.receipts.factReceipt.commitSha, null);
      assert.equal(result.after.registrySchema, "harness-daemon-registry/v2");
      assert.ok(result.after.canonicalEventHead > result.before.canonicalEventHead);
      assert.equal(result.after.walLines, 0);
      assert.equal(result.after.taskPackageExists, true);
      assert.equal(result.after.taskId, result.after.expectedTaskId);
      assert.equal(result.after.factId, result.after.expectedFactId);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
}
