// harness-test-tier: integration
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeJournaledWriteCoordinator, taskHolderActor } from "../src/index.ts";
import {
  executionDeclaration,
  reviewDeclaration,
  sha256Text,
  stablePayloadHash,
  writeDeclaredEntityTransaction,
  type ExecutionRecord,
  type ReviewRecord
} from "../../kernel/src/index.ts";
import { runEffect } from "./effect-test-helpers.ts";
import { writeAttribution } from "./test-attribution.ts";
import { taskIndex } from "./execution-saga-fixtures.ts";

const taskId = "task_01KXT7PXRADN9575XFZC321PRV";
const executionId = "exe_01KXT7PXRADN9575XFZC321PRW";
const reviewId = "rev_01KXT7PXRADN9575XFZC321PRX";
const reviewedAt = "2026-07-18T09:00:00.000Z";
const actor = taskHolderActor({ personId: "alice", displayName: "Alice" }, { kind: "agent", id: "codex" });

test("changes_requested review rolls back review and prior companions when either companion write fails", async () => {
  for (const killpoint of ["execution-companion", "task-companion"] as const) {
    const rootDir = mkdtempSync(path.join(tmpdir(), `ha-review-cr-${killpoint}-`));
    const taskRoot = path.join(rootDir, "harness/tasks", taskId);
    const executionRoot = path.join(taskRoot, "executions");
    const reviewRoot = path.join(taskRoot, "reviews");
    try {
      mkdirSync(executionRoot, { recursive: true });
      mkdirSync(reviewRoot, { recursive: true });
      const currentExecution = execution("submitted");
      const nextExecution = execution("changes_requested");
      const executionPath = path.join(executionRoot, `${executionId}.md`);
      const indexPath = path.join(taskRoot, "INDEX.md");
      const reviewPath = path.join(reviewRoot, `${reviewId}.md`);
      const currentExecutionBody = executionDeclaration.documentCodec.encode(currentExecution);
      const currentIndex = taskIndex(taskId, "in_review");
      writeFileSync(executionPath, currentExecutionBody, "utf8");
      writeFileSync(indexPath, currentIndex, "utf8");
      const coordinator = makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "codex") });
      if (killpoint === "execution-companion") chmodSync(executionRoot, 0o500);
      if (killpoint === "task-companion") chmodSync(taskRoot, 0o500);

      await assert.rejects(runEffect(writeDeclaredEntityTransaction(
        coordinator,
        stablePayloadHash,
        reviewDeclaration,
        { taskId, reviewId },
        review(),
        [
          { taskId, path: `executions/${executionId}.md`, body: executionDeclaration.documentCodec.encode(nextExecution) },
          { taskId, path: "INDEX.md", body: currentIndex.replace(/^(  status:\s*).+$/mu, "$1active") }
        ],
        [
          { taskId, path: `executions/${executionId}.md`, bodySha256: sha256Text(currentExecutionBody) },
          { taskId, path: `reviews/${reviewId}.md`, bodySha256: null },
          { taskId, path: "INDEX.md", bodySha256: sha256Text(currentIndex) }
        ]
      )), /EACCES|permission denied|operation not permitted/iu);

      if (killpoint === "execution-companion") chmodSync(executionRoot, 0o700);
      if (killpoint === "task-companion") chmodSync(taskRoot, 0o700);
      assert.equal(existsSync(reviewPath), false, killpoint);
      assert.equal(readFileSync(executionPath, "utf8"), currentExecutionBody, killpoint);
      assert.equal(readFileSync(indexPath, "utf8"), currentIndex, killpoint);
    } finally {
      chmodSync(taskRoot, 0o700);
      if (existsSync(executionRoot)) chmodSync(executionRoot, 0o700);
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

function execution(state: "submitted" | "changes_requested"): ExecutionRecord {
  return {
    schema: "execution/v2", execution_id: executionId, task_ref: `task/${taskId}`, state,
    primary_actor: actor, claimed_at: "2026-07-18T08:00:00.000Z",
    submitted_at: "2026-07-18T08:30:00.000Z", closed_at: state === "changes_requested" ? reviewedAt : null,
    session_bindings: [], outputs: [],
    submission: { completion_claim: "Probe delivery", deliverables: [], evidence_refs: [], verification_notes: [], known_gaps: [], residual_risks: [] }
  };
}

function review(): ReviewRecord {
  return {
    schema: "review/v3", review_id: reviewId, task_ref: `task/${taskId}`,
    execution_ref: `execution/${taskId}/${executionId}`, reviewer_actor: actor,
    reviewer_session_ref: "session/reviewer", findings: "Changes required", evidence_checked: [],
    rationale: "The delivery needs another round.", verdict: "changes_requested",
    archive_warnings_acknowledged: false, approval_basis: null, reviewed_at: reviewedAt
  };
}
