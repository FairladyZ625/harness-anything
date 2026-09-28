// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskV2 } from "@harness-anything/kernel";
import type { RepoCellActionContext } from "../src/repo-cell-action-context.ts";
import type { RepoCellOperationalContext } from "../src/repo-cell-action-context.ts";
import { withRetiredTaskClass } from "../src/repo-cell-task-maintenance.ts";
import { taskMutation } from "../src/repo-cell-task-mutation.ts";

const binding = { actor: "operator", source: "local" } as const,
  codedCell = {
    cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  } as unknown as RepoCellActionContext;

function cellHolding(taskClass: string): RepoCellOperationalContext {
  return {
    projection: { read: () => ({ snapshot: { task: { taskClass } } }) },
  } as unknown as RepoCellOperationalContext;
}

function task(taskClass: string): TaskV2 {
  return {
    taskId: "task-1",
    taskClass,
    contractVersion: 1,
    metadata: { presetId: "create-milestone" },
  } as unknown as TaskV2;
}

test("contract migrate plans a retired task class onto its successor and leaves current classes alone", () => {
  assert.deepEqual(withRetiredTaskClass(cellHolding("milestone"), "task-1", { taskId: "task-1", status: "current" }), {
    taskId: "task-1",
    status: "repair",
    disposition: "retired-task-class-restated",
    taskClassBefore: "milestone",
    taskClassAfter: "work",
  });
  assert.equal(
    withRetiredTaskClass(cellHolding("epic"), "task-1", { taskId: "task-1", status: "backfill" }).taskClassAfter,
    "standard",
  );
  const current = { taskId: "task-1", status: "current" },
    manual = { taskId: "task-1", status: "manual", reason: "contract_projection_pending" };
  assert.equal(withRetiredTaskClass(cellHolding("work"), "task-1", current), current);
  assert.equal(withRetiredTaskClass(cellHolding("milestone"), "task-1", manual), manual);
});

test("contract migrate restates the class of a current contract and keeps the preset provenance", () => {
  const snapshot = { lease: null } as unknown as Parameters<typeof taskMutation>[3],
    restated = taskMutation(
      codedCell,
      { kind: "task-contract-migrate", taskId: "task-1", repairTaskClass: "work" },
      task("milestone"),
      snapshot,
      binding,
    );
  assert.equal(restated.type, "task_contract_migrated");
  assert.equal(restated.task.taskClass, "work");
  assert.equal(restated.task.metadata?.presetId, "create-milestone");
  assert.deepEqual(restated.audit.fields, ["contractVersion", "taskClass"]);
  assert.match(restated.audit.reason, /retired task class/u);
  assert.throws(
    () =>
      taskMutation(
        codedCell,
        { kind: "task-contract-migrate", taskId: "task-1", repairTaskClass: "work" },
        task("work"),
        snapshot,
        binding,
      ),
    (error: unknown) => (error as { code?: string }).code === "contract_current",
  );
});
