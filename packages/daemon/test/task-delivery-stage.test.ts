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

const base = { snapshot: snapshotWith([]), closeout: openCloseout, blocking: noBlockers },
  nowMs = Date.parse("2026-10-23T12:00:00.000Z");

test("the lifecycle positions map onto their delivery stages", () => {
  assert.equal(
    taskDeliveryStage({ ...base, status: "active", updatedAt: "2026-10-23T11:00:00.000Z", nowMs }),
    "implementing",
  );
  assert.equal(
    taskDeliveryStage({
      status: "submitted",
      snapshot: snapshotWith([{ state: "submitted", iteration: 0 }]),
      closeout: openCloseout,
      blocking: noBlockers,
      updatedAt: "2026-10-23T11:00:00.000Z",
      nowMs,
    }),
    "delivered",
  );
  assert.equal(
    taskDeliveryStage({
      status: "in_review",
      snapshot: snapshotWith([{ state: "submitted", iteration: 0 }]),
      closeout: openCloseout,
      blocking: noBlockers,
      updatedAt: "2026-10-23T11:00:00.000Z",
      nowMs,
    }),
    "reviewing",
  );
  assert.equal(
    taskDeliveryStage({
      status: "in_review",
      snapshot: snapshotWith([{ state: "submitted", iteration: 0 }]),
      closeout: readyCloseout,
      blocking: noBlockers,
      updatedAt: "2026-10-23T11:00:00.000Z",
      nowMs,
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
      updatedAt: "2026-10-23T11:00:00.000Z",
      nowMs,
    }),
    "awaiting_owner",
  );
  assert.equal(
    taskDeliveryStage({
      status: "active",
      snapshot: snapshotWith([{ state: "active", iteration: 0 }], true),
      closeout: openCloseout,
      blocking: ownerAskBlockers,
      updatedAt: "2026-10-23T11:00:00.000Z",
      nowMs,
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
      updatedAt: "2026-10-23T11:00:00.000Z",
      nowMs,
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
      updatedAt: "2026-10-23T11:00:00.000Z",
      nowMs,
    }),
    "implementing",
  );
});

test("planned queues and an upstream block get their own pipeline words", () => {
  assert.equal(
    taskDeliveryStage({ ...base, status: "planned", updatedAt: "2026-10-23T11:00:00.000Z", nowMs }),
    "queued",
  );
  assert.equal(
    taskDeliveryStage({
      ...base,
      status: "blocked",
      blocking: upstreamBlockers,
      updatedAt: "2026-10-23T11:00:00.000Z",
      nowMs,
    }),
    "waiting_upstream",
  );
  // 业主的 awaits 边压过等上游:要我先于等上游。
  assert.equal(
    taskDeliveryStage({
      ...base,
      status: "blocked",
      blocking: ownerAskBlockers,
      updatedAt: "2026-10-23T11:00:00.000Z",
      nowMs,
    }),
    "awaiting_owner",
  );
});

test("terminal rows are done only inside the 24h window, cancelled stays off the pipeline", () => {
  assert.equal(taskDeliveryStage({ ...base, status: "done", updatedAt: "2026-10-23T05:00:00.000Z", nowMs }), "done");
  // 23h59m 仍在窗内;窗口边界按瞬间比较。
  assert.equal(taskDeliveryStage({ ...base, status: "done", updatedAt: "2026-10-22T12:00:01.000Z", nowMs }), "done");
  assert.equal(taskDeliveryStage({ ...base, status: "done", updatedAt: "2026-10-21T05:00:00.000Z", nowMs }), null);
  assert.equal(taskDeliveryStage({ ...base, status: "cancelled", updatedAt: "2026-10-23T11:00:00.000Z", nowMs }), null);
  assert.equal(taskDeliveryStage({ ...base, status: "unknown", updatedAt: "2026-10-23T11:00:00.000Z", nowMs }), null);
  // updatedAt 不可解析时不虚构窗口判定:离开流水线,由行自身状态词说话。
  assert.equal(taskDeliveryStage({ ...base, status: "done", updatedAt: "not-a-time", nowMs }), null);
});
