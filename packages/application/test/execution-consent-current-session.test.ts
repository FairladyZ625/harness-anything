// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeRecordExecutionConsentService, makeReviewExecutionService } from "../src/index.ts";
import { resolveConsentAuthorization } from "../src/consent-source-resolution.ts";
import { makeJournaledWriteCoordinator, makeMarkdownArtifactStore, taskHolderActor } from "../../kernel/src/index.ts";
import { taskIndex } from "./execution-saga-fixtures.ts";
import { writeAttribution } from "./test-attribution.ts";

const taskId = "task_01KX7H00000000000000000010";
const executionId = "exe_01KX7H00000000000000000010";
const consentId = "cns_01KX7H00000000000000000010";
const firstReviewId = "rev_01KX7H00000000000000000010";
const submittedAt = "2026-07-15T00:00:00.000Z";
const reviewerSession = { runtime: "codex" as const, sessionId: "consent-test", source: "runtime" as const, detectedAt: submittedAt };
const aliceWorker = taskHolderActor({ personId: "alice" }, { kind: "agent", id: "worker" });

test("review current session verifies consent when the Execution remains bound to a different worker session", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore, runtimeLogOptions }) => {
    const workerSession = bindExecutionToWorkerSession(rootDir);
    const reviewed = await makeReviewExecutionService({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") }),
      artifactStore,
      generateReviewId: () => firstReviewId,
      generateConsentId: () => consentId,
      now: () => "2026-07-15T00:01:00.000Z",
      runtimeLogOptions
    }).reviewExecution({ ...reviewInput(), consentUtterance: "Approved after reviewing the submitted evidence." });

    const stored = readConsent(rootDir, consentId);
    assert.equal(stored.source.strength, "transcript-verified");
    assert.equal(stored.source.transcript_anchor.session_ref, `session/${reviewerSession.sessionId}`);
    assert.equal(reviewed.review.reviewer_session_ref, `session/${reviewerSession.sessionId}`);
    assert.equal(readExecution(rootDir).session_bindings[0].session_ref, `session/${workerSession.sessionId}`);
  });
});

test("review current assistant turns cannot authorize a differently bound Execution", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore, runtimeLogOptions }) => {
    bindExecutionToWorkerSession(rootDir);
    await assert.rejects(makeReviewExecutionService({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") }),
      artifactStore,
      generateReviewId: () => firstReviewId,
      generateConsentId: () => consentId,
      now: () => "2026-07-15T00:01:00.000Z",
      runtimeLogOptions
    }).reviewExecution({ ...reviewInput(), consentUtterance: "Assistant-only approval phrase." }),
    /not found in any bound session transcript user turn/u);

    assert.equal(existsSync(consentPath(rootDir, consentId)), false);
    assert.equal(existsSync(reviewPath(rootDir, firstReviewId)), false);
  });
});

test("an unrelated session user turn cannot authorize the review", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore, runtimeLogOptions }) => {
    bindExecutionToWorkerSession(rootDir);
    const unrelatedSessionId = "unrelated-consent-test";
    const logRoot = runtimeLogOptions.runtimeLogRoots.codex[0]!;
    writeFileSync(path.join(logRoot, `rollout-2026-07-15T00-00-00-${unrelatedSessionId}.jsonl`), `${JSON.stringify({
      timestamp: "2026-07-15T00:00:40.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Approved only in unrelated session C." }
    })}\n`, "utf8");

    await assert.rejects(makeReviewExecutionService({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") }),
      artifactStore,
      generateReviewId: () => firstReviewId,
      generateConsentId: () => consentId,
      now: () => "2026-07-15T00:01:00.000Z",
      runtimeLogOptions
    }).reviewExecution({ ...reviewInput(), consentUtterance: "Approved only in unrelated session C." }),
    /not found in any bound session transcript user turn/u);

    assert.equal(existsSync(consentPath(rootDir, consentId)), false);
    assert.equal(existsSync(reviewPath(rootDir, firstReviewId)), false);
  });
});

test("a review-current utterance from before Execution submission is rejected", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore, runtimeLogOptions }) => {
    bindExecutionToWorkerSession(rootDir);
    const logRoot = runtimeLogOptions.runtimeLogRoots.codex[0]!;
    writeFileSync(path.join(logRoot, `rollout-2026-07-15T00-00-00-${reviewerSession.sessionId}.jsonl`), `${JSON.stringify({
      timestamp: "2026-07-14T23:59:59.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Approved before this Execution was submitted." }
    })}\n`, "utf8");

    await assert.rejects(makeReviewExecutionService({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") }),
      artifactStore,
      generateReviewId: () => firstReviewId,
      generateConsentId: () => consentId,
      now: () => "2026-07-15T00:01:00.000Z",
      runtimeLogOptions
    }).reviewExecution({ ...reviewInput(), consentUtterance: "Approved before this Execution was submitted." }),
    /falls outside the execution submission and review window/u);
  });
});

test("a review-current utterance older than the consent TTL is rejected even when submitted_at is older", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore, runtimeLogOptions }) => {
    const execution = readExecution(rootDir);
    execution.submitted_at = "2026-07-01T00:00:00.000Z";
    writeFileSync(executionPath(rootDir), `${JSON.stringify(execution, null, 2)}\n`, "utf8");
    const logRoot = runtimeLogOptions.runtimeLogRoots.codex[0]!;
    writeFileSync(path.join(logRoot, `rollout-2026-07-15T00-00-00-${reviewerSession.sessionId}.jsonl`), `${JSON.stringify({
      timestamp: "2026-07-13T00:00:00.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Approved outside the current consent TTL." }
    })}\n`, "utf8");

    await assert.rejects(makeReviewExecutionService({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") }),
      artifactStore,
      generateReviewId: () => firstReviewId,
      generateConsentId: () => consentId,
      now: () => "2026-07-15T00:01:00.000Z",
      runtimeLogOptions
    }).reviewExecution({ ...reviewInput(), consentUtterance: "Approved outside the current consent TTL." }),
    /falls outside the execution submission and review window/u);
  });
});

test("a review-current utterance without a reliable timestamp fails closed", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore, runtimeLogOptions }) => {
    bindExecutionToWorkerSession(rootDir);
    const logRoot = runtimeLogOptions.runtimeLogRoots.codex[0]!;
    writeFileSync(path.join(logRoot, `rollout-2026-07-15T00-00-00-${reviewerSession.sessionId}.jsonl`), `${JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "Approved without a timestamp." }
    })}\n`, "utf8");

    await assert.rejects(makeReviewExecutionService({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") }),
      artifactStore,
      generateReviewId: () => firstReviewId,
      generateConsentId: () => consentId,
      now: () => "2026-07-15T00:01:00.000Z",
      runtimeLogOptions
    }).reviewExecution({ ...reviewInput(), consentUtterance: "Approved without a timestamp." }),
    /requires a reliable transcript timestamp/u);
  });
});

test("an invalid review-current timestamp window is not misreported as a missing message timestamp", async () => {
  await withConsentFixture(async ({ rootDir, runtimeLogOptions }) => {
    await assert.rejects(resolveConsentAuthorization({
      rootInput: rootDir,
      transcriptCandidates: [{
        source: "review-current",
        sessionRef: `session/${reviewerSession.sessionId}`,
        session: reviewerSession,
        timestampWindow: { notBefore: "not-a-timestamp", notAfter: "2026-07-15T00:01:00.000Z" }
      }],
      request: { kind: "utterance", utterance: "Approved after reviewing the submitted evidence." },
      runtimeLogOptions
    }), /invalid timestamp window/u);
  });
});

test("an invalid or future submitted_at fails closed as an invalid review-current window", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore, runtimeLogOptions }) => {
    for (const submittedAtValue of ["not-a-timestamp", "2026-07-15T00:02:00.000Z"]) {
      const execution = readExecution(rootDir);
      execution.submitted_at = submittedAtValue;
      writeFileSync(executionPath(rootDir), `${JSON.stringify(execution, null, 2)}\n`, "utf8");

      await assert.rejects(makeReviewExecutionService({
        rootInput: rootDir,
        coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") }),
        artifactStore,
        generateReviewId: () => firstReviewId,
        generateConsentId: () => consentId,
        now: () => "2026-07-15T00:01:00.000Z",
        runtimeLogOptions
      }).reviewExecution({ ...reviewInput(), consentUtterance: "Approved after reviewing the submitted evidence." }),
      /invalid timestamp window/u);
    }
  });
});

test("review-current consent rejects replacement history timestamped only by a later compaction event", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore, runtimeLogOptions }) => {
    const logRoot = runtimeLogOptions.runtimeLogRoots.codex[0]!;
    writeFileSync(path.join(logRoot, `rollout-2026-07-15T00-00-00-${reviewerSession.sessionId}.jsonl`), `${JSON.stringify({
      timestamp: "2026-07-15T00:00:40.000Z",
      type: "compacted",
      payload: {
        replacement_history: [{
          role: "user",
          content: [{ type: "input_text", text: "Approved only in pre-compaction history." }]
        }]
      }
    })}\n`, "utf8");

    await assert.rejects(makeReviewExecutionService({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") }),
      artifactStore,
      generateReviewId: () => firstReviewId,
      generateConsentId: () => consentId,
      now: () => "2026-07-15T00:01:00.000Z",
      runtimeLogOptions
    }).reviewExecution({ ...reviewInput(), consentUtterance: "Approved only in pre-compaction history." }),
    /compaction.*timestamp.*unreliable/iu);
  });
});

test("an aliased execution session_ref cannot bypass the review-current timestamp window", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore, runtimeLogOptions }) => {
    const execution = readExecution(rootDir);
    execution.session_bindings[0].session_ref = "session/alias-for-current-session";
    writeFileSync(executionPath(rootDir), `${JSON.stringify(execution, null, 2)}\n`, "utf8");
    const logRoot = runtimeLogOptions.runtimeLogRoots.codex[0]!;
    writeFileSync(path.join(logRoot, `rollout-2026-07-15T00-00-00-${reviewerSession.sessionId}.jsonl`), `${JSON.stringify({
      timestamp: "2026-07-14T23:59:59.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Approved through an aliased execution binding." }
    })}\n`, "utf8");

    await assert.rejects(makeReviewExecutionService({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") }),
      artifactStore,
      generateReviewId: () => firstReviewId,
      generateConsentId: () => consentId,
      now: () => "2026-07-15T00:01:00.000Z",
      runtimeLogOptions
    }).reviewExecution({ ...reviewInput(), consentUtterance: "Approved through an aliased execution binding." }),
    /session_ref.*sessionId/iu);
  });
});

test("independent consent recording verifies the current consent-command session", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore, runtimeLogOptions }) => {
    const workerSession = bindExecutionToWorkerSession(rootDir);
    const result = await makeRecordExecutionConsentService({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") }),
      artifactStore,
      generateConsentId: () => consentId,
      now: () => "2026-07-15T00:01:00.000Z",
      runtimeLogOptions
    }).recordConsent({
      taskId,
      executionId,
      actor: aliceWorker,
      session: reviewerSession,
      utterance: "Approved after reviewing the submitted evidence."
    });

    assert.equal(result.consent.source.strength, "transcript-verified");
    assert.equal(result.consent.source.transcript_anchor?.session_ref, `session/${reviewerSession.sessionId}`);
    assert.equal(readExecution(rootDir).session_bindings[0].session_ref, `session/${workerSession.sessionId}`);
  });
});

test("independent consent recording rejects an execution-bound utterance outside the consent-command session", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore, runtimeLogOptions }) => {
    const workerSession = bindExecutionToWorkerSession(rootDir);
    const logRoot = runtimeLogOptions.runtimeLogRoots.codex[0]!;
    writeFileSync(path.join(logRoot, `rollout-2026-07-15T00-00-00-${workerSession.sessionId}.jsonl`), `${JSON.stringify({
      timestamp: "2026-07-15T00:00:40.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Approved only in the execution-bound worker session." }
    })}\n`, "utf8");

    await assert.rejects(makeRecordExecutionConsentService({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") }),
      artifactStore,
      generateConsentId: () => consentId,
      now: () => "2026-07-15T00:01:00.000Z",
      runtimeLogOptions
    }).recordConsent({
      taskId,
      executionId,
      actor: aliceWorker,
      session: reviewerSession,
      utterance: "Approved only in the execution-bound worker session."
    }), /current consent-command session/u);

    assert.equal(existsSync(consentPath(rootDir, consentId)), false);
  });
});

function reviewInput() {
  return {
    taskId,
    executionId,
    reviewer: aliceWorker,
    reviewerSession,
    findings: "Acceptance checks passed.",
    evidenceChecked: [],
    rationale: "The exact submitted delivery is acceptable.",
    verdict: "approved" as const,
    archiveWarningsAcknowledged: false
  };
}

function bindExecutionToWorkerSession(rootDir: string) {
  const execution = readExecution(rootDir);
  const workerSession = { runtime: "codex", sessionId: "worker-consent-test", source: "runtime", detectedAt: submittedAt };
  execution.session_bindings[0] = {
    ...execution.session_bindings[0],
    binding_id: "bind_primary_worker_consent_test",
    session_ref: `session/${workerSession.sessionId}`,
    session: workerSession
  };
  writeFileSync(executionPath(rootDir), `${JSON.stringify(execution, null, 2)}\n`, "utf8");
  return workerSession;
}

async function withConsentFixture(
  run: (fixture: {
    readonly rootDir: string;
    readonly artifactStore: ReturnType<typeof makeMarkdownArtifactStore>;
    readonly runtimeLogOptions: { readonly runtimeLogRoots: { readonly codex: ReadonlyArray<string> } };
  }) => Promise<void>
): Promise<void> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-execution-consent-current-session-"));
  try {
    const taskRoot = path.join(rootDir, "harness/tasks", taskId);
    const logRoot = path.join(rootDir, "runtime-logs");
    mkdirSync(path.join(taskRoot, "executions"), { recursive: true });
    mkdirSync(logRoot, { recursive: true });
    writeFileSync(path.join(logRoot, `rollout-2026-07-15T00-00-00-${reviewerSession.sessionId}.jsonl`), `${JSON.stringify({
      timestamp: "2026-07-15T00:00:30.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Approved after reviewing the submitted evidence." }
    })}\n${JSON.stringify({
      timestamp: "2026-07-15T00:00:31.000Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Assistant-only approval phrase." }] }
    })}\n`, "utf8");
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex(taskId, "in_review"), "utf8");
    writeFileSync(executionPath(rootDir), `${JSON.stringify({
      schema: "execution/v2",
      execution_id: executionId,
      task_ref: `task/${taskId}`,
      state: "submitted",
      primary_actor: aliceWorker,
      claimed_at: submittedAt,
      submitted_at: submittedAt,
      closed_at: null,
      session_bindings: [{
        binding_id: "bind_primary_consent_test",
        session_ref: `session/${reviewerSession.sessionId}`,
        role: "primary",
        archive_status: "complete",
        attached_at: submittedAt,
        session: reviewerSession,
        capture_range: null
      }],
      outputs: [],
      submission: {
        completion_claim: "Implement the exact requested behavior.",
        deliverables: ["consent gate"],
        evidence_refs: [],
        verification_notes: ["tests passed"],
        known_gaps: [],
        residual_risks: ["agent-relayed is an assertion"]
      }
    }, null, 2)}\n`, "utf8");
    await run({
      rootDir,
      artifactStore: makeMarkdownArtifactStore({ rootDir }),
      runtimeLogOptions: { runtimeLogRoots: { codex: [logRoot] } }
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function executionPath(rootDir: string): string {
  return path.join(rootDir, "harness/tasks", taskId, "executions", `${executionId}.md`);
}

function reviewPath(rootDir: string, id: string): string {
  return path.join(rootDir, "harness/tasks", taskId, "reviews", `${id}.md`);
}

function consentPath(rootDir: string, id: string): string {
  return path.join(rootDir, "harness/tasks", taskId, "consents", `${id}.md`);
}

function readExecution(rootDir: string): Record<string, any> {
  return JSON.parse(readFileSync(executionPath(rootDir), "utf8")) as Record<string, any>;
}

function readConsent(rootDir: string, id: string): Record<string, any> {
  return JSON.parse(readFileSync(consentPath(rootDir, id), "utf8")) as Record<string, any>;
}
