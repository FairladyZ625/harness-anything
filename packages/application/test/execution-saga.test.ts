// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect, Schema } from "effect";
import {
  ExecutionLeaseCollisionError,
  executionDeclaration,
  makeCoordinatedExecutionAuthoredStore,
  makeExecutionReservationReconciler,
  makeExecutionCompletionService,
  makeJournaledWriteCoordinator,
  makeMarkdownArtifactStore,
  makeExecutionSagaService,
  makeReviewExecutionService,
  makeTaskHolderService,
  resolveEntityDocumentPath,
  taskHolderActor
} from "../src/index.ts";
import { writeContentAddressedBlob, writeSessionEntity } from "../../kernel/src/index.ts";
import type { ExecutionAuthoredStore, ExecutionRecord } from "../src/index.ts";
import { validateOutputEvidence } from "../../kernel/src/index.ts";

const taskId = "task_01KX19GEKWMEJNGSMRT6JJH6HY";
const executionId = "exe_01KX7H00000000000000000001";
const secondExecutionId = "exe_01KX7H00000000000000000002";
const firstReviewId = "rev_01KX7H00000000000000000001";
const secondReviewId = "rev_01KX7H00000000000000000002";
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

    const primarySession = {
      runtime: "codex" as const,
      sessionId: "codex-real-primary",
      source: "runtime" as const,
      detectedAt: "2026-07-11T00:00:00.000Z"
    };
    const claimed = await saga.claim({ taskId, principal: aliceCodex, primarySession });
    const bodyRef = writeContentAddressedBlob(rootDir, "# finalized session\n", "text/markdown; charset=utf-8");
    Effect.runSync(writeSessionEntity(coordinator, rootDir, {
      schema: "session-entity/v1",
      sessionId: primarySession.sessionId,
      lifecycle: "sealed",
      archiveStatus: "complete",
      runtime: "codex",
      source: "runtime",
      detectedAt: primarySession.detectedAt,
      exportedAt: "2026-07-11T00:00:01.000Z",
      bodyRef: { store: "authored-cas/v1", ...bodyRef },
      snapshot: {
        capturedAt: "2026-07-11T00:00:01.000Z",
        completeness: "complete",
        captureRange: { messageCount: 1 },
        privacyScan: { scannerVersion: "test", passed: true, findings: [] }
      }
    }));
    await saga.submitForReview({
      taskId,
      executionId,
      leaseToken: claimed.leaseToken,
      principal: aliceCodex,
      submission: {
        completionClaim: "round one",
        deliverables: [],
        verificationNotes: ["node:test"],
        knownGaps: [],
        residualRisks: ["review pending"],
        evidence: [{ evidence_id: "ev_round_1", execution_ref: `execution/${taskId}/${executionId}`, locator: { substrate: "inline", text: "abc123" } }]
      }
    });

    const stored = JSON.parse(readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8")) as ExecutionRecord;
    assert.equal(stored.state, "submitted");
    assert.equal(stored.outputs[0]?.evidence_id, "ev_round_1");
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: in_review$/mu);

    const review = makeReviewExecutionService({
      rootInput: rootDir,
      coordinator,
      artifactStore: makeMarkdownArtifactStore({ rootDir }),
      generateReviewId: () => firstReviewId,
      now: () => "2026-07-11T00:02:00.000Z"
    });
    await review.reviewExecution({
      taskId,
      executionId,
      reviewer: aliceClaude,
      reviewerSession: {
        runtime: "claude-code",
        sessionId: "review-rework",
        source: "runtime",
        detectedAt: "2026-07-11T00:02:00.000Z"
      },
      findings: "The submitted round requires changes.",
      evidenceChecked: ["ev_round_1"],
      rationale: "The delivery needs another round.",
      verdict: "changes_requested",
      archiveWarningsAcknowledged: false
    });
    const rework = await saga.claim({ taskId, principal: aliceCodex });

    assert.equal(rework.execution.execution_id, secondExecutionId);
    const oldRound = JSON.parse(readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8")) as ExecutionRecord;
    assert.equal(oldRound.state, "changes_requested");
    assert.equal(oldRound.outputs[0]?.evidence_id, "ev_round_1");
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

test("reservation reconciler converges an orphan Execution reservation without authored writes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-execution-startup-reconcile-"));
  try {
    const taskRoot = path.join(rootDir, "harness/tasks", `${taskId}-startup-reconcile`);
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex("planned"), "utf8");
    const holder = makeTaskHolderService({ rootInput: rootDir });
    await holder.reserveExecution({ taskId, executionId, principal: aliceCodex });
    const authored = makeCoordinatedExecutionAuthoredStore({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, actor: { kind: "system", id: "reconciler-test" } }),
      artifactStore: makeMarkdownArtifactStore({ rootDir })
    });
    const reconcile = makeExecutionReservationReconciler({
      rootInput: rootDir,
      taskHolderService: holder,
      authoredStore: authored
    });

    await reconcile();
    assert.equal((await holder.holder({ taskId })).effectiveHolder, null);
    assert.equal(existsSync(path.join(taskRoot, "executions", `${executionId}.md`)), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("submit-for-review rejects an Execution without a finalized primary Session", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-execution-primary-gate-"));
  try {
    const taskRoot = path.join(rootDir, "harness/tasks", `${taskId}-primary-gate`);
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex("planned"), "utf8");
    const coordinator = makeJournaledWriteCoordinator({ rootDir, actor: { kind: "agent", id: "test" } });
    const holder = makeTaskHolderService({ rootInput: rootDir });
    const saga = makeExecutionSagaService({
      taskHolderService: holder,
      authoredStore: makeCoordinatedExecutionAuthoredStore({
        rootInput: rootDir,
        coordinator,
        artifactStore: makeMarkdownArtifactStore({ rootDir })
      }),
      generateExecutionId: () => executionId,
      now: () => "2026-07-11T00:00:00.000Z"
    });
    const claimed = await saga.claim({ taskId, principal: aliceCodex });

    await assert.rejects(saga.submitForReview({
      taskId,
      executionId,
      leaseToken: claimed.leaseToken,
      principal: aliceCodex,
      submission: {
        completionClaim: "missing primary",
        deliverables: [],
        verificationNotes: [],
        knownGaps: [],
        residualRisks: [],
        evidence: []
      }
    }), /primary Session binding is required; attach the current session through ExecutionSagaService\.attachSession/u);
    assert.equal((await holder.holder({ taskId })).holder?.schema, "task-holder/v2");
    assert.equal(JSON.parse(readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8")).state, "active");
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
        completionClaim: "ready for review",
        deliverables: [],
        verificationNotes: ["test:pass"],
        knownGaps: [],
        residualRisks: [],
        evidence: []
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
        completionClaim: "ready for review",
        deliverables: [],
        verificationNotes: ["test:pass"],
        knownGaps: [],
        residualRisks: [],
        evidence: []
      }
    });
    assert.equal(authored.executions.get(executionId)?.state, "submitted");
    assert.equal(authored.taskStatus, "in_review");
    assert.equal((await holder.holder({ taskId })).effectiveHolder, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Execution session bindings can only be attached while the Execution is active", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-execution-attach-"));
  try {
    const taskRoot = path.join(rootDir, "harness/tasks", `${taskId}-attach`);
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex("planned"), "utf8");
    const holder = makeTaskHolderService({ rootInput: rootDir });
    const authored = makeCoordinatedExecutionAuthoredStore({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, actor: { kind: "agent", id: "test" } }),
      artifactStore: makeMarkdownArtifactStore({ rootDir })
    });
    const saga = makeExecutionSagaService({
      taskHolderService: holder,
      authoredStore: authored,
      generateExecutionId: () => executionId,
      now: () => "2026-07-11T00:00:00.000Z"
    });
    const claimed = await saga.claim({ taskId, principal: aliceCodex });

    await saga.attachSession({
      taskId,
      executionId,
      leaseToken: claimed.leaseToken,
      principal: aliceCodex,
      session: {
        runtime: "codex",
        sessionId: "codex-primary-session",
        source: "runtime",
        detectedAt: "2026-07-11T00:00:00.000Z"
      },
      role: "primary"
    });
    const executionPath = path.join(taskRoot, "executions", `${executionId}.md`);
    const activeExecution = JSON.parse(readFileSync(executionPath, "utf8")) as ExecutionRecord;
    assert.deepEqual(activeExecution.session_bindings, [{
      binding_id: "primary:codex-primary-session",
      session_ref: "session/codex-primary-session",
      role: "primary",
      archive_status: "pending",
      attached_at: "2026-07-11T00:00:00.000Z",
      session: {
        runtime: "codex",
        sessionId: "codex-primary-session",
        source: "runtime",
        detectedAt: "2026-07-11T00:00:00.000Z"
      },
      capture_range: {
        range_id: "primary:codex-primary-session:2026-07-11T00:00:00.000Z",
        coordinate: "timestamp",
        start_at: "2026-07-11T00:00:00.000Z",
        end_at: null,
        bounds: "inclusive"
      }
    }]);

    writeFileSync(executionPath, `${JSON.stringify({
      ...activeExecution,
      state: "submitted",
      submitted_at: "2026-07-11T00:01:00.000Z"
    }, null, 2)}\n`, "utf8");
    await assert.rejects(authored.attachSession({
      taskId,
      executionId,
      binding: {
        binding_id: "subagent:late-session",
        session_ref: "session/late-session",
        role: "subagent",
        archive_status: "pending",
        attached_at: "2026-07-11T00:01:00.000Z",
        session: null,
        capture_range: null
      }
    }), /execution is not active/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Review rounds append, require archive-warning acknowledgement, and dismissed leaves lifecycle state unchanged", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-review-rounds-"));
  try {
    const taskRoot = path.join(rootDir, "harness/tasks", taskId);
    mkdirSync(path.join(taskRoot, "executions"), { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex("in_review"), "utf8");
    writeFileSync(path.join(taskRoot, "executions", `${executionId}.md`), `${JSON.stringify({
      schema: "execution/v1",
      execution_id: executionId,
      task_ref: `task/${taskId}`,
      state: "submitted",
      primary_actor: aliceCodex,
      claimed_at: "2026-07-11T00:00:00.000Z",
      submitted_at: "2026-07-11T00:01:00.000Z",
      closed_at: null,
      session_bindings: [{ binding_id: "primary:test", session_ref: "session/test", role: "primary", archive_status: "partial", attached_at: "2026-07-11T00:00:00.000Z", session: null }],
      outputs: [],
      submission: { summary: "round one", verification: [], residual_risks: [] }
    }, null, 2)}\n`, "utf8");
    const reviewIds = [firstReviewId, secondReviewId];
    const service = makeReviewExecutionService({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, actor: { kind: "agent", id: "reviewer" } }),
      artifactStore: makeMarkdownArtifactStore({ rootDir }),
      generateReviewId: () => reviewIds.shift()!,
      now: () => "2026-07-11T00:02:00.000Z"
    });
    const session = { runtime: "claude-code" as const, sessionId: "review-session", source: "runtime" as const, detectedAt: "2026-07-11T00:02:00.000Z" };

    await assert.rejects(service.reviewExecution({
      taskId,
      executionId,
      reviewer: aliceCodex,
      reviewerSession: session,
      findings: "Self review is not allowed.",
      evidenceChecked: [],
      rationale: "Self review is prohibited.",
      verdict: "approved",
      archiveWarningsAcknowledged: true
    }), /executor cannot review its own delivery/u);

    await assert.rejects(service.reviewExecution({
      taskId,
      executionId,
      reviewer: aliceClaude,
      reviewerSession: session,
      findings: "Archive is partial.",
      evidenceChecked: [],
      rationale: "Archive warnings remain.",
      verdict: "dismissed",
      archiveWarningsAcknowledged: false
    }), /archive warnings must be explicitly acknowledged/u);

    const dismissed = await service.reviewExecution({
      taskId,
      executionId,
      reviewer: aliceClaude,
      reviewerSession: session,
      findings: "This review round is void.",
      evidenceChecked: [],
      rationale: "The round is dismissed.",
      verdict: "dismissed",
      archiveWarningsAcknowledged: true
    });
    const approved = await service.reviewExecution({
      taskId,
      executionId,
      reviewer: aliceClaude,
      reviewerSession: session,
      findings: "The delivery is acceptable.",
      evidenceChecked: [],
      rationale: "Acceptance criteria are satisfied.",
      verdict: "approved",
      archiveWarningsAcknowledged: true
    });

    assert.equal(dismissed.review.review_id, firstReviewId);
    assert.equal(approved.review.review_id, secondReviewId);
    assert.equal(existsSync(path.join(taskRoot, "reviews", `${firstReviewId}.md`)), true);
    assert.equal(existsSync(path.join(taskRoot, "reviews", `${secondReviewId}.md`)), true);
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: in_review$/mu);
    assert.equal(JSON.parse(readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8")).state, "submitted");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Execution completion requires an approved Review, rejects the executor, and accepts atomically", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-execution-complete-"));
  try {
    const taskRoot = path.join(rootDir, "harness/tasks", taskId);
    mkdirSync(path.join(taskRoot, "executions"), { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex("in_review"), "utf8");
    writeFileSync(path.join(taskRoot, "executions", `${executionId}.md`), `${JSON.stringify({
      schema: "execution/v1",
      execution_id: executionId,
      task_ref: `task/${taskId}`,
      state: "submitted",
      primary_actor: aliceCodex,
      claimed_at: "2026-07-11T00:00:00.000Z",
      submitted_at: "2026-07-11T00:01:00.000Z",
      closed_at: null,
      session_bindings: [{ binding_id: "primary:test", session_ref: "session/test", role: "primary", archive_status: "complete", attached_at: "2026-07-11T00:00:00.000Z", session: null }],
      outputs: [],
      submission: { summary: "round one", verification: ["tests passed"], residual_risks: [] }
    }, null, 2)}\n`, "utf8");
    const coordinator = makeJournaledWriteCoordinator({ rootDir, actor: { kind: "agent", id: "commander" } });
    const artifactStore = makeMarkdownArtifactStore({ rootDir });
    const completion = makeExecutionCompletionService({ rootInput: rootDir, coordinator, artifactStore, now: () => "2026-07-11T00:03:00.000Z" });

    await assert.rejects(completion.completeTaskExecution({ taskId, actor: aliceClaude }), /approved Review/u);
    const reviewIds = [firstReviewId, secondReviewId];
    const reviews = makeReviewExecutionService({
      rootInput: rootDir,
      coordinator,
      artifactStore,
      generateReviewId: () => reviewIds.shift()!,
      now: () => "2026-07-11T00:02:00.000Z"
    });
    await reviews.reviewExecution({
      taskId,
      executionId,
      reviewer: aliceClaude,
      reviewerSession: { runtime: "claude-code", sessionId: "review-complete", source: "runtime", detectedAt: "2026-07-11T00:02:00.000Z" },
      findings: "Approved for completion.",
      evidenceChecked: [],
      rationale: "The execution is complete.",
      verdict: "approved",
      archiveWarningsAcknowledged: false
    });

    const firstExecution = JSON.parse(readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8")) as ExecutionRecord;
    writeFileSync(path.join(taskRoot, "executions", `${secondExecutionId}.md`), `${JSON.stringify({
      ...firstExecution,
      execution_id: secondExecutionId,
      submitted_at: "2026-07-11T00:02:30.000Z"
    }, null, 2)}\n`, "utf8");
    await assert.rejects(completion.completeTaskExecution({ taskId, actor: aliceClaude }), /approved Review/u);
    await reviews.reviewExecution({
      taskId,
      executionId: secondExecutionId,
      reviewer: aliceClaude,
      reviewerSession: { runtime: "claude-code", sessionId: "review-complete-2", source: "runtime", detectedAt: "2026-07-11T00:02:30.000Z" },
      findings: "The latest delivery is approved.",
      evidenceChecked: [],
      rationale: "The latest execution is complete.",
      verdict: "approved",
      archiveWarningsAcknowledged: false
    });

    await assert.rejects(completion.completeTaskExecution({ taskId, actor: aliceCodex }), /executor cannot complete/u);
    const result = await completion.completeTaskExecution({ taskId, actor: aliceClaude });

    assert.deepEqual(result, { executionId: secondExecutionId });
    assert.equal(JSON.parse(readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8")).state, "submitted");
    assert.equal(JSON.parse(readFileSync(path.join(taskRoot, "executions", `${secondExecutionId}.md`), "utf8")).state, "accepted");
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: done$/mu);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("execution/v1 reads upgrade semantically and malformed legacy records fail closed", () => {
  const legacy = {
    schema: "execution/v1", execution_id: executionId, task_ref: `task/${taskId}`, state: "submitted",
    primary_actor: aliceCodex, claimed_at: "2026-07-11T00:00:00.000Z", submitted_at: "2026-07-11T00:01:00.000Z", closed_at: null,
    session_bindings: [], outputs: [{ legacy: "deliverable" }],
    submission: { summary: "legacy claim", verification: ["legacy check"], residual_risks: [] }
  };
  const decode = (value: unknown) => Schema.decodeUnknownSync(executionDeclaration.schema)(
    executionDeclaration.documentCodec.decode(JSON.stringify(value))
  ) as ExecutionRecord;
  const upgraded = decode(legacy);
  assert.equal(upgraded.schema, "execution/v2");
  assert.equal(upgraded.submission?.completion_claim, "legacy claim");
  assert.deepEqual(upgraded.submission?.deliverables, ['{"legacy":"deliverable"}']);
  assert.throws(() => decode({ ...legacy, execution_id: "malformed" }));
});

test("OutputEvidence mechanical boundary rejects bad provenance while zero evidence remains legal", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-output-evidence-"));
  try {
    const owner = `execution/${taskId}/${executionId}`;
    const validate = (evidence: Parameters<typeof validateOutputEvidence>[0]["evidence"]) =>
      validateOutputEvidence({ rootInput: rootDir, taskId, executionId, evidence });
    assert.doesNotThrow(() => validate([])); // dec_mrg3z1we/CH1: Evidence is 0..N.
    assert.throws(() => validate([{
      evidence_id: "ev_missing", execution_ref: owner, locator: { substrate: "file", path: "missing.txt" }
    }]), /file does not exist/u);
    assert.throws(() => validate([{
      evidence_id: "ev_digest", execution_ref: owner, locator: { substrate: "inline", text: "payload" }, sha256: "0".repeat(64)
    }]), /digest mismatch/u);
    assert.throws(() => validate([{
      evidence_id: "ev_foreign", execution_ref: `execution/${taskId}/${secondExecutionId}`, locator: { substrate: "inline", text: "payload" }
    }]), /belongs to/u);
    assert.throws(() => validate([{
      evidence_id: "ev_target", execution_ref: owner, locator: { substrate: "inline", text: "payload" }, checker_receipt_ref: "ev_receipt"
    }]), /checker receipt does not exist/u);
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
    attachSession: async (input) => {
      const current = executions.get(input.executionId);
      if (!current || current.state !== "active") throw new Error("execution is not active");
      executions.set(input.executionId, {
        ...current,
        session_bindings: [...current.session_bindings, input.binding]
      });
    },
    submitForReview: async (input) => {
      if (store.failSubmit) throw new Error("authored submit failed");
      const current = executions.get(input.executionId);
      if (!current || current.state !== "active") throw new Error("execution is not active");
      executions.set(input.executionId, {
        ...current,
        state: "submitted",
        submitted_at: input.submittedAt,
        outputs: input.submission.evidence,
        submission: {
          completion_claim: input.submission.completionClaim,
          deliverables: input.submission.deliverables,
          evidence_refs: input.submission.evidence.map((evidence) => evidence.evidence_id),
          verification_notes: input.submission.verificationNotes,
          known_gaps: input.submission.knownGaps,
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
