// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { ExecutionRecord } from "../../kernel/src/index.ts";
import { runJson, withTempRoot, writeIndex } from "./helpers/task-document-gates-fixtures.ts";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";

type OpenTaskStatus = "planned" | "active" | "blocked" | "in_review";
type MatrixTaskStatus = OpenTaskStatus | "done" | "cancelled";
type RoundState = ExecutionRecord["state"];

interface RecoveryShape {
  readonly name: string;
  readonly taskStatus: MatrixTaskStatus;
  readonly rounds: ReadonlyArray<RoundState>;
}

const recoveryShapes: ReadonlyArray<RecoveryShape> = [
  { name: "planned + zero round", taskStatus: "planned", rounds: [] },
  { name: "active + zero round", taskStatus: "active", rounds: [] },
  { name: "active + active round", taskStatus: "active", rounds: ["active"] },
  { name: "active + submitted round", taskStatus: "active", rounds: ["submitted"] },
  { name: "active + accepted round", taskStatus: "active", rounds: ["accepted"] },
  { name: "active + closed round mix", taskStatus: "active", rounds: ["changes_requested", "abandoned"] },
  { name: "active + submitted/accepted mix", taskStatus: "active", rounds: ["submitted", "accepted"] },
  { name: "blocked + zero round", taskStatus: "blocked", rounds: [] },
  { name: "blocked + active round", taskStatus: "blocked", rounds: ["active"] },
  { name: "blocked + submitted round", taskStatus: "blocked", rounds: ["submitted"] },
  { name: "in_review + zero round", taskStatus: "in_review", rounds: [] },
  { name: "in_review + active round", taskStatus: "in_review", rounds: ["active"] },
  { name: "in_review + submitted round", taskStatus: "in_review", rounds: ["submitted"] },
  { name: "in_review + accepted round", taskStatus: "in_review", rounds: ["accepted"] },
  { name: "in_review + closed round mix", taskStatus: "in_review", rounds: ["changes_requested", "abandoned"] },
  { name: "in_review + duplicate submitted rounds", taskStatus: "in_review", rounds: ["submitted", "submitted"] },
  { name: "in_review + active/accepted mix", taskStatus: "in_review", rounds: ["active", "accepted"] },
  { name: "done + accepted round", taskStatus: "done", rounds: ["accepted"] },
  { name: "cancelled + retired round", taskStatus: "cancelled", rounds: ["abandoned"] }
];

for (const [shapeIndex, shape] of recoveryShapes.entries()) {
  test(`lifecycle recovery matrix: ${shape.name}`, () => {
    withTempRoot((rootDir) => {
      const taskId = matrixId("task", shapeIndex);
      const taskRoot = path.join(rootDir, "harness/tasks", taskId);
      writeIndex(rootDir, taskId, shape.name, shape.taskStatus);
      writeSubstantiveTaskPlan(rootDir, `harness/tasks/${taskId}`);
      const executionIds = shape.rounds.map((state, roundIndex) => {
        const executionId = matrixId("exe", shapeIndex * 4 + roundIndex);
        writeExecution(taskRoot, executionId, state);
        return executionId;
      });
      const terminalIndexBefore = isTerminal(shape.taskStatus)
        ? readFileSync(path.join(taskRoot, "INDEX.md"), "utf8")
        : null;
      const terminalExecutionsBefore = isTerminal(shape.taskStatus)
        ? listExecutions(taskRoot)
        : null;

      if (isTerminal(shape.taskStatus)) {
        assert.equal(readTaskStatus(taskRoot), shape.taskStatus);
        const rejectedSubmit = runJson(rootDir, [
          "task", "submit", taskId, "--from-file", writeSubmissionPacket(rootDir, shapeIndex)
        ], false, actorEnv);
        assert.equal(rejectedSubmit.ok, false, JSON.stringify(rejectedSubmit));
        const rejectedComplete = runJson(rootDir, [
          "task", "complete", taskId, "--ci", "passed", "--reviewer", "person_matrix"
        ], false, actorEnv);
        assert.equal(rejectedComplete.ok, false, JSON.stringify(rejectedComplete));
        const rejectedStart = runJson(rootDir, ["task", "start", taskId], false, actorEnv);
        assert.equal(rejectedStart.ok, false, JSON.stringify(rejectedStart));
        assert.equal(rejectedStart.error?.code, "terminal_reopen_requires_supersede");
        assert.match(String(rejectedStart.error?.hint), /ha task supersede .* --title <follow-up-title>.*ha task create --title <follow-up-title>/u);
        assert.equal(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), terminalIndexBefore);
        assert.deepEqual(listExecutions(taskRoot), terminalExecutionsBefore);
        return;
      }

      if (shape.taskStatus === "planned") {
        const started = runJson(rootDir, ["task", "start", taskId], true, actorEnv);
        assert.equal(started.status, "active");
        assert.equal(readTaskStatus(taskRoot), "active");
        assert.equal(readExecution(taskRoot, String(started.executionId)).state, "active");
        return;
      }

      if (shape.taskStatus === "blocked") {
        const activated = runJson(rootDir, ["task", "transition", taskId, "active"], true, actorEnv);
        assert.equal(activated.status, "active");
      }

      for (const executionId of executionIds.filter((id) => readExecution(taskRoot, id).state === "submitted")) {
        requestChanges(rootDir, taskId, executionId);
      }
      for (const executionId of executionIds.filter((id) => readExecution(taskRoot, id).state === "accepted")) {
        requestChanges(rootDir, taskId, executionId);
      }

      if (readTaskStatus(taskRoot) === "in_review") {
        const existingActive = executionIds.find((id) => readExecution(taskRoot, id).state === "active");
        const started = runJson(rootDir, [
          "task", "start", taskId,
          ...(existingActive ? ["--execution-id", existingActive] : [])
        ], true, actorEnv);
        const recoveryExecutionId = String(started.executionId);
        makeBindingFinal(taskRoot, recoveryExecutionId);
        const submitted = runJson(rootDir, [
          "task", "submit", taskId, "--from-file", writeSubmissionPacket(rootDir, shapeIndex)
        ], true, actorEnv);
        assert.equal(submitted.ok, true);
        assert.equal(readTaskStatus(taskRoot), "in_review");
        requestChanges(rootDir, taskId, recoveryExecutionId);
      }

      assert.equal(readTaskStatus(taskRoot), "active");
      const reusable = listExecutions(taskRoot).find((execution) => execution.state === "active");
      const restarted = runJson(rootDir, [
        "task", "start", taskId,
        ...(reusable ? ["--execution-id", reusable.execution_id] : [])
      ], true, actorEnv);
      assert.equal(restarted.status, "active");
      assert.equal(readExecution(taskRoot, String(restarted.executionId)).state, "active");
    });
  });
}

function requestChanges(rootDir: string, taskId: string, executionId: string): void {
  const reviewed = runJson(rootDir, [
    "task", "review-execution", taskId,
    "--execution-id", executionId,
    "--verdict", "changes_requested",
    "--findings", "This historical round needs a fresh recovery round.",
    "--rationale", "Returning the task to active preserves the review boundary.",
    "--acknowledge-archive-warnings"
  ], true, actorEnv);
  assert.equal(reviewed.executionId, executionId);
  assert.equal(readExecution(path.join(rootDir, "harness/tasks", taskId), executionId).state, "changes_requested");
}

function writeExecution(taskRoot: string, executionId: string, state: RoundState): void {
  const submitted = state === "submitted" || state === "accepted" || state === "changes_requested";
  const closed = state === "accepted" || state === "changes_requested" || state === "abandoned";
  const execution: ExecutionRecord = {
    schema: "execution/v2",
    execution_id: executionId,
    task_ref: `task/${path.basename(taskRoot)}`,
    state,
    primary_actor: {
      principal: { personId: "person_matrix" },
      executor: { kind: "agent", id: "matrix-worker" },
      responsibleHuman: "person_matrix"
    },
    claimed_at: "2026-07-31T00:00:00.000Z",
    submitted_at: submitted ? "2026-07-31T00:01:00.000Z" : null,
    closed_at: closed ? "2026-07-31T00:02:00.000Z" : null,
    session_bindings: [finalBinding(executionId)],
    outputs: [],
    submission: submitted ? {
      completion_claim: `historical ${state} round`,
      deliverables: [],
      evidence_refs: [],
      verification_notes: [],
      known_gaps: [],
      residual_risks: []
    } : null
  };
  mkdirSync(path.join(taskRoot, "executions"), { recursive: true });
  writeFileSync(
    path.join(taskRoot, "executions", `${executionId}.md`),
    `${JSON.stringify(execution, null, 2)}\n`,
    "utf8"
  );
}

function makeBindingFinal(taskRoot: string, executionId: string): void {
  const execution = readExecution(taskRoot, executionId);
  writeFileSync(
    path.join(taskRoot, "executions", `${executionId}.md`),
    `${JSON.stringify({ ...execution, session_bindings: [finalBinding(executionId)] }, null, 2)}\n`,
    "utf8"
  );
}

function finalBinding(executionId: string): ExecutionRecord["session_bindings"][number] {
  return {
    binding_id: `primary:${executionId}`,
    session_ref: `session/${executionId}`,
    role: "primary",
    archive_status: "unavailable",
    attached_at: "2026-07-31T00:00:00.000Z",
    session: null,
    capture_range: null
  };
}

function writeSubmissionPacket(rootDir: string, shapeIndex: number): string {
  const packetPath = path.join(rootDir, `recovery-submission-${shapeIndex}.json`);
  writeFileSync(packetPath, JSON.stringify({
    completionClaim: "The recovered round is ready for a fresh review.",
    deliverables: [],
    outputs: [],
    verificationNotes: [],
    knownGaps: [],
    residualRisks: []
  }), "utf8");
  return packetPath;
}

function listExecutions(taskRoot: string): ReadonlyArray<ExecutionRecord> {
  const executionRoot = path.join(taskRoot, "executions");
  try {
    return readdirSync(executionRoot)
      .filter((name) => name.endsWith(".md"))
      .map((name) => readExecution(taskRoot, name.slice(0, -".md".length)));
  } catch {
    return [];
  }
}

function readExecution(taskRoot: string, executionId: string): ExecutionRecord {
  return JSON.parse(readFileSync(
    path.join(taskRoot, "executions", `${executionId}.md`),
    "utf8"
  )) as ExecutionRecord;
}

function readTaskStatus(taskRoot: string): string {
  return readFileSync(path.join(taskRoot, "INDEX.md"), "utf8")
    .match(/^  status:\s*(.+)$/mu)?.[1]?.trim() ?? "";
}

function matrixId(kind: "task" | "exe", index: number): string {
  const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return `${kind}_01KYSZFDY3GAS9H3GAEHTH50${crockford[Math.floor(index / 32)]}${crockford[index % 32]}`;
}

function isTerminal(status: MatrixTaskStatus): status is "done" | "cancelled" {
  return status === "done" || status === "cancelled";
}

const actorEnv = { HARNESS_ACTOR: "agent:matrix-worker" } as const;
