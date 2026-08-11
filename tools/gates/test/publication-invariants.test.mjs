// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { addWriteTarget, TaskLifecycleContractError } from "../../../packages/kernel/src/domain/task-lifecycle.contract.ts";
import { lifecycleHarness } from "../../../packages/application/test/task-lifecycle-test-harness.ts";

test("G29 publication-invariants preserve existing artifacts and reject submit targets added after freeze", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    const started = await harness.start("execution-1");
    assert.deepEqual(started.writePlan.targets.filter((target) => target.kind === "lease_sqlite"), [
      { kind: "lease_sqlite", table: "lease_cas", taskId: "task-1", operation: "reserve" },
      { kind: "lease_sqlite", table: "lease_cas", taskId: "task-1", operation: "activate" }
    ]);
    const artifact = path.join(harness.rootDir, "harness/tasks/task-1/existing.bin");
    const sentinel = path.join(harness.rootDir, "harness/unrelated.bin");
    mkdirSync(path.dirname(artifact), { recursive: true });
    writeFileSync(artifact, Buffer.from([9, 8, 7, 6]));
    writeFileSync(sentinel, Buffer.from([0, 1, 2, 255]));
    const before = bytes([artifact, sentinel]);

    const receipt = await harness.submit("execution-1");
    assert.equal(receipt.status, "applied");
    assert.deepEqual(bytes([artifact, sentinel]), before);
    assert.deepEqual(receipt.writePlan.targets.filter((target) => target.kind === "lease_sqlite"), [
      { kind: "lease_sqlite", table: "lease_cas", taskId: "task-1", operation: "release" }
    ]);
    assert.throws(
      () => addWriteTarget(receipt.writePlan, { kind: "task_artifact", path: "harness/tasks/task-1/late.bin", operation: "create" }),
      (error) => error instanceof TaskLifecycleContractError && error.code === "frozen_write_plan"
    );

    const afterSubmit = bytes([artifact, sentinel]);
    writeFileSync(sentinel, Buffer.from([4, 3, 2, 1]));
    assert.throws(() => assertUnchangedBytes(afterSubmit, bytes([artifact, sentinel])), /G29 undeclared byte mutation/u);
  } finally {
    harness.cleanup();
  }
});

function bytes(paths) {
  return Object.fromEntries(paths.map((filePath) => [filePath, readFileSync(filePath).toString("base64")]));
}

function assertUnchangedBytes(before, after) {
  const changed = Object.keys(before).filter((filePath) => before[filePath] !== after[filePath]);
  if (changed.length > 0) throw new Error(`G29 undeclared byte mutation: ${changed.join(", ")}`);
}
