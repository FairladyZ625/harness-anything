// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import type { ActorIdentity, LeaseV1, TaskLifecycleSnapshot, TaskV2 } from "../../kernel/src/index.ts";
import { reacquireSquadTaskLease } from "../src/repo-cell-open.ts";
import { initialLeaderPrompt, parseLeaderDecision } from "../src/squad-leader-decision.ts";

const squadActor: ActorIdentity = {
    principal: { personId: "person-squad" },
    executor: { kind: "agent", id: "squad-runner" },
  },
  task: TaskV2 = {
    schema: "task/v2",
    taskId: "task-squad-reacquire",
    title: "Squad reacquire",
    taskClass: "standard",
    status: "active",
    graph: { maxIterations: 1, nodes: [], edges: [] },
    currentNode: "implementation",
    iteration: 0,
    createdBy: squadActor,
    completionGateIds: [],
    presetSnapshotDigest: null,
    pinned: false,
  };

test("squad lease reacquisition reports conflict when another actor takes the released execution", async () => {
  const execution = {
      schema: "execution/v1" as const,
      executionId: "execution-squad-reacquire",
      taskId: task.taskId,
      nodeId: "implementation" as const,
      iteration: 0,
      state: "active" as const,
      actor: squadActor,
      claimedAt: "2026-08-27T00:00:00.000Z",
      submittedAt: null,
      closedAt: null,
      submission: null,
    },
    foreignLease: LeaseV1 = {
      schema: "lease/v1",
      taskId: task.taskId,
      executionId: execution.executionId,
      actor: {
        principal: { personId: "person-other" },
        executor: { kind: "agent", id: "other-runner" },
      },
      source: "local",
      phase: "held",
      expiresAt: "2026-08-28T00:00:00.000Z",
      ttlMs: 86_400_000,
      version: 2,
    },
    snapshot: TaskLifecycleSnapshot = {
      revision: 3,
      task,
      executions: [execution],
      reviews: [],
      consents: [],
      codeDocWitnesses: [],
      gateWitnesses: [],
      edgesTaken: [],
      lease: foreignLease,
    };
  let starts = 0;

  await assert.rejects(
    reacquireSquadTaskLease({
      taskId: task.taskId,
      binding: { actor: squadActor, source: "local" },
      snapshot,
      start: () => {
        starts += 1;
        return Promise.resolve({ outcome: "applied" });
      },
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "lease_conflict",
  );
  assert.equal(starts, 0, "a conflicting lease must not be reacquired or overwritten");
});

test("runtime-batch leaves worker instance selection to the harness", () => {
  const prompt = initialLeaderPrompt({
      taskId: "task-squad",
      squadRunId: "squad_0123456789abcdef01234567",
      roster: "worker -> terra\nsynthesis -> artifacts/reports/{squadRunId}.md",
      mission: "Review the runtime boundary.",
      workerAttempts: [],
    }),
    decision = parseLeaderDecision(
      JSON.stringify({ schema: "runtime-batch/v1", dispatches: [{ to: "terra", prompt: "Review it." }] }),
      ["terra"],
    );

  assert.doesNotMatch(prompt, /"instance"/u);
  assert.deepEqual(decision, {
    kind: "plan",
    dispatches: [{ workerId: "terra", prompt: "Review it." }],
  });
  assert.throws(
    () =>
      parseLeaderDecision(
        JSON.stringify({
          schema: "runtime-batch/v1",
          dispatches: [{ instance: "leader-instance", to: "terra", prompt: "Review it." }],
        }),
        ["terra"],
      ),
    /Leader dispatch contains harness-owned fields\./u,
  );
});
