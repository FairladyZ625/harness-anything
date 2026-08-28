// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  REPLAY_TASK_GRAPH,
  type ExecutionV1,
  type TaskLifecycleSnapshot,
  type TaskV1,
} from "../../kernel/src/index.ts";
import { buildCommand } from "../src/repo-cell-command.ts";

const taskId = "task-code-doc-source",
  actor = { principal: { personId: "person-owner" }, executor: null } as const,
  task: TaskV1 = {
    schema: "task/v1",
    taskId,
    title: "Code-doc source",
    taskClass: "standard",
    status: "done",
    graph: REPLAY_TASK_GRAPH,
    currentNode: "review",
    iteration: 0,
    createdBy: actor,
    completionGateIds: ["code-doc-reconciliation"],
    presetSnapshotDigest: null,
  },
  submission = {
    completionClaim: "Complete",
    deliverables: ["README.md"],
    outputs: ["README.md"],
    verificationNotes: ["tests"],
    knownGaps: [],
    residualRisks: [],
    commitSha: "a".repeat(40),
  },
  binding = { actor, source: "local" } as const;

function execution(executionId: string, state: ExecutionV1["state"]): ExecutionV1 {
  return {
    schema: "execution/v1",
    executionId,
    taskId,
    nodeId: "implementation",
    iteration: 0,
    state,
    actor,
    claimedAt: "2026-08-29T00:00:00.000Z",
    submittedAt: "2026-08-29T00:01:00.000Z",
    closedAt: state === "accepted" ? "2026-08-29T00:02:00.000Z" : null,
    submission,
  };
}

function snapshot(executions: readonly ExecutionV1[]): TaskLifecycleSnapshot {
  return {
    revision: 7,
    task,
    executions,
    reviews: [],
    consents: [],
    codeDocWitnesses: [],
    gateWitnesses: [],
    edgesTaken: [],
    lease: null,
  };
}

function repoint(source: TaskLifecycleSnapshot, extra: Readonly<Record<string, unknown>> = {}) {
  return buildCommand(
    {
      kind: "task-code-doc-repoint",
      taskId,
      record: "code-doc-active",
      paths: ["README.md"],
      reason: "Correct witness",
      ...extra,
    },
    taskId,
    binding,
    "repo-code-doc-source",
    source.revision,
    "/repo",
    source,
  );
}

test("reconcile and repoint derive the commit from the same execution submission", () => {
  const accepted = execution("execution-one", "accepted"),
    repointed = repoint(snapshot([accepted])),
    submitted = execution("execution-one", "submitted"),
    reconciled = buildCommand(
      { kind: "task-code-doc-reconcile", taskId },
      taskId,
      binding,
      "repo-code-doc-source",
      7,
      "/repo",
      snapshot([submitted]),
    );
  assert.equal(repointed.type, "RepointCodeDoc");
  assert.equal(reconciled.type, "ReconcileCodeDoc");
  if (repointed.type === "RepointCodeDoc" && reconciled.type === "ReconcileCodeDoc") {
    assert.equal(repointed.commitSha, submission.commitSha);
    assert.equal(reconciled.commitSha, submission.commitSha);
    assert.deepEqual(repointed.paths, reconciled.paths);
  }
});

test("repoint rejects caller drift and missing or conflicting canonical submissions", () => {
  assert.throws(
    () => repoint(snapshot([execution("execution-one", "accepted")]), { commitSha: "b".repeat(40) }),
    /without commitSha; the submitted execution supplies the witness cut/u,
  );
  assert.throws(() => repoint(snapshot([])), /found none/u);
  assert.throws(
    () => repoint(snapshot([execution("execution-one", "accepted"), execution("execution-two", "accepted")])),
    /found execution-one, execution-two/u,
  );
});
