// harness-test-tier: fast
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { submissionDigest, type RuntimeExecutionPrincipal } from "@harness-anything/kernel";
import { requireCurrentExecutionScope, requireExecutionActionScope } from "../src/runtime-execution-scope.ts";

for (const source of ["local", { kind: "node", nodeId: "edge-one" }] as const)
  test(`reviewer ${JSON.stringify(source)} can register its own disk packet or carried report`, (t) => {
    const principal: RuntimeExecutionPrincipal = {
        personId: "person-worker",
        repoId: "repo",
        runtimeSessionId: "runtime-reviewer",
        dispatchId: "dispatch-reviewer",
        taskId: "task-reviewed",
        executionId: "execution-reviewed",
        role: "reviewer",
        source,
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      actor = {
        principal: { personId: principal.personId },
        executor: { kind: "agent" as const, id: `runtime-session:${principal.runtimeSessionId}` },
      },
      submission = {} as Parameters<typeof submissionDigest>[0],
      packagePath = "tasks/task-reviewed-package",
      packet = `${packagePath}/artifacts/reports/${principal.dispatchId}.json`,
      action = {
        kind: "task-review-execution",
        taskId: principal.taskId,
        executionId: principal.executionId,
        reviewId: `review-${principal.dispatchId}`,
        fromFile: path.resolve("harness", packet),
      },
      input = {
        action,
        binding: { executionPrincipal: principal, actor, source },
        now: "2026-11-02T00:00:00.000Z",
        projection: {
          read: () => ({ packagePath, snapshot: { executions: [{ executionId: principal.executionId, submission }] } }),
          readRuntimeSession: () => ({
            liveness: "live",
            outcome: null,
            taskBindings: [{ taskId: principal.taskId, executionId: principal.executionId }],
          }),
          readRuntimeDispatch: () => ({
            actor,
            source,
            payload: {
              dispatchId: principal.dispatchId,
              role: "reviewer",
              reviewTarget: {
                kind: "task",
                taskId: principal.taskId,
                executionId: principal.executionId,
                digest: submissionDigest(submission),
              },
            },
          }),
        } as never,
      };
    assert.doesNotThrow(() => requireCurrentExecutionScope(input));
    const report = { path: `${packagePath}/artifacts/reports/${principal.dispatchId}.md` };
    assert.doesNotThrow(() =>
      requireCurrentExecutionScope({ ...input, action: { ...action, fromFile: undefined, docChanges: [report] } }),
    );
    for (const changed of [
      { taskId: "task-other" },
      { reviewId: "review-other" },
      { fromFile: "harness/tasks/task-other/artifacts/reports/other.json" },
      { docChanges: [{ path: `${packagePath}/artifacts/reports/other.md` }] },
      { docChanges: [report, report] },
      { docChanges: [] },
    ])
      assert.throws(() => requireCurrentExecutionScope({ ...input, action: { ...action, ...changed } }), {
        code: "execution_credential_rejected",
      });
    assert.throws(() => requireCurrentExecutionScope({ ...input, action: { ...action, reviewId: "review-other" } }), {
      code: "execution_credential_rejected",
      message: new RegExp(`--review-id review-${principal.dispatchId}.*--from-file`, "u"),
    });
    try {
      requireCurrentExecutionScope({ ...input, action: { ...action, taskId: "task-other" } });
      assert.fail("cross-task review must be rejected");
    } catch (error) {
      assert.equal((error as { code?: string }).code, "execution_credential_rejected");
      t.diagnostic(
        `Cross-task negative control: ${(error as Error & { code: string }).code}: ${(error as Error).message}`,
      );
    }
    assert.throws(() => requireExecutionActionScope({ ...principal, role: "implementation" }, action), {
      code: "execution_credential_rejected",
    });
  });

test("a worker cannot dispatch a reviewer and receives the CEO recovery route", () => {
  const principal: RuntimeExecutionPrincipal = {
    personId: "person-worker",
    repoId: "repo",
    runtimeSessionId: "runtime-worker",
    dispatchId: "dispatch-worker",
    taskId: "task-worker",
    executionId: "execution-worker",
    role: "implementation",
    source: "local",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  assert.throws(
    () => requireExecutionActionScope(principal, { kind: "task-dispatch-review", taskIds: [principal.taskId] }),
    { code: "execution_credential_rejected", message: /CEO.*ha task dispatch-review task-worker/u },
  );
  // An unbound owner session keeps its ordinary repository authorization; this hint only limits task workers.
  assert.doesNotThrow(() =>
    requireExecutionActionScope(
      { ...principal, role: "session", taskId: null, executionId: null },
      { kind: "task-dispatch-review", taskIds: [principal.taskId] },
    ),
  );
});
