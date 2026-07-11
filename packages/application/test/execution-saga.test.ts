import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ExecutionLeaseCollisionError,
  executionDeclaration,
  makeCoordinatedExecutionAuthoredStore,
  makeJournaledWriteCoordinator,
  makeMarkdownArtifactStore,
  makeExecutionSagaService,
  makeTaskHolderService,
  resolveEntityDocumentPath,
  taskHolderActor
} from "../src/index.ts";
import type { ExecutionAuthoredStore, ExecutionRecord } from "../src/index.ts";

const taskId = "task_01KX19GEKWMEJNGSMRT6JJH6HY";
const executionId = "exe_01KX7H00000000000000000001";
const secondExecutionId = "exe_01KX7H00000000000000000002";
const aliceCodex = taskHolderActor(
  { personId: "alice", displayName: "Alice" },
  { kind: "agent", id: "codex" }
);
const aliceClaude = taskHolderActor(
  { personId: "alice", displayName: "Alice" },
  { kind: "agent", id: "claude-code" }
);

test("Execution is a hosted entity and Holder V2 rejects a second executor", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-execution-saga-"));
  try {
    mkdirSync(path.join(rootDir, "harness/tasks", taskId), { recursive: true });
    assert.equal(
      resolveEntityDocumentPath(rootDir, executionDeclaration, { taskId, executionId }),
      path.join(rootDir, "harness/tasks", taskId, "executions", `${executionId}.md`)
    );

    const service = makeTaskHolderService({
      rootInput: rootDir,
      now: () => new Date("2026-07-11T00:00:00.000Z")
    });
    const reserved = await service.reserveExecution({ taskId, executionId, principal: aliceCodex, ttlMs: 60_000 });

    assert.equal(reserved.holder?.schema, "task-holder/v2");
    assert.equal(reserved.holder?.executionId, executionId);
    assert.deepEqual(reserved.effectiveHolder?.executor, { kind: "agent", id: "codex" });
    assert.match(reserved.leaseToken, /^[0-9a-f]{64}$/u);

    await assert.rejects(
      service.reserveExecution({
        taskId,
        executionId: "exe_01KX7H00000000000000000002",
        principal: aliceClaude,
        ttlMs: 60_000
      }),
      ExecutionLeaseCollisionError
    );
    await assert.rejects(service.activateExecution({
      taskId,
      executionId,
      leaseToken: reserved.leaseToken,
      principal: aliceClaude
    }), /requires an active lease/u);
    await assert.rejects(service.release({ taskId, principal: aliceCodex }), /is not held/u);
    const active = await service.activateExecution({
      taskId,
      executionId,
      leaseToken: reserved.leaseToken,
      principal: aliceCodex
    });
    assert.equal(active.phase, "active");
    assert.equal(
      readFileSync(path.join(rootDir, ".harness/task-holders", `${taskId}.json`), "utf8").includes(reserved.leaseToken),
      false
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a real coordinated claim and submit preserves the hosted Execution round", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-execution-real-"));
  try {
    const taskRoot = path.join(rootDir, "harness/tasks", `${taskId}-round-trip`);
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex("planned"), "utf8");
    const coordinator = makeJournaledWriteCoordinator({ rootDir, actor: { kind: "agent", id: "test" } });
    const holder = makeTaskHolderService({ rootInput: rootDir });
    const executionIds = [executionId, secondExecutionId];
    const saga = makeExecutionSagaService({
      taskHolderService: holder,
      authoredStore: makeCoordinatedExecutionAuthoredStore({
        rootInput: rootDir,
        coordinator,
        artifactStore: makeMarkdownArtifactStore({ rootDir })
      }),
      generateExecutionId: () => executionIds.shift()!,
      now: () => "2026-07-11T00:00:00.000Z"
    });

    const claimed = await saga.claim({ taskId, principal: aliceCodex });
    await saga.submitForReview({
      taskId,
      executionId,
      leaseToken: claimed.leaseToken,
      principal: aliceCodex,
      submission: {
        summary: "round one",
        verification: ["node:test"],
        residualRisks: ["review pending"],
        outputs: [{ kind: "commit", ref: "abc123" }]
      }
    });

    const stored = JSON.parse(readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8")) as ExecutionRecord;
    assert.equal(stored.state, "submitted");
    assert.deepEqual(stored.outputs, [{ kind: "commit", ref: "abc123" }]);
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: in_review$/mu);

    writeFileSync(path.join(taskRoot, "executions", `${executionId}.md`), `${JSON.stringify({ ...stored, state: "changes_requested" }, null, 2)}\n`, "utf8");
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex("active"), "utf8");
    const rework = await saga.claim({ taskId, principal: aliceCodex });

    assert.equal(rework.execution.execution_id, secondExecutionId);
    const oldRound = JSON.parse(readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8")) as ExecutionRecord;
    assert.equal(oldRound.state, "changes_requested");
    assert.deepEqual(oldRound.outputs, [{ kind: "commit", ref: "abc123" }]);
    assert.equal(JSON.parse(readFileSync(path.join(taskRoot, "executions", `${secondExecutionId}.md`), "utf8")).state, "active");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("claim releases its reservation when the authored Execution transaction fails", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-execution-claim-rollback-"));
  try {
    const holder = makeTaskHolderService({ rootInput: rootDir });
    const authored = memoryAuthoredStore({ failOpen: true });
    const saga = makeExecutionSagaService({
      taskHolderService: holder,
      authoredStore: authored,
      generateExecutionId: () => executionId,
      now: () => "2026-07-11T00:00:00.000Z"
    });

    await assert.rejects(saga.claim({ taskId, principal: aliceCodex }), /authored open failed/u);
    assert.equal((await holder.holder({ taskId })).effectiveHolder, null);
    assert.equal(authored.executions.size, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("submit-for-review changes Execution and Task atomically before releasing the Lease", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-execution-submit-"));
  try {
    const holder = makeTaskHolderService({ rootInput: rootDir });
    const authored = memoryAuthoredStore();
    const saga = makeExecutionSagaService({
      taskHolderService: holder,
      authoredStore: authored,
      generateExecutionId: () => executionId,
      now: () => "2026-07-11T00:00:00.000Z"
    });
    const claimed = await saga.claim({ taskId, principal: aliceCodex });
    authored.failSubmit = true;

    await assert.rejects(saga.submitForReview({
      taskId,
      executionId,
      leaseToken: claimed.leaseToken,
      principal: aliceCodex,
      submission: {
        summary: "ready for review",
        verification: ["test:pass"],
        residualRisks: [],
        outputs: [{ kind: "commit", ref: "abc123" }]
      }
    }), /authored submit failed/u);
    assert.equal(authored.executions.get(executionId)?.state, "active");
    assert.equal(authored.taskStatus, "active");
    assert.notEqual((await holder.holder({ taskId })).effectiveHolder, null);

    authored.failSubmit = false;
    await saga.submitForReview({
      taskId,
      executionId,
      leaseToken: claimed.leaseToken,
      principal: aliceCodex,
      submission: {
        summary: "ready for review",
        verification: ["test:pass"],
        residualRisks: [],
        outputs: [{ kind: "commit", ref: "abc123" }]
      }
    });
    assert.equal(authored.executions.get(executionId)?.state, "submitted");
    assert.equal(authored.taskStatus, "in_review");
    assert.equal((await holder.holder({ taskId })).effectiveHolder, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function memoryAuthoredStore(options: { readonly failOpen?: boolean } = {}): ExecutionAuthoredStore & {
  readonly executions: Map<string, ExecutionRecord>;
  taskStatus: "planned" | "active" | "in_review";
  failSubmit: boolean;
} {
  const executions = new Map<string, ExecutionRecord>();
  const store = {
    executions,
    taskStatus: "planned" as const satisfies "planned" | "active" | "in_review",
    failSubmit: false,
    readExecution: async (input) => executions.get(input.executionId) ?? null,
    openExecution: async (input) => {
      if (options.failOpen) throw new Error("authored open failed");
      if (executions.has(input.execution.execution_id)) throw new Error("execution already exists");
      executions.set(input.execution.execution_id, input.execution);
      store.taskStatus = "active";
    },
    submitForReview: async (input) => {
      if (store.failSubmit) throw new Error("authored submit failed");
      const current = executions.get(input.executionId);
      if (!current || current.state !== "active") throw new Error("execution is not active");
      executions.set(input.executionId, {
        ...current,
        state: "submitted",
        submitted_at: input.submittedAt,
        outputs: input.submission.outputs,
        submission: {
          summary: input.submission.summary,
          verification: input.submission.verification,
          residual_risks: input.submission.residualRisks
        }
      });
      store.taskStatus = "in_review";
    }
  };
  return store;
}

function taskIndex(status: "planned" | "active" | "in_review"): string {
  return [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    "title: Execution fixture",
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    `  status: ${status}`,
    "  ref:",
    "  titleSnapshot: Execution fixture",
    "  url:",
    "  bindingCreatedAt: 2026-07-11T00:00:00.000Z",
    "  bindingFingerprint: sha256:fixture",
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "provenance:",
    "  - {runtime: \"node-test\", sessionId: \"execution-saga\", boundAt: \"2026-07-11T00:00:00.000Z\"}",
    "---",
    "",
    "# Execution fixture",
    ""
  ].join("\n");
}
