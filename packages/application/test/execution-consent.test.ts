// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  DEFAULT_HUMAN_CONSENT_TTL_MS,
  makeExecutionCompletionService,
  makeRecordExecutionConsentService,
  makeReviewExecutionService
} from "../src/index.ts";
import {
  makeJournaledWriteCoordinator,
  makeMarkdownArtifactStore,
  taskHolderActor,
  type WriteCoordinator,
  type WriteAttribution,
  type WriteOp
} from "../../kernel/src/index.ts";
import { writeAttribution } from "./test-attribution.ts";
import { taskIndex } from "./execution-saga-fixtures.ts";
import { runEffect } from "./effect-test-helpers.ts";

const taskId = "task_01KX7H00000000000000000010";
const executionId = "exe_01KX7H00000000000000000010";
const consentId = "cns_01KX7H00000000000000000010";
const firstReviewId = "rev_01KX7H00000000000000000010";
const secondReviewId = "rev_01KX7H00000000000000000011";
const activeDecisionId = "dec_01KX7H00000000000000000010";
const submittedAt = "2026-07-15T00:00:00.000Z";
const reviewerSession = { runtime: "codex" as const, sessionId: "consent-test", source: "runtime" as const, detectedAt: submittedAt };
const aliceWorker = taskHolderActor({ personId: "alice" }, { kind: "agent", id: "worker" });
const aliceRenamed = taskHolderActor({ personId: "alice" }, { kind: "agent", id: "renamed-reviewer" });
const aliceHuman = taskHolderActor({ personId: "alice" }, null);
const bobWorker = taskHolderActor({ personId: "bob" }, { kind: "agent", id: "reviewer" });

test("approved Review fails without consent for both the delivery executor and a renamed executor", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore }) => {
    for (const reviewer of [aliceWorker, aliceRenamed]) {
      const service = makeReviewExecutionService({
        rootInput: rootDir,
        coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", reviewer.executor!.id) }),
        artifactStore,
        generateReviewId: () => firstReviewId,
        now: () => "2026-07-15T00:01:00.000Z"
      });
      await assert.rejects(service.reviewExecution(reviewInput(reviewer)), (error: unknown) => {
        assert.match(String(error), /Human consent required/u);
        assert.match(String(error), /Keep HARNESS_ACTOR unchanged/u);
        return true;
      });
    }
    assert.equal(existsSync(reviewPath(rootDir, firstReviewId)), false);
    await assert.rejects(makeExecutionCompletionService({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "renamed-reviewer") }),
      artifactStore
    }).completeTaskExecution({ taskId, actor: aliceRenamed }), /approved Review backed by consumed human consent/u);
  });
});

test("same executor can record asserted consent, approve, and complete without changing identity", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore }) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") });
    const consent = await makeRecordExecutionConsentService({
      rootInput: rootDir,
      coordinator,
      artifactStore,
      generateConsentId: () => consentId,
      now: () => "2026-07-15T00:01:00.000Z"
    }).recordConsent({
      taskId,
      executionId,
      actor: aliceWorker,
      session: reviewerSession,
      assertedRationale: "Approval was received through an external channel."
    });
    assert.equal(Date.parse(consent.consent.expires_at) - Date.parse(consent.consent.granted_at), DEFAULT_HUMAN_CONSENT_TTL_MS);
    assert.deepEqual(consent.consent.scope.actions, ["approve_execution", "complete_task"]);
    assert.equal(consent.consent.source.strength, "asserted");

    const reviewed = await makeReviewExecutionService({
      rootInput: rootDir,
      coordinator,
      artifactStore,
      generateReviewId: () => firstReviewId,
      now: () => "2026-07-15T00:02:00.000Z"
    }).reviewExecution({ ...reviewInput(aliceWorker), consentId });
    assert.equal(reviewed.review.reviewer_actor.executor?.id, "worker");
    assert.equal(reviewed.review.approval_basis?.kind, "human-consent");
    assert.equal(readConsent(rootDir, consentId).state, "consumed");

    const completed = await makeExecutionCompletionService({
      rootInput: rootDir,
      coordinator,
      artifactStore,
      now: () => "2026-07-15T00:03:00.000Z"
    }).completeTaskExecution({ taskId, actor: aliceWorker });
    assert.deepEqual(completed, { executionId });
    assert.equal(readExecution(rootDir).state, "accepted");
  });
});

test("--consent-utterance verifies a bound user turn and records a location anchor", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore, runtimeLogOptions }) => {
    const reviewed = await makeReviewExecutionService({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") }),
      artifactStore,
      generateReviewId: () => firstReviewId,
      generateConsentId: () => consentId,
      now: () => "2026-07-15T00:01:00.000Z",
      runtimeLogOptions
    }).reviewExecution({ ...reviewInput(aliceWorker), consentUtterance: "Approved after reviewing the submitted evidence." });

    const stored = readConsent(rootDir, consentId);
    assert.equal(stored.state, "consumed");
    assert.equal(stored.consumed_by, `review/${taskId}/${firstReviewId}`);
    assert.deepEqual(stored.source, {
      strength: "transcript-verified",
      transcript_anchor: {
        session_ref: `session/${reviewerSession.sessionId}`,
        message_index: 0,
        role: "user",
        message_sha256: "sha256:d430c94f634d5847b70e405964c7bc6d81bec4ce4d8ddde6771b76bc9569b0c6",
        timestamp: "2026-07-15T00:00:30.000Z"
      }
    });
    assert.equal(reviewed.review.approval_basis?.kind, "human-consent");
  });
});

test("--consent-utterance rejects an unbound phrase instead of granting transcript-verified", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore, runtimeLogOptions }) => {
    await assert.rejects(makeReviewExecutionService({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") }),
      artifactStore,
      generateReviewId: () => firstReviewId,
      generateConsentId: () => consentId,
      runtimeLogOptions
    }).reviewExecution({ ...reviewInput(aliceWorker), consentUtterance: "A phrase absent from every user turn" }),
    /not found in any bound session transcript user turn/u);
    assert.equal(existsSync(consentPath(rootDir, consentId)), false);
    assert.equal(existsSync(reviewPath(rootDir, firstReviewId)), false);
  });
});

test("assistant turns cannot satisfy transcript verification", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore, runtimeLogOptions }) => {
    await assert.rejects(makeReviewExecutionService({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") }),
      artifactStore,
      generateReviewId: () => firstReviewId,
      generateConsentId: () => consentId,
      runtimeLogOptions
    }).reviewExecution({ ...reviewInput(aliceWorker), consentUtterance: "Assistant-only approval phrase." }),
    /not found in any bound session transcript user turn/u);
  });
});

test("structurally transcript-less runtimes produce a distinct diagnostic", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore }) => {
    const execution = readExecution(rootDir);
    execution.session_bindings[0].session.runtime = "antigravity";
    writeFileSync(executionPath(rootDir), `${JSON.stringify(execution, null, 2)}\n`, "utf8");
    await assert.rejects(makeReviewExecutionService({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") }),
      artifactStore,
      generateReviewId: () => firstReviewId,
      generateConsentId: () => consentId
    }).reviewExecution({ ...reviewInput(aliceWorker), consentUtterance: "Approved" }),
    /runtime \(antigravity\) structurally does not produce a verifiable transcript/u);
  });
});

test("inline standing-policy and asserted sources both remain agent-executable", async () => {
  for (const source of [
    { consentStandingPolicyDecisionId: activeDecisionId, expected: "standing-policy" },
    { consentAssertedRationale: "Approval was received in a private meeting.", expected: "asserted" }
  ] as const) {
    await withConsentFixture(async ({ rootDir, artifactStore }) => {
      await makeReviewExecutionService({
        rootInput: rootDir,
        coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") }),
        artifactStore,
        generateReviewId: () => firstReviewId,
        generateConsentId: () => consentId
      }).reviewExecution({ ...reviewInput(aliceWorker), ...source });
      assert.equal(readConsent(rootDir, consentId).source.strength, source.expected);
    });
  }
});

test("independent consent recording supports transcript, standing-policy, and asserted sources", async () => {
  for (const source of [
    { utterance: "Approved after reviewing the submitted evidence.", expected: "transcript-verified" },
    { standingPolicyDecisionId: activeDecisionId, expected: "standing-policy" },
    { assertedRationale: "Approval was received in a private meeting.", expected: "asserted" }
  ] as const) {
    await withConsentFixture(async ({ rootDir, artifactStore, runtimeLogOptions }) => {
      const result = await makeRecordExecutionConsentService({
        rootInput: rootDir,
        coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") }),
        artifactStore,
        generateConsentId: () => consentId,
        runtimeLogOptions
      }).recordConsent({ taskId, executionId, actor: aliceWorker, session: reviewerSession, ...source });
      assert.equal(result.consent.source.strength, source.expected);
    });
  }
});

test("direct human CLI still creates and consumes the independent consent entity", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore }) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir, attribution: humanWriteAttribution("alice") });
    await makeReviewExecutionService({
      rootInput: rootDir,
      coordinator,
      artifactStore,
      generateReviewId: () => firstReviewId,
      generateConsentId: () => consentId,
      now: () => "2026-07-15T00:01:00.000Z"
    }).reviewExecution({ ...reviewInput(aliceHuman), consentAssertedRationale: "Approval was received through an external channel." });

    const stored = readConsent(rootDir, consentId);
    assert.equal(stored.channel.kind, "human-cli");
    assert.equal(stored.state, "consumed");
    assert.equal(existsSync(consentPath(rootDir, consentId)), true);
  });
});

test("consumed consent cannot be replayed for a second approved Review", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore }) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") });
    await recordOpenConsent(rootDir, artifactStore, coordinator);
    await makeReviewExecutionService({
      rootInput: rootDir,
      coordinator,
      artifactStore,
      generateReviewId: () => firstReviewId,
      now: () => "2026-07-15T00:02:00.000Z"
    }).reviewExecution({ ...reviewInput(aliceWorker), consentId });

    await assert.rejects(makeReviewExecutionService({
      rootInput: rootDir,
      coordinator,
      artifactStore,
      generateReviewId: () => secondReviewId,
      now: () => "2026-07-15T00:03:00.000Z"
    }).reviewExecution({ ...reviewInput(aliceRenamed), consentId }), /consumed and cannot be replayed/u);
    assert.equal(existsSync(reviewPath(rootDir, secondReviewId)), false);
  });
});

test("consent remains bound to its recorded person principal", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore }) => {
    await recordOpenConsent(
      rootDir,
      artifactStore,
      makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") })
    );
    await assert.rejects(makeReviewExecutionService({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("bob", "reviewer") }),
      artifactStore,
      generateReviewId: () => firstReviewId,
      now: () => "2026-07-15T00:02:00.000Z"
    }).reviewExecution({ ...reviewInput(bobWorker), consentId }), /belongs to a different principal/u);
    assert.equal(readConsent(rootDir, consentId).state, "open");
    assert.equal(existsSync(reviewPath(rootDir, firstReviewId)), false);
  });
});

test("consent grant survives a stop after durable enqueue and recovers exactly once", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore }) => {
    const durable = makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") });
    await assert.rejects(makeRecordExecutionConsentService({
      rootInput: rootDir,
      coordinator: stopBeforeConsentFlush(durable),
      artifactStore,
      generateConsentId: () => consentId,
      now: () => "2026-07-15T00:01:00.000Z"
    }).recordConsent({
      taskId,
      executionId,
      actor: aliceWorker,
      session: reviewerSession,
      assertedRationale: "Approval was received through an external channel."
    }), /simulated process stop after consent WAL append/u);
    assert.equal(existsSync(consentPath(rootDir, consentId)), false);

    const firstRecovery = await runEffect(makeJournaledWriteCoordinator({
      rootDir,
      attribution: writeAttribution("alice", "worker")
    }).recover);
    assert.equal(firstRecovery.replayedOps, 1);
    assert.deepEqual({
      state: readConsent(rootDir, consentId).state,
      principal: readConsent(rootDir, consentId).principal
    }, { state: "open", principal: { personId: "alice" } });

    const secondRecovery = await runEffect(makeJournaledWriteCoordinator({
      rootDir,
      attribution: writeAttribution("alice", "worker")
    }).recover);
    assert.equal(secondRecovery.replayedOps, 0);
    assert.equal(readConsent(rootDir, consentId).state, "open");
  });
});

test("expired consent is materialized expired and cannot approve", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore }) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") });
    await makeRecordExecutionConsentService({
      rootInput: rootDir,
      coordinator,
      artifactStore,
      generateConsentId: () => consentId,
      now: () => "2026-07-15T00:01:00.000Z",
      ttlMs: 1_000
    }).recordConsent({ taskId, executionId, actor: aliceWorker, session: reviewerSession, assertedRationale: "Approval was received through an external channel." });

    await assert.rejects(makeReviewExecutionService({
      rootInput: rootDir,
      coordinator,
      artifactStore,
      generateReviewId: () => firstReviewId,
      now: () => "2026-07-15T00:01:02.000Z"
    }).reviewExecution({ ...reviewInput(aliceWorker), consentId }), /expired at/u);
    assert.equal(readConsent(rootDir, consentId).state, "expired");
    assert.equal(existsSync(reviewPath(rootDir, firstReviewId)), false);
  });
});

test("delivery changes break the content pin before the 24h freshness bound", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore }) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") });
    await recordOpenConsent(rootDir, artifactStore, coordinator);
    const execution = readExecution(rootDir);
    writeFileSync(executionPath(rootDir), `${JSON.stringify({
      ...execution,
      submission: { ...execution.submission, completion_claim: "changed after consent" }
    }, null, 2)}\n`, "utf8");

    await assert.rejects(makeReviewExecutionService({
      rootInput: rootDir,
      coordinator,
      artifactStore,
      generateReviewId: () => firstReviewId,
      now: () => "2026-07-15T00:02:00.000Z"
    }).reviewExecution({ ...reviewInput(aliceWorker), consentId }), /Delivery changed after consent/u);
    assert.equal(readConsent(rootDir, consentId).state, "open");
    assert.equal(existsSync(reviewPath(rootDir, firstReviewId)), false);
  });
});

test("approve-only consent cannot authorize completion", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore }) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") });
    await makeReviewExecutionService({
      rootInput: rootDir,
      coordinator,
      artifactStore,
      generateReviewId: () => firstReviewId,
      generateConsentId: () => consentId,
      now: () => "2026-07-15T00:01:00.000Z"
    }).reviewExecution({
      ...reviewInput(aliceWorker),
      consentAssertedRationale: "Approval was received externally for approval only.",
      consentActions: ["approve_execution"]
    });

    await assert.rejects(makeExecutionCompletionService({
      rootInput: rootDir,
      coordinator,
      artifactStore
    }).completeTaskExecution({ taskId, actor: aliceRenamed }), /grants complete_task/u);
    assert.equal(readExecution(rootDir).state, "submitted");
  });
});

test("dismissed Review needs no consent and records approval_basis null", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore }) => {
    const result = await makeReviewExecutionService({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") }),
      artifactStore,
      generateReviewId: () => firstReviewId,
      now: () => "2026-07-15T00:01:00.000Z"
    }).reviewExecution({ ...reviewInput(aliceWorker), verdict: "dismissed" });
    assert.equal(result.review.approval_basis, null);
  });
});

test("changes_requested Review needs no consent and records approval_basis null", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore }) => {
    const result = await makeReviewExecutionService({
      rootInput: rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") }),
      artifactStore,
      generateReviewId: () => firstReviewId,
      now: () => "2026-07-15T00:01:00.000Z"
    }).reviewExecution({ ...reviewInput(aliceWorker), verdict: "changes_requested" });
    assert.equal(result.review.approval_basis, null);
    assert.equal(readExecution(rootDir).state, "changes_requested");
  });
});

test("two requests that both read open consent cannot both pass the locked preimage condition", async () => {
  await withConsentFixture(async ({ rootDir, artifactStore }) => {
    const writer = makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "worker") });
    await recordOpenConsent(rootDir, artifactStore, writer);
    const firstCapture = captureCoordinator();
    const secondCapture = captureCoordinator();
    await makeReviewExecutionService({
      rootInput: rootDir,
      coordinator: firstCapture.coordinator,
      artifactStore,
      generateReviewId: () => firstReviewId,
      now: () => "2026-07-15T00:02:00.000Z"
    }).reviewExecution({ ...reviewInput(aliceWorker), consentId });
    await makeReviewExecutionService({
      rootInput: rootDir,
      coordinator: secondCapture.coordinator,
      artifactStore,
      generateReviewId: () => secondReviewId,
      now: () => "2026-07-15T00:02:00.000Z"
    }).reviewExecution({ ...reviewInput(aliceRenamed), consentId });

    assert.equal(firstCapture.ops.length, 1);
    assert.equal(secondCapture.ops.length, 1);
    await runEffect(writer.enqueue(firstCapture.ops[0]!));
    await runEffect(writer.flush("explicit"));
    await assert.rejects(runEffect(writer.enqueue(secondCapture.ops[0]!)), /declared entity precondition changed/u);
    assert.equal(readConsent(rootDir, consentId).consumed_by, `review/${taskId}/${firstReviewId}`);
    assert.equal(existsSync(reviewPath(rootDir, secondReviewId)), false);
  });
});

async function recordOpenConsent(
  rootDir: string,
  artifactStore: ReturnType<typeof makeMarkdownArtifactStore>,
  coordinator: WriteCoordinator
): Promise<void> {
  await makeRecordExecutionConsentService({
    rootInput: rootDir,
    coordinator,
    artifactStore,
    generateConsentId: () => consentId,
    now: () => "2026-07-15T00:01:00.000Z"
  }).recordConsent({ taskId, executionId, actor: aliceWorker, session: reviewerSession, assertedRationale: "Approval was received through an external channel." });
}

function reviewInput(reviewer: typeof aliceWorker) {
  return {
    taskId,
    executionId,
    reviewer,
    reviewerSession,
    findings: "Acceptance checks passed.",
    evidenceChecked: [],
    rationale: "The exact submitted delivery is acceptable.",
    verdict: "approved" as const,
    archiveWarningsAcknowledged: false
  };
}

async function withConsentFixture(
  run: (fixture: {
    readonly rootDir: string;
    readonly artifactStore: ReturnType<typeof makeMarkdownArtifactStore>;
    readonly runtimeLogOptions: { readonly runtimeLogRoots: { readonly codex: ReadonlyArray<string> } };
  }) => Promise<void>
): Promise<void> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-execution-consent-"));
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
    writeActiveDecision(rootDir);
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

function writeActiveDecision(rootDir: string): void {
  const decisionRoot = path.join(rootDir, "harness/decisions", `decision-${activeDecisionId}`);
  mkdirSync(decisionRoot, { recursive: true });
  writeFileSync(path.join(decisionRoot, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${activeDecisionId}`,
    "title: Consent standing policy",
    "state: active",
    "riskTier: high",
    "urgency: high",
    "vertical: software/coding",
    "preset: architecture-decision",
    "applies_to:",
    "  modules: []",
    "  productLines: []",
    "proposedAt: 2026-07-15T00:00:00.000Z",
    "decidedAt: 2026-07-15T00:00:01.000Z",
    "contentPins: []",
    "provenance:",
    "  - {runtime: codex, sessionId: consent-test, boundAt: 2026-07-15T00:00:00.000Z}",
    "question: May this policy authorize execution approval?",
    "chosen:",
    "  - {id: CH1, text: Yes}",
    "rejected:",
    "  - {id: RJ1, text: No, why_not: The policy is active.}",
    "claims:",
    "  - {id: C1, text: This policy authorizes approval.}",
    "relations:",
    "---",
    "",
    "# Consent standing policy",
    ""
  ].join("\n"), "utf8");
}

function captureCoordinator(): { readonly coordinator: WriteCoordinator; readonly ops: WriteOp[] } {
  const ops: WriteOp[] = [];
  return {
    ops,
    coordinator: {
      enqueue: (op) => Effect.sync(() => {
        ops.push(op);
        return { opId: op.opId, entityId: op.entityId, accepted: true };
      }),
      flush: (reason) => Effect.succeed({ reason, opCount: ops.length, committed: false }),
      recover: Effect.succeed({ replayedOps: 0 })
    }
  };
}

function stopBeforeConsentFlush(coordinator: WriteCoordinator): WriteCoordinator {
  return {
    ...coordinator,
    flush: () => Effect.die(new Error("simulated process stop after consent WAL append"))
  };
}

function humanWriteAttribution(personId: string): WriteAttribution {
  return {
    actor: { principal: { kind: "person", personId }, executor: null },
    principalSource: { kind: "local-configured", authority: "harness.yaml", authoritySha256: "sha256:test" },
    executorSource: "none"
  };
}

function executionPath(rootDir: string): string {
  return path.join(rootDir, "harness/tasks", taskId, "executions", `${executionId}.md`);
}

function reviewPath(rootDir: string, reviewId: string): string {
  return path.join(rootDir, "harness/tasks", taskId, "reviews", `${reviewId}.md`);
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
