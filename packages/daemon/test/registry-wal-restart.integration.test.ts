// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { reproduceRegistryWalRestart } from "./registry-wal-restart.repro.mjs";

for (const arm of ["migrate-v1", "restart-v2"] as const) {
  test(`acknowledged task and fact survive the ${arm} daemon replacement sequence`, async () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), `ha-registry-wal-test-${arm}-`));
    try {
      const result = await reproduceRegistryWalRestart(arm, { fixtureRoot });
      assert.equal(result.before.gitEventHead, 0);
      assert.equal(result.before.walLines, 2);
      assert.equal(result.before.receipts.taskReceipt.commitSha, null);
      assert.equal(result.before.receipts.factReceipt.commitSha, null);
      assert.equal(result.after.registrySchema, "harness-daemon-registry/v2");
      assert.equal(result.after.eventHead, 2);
      assert.deepEqual(result.after.schemas, ["task-event/v1", "fact-event/v1"]);
      assert.deepEqual(result.after.walRevisions, []);
      assert.equal(result.after.taskPackageExists, true);
      assert.equal(result.after.factDocumentExists, true);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
}

test("the reproduction fails closed when migration drops the v1 repository mapping", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-registry-wal-test-drop-"));
  try {
    await assert.rejects(
      reproduceRegistryWalRestart("drop-v1-mapping", { fixtureRoot }),
      /restart cannot attach repro-repo because its registry mapping is absent/u,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
