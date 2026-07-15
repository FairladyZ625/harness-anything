// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ExecutionLeaseCollisionError,
  makeExecutionSagaService,
  makeTaskHolderService,
  taskHolderActor
} from "../src/index.ts";
import { memoryAuthoredStore } from "./execution-saga-fixtures.ts";

const taskId = "task_01KX19GEKWMEJNGSMRT6JJH6HY";
const executionId = "exe_01KX7H00000000000000000001";
const aliceCodex = taskHolderActor(
  { personId: "alice", displayName: "Alice" },
  { kind: "agent", id: "codex" }
);
const aliceClaude = taskHolderActor(
  { personId: "alice", displayName: "Alice" },
  { kind: "agent", id: "claude-code" }
);

test("the active execution holder can renew its token while other holders and stale tokens are rejected", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-execution-renew-"));
  const leaseActions: string[] = [];
  let generatedExecutionIds = 0;
  try {
    const holder = makeTaskHolderService({
      rootInput: rootDir,
      now: () => new Date("2026-07-11T00:00:00.000Z"),
      appendLeaseEvent: async (event) => { leaseActions.push(event.lease.action); }
    });
    const authored = memoryAuthoredStore();
    const saga = makeExecutionSagaService({
      taskHolderService: holder,
      authoredStore: authored,
      generateExecutionId: () => {
        generatedExecutionIds += 1;
        return executionId;
      },
      now: () => "2026-07-11T00:00:00.000Z"
    });

    const claimed = await saga.claim({ taskId, principal: aliceCodex });
    const renewed = await saga.claim({ taskId, principal: aliceCodex });

    assert.equal(renewed.executionId, claimed.executionId);
    assert.equal(renewed.execution.execution_id, claimed.execution.execution_id);
    assert.notEqual(renewed.leaseToken, claimed.leaseToken);
    assert.equal(generatedExecutionIds, 1);
    assert.equal(authored.executions.size, 1);
    assert.deepEqual(leaseActions, ["reserved", "activated", "renewed"]);

    await assert.rejects(holder.assertExecutionLease({
      taskId,
      executionId,
      leaseToken: claimed.leaseToken,
      principal: aliceCodex
    }), /requires an active lease/u);
    await holder.assertExecutionLease({
      taskId,
      executionId,
      leaseToken: renewed.leaseToken,
      principal: aliceCodex
    });
    await assert.rejects(saga.claim({ taskId, principal: aliceClaude }), ExecutionLeaseCollisionError);
    await assert.rejects(holder.assertExecutionLease({
      taskId,
      executionId,
      leaseToken: renewed.leaseToken,
      principal: aliceClaude
    }), /requires an active lease/u);
    await assert.rejects(holder.assertExecutionLease({
      taskId,
      executionId,
      leaseToken: "missing",
      principal: aliceCodex
    }), /requires an active lease/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
