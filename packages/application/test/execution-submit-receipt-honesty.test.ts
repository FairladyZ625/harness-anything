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

    assert.deepEqual(result, { leaseReleased: true });
    assert.equal(authored.executions.get(executionId)?.state, "submitted");
    assert.equal(authored.taskStatus, "in_review");
    assert.equal((await holder.holder({ taskId })).effectiveHolder, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
