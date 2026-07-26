// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTaskPlanAdmission,
  taskExecutionAdmissionPublicationRevalidation
} from "../src/authority/task-execution-admission-policy.ts";

test("task plan classification has one template-aware policy implementation", () => {
  const policy = {
    closeoutPlaceholderFingerprints: [],
    taskPlanPlaceholderFingerprintSets: [[{ anchor: "## Goal", body: "Describe the goal." }]],
    visualMapPlaceholderFingerprintSets: [],
    lessonCandidatesPlaceholderFingerprintSets: []
  };

  assert.equal(classifyTaskPlanAdmission({
    taskId: "task_NEW",
    taskRoot: "harness/tasks/task_NEW-fixture",
    taskPlan: "# Plan\n\n## Goal\n\nDescribe the goal.\n",
    policy
  }).state, "placeholder");
  assert.equal(classifyTaskPlanAdmission({
    taskId: "task_NEW",
    taskRoot: "harness/tasks/task_NEW-fixture",
    taskPlan: "# Plan\n\n## Goal\n\nShip the canonical admission gate.\n",
    policy
  }).state, "substantive");
});

test("execution admission rejects a placeholder plan before checking workstation capacity", async () => {
  const revalidate = taskExecutionAdmissionPublicationRevalidation({
    taskPlanSnapshot: async () => ({
      taskId: "task_NEW",
      state: "placeholder",
      taskRoot: "harness/tasks/task_NEW-fixture"
    }),
    taskWipSnapshot: async () => ({
      limit: 30,
      tasks: []
    })
  }, "task_NEW");

  await assert.rejects(revalidate, (error: Error) =>
    /TASK_PLAN_PLACEHOLDER/u.test(error.message)
    && /task_NEW/u.test(error.message)
    && /task_plan\.md/u.test(error.message)
    && /ha task transition task_NEW active/u.test(error.message));
});
