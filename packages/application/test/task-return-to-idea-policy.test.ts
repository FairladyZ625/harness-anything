// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  taskReturnToIdeaPublicationRevalidation,
  type TaskReturnToIdeaSnapshotV1
} from "../src/authority/task-return-to-idea-policy.ts";

const taskId = "task_RETURN";

test("active Execution blocks returning a task to planned and names the retirement command", async () => {
  const revalidate = taskReturnToIdeaPublicationRevalidation(async () => snapshot({
    activeExecutions: [{ executionId: "exe_ACTIVE" }]
  }), taskId);

  await assert.rejects(revalidate, (error: Error) =>
    /TASK_RETURN_TO_IDEA_BLOCKED/u.test(error.message)
    && /exe_ACTIVE/u.test(error.message)
    && new RegExp(`ha task retire-execution ${taskId} --execution-id exe_ACTIVE --reason`, "u").test(error.message));
});

test("active lease blocks returning a task to planned and names its holder and release command", async () => {
  const revalidate = taskReturnToIdeaPublicationRevalidation(async () => snapshot({
    activeLease: {
      holder: {
        principal: { personId: "person_zeyu", displayName: "Zeyu" },
        executor: { kind: "agent", id: "codex-t4" },
        responsibleHuman: "person_zeyu"
      },
      executionId: "exe_LEASED",
      leaseExpiresAt: "2026-07-26T12:00:00.000Z"
    }
  }), taskId);

  await assert.rejects(revalidate, (error: Error) =>
    /person:person_zeyu\/agent:codex-t4/u.test(error.message)
    && /exe_LEASED/u.test(error.message)
    && new RegExp(`ha task release ${taskId}`, "u").test(error.message));
});

test("returning to planned succeeds after execution retirement and lease release remove both blockers", async () => {
  let current = snapshot({
    activeExecutions: [{ executionId: "exe_ACTIVE" }],
    activeLease: {
      holder: {
        principal: { personId: "person_zeyu", displayName: "Zeyu" },
        executor: { kind: "agent", id: "codex-t4" },
        responsibleHuman: "person_zeyu"
      },
      executionId: "exe_ACTIVE",
      leaseExpiresAt: "2026-07-26T12:00:00.000Z"
    }
  });
  const revalidate = taskReturnToIdeaPublicationRevalidation(async () => current, taskId);

  await assert.rejects(revalidate, /ha task release/u);
  current = snapshot({});
  await assert.doesNotReject(revalidate);
});

function snapshot(
  overrides: Partial<Omit<TaskReturnToIdeaSnapshotV1, "taskId">>
): TaskReturnToIdeaSnapshotV1 {
  return {
    taskId,
    activeExecutions: [],
    activeLease: null,
    ...overrides
  };
}
