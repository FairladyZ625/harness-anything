// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { taskDeliveryStage } from "../src/task-delivery-stage.ts";
import { emptyTaskLifecycleSnapshot } from "@harness-anything/kernel";

const readyCloseout = { readiness: "ready" as const, blocker: undefined },
  openCloseout = { readiness: "incomplete" as const, blocker: undefined },
  consentCloseout = { readiness: "incomplete" as const, blocker: "consent" as const },
  noBlockers = { blockers: [] },
  ownerAskBlockers = { blockers: [{ kind: "awaits" as const }] },
  upstreamBlockers = { blockers: [{ kind: "depends-on" as const }] };

function snapshotWith(executions: readonly { state: string; iteration: number }[], lease = false) {
  return {
    ...emptyTaskLifecycleSnapshot(),
    executions,
    ...(lease ? { lease: { executionId: "execution-live", phase: "held" as const } } : {}),
  } as Parameters<typeof taskDeliveryStage>[0]["snapshot"];
}

test("the lifecycle positions map onto their delivery stages", () => {
  assert.equal(
    taskDeliveryStage({ status: "active", snapshot: snapshotWith([]), closeout: openCloseout, blocking: noBlockers }),
    "implementing",
  );
  assert.equal(
    taskDeliveryStage({
      status: "submitted",
      snapshot: snapshotWith([{ state: "submitted", iteration: 0 }]),
      closeout: openCloseout,
      blocking: noBlockers,
    }),
    "delivered",
  );
  assert.equal(
    taskDeliveryStage({
      status: "in_review",
      snapshot: snapshotWith([{ state: "submitted", iteration: 0 }]),
      closeout: openCloseout,
      blocking: noBlockers,
    }),
    "reviewing",
  );
  assert.equal(
    taskDeliveryStage({
      status: "in_review",
      snapshot: snapshotWith([{ state: "submitted", iteration: 0 }]),
      closeout: readyCloseout,
      blocking: noBlockers,
    }),
    "merge_ready",
  );
});

test("the owner's own gates outrank the lifecycle position", () => {
  assert.equal(
    taskDeliveryStage({
      status: "in_review",
      snapshot: snapshotWith([{ state: "submitted", iteration: 0 }]),
      closeout: consentCloseout,
      blocking: noBlockers,
    }),
    "awaiting_owner",
  );
  assert.equal(
    taskDeliveryStage({
      status: "active",
      snapshot: snapshotWith([{ state: "active", iteration: 0 }], true),
      closeout: openCloseout,
      blocking: ownerAskBlockers,
    }),
    "awaiting_owner",
  );
});

test("a rejected task with nothing in flight is rework, back from the review stage", () => {
  assert.equal(
    taskDeliveryStage({
      status: "active",
      snapshot: snapshotWith([{ state: "changes_requested", iteration: 1 }]),
      closeout: openCloseout,
      blocking: noBlockers,
    }),
    "rework",
  );
  // 仍在飞的 execution 说明返工已经开始:回到实现位。
  assert.equal(
    taskDeliveryStage({
      status: "active",
      snapshot: snapshotWith([{ state: "active", iteration: 2 }], true),
      closeout: openCloseout,
      blocking: noBlockers,
    }),
    "implementing",
  );
});

test("queued, upstream-blocked and terminal rows are off the delivery path", () => {
  for (const status of ["planned", "done", "cancelled", "unknown"] as const)
    assert.equal(
      taskDeliveryStage({ status, snapshot: snapshotWith([]), closeout: openCloseout, blocking: noBlockers }),
      null,
      status,
    );
  assert.equal(
    taskDeliveryStage({
      status: "blocked",
      snapshot: snapshotWith([]),
      closeout: openCloseout,
      blocking: upstreamBlockers,
    }),
    null,
  );
});
