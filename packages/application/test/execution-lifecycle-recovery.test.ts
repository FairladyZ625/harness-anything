// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeExecutionCompletionService,
  makeExecutionSagaService,
  makeJournaledWriteCoordinator,
  makeMarkdownArtifactStore,
  makeReviewExecutionService,
  makeTaskHolderService,
  taskHolderActor,
  type ExecutionRecord
} from "../src/index.ts";
import { memoryAuthoredStore, taskIndex } from "./execution-saga-fixtures.ts";
import { writeAttribution } from "./test-attribution.ts";

const taskId = "task_01KX19GEKWMEJNGSMRT6JJH6HY";
const executionIds = [
  "exe_01KX7H00000000000000000001",
  "exe_01KX7H00000000000000000002",
  "exe_01KX7H00000000000000000003",
  "exe_01KX7H00000000000000000004",
  "exe_01KX7H00000000000000000005"
] as const;
const reviewIds = [
  "rev_01KX7H00000000000000000001",
  "rev_01KX7H00000000000000000002"
] as const;
const aliceCodex = taskHolderActor(
  { personId: "alice", displayName: "Alice" },
  { kind: "agent", id: "codex" }
);
const aliceClaude = taskHolderActor(
  { personId: "alice", displayName: "Alice" },
  { kind: "agent", id: "claude-code" }
);
const attribution = writeAttribution("alice", "codex");

test("Execution claim reuses the sole active authored round after lease release", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-execution-resume-"));
  try {
    const holder = makeTaskHolderService({ rootInput: rootDir });
    const authored = memoryAuthoredStore();
    const generated = [executionIds[0], executionIds[1]];
    const saga = makeExecutionSagaService({
      taskHolderService: holder,
      authoredStore: authored,
      generateExecutionId: () => generated.shift()!,
      now: () => "2026-07-11T00:00:00.000Z"
    });

    const first = await saga.claim({ taskId, principal: aliceCodex });
    await holder.releaseExecution({
      taskId,
      executionId: executionIds[0],
      leaseToken: first.leaseToken,
      principal: aliceCodex
    });
    const resumed = await saga.claim({ taskId, principal: aliceCodex });

    assert.equal(resumed.executionId, executionIds[0]);
    assert.equal(resumed.reused, true);
    assert.equal(authored.executions.size, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("changes_requested keeps another submitted round reviewable and the remaining round completes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-execution-multi-round-recovery-"));
  try {
    const taskRoot = createTask(rootDir, "active");
    writeExecutionFixture(taskRoot, executionFixture(executionIds[0], "submitted"));
    writeExecutionFixture(taskRoot, executionFixture(executionIds[1], "submitted"));
    const coordinator = makeJournaledWriteCoordinator({ rootDir, attribution });
    const artifactStore = makeMarkdownArtifactStore({ rootDir });
    const generatedReviewIds = [...reviewIds];
    const reviews = makeReviewExecutionService({
      rootInput: rootDir,
      coordinator,
      artifactStore,
      generateReviewId: () => generatedReviewIds.shift()!,
      now: () => "2026-07-11T00:02:00.000Z"
    });

    await reviews.reviewExecution({
      taskId,
      executionId: executionIds[0],
      reviewer: aliceClaude,
      reviewerSession: reviewSession("review-redundant"),
      findings: "This duplicate round is superseded.",
      evidenceChecked: [],
      rationale: "The other submitted round remains authoritative.",
      verdict: "changes_requested",
      archiveWarningsAcknowledged: false
    });

    assert.equal(readExecutionState(taskRoot, executionIds[0]), "changes_requested");
    assert.equal(readExecutionState(taskRoot, executionIds[1]), "submitted");
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: in_review$/mu);

    await reviews.reviewExecution({
      taskId,
      executionId: executionIds[1],
      reviewer: aliceClaude,
      reviewerSession: reviewSession("review-authoritative"),
      findings: "The authoritative round satisfies the task.",
      evidenceChecked: [],
      rationale: "The submitted claim is complete.",
      verdict: "approved",
      archiveWarningsAcknowledged: false,
      consentAssertedRationale: "Approval was received through an external channel."
    });
    const completion = makeExecutionCompletionService({
      rootInput: rootDir,
      coordinator,
      artifactStore,
      now: () => "2026-07-11T00:03:00.000Z"
    });

    assert.deepEqual(await completion.completeTaskExecution({ taskId, actor: aliceCodex }), { executionId: executionIds[1] });
    assert.equal(readExecutionState(taskRoot, executionIds[1]), "accepted");
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: done$/mu);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("X5-shaped five-round state completes from an active Task projection and abandons stale active rounds", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-execution-x5-recovery-"));
  try {
    const taskRoot = createTask(rootDir, "in_review");
    writeExecutionFixture(taskRoot, executionFixture(executionIds[2], "submitted"));
    const coordinator = makeJournaledWriteCoordinator({ rootDir, attribution });
    const artifactStore = makeMarkdownArtifactStore({ rootDir });
    const reviews = makeReviewExecutionService({
      rootInput: rootDir,
      coordinator,
      artifactStore,
      generateReviewId: () => reviewIds[0],
      now: () => "2026-07-11T00:02:00.000Z"
    });
    await reviews.reviewExecution({
      taskId,
      executionId: executionIds[2],
      reviewer: aliceClaude,
      reviewerSession: reviewSession("review-x5"),
      findings: "The authoritative X5 round is complete.",
      evidenceChecked: [],
      rationale: "The delivery satisfies the task intent.",
      verdict: "approved",
      archiveWarningsAcknowledged: false,
      consentAssertedRationale: "Approval was received through an external channel."
    });

    writeExecutionFixture(taskRoot, executionFixture(executionIds[0], "active"));
    writeExecutionFixture(taskRoot, executionFixture(executionIds[1], "changes_requested"));
    writeExecutionFixture(taskRoot, executionFixture(executionIds[3], "changes_requested"));
    writeExecutionFixture(taskRoot, executionFixture(executionIds[4], "active"));
    writeFileSync(
      path.join(taskRoot, "INDEX.md"),
      readFileSync(path.join(taskRoot, "INDEX.md"), "utf8").replace(/^(  status:\s*).+$/mu, "$1active"),
      "utf8"
    );
    const completion = makeExecutionCompletionService({
      rootInput: rootDir,
      coordinator,
      artifactStore,
      now: () => "2026-07-11T00:03:00.000Z"
    });

    assert.deepEqual(await completion.completeTaskExecution({ taskId, actor: aliceCodex }), { executionId: executionIds[2] });
    assert.deepEqual(executionIds.map((id) => readExecutionState(taskRoot, id)), [
      "abandoned", "changes_requested", "accepted", "changes_requested", "abandoned"
    ]);
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: done$/mu);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function createTask(rootDir: string, status: "active" | "in_review"): string {
  const taskRoot = path.join(rootDir, "harness/tasks", `${taskId}-lifecycle-recovery`);
  mkdirSync(path.join(taskRoot, "executions"), { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex(taskId, status), "utf8");
  return taskRoot;
}

function executionFixture(id: string, state: ExecutionRecord["state"]): ExecutionRecord {
  const submitted = state === "submitted";
  const closed = state === "changes_requested" || state === "accepted" || state === "abandoned";
  return {
    schema: "execution/v2",
    execution_id: id,
    task_ref: `task/${taskId}`,
    state,
    primary_actor: aliceCodex,
    claimed_at: "2026-07-11T00:00:00.000Z",
    submitted_at: submitted || closed ? "2026-07-11T00:01:00.000Z" : null,
    closed_at: closed ? "2026-07-11T00:02:00.000Z" : null,
    session_bindings: [{
      binding_id: `primary:${id}`,
      session_ref: `session/${id}`,
      role: "primary",
      archive_status: "complete",
      attached_at: "2026-07-11T00:00:00.000Z",
      session: null,
      capture_range: null
    }],
    outputs: [],
    submission: submitted || closed ? {
      completion_claim: `claim for ${id}`,
      deliverables: [],
      evidence_refs: [],
      verification_notes: [],
      known_gaps: [],
      residual_risks: []
    } : null
  };
}

function reviewSession(sessionId: string) {
  return {
    runtime: "claude-code" as const,
    sessionId,
    source: "runtime" as const,
    detectedAt: "2026-07-11T00:02:00.000Z"
  };
}

function writeExecutionFixture(taskRoot: string, execution: ExecutionRecord): void {
  writeFileSync(path.join(taskRoot, "executions", `${execution.execution_id}.md`), `${JSON.stringify(execution, null, 2)}\n`, "utf8");
}

function readExecutionState(taskRoot: string, id: string): ExecutionRecord["state"] {
  return (JSON.parse(readFileSync(path.join(taskRoot, "executions", `${id}.md`), "utf8")) as ExecutionRecord).state;
}
