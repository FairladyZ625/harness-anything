// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { TaskLifecycleContractError } from "../../../packages/kernel/src/domain/task-lifecycle.contract.ts";
import { addWriteTarget } from "../../../packages/kernel/src/domain/task-write-decision.ts";
import { lifecycleHarness } from "../../../packages/application/test/task-lifecycle-test-harness.ts";
import { assertWriteTargetDeclared } from "../../../packages/application/src/task-lifecycle-service.ts";

test("G29 compares the complete published byte delta with the frozen plan declaration", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    const started = await harness.start("execution-1");
    assert.deepEqual(started.frozenPlan.targets.filter((target) => target.kind === "lease_sqlite"), [
      { kind: "lease_sqlite", table: "lease_cas", taskId: "task-1", operation: "reserve" },
      { kind: "lease_sqlite", table: "lease_cas", taskId: "task-1", operation: "activate" },
      { kind: "lease_sqlite", table: "lease_cas", taskId: "task-1", operation: "release" }
    ]);
    const artifact = path.join(harness.rootDir, "harness/tasks/task-1/existing.bin");
    const sentinel = path.join(harness.rootDir, "harness/unrelated.bin");
    mkdirSync(path.dirname(artifact), { recursive: true });
    writeFileSync(artifact, Buffer.from([9, 8, 7, 6]));
    writeFileSync(sentinel, Buffer.from([0, 1, 2, 255]));
    const before = snapshotTree(harness.rootDir);

    const receipt = await harness.submit("execution-1");
    assert.equal(receipt.outcome, "applied");
    assert.deepEqual(receipt.frozenPlan.targets.filter((target) => target.kind === "lease_sqlite"), [
      { kind: "lease_sqlite", table: "lease_cas", taskId: "task-1", operation: "release" }
    ]);
    assertChangedPathsDeclared(before, snapshotTree(harness.rootDir), receipt.frozenPlan);
    assert.deepEqual(readFileSync(artifact), Buffer.from([9, 8, 7, 6]));
    assert.deepEqual(readFileSync(sentinel), Buffer.from([0, 1, 2, 255]));
    assert.throws(
      () => addWriteTarget(receipt.frozenPlan, { kind: "task_artifact", path: "harness/tasks/task-1/late.bin", operation: "create" }),
      (error) => error instanceof TaskLifecycleContractError && error.code === "frozen_write_plan"
    );
  } finally {
    harness.cleanup();
  }
});

test("G29 rejects an undeclared write outside the frozen plan", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    const before = snapshotTree(harness.rootDir);
    const receipt = await harness.submit("execution-1");
    assert.throws(() => assertWriteTargetDeclared(receipt.frozenPlan,
      { kind: "task_artifact", path: "harness/undeclared-side-effect.bin", operation: "create" }), /undeclared_write_target/u);
    const injected = path.join(harness.rootDir, "harness/undeclared-side-effect.bin");
    writeFileSync(injected, Buffer.from([4, 3, 2, 1]));
    assert.throws(
      () => assertChangedPathsDeclared(before, snapshotTree(harness.rootDir), receipt.frozenPlan),
      /G29 undeclared byte mutation.*harness\/undeclared-side-effect\.bin/iu
    );
  } finally {
    harness.cleanup();
  }
});

function snapshotTree(rootDir) {
  const snapshot = new Map();
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const absolute = path.join(directory, name);
      if (statSync(absolute).isDirectory()) visit(absolute);
      else snapshot.set(path.relative(rootDir, absolute).split(path.sep).join("/"), readFileSync(absolute).toString("base64"));
    }
  };
  visit(rootDir);
  return snapshot;
}

function assertChangedPathsDeclared(before, after, plan) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  const changed = [...paths].filter((filePath) => before.get(filePath) !== after.get(filePath));
  const declared = declaredMatchers(plan);
  const undeclared = changed.filter((filePath) => !declared.some((matches) => matches(filePath)));
  if (undeclared.length > 0) throw new Error(`G29 undeclared byte mutation: ${undeclared.join(", ")}`);
}

function declaredMatchers(plan) {
  return plan.targets.flatMap((target) => {
    if (target.kind === "event_stream") return [exact(target.stream), prefix(".harness/write-journal/")];
    if (target.kind === "projection_invalidation" || target.kind === "lease_sqlite") return [exact(".harness/cache/task.sqlite"), prefix(".harness/write-journal/")];
    return [exact(target.path)];
  });
}

function exact(expected) { return (actual) => actual === expected; }
function prefix(expected) { return (actual) => actual.startsWith(expected); }
