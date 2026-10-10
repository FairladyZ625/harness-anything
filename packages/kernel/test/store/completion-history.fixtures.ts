import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import type { CanonicalEventV1 } from "../../src/domain/doc-sync-types.ts";

export const digest = `sha256:${"a".repeat(64)}`;
export const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "worker" } };
export const stamp = "2026-09-01T00:00:00.000Z";
export function history() {
  const task = {
    schema: "task/v2",
    taskId: "task-history",
    title: "Accepted experiment",
    taskClass: "standard",
    status: "planned",
    graph: REPLAY_TASK_GRAPH,
    currentNode: "implementation",
    iteration: 0,
    createdBy: actor,
    completionGateIds: ["ci"],
    presetSnapshotDigest: digest,
    pinned: false,
  };
  const execution = {
    schema: "execution/v1",
    taskId: task.taskId,
    executionId: "execution-history",
    nodeId: "implementation",
    iteration: 0,
    state: "active",
    actor,
    claimedAt: stamp,
    submittedAt: null,
    closedAt: null,
    submission: null,
  };
  const submission = {
    commitSha: "b".repeat(40),
    completionClaim: "Delivered",
    deliverables: [],
    outputs: [],
    verificationNotes: [],
    knownGaps: [],
    residualRisks: [],
  };
  const lease = {
    schema: "lease/v1",
    taskId: task.taskId,
    executionId: execution.executionId,
    actor,
    source: "local",
    phase: "held",
    expiresAt: "2026-09-02T00:00:00.000Z",
    ttlMs: 86400000,
    version: 1,
  };
  const submittedTask = { ...task, status: "in_review", currentNode: "review" };
  const submittedExecution = { ...execution, state: "submitted", submittedAt: stamp, submission };
  const payloads = [
    ["task_created", { task }],
    [
      "execution_started",
      {
        task: { ...task, status: "active" },
        execution,
        lease,
        previousHolder: null,
        leaseExpiresAt: lease.expiresAt,
        reason: "initial_claim",
        documentClaims: [],
      },
    ],
    [
      "execution_submitted",
      {
        task: submittedTask,
        execution: submittedExecution,
        documentClaims: [],
        edge: {
          edgeId: "implementation-submitted",
          from: "implementation",
          to: "review",
          on: "submitted",
          actorRole: "executor",
          reason: "Delivered",
          commitSha: submission.commitSha,
          iteration: 0,
        },
      },
    ],
    [
      "task_completed",
      {
        task: { ...submittedTask, status: "done" },
        execution: { ...submittedExecution, state: "accepted", closedAt: stamp },
        documentClaims: [],
      },
    ],
  ];
  return payloads.map(([type, payload], index) => ({
    schema: "task-event/v1",
    type,
    payload,
    taskId: task.taskId,
    workspaceRevision: index + 1,
    eventId: `event-${index}`,
    opId: `op-${index}`,
    actor,
    source: "local",
    occurredAt: stamp,
  })) as unknown as CanonicalEventV1[];
}
