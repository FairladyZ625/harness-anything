// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  TaskSubmitTransitionService,
  taskSubmitPlanInput
} from "../src/index.ts";
import { taskHolderActor, type ExecutionRecord } from "../../kernel/src/index.ts";

const taskId = "task_01KZ2DNXA7659VD5QGEFV94X4T";
const executionId = "exe_01KZ2DNXA7659VD5QGEFV94X4T";
const submittedAt = "2026-08-03T12:00:00.000Z";

test("task submit planner owns the submitted Execution and in_review Task bytes", () => {
  const plan = TaskSubmitTransitionService.plan({
    rootInput: "/fixture",
    taskId,
    taskIndexBody: taskIndex("active"),
    execution: activeExecution(),
    submittedAt
  }, taskSubmitPlanInput(command()));

  assert.equal(plan.schema, "task-submit-transition-plan/v1");
  assert.equal(plan.execution.state, "submitted");
  assert.equal(plan.execution.submitted_at, submittedAt);
  assert.deepEqual(plan.execution.submission, {
    completion_claim: "Ready for review.",
    deliverables: ["typed submission"],
    evidence_refs: ["ev_cli_1"],
    verification_notes: ["tests passed"],
    known_gaps: [],
    residual_risks: ["none"]
  });
  assert.equal(plan.execution.outputs.at(-1)?.locator.substrate, "inline");
  assert.match(plan.taskIndexBody, /^  status: in_review$/mu);
  assert.equal(plan.execution.session_bindings[0]?.capture_range?.end_at, submittedAt);
});

test("task submit planner rejects state and identity drift before producing bytes", () => {
  assert.throws(() => TaskSubmitTransitionService.plan({
    rootInput: "/fixture",
    taskId,
    taskIndexBody: taskIndex("planned"),
    execution: activeExecution(),
    submittedAt
  }, taskSubmitPlanInput(command())), /task status planned cannot enter in_review/u);

  assert.throws(() => TaskSubmitTransitionService.plan({
    rootInput: "/fixture",
    taskId,
    taskIndexBody: taskIndex("active"),
    execution: { ...activeExecution(), execution_id: "exe_OTHER" },
    submittedAt
  }, taskSubmitPlanInput(command())), /execution identity does not match/u);
});

function command() {
  return {
    kind: "task-submit" as const,
    taskId,
    executionId,
    leaseToken: null,
    submission: {
      completionClaim: "Ready for review.",
      deliverables: ["typed submission"],
      outputs: ["integration passed"],
      verificationNotes: ["tests passed"],
      knownGaps: [],
      residualRisks: ["none"]
    },
    callerIdempotencyKey: "task-submit-planner-test",
    dryRun: false
  };
}

function activeExecution(): ExecutionRecord {
  return {
    schema: "execution/v2",
    execution_id: executionId,
    task_ref: `task/${taskId}`,
    state: "active",
    primary_actor: taskHolderActor(
      { personId: "person_test" },
      { kind: "agent", id: "codex" }
    ),
    claimed_at: "2026-08-03T11:00:00.000Z",
    submitted_at: null,
    closed_at: null,
    session_bindings: [{
      binding_id: "primary:session_test",
      session_ref: "session/session_test",
      role: "primary",
      archive_status: "unavailable",
      attached_at: "2026-08-03T11:00:00.000Z",
      session: null,
      capture_range: {
        range_id: "range_test",
        coordinate: "timestamp",
        start_at: "2026-08-03T11:00:00.000Z",
        end_at: null,
        bounds: "inclusive"
      }
    }],
    outputs: [],
    submission: null
  };
}

function taskIndex(status: "planned" | "active"): string {
  return `---\nha:\n  status: ${status}\n  engine: local\n---\n`;
}
