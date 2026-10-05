// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionV1 } from "@harness-anything/kernel";
import { selectReadOnlyAttachTarget } from "../src/review-dispatch-admission.ts";

function submittedExecution(executionId: string): ExecutionV1 {
  return {
    schema: "execution/v1",
    executionId,
    iteration: 2,
    state: "submitted",
    submission: { commitSha: "a".repeat(40) },
  } as unknown as ExecutionV1;
}

function snapshotFor(executions: readonly ExecutionV1[]): Parameters<typeof selectReadOnlyAttachTarget>[1] {
  return { task: { taskId: "task-attach", iteration: 2 }, executions } as never;
}

test("a frozen round with one submitted cut attaches to exactly that execution", () => {
  const execution = submittedExecution("exec-attach-single");
  assert.equal(selectReadOnlyAttachTarget("task-attach", snapshotFor([execution])), execution);
});

test("a frozen round without a submitted cut refuses the attach instead of guessing", () => {
  assert.throws(
    () => selectReadOnlyAttachTarget("task-attach", snapshotFor([])),
    (error: unknown) => {
      assert.equal((error as { readonly code?: unknown }).code, "attach_target_missing");
      assert.match(String((error as Error).message), /froze without a submitted execution/u);
      return true;
    },
  );
});

test("a frozen round with several submitted cuts names them and refuses to choose", () => {
  const first = submittedExecution("exec-attach-first"),
    second = submittedExecution("exec-attach-second");
  assert.throws(
    () => selectReadOnlyAttachTarget("task-attach", snapshotFor([first, second])),
    (error: unknown) => {
      assert.equal((error as { readonly code?: unknown }).code, "attach_target_missing");
      assert.match(String((error as Error).message), /exec-attach-first, exec-attach-second/u);
      assert.match(String((error as Error).message), /cannot choose between them/u);
      return true;
    },
  );
});

test("earlier-iteration and unsubmitted executions are not attach targets", () => {
  const stale = { ...submittedExecution("exec-attach-stale"), iteration: 1 } as ExecutionV1,
    active = { ...submittedExecution("exec-attach-active"), state: "active", submission: null } as ExecutionV1,
    submitted = submittedExecution("exec-attach-current");
  assert.equal(selectReadOnlyAttachTarget("task-attach", snapshotFor([stale, active, submitted])), submitted);
});
