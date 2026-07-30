// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeRecordExecutionConsentService,
  makeReviewExecutionService
} from "../src/index.ts";
import {
  makeJournaledWriteCoordinator,
  makeMarkdownArtifactStore,
  taskHolderActor
} from "../../kernel/src/index.ts";
import { taskIndex } from "./execution-saga-fixtures.ts";
import { writeAttribution } from "./test-attribution.ts";

const taskId = "task_01KX7H00000000000000000010";
const executionId = "exe_01KX7H00000000000000000010";
const consentId = "cns_01KX7H00000000000000000010";
const reviewId = "rev_01KX7H00000000000000000010";
const submittedAt = "2026-07-15T00:00:00.000Z";
const session = { runtime: "codex" as const, sessionId: "consent-active-task", source: "runtime" as const, detectedAt: submittedAt };
const actor = taskHolderActor({ personId: "alice" }, { kind: "agent", id: "worker" });

test("active task with a submitted round supports record-then-consume consent", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-execution-consent-active-"));
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  try {
    mkdirSync(path.join(taskRoot, "executions"), { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex(taskId, "active"));
    writeFileSync(path.join(taskRoot, "executions", `${executionId}.md`), `${JSON.stringify({
      schema: "execution/v2",
      execution_id: executionId,
      task_ref: `task/${taskId}`,
      state: "submitted",
      primary_actor: actor,
      claimed_at: submittedAt,
      submitted_at: submittedAt,
      closed_at: null,
      session_bindings: [{
        binding_id: "bind_primary_consent_active",
        session_ref: `session/${session.sessionId}`,
        role: "primary",
        archive_status: "complete",
        attached_at: submittedAt,
        session,
        capture_range: null
      }],
      outputs: [],
      submission: {
        completion_claim: "Implement the exact requested behavior.",
        deliverables: ["consent gate"],
        evidence_refs: [],
        verification_notes: ["tests passed"],
        known_gaps: [],
        residual_risks: []
      }
    }, null, 2)}\n`);
    const artifactStore = makeMarkdownArtifactStore({ rootDir });
    const coordinator = makeJournaledWriteCoordinator({
      rootDir,
      attribution: writeAttribution("alice", "worker")
    });
    const recorded = await makeRecordExecutionConsentService({
      rootInput: rootDir,
      coordinator,
      artifactStore,
      generateConsentId: () => consentId,
      now: () => "2026-07-15T00:01:00.000Z"
    }).recordConsent({
      taskId,
      executionId,
      actor,
      session,
      assertedRationale: "Approval was received through an external channel."
    });
    const reviewed = await makeReviewExecutionService({
      rootInput: rootDir,
      coordinator,
      artifactStore,
      generateReviewId: () => reviewId,
      now: () => "2026-07-15T00:02:00.000Z"
    }).reviewExecution({
      taskId,
      executionId,
      reviewer: actor,
      reviewerSession: session,
      findings: "Acceptance checks passed.",
      evidenceChecked: [],
      rationale: "The exact submitted delivery is acceptable.",
      verdict: "approved",
      archiveWarningsAcknowledged: false,
      consentId: recorded.consent.consent_id
    });

    const consent = JSON.parse(readFileSync(path.join(taskRoot, "consents", `${consentId}.md`), "utf8"));
    const execution = JSON.parse(readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8"));
    assert.equal(reviewed.review.approval_basis?.kind, "human-consent");
    assert.equal(consent.state, "consumed");
    assert.equal(execution.state, "accepted");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
