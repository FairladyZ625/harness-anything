// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { isReturnedRuntimeContinuation, reduceTaskEvent } from "../../src/index.ts";
import { emptyTaskLifecycleSnapshot } from "../../src/domain/task-lifecycle.contract.ts";
import { lifecycleFixture } from "../store/task-lifecycle-fixture.ts";

test("only the next leased execution may resume a formally returned round", () => {
  const active = lifecycleFixture().events.slice(0, 2).reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot()),
    original = active.executions[0]!,
    previous = { ...original, state: "changes_requested" as const },
    current = { ...original, executionId: "execution-next", iteration: original.iteration + 1 },
    snapshot = {
      ...active,
      task: { ...active.task!, iteration: current.iteration },
      executions: [previous, current],
      lease: { ...active.lease!, executionId: current.executionId },
    };
  const allows = (value = snapshot) => isReturnedRuntimeContinuation(value, original.executionId, current.executionId);
  assert.equal(allows(), true);
  for (const state of ["active", "submitted", "accepted", "abandoned"] as const)
    assert.equal(
      isReturnedRuntimeContinuation(
        { ...snapshot, executions: [{ ...previous, state }, current] },
        original.executionId,
        current.executionId,
      ),
      false,
      state,
    );
  assert.equal(
    isReturnedRuntimeContinuation({ ...snapshot, lease: null }, original.executionId, current.executionId),
    false,
  );
  assert.equal(allows({ ...snapshot, lease: { ...snapshot.lease, executionId: original.executionId } }), false);
  assert.equal(
    allows({ ...snapshot, executions: [previous, { ...current, iteration: current.iteration + 1 }] }),
    false,
  );
  assert.equal(allows({ ...snapshot, task: { ...snapshot.task, iteration: current.iteration + 1 } }), false);
  assert.equal(isReturnedRuntimeContinuation(snapshot, "missing-source", current.executionId), false);
  assert.equal(isReturnedRuntimeContinuation(snapshot, original.executionId, "missing-target"), false);
});
