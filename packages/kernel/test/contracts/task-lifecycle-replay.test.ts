// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  REPLAY_TASK_GRAPH,
  currentTaskForWrite,
  reduceTaskEvent,
  type TaskEventV1,
  type TaskLifecycleSnapshot,
} from "../../src/index.ts";
import { emptyTaskLifecycleSnapshot } from "../../src/domain/task-lifecycle.contract.ts";

const actor = { principal: { personId: "person-owner" }, executor: null } as const;
const metadata = {
  idempotencyKey: null,
  parentTaskId: null,
  workKind: "fix" as const,
  riskTier: "medium" as const,
  urgency: null,
  verticalId: "software/coding",
  presetId: "standard-task",
  profileId: "baseline",
  moduleKey: null,
  slug: "legacy-release",
  surfaces: [] as readonly string[],
  fromLegacyId: null,
};

test("lease release replay ignores only the retired longRunning task metadata", () => {
  const task = {
      schema: "task/v1",
      taskId: "task-legacy-release",
      title: "Legacy release",
      taskClass: "standard",
      status: "active",
      graph: REPLAY_TASK_GRAPH,
      currentNode: "implementation",
      iteration: 0,
      createdBy: actor,
      completionGateIds: [],
      presetSnapshotDigest: null,
      metadata: { ...metadata, longRunning: false },
    } as const,
    execution = {
      schema: "execution/v1",
      executionId: "execution-legacy-release",
      taskId: task.taskId,
      nodeId: "implementation",
      iteration: 0,
      state: "active",
      actor,
      claimedAt: "2026-08-15T20:36:06.914Z",
      submittedAt: null,
      closedAt: null,
      submission: null,
    } as const,
    lease = {
      schema: "lease/v1",
      taskId: task.taskId,
      executionId: execution.executionId,
      actor,
      source: "local",
      phase: "held",
      expiresAt: "2026-08-15T21:06:06.914Z",
      ttlMs: 1_800_000,
      version: 1,
    } as const,
    snapshot: TaskLifecycleSnapshot = {
      ...emptyTaskLifecycleSnapshot(1),
      task,
      executions: [execution],
      lease,
    },
    release: TaskEventV1 = {
      schema: "task-event/v1",
      eventId: "event-release",
      workspaceRevision: 2,
      opId: "op-release",
      taskId: task.taskId,
      type: "lease_released",
      actor,
      source: "local",
      occurredAt: "2026-08-24T01:05:05.136Z",
      payload: {
        task: currentTaskForWrite(task),
        execution,
        releasedLease: { ...lease, phase: "orphaned" },
        mutation: { command: "release", reason: "expired lease", fields: ["lease"] },
        documentClaims: [],
      },
    };

  assert.equal(reduceTaskEvent(snapshot, release).lease, null);
  assert.throws(
    () =>
      reduceTaskEvent(snapshot, {
        ...release,
        payload: { ...release.payload, task: { ...release.payload.task, title: "Changed" } },
      }),
    /replayed lease release is incomplete/u,
  );
});
