// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeExecutionSagaService,
  makeTaskHolderService,
  taskHolderActor,
  type ExecutionAuthoredStore
} from "../src/index.ts";
import { memoryAuthoredStore } from "./execution-saga-fixtures.ts";

const taskId = "task_01KX19GEKWMEJNGSMRT6JJH6HY";
const executionId = "exe_01KX7H00000000000000000001";
const principal = taskHolderActor(
  { personId: "alice", displayName: "Alice" },
  { kind: "agent", id: "codex" }
);

test("claim adopts a matching execution when publication committed before returning an error", async () => {
  await withClaimFixture(async ({ holder, authored, saga }) => {
    const publishedThenRejected: ExecutionAuthoredStore = {
      ...authored,
      openExecution: async (input) => {
        await authored.openExecution(input);
        throw new Error("publication outcome reported unavailable");
      }
    };
    const recoveringSaga = makeExecutionSagaService({
      taskHolderService: holder,
      authoredStore: publishedThenRejected,
      generateExecutionId: () => executionId,
      now: () => "2026-07-29T00:00:00.000Z"
    });

    const claimed = await recoveringSaga.claim({ taskId, principal });

    assert.equal(claimed.executionId, executionId);
    assert.equal(claimed.phase, "active");
    assert.equal(authored.executions.size, 1);
    const snapshot = await holder.holder({ taskId });
    assert.equal(snapshot.holder?.schema, "task-holder/v2");
    assert.equal(snapshot.holder?.schema === "task-holder/v2" ? snapshot.holder.phase : null, "active");
    void saga;
  });
});

test("claim is idempotent when reconciliation activates the reservation after publication", async () => {
  await withClaimFixture(async ({ holder, authored }) => {
    const reconciledDuringPublication: ExecutionAuthoredStore = {
      ...authored,
      openExecution: async (input) => {
        await authored.openExecution(input);
        await holder.reconcileExecution({
          taskId: input.taskId,
          executionId: input.execution.execution_id,
          authoredState: "active"
        });
      }
    };
    const saga = makeExecutionSagaService({
      taskHolderService: holder,
      authoredStore: reconciledDuringPublication,
      generateExecutionId: () => executionId,
      now: () => "2026-07-29T00:00:00.000Z"
    });

    const claimed = await saga.claim({ taskId, principal });

    assert.equal(claimed.executionId, executionId);
    assert.equal(claimed.phase, "active");
    assert.equal(authored.executions.size, 1);
  });
});

test("claim releases its reservation when publication fails before creating an execution", async () => {
  await withClaimFixture(async ({ holder, authored }) => {
    const rejectedBeforePublication: ExecutionAuthoredStore = {
      ...authored,
      openExecution: async () => {
        throw new Error("publication rejected before commit");
      }
    };
    const saga = makeExecutionSagaService({
      taskHolderService: holder,
      authoredStore: rejectedBeforePublication,
      generateExecutionId: () => executionId,
      now: () => "2026-07-29T00:00:00.000Z"
    });

    await assert.rejects(
      saga.claim({ taskId, principal }),
      /publication rejected before commit/u
    );

    assert.equal(authored.executions.size, 0);
    assert.equal((await holder.holder({ taskId })).effectiveHolder, null);
  });
});

async function withClaimFixture(
  run: (fixture: {
    readonly holder: ReturnType<typeof makeTaskHolderService>;
    readonly authored: ReturnType<typeof memoryAuthoredStore>;
    readonly saga: ReturnType<typeof makeExecutionSagaService>;
  }) => Promise<void>
): Promise<void> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-claim-atomicity-"));
  try {
    const holder = makeTaskHolderService({ rootInput: rootDir });
    const authored = memoryAuthoredStore();
    const saga = makeExecutionSagaService({
      taskHolderService: holder,
      authoredStore: authored,
      generateExecutionId: () => executionId,
      now: () => "2026-07-29T00:00:00.000Z"
    });
    await run({ holder, authored, saga });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
