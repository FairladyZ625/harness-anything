// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { resolveLifecycleAction, resolveLifecycleTransition } from "../src/repo-cell-lifecycle-action.ts";

test("the ingress resolver derives execution.start and reservation coordination from the catalogs", () => {
  const resolved = resolveLifecycleAction({ kind: "task-start" });
  assert.ok(resolved);
  assert.deepEqual(
    {
      transitionId: resolved.transitionId,
      commandType: resolved.commandType,
      actionKind: resolved.actionKind,
      targetIdField: resolved.targetIdField,
      target: resolved.targetRef("execution-1"),
      coordination: resolved.coordination,
    },
    {
      transitionId: "start_execution",
      commandType: "StartExecution",
      actionKind: "execution.start",
      targetIdField: "executionId",
      target: "execution/execution-1",
      coordination: "reserve",
    },
  );
  const transition = resolveLifecycleTransition("start_execution");
  assert.ok(transition);
  assert.deepEqual(
    [transition.transitionId, transition.actionKind, transition.coordination],
    ["start_execution", "execution.start", "reserve"],
  );
});

test("dry-run changes coordination without changing the resolved Action or transition", () => {
  const preview = resolveLifecycleAction({ kind: "task-start", dryRun: true });
  assert.ok(preview);
  assert.equal(preview.transitionId, "start_execution");
  assert.equal(preview.actionKind, "execution.start");
  assert.equal(preview.coordination, "preview");
});

test("non-lifecycle fleet commands do not acquire Action coordination", () => {
  for (const kind of ["task-progress-append", "task-release", "task-show", "task-create"])
    assert.equal(resolveLifecycleAction({ kind }), null, kind);
  const submit = resolveLifecycleAction({ kind: "task-submit" });
  assert.equal(submit?.actionKind, "execution.submit");
  assert.equal(submit?.coordination, "execute");
});
