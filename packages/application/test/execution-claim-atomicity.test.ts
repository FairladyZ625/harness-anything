// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import {
  makeCoordinatedExecutionAuthoredStore,
  makeExecutionSagaService,
  makeJournaledWriteCoordinator,
  makeMarkdownArtifactStore,
  makeTaskHolderService,
  taskHolderActor,
  type ExecutionRecord,
  type ExecutionAuthoredStore
} from "../src/index.ts";
import { memoryAuthoredStore } from "./execution-saga-fixtures.ts";
import { taskIndex } from "./execution-saga-fixtures.ts";
import { writeAttribution } from "./test-attribution.ts";

const taskId = "task_01KX19GEKWMEJNGSMRT6JJH6HY";
const executionId = "exe_01KX7H00000000000000000001";
const principal = taskHolderActor(
  { personId: "alice", displayName: "Alice" },
  { kind: "agent", id: "codex" }
);
const samePersonDifferentExecutor = taskHolderActor(
  { personId: "alice", displayName: "Alice" },
  { kind: "agent", id: "claude-code" }
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

test("claim never reports success when only the Execution half of activation is observable", async () => {
  await withClaimFixture(async ({ holder, authored }) => {
    const executionOnlyThenRejected: ExecutionAuthoredStore = {
      ...authored,
      openExecution: async (input) => {
        await authored.openExecution({ taskId: input.taskId, execution: input.execution });
        throw new Error("activation publication outcome unavailable");
      }
    };
    const saga = makeExecutionSagaService({
      taskHolderService: holder,
      authoredStore: executionOnlyThenRejected,
      generateExecutionId: () => executionId,
      now: () => "2026-07-29T00:00:00.000Z"
    });

    await assert.rejects(
      saga.claim({
        taskId,
        principal,
        activation: { taskPlanBodySha256: "a".repeat(64) }
      }),
      /indeterminate|partial|activation publication/iu
    );

    assert.equal(authored.executions.size, 1);
    assert.equal(authored.taskStatus, "planned");
    assert.equal((await holder.holder({ taskId })).effectiveHolder, null);
  });
});

test("writes stay fenced between authored activation and Execution lease activation", async () => {
  await withClaimFixture(async ({ holder, authored }) => {
    let writeAdmittedDuringReservation = false;
    const pauseAfterPublication: ExecutionAuthoredStore = {
      ...authored,
      openExecution: async (input) => {
        await authored.openExecution(input);
        try {
          await holder.assertActiveLease({
            taskId: input.taskId,
            principal: samePersonDifferentExecutor
          });
          writeAdmittedDuringReservation = true;
        } catch {
          // Expected: V2 writes require an active phase and exact executor.
        }
      }
    };
    const saga = makeExecutionSagaService({
      taskHolderService: holder,
      authoredStore: pauseAfterPublication,
      generateExecutionId: () => executionId,
      now: () => "2026-07-29T00:00:00.000Z"
    });

    const claimed = await saga.claim({
      taskId,
      principal,
      activation: { taskPlanBodySha256: "a".repeat(64) }
    });

    assert.equal(writeAdmittedDuringReservation, false);
    assert.equal(claimed.phase, "active");
  });
});

test("concurrent coordinated activations admit one Execution under the INDEX and absence CAS", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-claim-coordinated-race-"));
  try {
    const taskRoot = path.join(rootDir, "harness/tasks", taskId);
    mkdirSync(taskRoot, { recursive: true });
    const plan = "# Plan\n\nImplement the atomic claim transaction.\n";
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex(taskId, "planned"), "utf8");
    writeFileSync(path.join(taskRoot, "task_plan.md"), plan, "utf8");
    const baseStore = makeMarkdownArtifactStore({ rootDir });
    const bothRead = barrier(2);
    const artifactStore = {
      readTaskPackage: (id: Parameters<typeof baseStore.readTaskPackage>[0]) => baseStore.readTaskPackage(id).pipe(
        Effect.tap(() => Effect.promise(() => bothRead()))
      )
    };
    const observedPreconditions: Array<ReadonlyArray<Record<string, unknown>>> = [];
    const open = (id: string) => {
      const journaled = makeJournaledWriteCoordinator({
        rootDir,
        attribution: writeAttribution("alice", id)
      });
      const coordinator = {
        ...journaled,
        enqueue: (op: Parameters<typeof journaled.enqueue>[0]) => {
          const payload = op.payload as { readonly preconditions?: ReadonlyArray<Record<string, unknown>> };
          observedPreconditions.push(payload.preconditions ?? []);
          return journaled.enqueue(op);
        }
      };
      return makeCoordinatedExecutionAuthoredStore({ rootInput: rootDir, coordinator, artifactStore }).openExecution({
        taskId,
        execution: executionRecord(id),
        activation: { taskPlanBodySha256: sha256(plan) }
      });
    };

    const results = await Promise.allSettled([
      open("exe_01KX7H00000000000000000001"),
      open("exe_01KX7H00000000000000000002")
    ]);

    const resultSummary = results.map((result) => result.status === "fulfilled"
      ? { status: result.status }
      : { status: result.status, reason: String(result.reason) });
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1, JSON.stringify(resultSummary));
    assert.equal(results.filter((result) => result.status === "rejected").length, 1, JSON.stringify(resultSummary));
    assert.equal(observedPreconditions.length, 2);
    for (const preconditions of observedPreconditions) {
      assert.equal(preconditions.length, 3);
      assert.match(String(preconditions[0]?.path), /^executions\/exe_[0-9A-Z]+\.md$/u);
      assert.equal(preconditions[0]?.bodySha256, null);
      assert.deepEqual(preconditions.slice(1).map((entry) => [entry.path, entry.bodySha256]), [
        ["INDEX.md", sha256(taskIndex(taskId, "planned"))],
        ["task_plan.md", sha256(plan)]
      ]);
    }
    const executionFiles = readdirSync(path.join(taskRoot, "executions"));
    assert.equal(executionFiles.length, 1);
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: active$/mu);
    const winnerId = executionFiles[0]!.replace(/\.md$/u, "");
    const holder = makeTaskHolderService({ rootInput: rootDir });
    const reservation = await holder.reserveExecution({ taskId, executionId: winnerId, principal });
    await holder.activateExecution({ taskId, executionId: winnerId, leaseToken: reservation.leaseToken, principal });
    assert.equal((await holder.holder({ taskId })).holder?.schema, "task-holder/v2");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("journal recovery completes a claim transaction after SIGTERM follows its first rename", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-claim-sigterm-recovery-"));
  try {
    const taskRoot = path.join(rootDir, "harness/tasks", taskId);
    mkdirSync(taskRoot, { recursive: true });
    const plan = "# Plan\n\nImplement the atomic claim transaction.\n";
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex(taskId, "planned"), "utf8");
    writeFileSync(path.join(taskRoot, "task_plan.md"), plan, "utf8");
    const worker = fileURLToPath(new URL("./fixtures/execution-claim-transaction-worker.ts", import.meta.url));

    const killed = spawnSync(process.execPath, [worker, rootDir, taskId, executionId], {
      encoding: "utf8",
      env: {
        ...process.env,
        HARNESS_TEST_DECLARED_TRANSACTION_KILLPOINT: "after-first-rename"
      }
    });

    assert.equal(killed.signal, "SIGTERM", `${killed.stdout}\n${killed.stderr}`);
    const executionPath = path.join(taskRoot, "executions", `${executionId}.md`);
    assert.equal(exists(executionPath), true);
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: planned$/mu);

    const recovery = makeJournaledWriteCoordinator({
      rootDir,
      attribution: writeAttribution("alice", "recovery")
    });
    await Effect.runPromise(recovery.recover);
    assert.equal(exists(executionPath), true);
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: active$/mu);
    await Effect.runPromise(recovery.recover);
    assert.equal(readdirSync(path.join(taskRoot, "executions")).length, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
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

function executionRecord(id: string): ExecutionRecord {
  return {
    schema: "execution/v2",
    execution_id: id,
    task_ref: `task/${taskId}`,
    state: "active",
    primary_actor: principal,
    claimed_at: "2026-07-29T00:00:00.000Z",
    submitted_at: null,
    closed_at: null,
    session_bindings: [],
    outputs: [],
    submission: null
  };
}

function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function barrier(count: number): () => Promise<void> {
  let waiting = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    waiting += 1;
    if (waiting === count) release();
    await ready;
  };
}

function exists(filePath: string): boolean {
  try {
    readFileSync(filePath);
    return true;
  } catch {
    return false;
  }
}
