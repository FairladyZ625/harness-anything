// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionRecord, TaskHolderSnapshot } from "../../kernel/src/index.ts";
import type { TaskCompleteTransitionCommand } from "../src/index.ts";
import {
  resolveTaskCurrentRound,
  TaskLifecycleTransitionPlanningError,
  TaskLifecycleTransitionService,
  taskLifecycleTransitionId
} from "../src/index.ts";

const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8";
const executionId = "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG7";
const callerIdempotencyKey = `task-complete-${"a".repeat(64)}`;
const principal = {
  principal: { personId: "person_alice" },
  executor: { kind: "agent" as const, id: "codex" },
  responsibleHuman: "person_alice"
};

test("one caller idempotency key names one transition independent of snapshot state", () => {
  const command = completeCommand();
  const submitted = execution(executionId, "submitted");
  const first = TaskLifecycleTransitionService.plan(snapshot({
    currentRound: { kind: "submitted", execution: submitted }
  }), command);
  assert.equal(first.kind, "execution-review");
  assert.equal(first.transitionId, taskLifecycleTransitionId(callerIdempotencyKey));

  const replay = TaskLifecycleTransitionService.plan(snapshot({
    taskStatus: "done",
    currentRound: { kind: "accepted-replay", execution: { ...submitted, state: "accepted", closed_at: "2026-08-03T00:10:00.000Z" } },
    existingTransition: {
      transitionId: first.transitionId,
      callerIdempotencyKey,
      taskId,
      committedCase: "execution-review",
      executionId,
      terminalTaskStatus: "done",
      terminalExecutionState: "accepted"
    }
  }), command);

  assert.equal(replay.kind, "already-committed");
  assert.equal(replay.transitionId, first.transitionId);
});

test("current-round resolution never guesses among multiple accepted histories", () => {
  const first = execution("exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG6", "accepted");
  const second = execution("exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5", "accepted");
  const ambiguous = resolveTaskCurrentRound({
    taskId,
    documents: [executionDocument(first), executionDocument(second)]
  });
  assert.deepEqual(ambiguous, {
    kind: "manual-disposition",
    category: "multiple-accepted-history",
    candidateExecutionIds: [second.execution_id, first.execution_id]
  });

  const explicit = resolveTaskCurrentRound({
    taskId,
    executionId: first.execution_id,
    documents: [executionDocument(first), executionDocument(second)]
  });
  assert.equal(explicit.kind, "accepted-replay");
  if (explicit.kind === "accepted-replay") assert.equal(explicit.execution.execution_id, first.execution_id);
});

test("multiple open rounds and missing rounds are explicit manual dispositions", () => {
  const active = execution("exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG4", "active");
  const submitted = execution("exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG3", "submitted");
  assert.deepEqual(resolveTaskCurrentRound({
    taskId,
    documents: [executionDocument(active), executionDocument(submitted)]
  }), {
    kind: "manual-disposition",
    category: "multiple-open-rounds",
    candidateExecutionIds: [submitted.execution_id, active.execution_id]
  });
  assert.deepEqual(resolveTaskCurrentRound({ taskId, documents: [] }), {
    kind: "manual-disposition",
    category: "no-current-round",
    candidateExecutionIds: []
  });
});

test("a terminal transition cannot be planned while the task still has an effective holder", () => {
  const submitted = execution(executionId, "submitted");
  const held: TaskHolderSnapshot = {
    taskId,
    holder: {
      schema: "task-holder/v2",
      taskId,
      executionId,
      phase: "active",
      holder: principal,
      tokenHash: "token",
      acquiredVia: "claim",
      acquiredAt: "2026-08-03T00:00:00.000Z",
      leaseExpiresAt: "2026-08-04T00:00:00.000Z",
      releasedAt: null,
      updatedAt: "2026-08-03T00:00:00.000Z",
      version: "holder-v1"
    },
    effectiveHolder: principal,
    leaseExpiresAt: "2026-08-04T00:00:00.000Z",
    orphan: false
  };

  assert.throws(
    () => TaskLifecycleTransitionService.plan(snapshot({
      currentRound: { kind: "submitted", execution: submitted },
      holder: held
    }), completeCommand()),
    (error: unknown) => error instanceof TaskLifecycleTransitionPlanningError
      && error.code === "TASK_LIFECYCLE_HOLDER_RELEASE_REQUIRED"
  );
});

function snapshot(overrides: Partial<Parameters<typeof TaskLifecycleTransitionService.plan>[0]> = {}): Parameters<typeof TaskLifecycleTransitionService.plan>[0] {
  const submitted = execution(executionId, "submitted");
  return {
    taskId,
    taskStatus: "in_review",
    currentRound: { kind: "submitted", execution: submitted },
    holder: {
      taskId,
      holder: null,
      effectiveHolder: null,
      leaseExpiresAt: null,
      orphan: false
    },
    sessionBinding: { sessionId: "session-lifecycle", actor: principal },
    verifiedExternalWitnesses: [],
    completionContractBodySha256: null,
    ...overrides
  };
}

function completeCommand(): TaskCompleteTransitionCommand {
  return {
    kind: "task-complete",
    taskId,
    executionId,
    ciGate: "passed",
    reviewerId: "person_alice",
    evidenceMode: "execution-review",
    commitRef: null,
    judgment: null,
    approval: {
      executionId,
      findings: "The delivery satisfies the task.",
      evidenceChecked: ["ev_lifecycle"],
      rationale: "The submitted evidence covers the acceptance criteria.",
      archiveWarningsAcknowledged: true,
      consentSource: { kind: "asserted-rationale", rationale: "Owner approval was received." },
      consentActions: ["approve_execution", "complete_task"],
      paths: [],
      prRef: null
    },
    externalCheckpointRefs: [],
    callerIdempotencyKey,
    dryRun: false
  };
}

function execution(id: string, state: ExecutionRecord["state"]): ExecutionRecord {
  return {
    schema: "execution/v2",
    execution_id: id,
    task_ref: `task/${taskId}`,
    state,
    primary_actor: principal,
    claimed_at: "2026-08-03T00:00:00.000Z",
    submitted_at: state === "active" ? null : "2026-08-03T00:05:00.000Z",
    closed_at: state === "accepted" || state === "changes_requested" || state === "abandoned"
      ? "2026-08-03T00:10:00.000Z"
      : null,
    session_bindings: [],
    outputs: [{
      evidence_id: "ev_lifecycle",
      execution_ref: `execution/${taskId}/${id}`,
      locator: { substrate: "inline", text: "Lifecycle evidence" }
    }],
    submission: state === "active" ? null : {
      completion_claim: "Lifecycle transition is complete.",
      deliverables: ["Lifecycle transition"],
      evidence_refs: ["ev_lifecycle"],
      verification_notes: ["Verified."],
      known_gaps: [],
      residual_risks: []
    }
  };
}

function executionDocument(value: ExecutionRecord): { readonly path: string; readonly body: string } {
  return {
    path: `executions/${value.execution_id}.md`,
    body: JSON.stringify(value)
  };
}
