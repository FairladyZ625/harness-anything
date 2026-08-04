// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeExecutionSagaService,
  makeTaskHolderService,
  taskHolderActor
} from "../src/index.ts";
import { memoryAuthoredStore } from "./execution-saga-fixtures.ts";

const taskId = "task_01KX19GEKWMEJNGSMRT6JJH6HY";
const executionId = "exe_01KX7H00000000000000000001";
const actor = taskHolderActor(
  { personId: "alice", displayName: "Alice" },
  { kind: "agent", id: "codex" }
);

test("submit reports the committed authored outcome when its lease expires during publication", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-submit-receipt-honesty-"));
  let nowMs = Date.parse("2026-07-30T00:00:00.000Z");
  try {
    const holder = makeTaskHolderService({
      rootInput: rootDir,
      now: () => new Date(nowMs)
    });
    const authored = memoryAuthoredStore();
    const publish = authored.submitForReview;
    const authoredWithSlowPublication = {
      ...authored,
      submitForReview: async (input: Parameters<typeof publish>[0]) => {
        await publish(input);
        nowMs += 120_000;
      }
    };
    const saga = makeExecutionSagaService({
      taskHolderService: holder,
      authoredStore: authoredWithSlowPublication,
      generateExecutionId: () => executionId,
      now: () => new Date(nowMs).toISOString()
    });
    await saga.claim({ taskId, principal: actor, ttlMs: 60_000 });
    authored.taskStatus = "active";

    const result = await saga.submitForReview({
      taskId,
      executionId,
      principal: actor,
      submission: {
        completionClaim: "publication committed before lease cleanup",
        deliverables: [],
        verificationNotes: [],
        knownGaps: [],
        residualRisks: [],
        evidence: []
      }
    });

    assert.equal(result.leaseReleased, true);
    assert.equal(result.cleanup.status, "released");
    assert.deepEqual(result.cleanup.diagnostics, []);
    assert.equal(authored.executions.get(executionId)?.state, "submitted");
    assert.equal(authored.taskStatus, "in_review");
    assert.equal((await holder.holder({ taskId })).effectiveHolder, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("submit adopts the exact authored publication when the store throws after commit", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-submit-commit-after-error-"));
  try {
    const holder = makeTaskHolderService({ rootInput: rootDir });
    const authored = memoryAuthoredStore();
    const publishedThenRejected = {
      ...authored,
      submitForReview: async (input: Parameters<typeof authored.submitForReview>[0]) => {
        await authored.submitForReview(input);
        throw new Error("publication transport failed after authored commit");
      },
      submitPublicationState: async () => "committed" as const
    };
    const saga = makeExecutionSagaService({
      taskHolderService: holder,
      authoredStore: publishedThenRejected,
      generateExecutionId: () => executionId,
      now: () => new Date("2026-07-30T00:00:00.000Z").toISOString()
    });
    await saga.claim({ taskId, principal: actor, ttlMs: 60_000 });
    authored.taskStatus = "active";

    const result = await saga.submitForReview({
      taskId,
      executionId,
      principal: actor,
      submission: {
        completionClaim: "committed before transport error",
        deliverables: [],
        verificationNotes: [],
        knownGaps: [],
        residualRisks: [],
        evidence: []
      }
    });

    assert.deepEqual(result, {
      leaseReleased: true,
      cleanup: { status: "released", diagnostics: [] }
    });
    assert.equal(authored.executions.get(executionId)?.state, "submitted");
    assert.equal(authored.taskStatus, "in_review");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("submit reports cleanup unknown with both release and verification diagnostics", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-submit-cleanup-double-failure-"));
  try {
    const holder = makeTaskHolderService({ rootInput: rootDir });
    const cleanupFailures = {
      ...holder,
      releaseExecution: async () => {
        throw new Error("release credential rejected");
      },
      reconcileExecution: async () => {
        throw new Error("cleanup journal disk full");
      }
    };
    const authored = memoryAuthoredStore();
    const saga = makeExecutionSagaService({
      taskHolderService: cleanupFailures,
      authoredStore: authored,
      generateExecutionId: () => executionId,
      now: () => "2026-07-30T00:00:00.000Z"
    });
    await saga.claim({ taskId, principal: actor, ttlMs: 60_000 });
    authored.taskStatus = "active";

    const result = await saga.submitForReview({
      taskId,
      executionId,
      principal: actor,
      submission: {
        completionClaim: "authored commit survives cleanup failures",
        deliverables: [],
        verificationNotes: [],
        knownGaps: [],
        residualRisks: [],
        evidence: []
      }
    });

    assert.deepEqual(result, {
      leaseReleased: false,
      cleanup: {
        status: "unknown",
        diagnostics: [
          { phase: "release", message: "Error: release credential rejected" },
          { phase: "verification", message: "Error: cleanup journal disk full" }
        ]
      }
    });
    assert.equal(authored.executions.get(executionId)?.state, "submitted");
    assert.equal(authored.taskStatus, "in_review");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
