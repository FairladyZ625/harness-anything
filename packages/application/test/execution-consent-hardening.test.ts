// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeRecordExecutionConsentService, makeReviewExecutionService } from "../src/index.ts";
import { resolveConsentAuthorization } from "../src/consent-source-resolution.ts";
import {
  makeJournaledWriteCoordinator,
  makeMarkdownArtifactStore,
  sha256Text,
  taskHolderActor
} from "../../kernel/src/index.ts";
import { writeAttribution } from "./test-attribution.ts";

const session = {
  runtime: "codex" as const,
  sessionId: "consent-utterance-hardening",
  source: "runtime" as const,
  detectedAt: "2026-08-05T00:00:00.000Z"
};
const firstTaskId = "task_01KZ7000000000000000000001";
const secondTaskId = "task_01KZ7000000000000000000002";
const firstExecutionId = "exe_01KZ7000000000000000000001";
const secondExecutionId = "exe_01KZ7000000000000000000002";
const firstConsentId = "cns_01KZ7000000000000000000001";
const secondConsentId = "cns_01KZ7000000000000000000002";
const firstReviewId = "rev_01KZ7000000000000000000001";
const secondReviewId = "rev_01KZ7000000000000000000002";
const actor = taskHolderActor({ personId: "owner" }, { kind: "agent", id: "worker" });
const confirmation = "Approve this exact execution.";

test("a negated user message cannot satisfy consent by an extracted substring", async () => {
  await withUserMessage("Do not approve this execution", async (rootDir, runtimeLogOptions) => {
    await assert.rejects(resolveConsentAuthorization({
      rootInput: rootDir,
      transcriptCandidates: [{
        source: "execution-bound",
        sessionRef: `session/${session.sessionId}`,
        session
      }],
      request: { kind: "utterance", utterance: "approve this execution" },
      runtimeLogOptions
    }), (error: unknown) => {
      assert.match(String(error), /utterance must equal the human's complete message after trimming/u);
      assert.match(String(error), /ask the human to send a separate standalone confirmation message/u);
      return true;
    });
  });
});

test("quoted approval words cannot satisfy consent by an extracted substring", async () => {
  await withUserMessage("The reviewer said: \"Approve this execution\"", async (rootDir, runtimeLogOptions) => {
    await assert.rejects(resolveConsentAuthorization({
      rootInput: rootDir,
      transcriptCandidates: [{
        source: "execution-bound",
        sessionRef: `session/${session.sessionId}`,
        session
      }],
      request: { kind: "utterance", utterance: "Approve this execution" },
      runtimeLogOptions
    }), /utterance must equal the human's complete message after trimming/u);
  });
});

test("an embedded short ok cannot satisfy consent", async () => {
  await withUserMessage("This execution is not ok", async (rootDir, runtimeLogOptions) => {
    await assert.rejects(resolveConsentAuthorization({
      rootInput: rootDir,
      transcriptCandidates: [{
        source: "execution-bound",
        sessionRef: `session/${session.sessionId}`,
        session
      }],
      request: { kind: "utterance", utterance: "ok" },
      runtimeLogOptions
    }), /ask the human to send a separate standalone confirmation message/u);
  });
});

test("a complete user message still matches after surrounding whitespace is trimmed", async () => {
  await withUserMessage("  Approve this execution.  ", async (rootDir, runtimeLogOptions) => {
    const authorization = await resolveConsentAuthorization({
      rootInput: rootDir,
      transcriptCandidates: [{
        source: "execution-bound",
        sessionRef: `session/${session.sessionId}`,
        session
      }],
      request: { kind: "utterance", utterance: "  Approve this execution. " },
      runtimeLogOptions
    });
    assert.deepEqual(authorization.response, {
      kind: "utterance",
      text: "Approve this execution.",
      session_ref: `session/${session.sessionId}`
    });
  });
});

test("one transcript anchor cannot record consent for another execution in the same task", async () => {
  await withUserMessage(confirmation, async (rootDir, runtimeLogOptions) => {
    seedTask(rootDir, firstTaskId, [firstExecutionId, secondExecutionId]);
    await recordConsent(rootDir, runtimeLogOptions, firstTaskId, firstExecutionId, firstConsentId);

    await assert.rejects(
      recordConsent(rootDir, runtimeLogOptions, firstTaskId, secondExecutionId, secondConsentId),
      (error: unknown) => {
        const expectedAnchorKey = `sha256:${sha256Text(
          `session/${session.sessionId}0sha256:${sha256Text(confirmation)}`
        )}`;
        assert.match(String(error), new RegExp(`transcript consent anchor ${expectedAnchorKey}`, "u"));
        assert.match(String(error), new RegExp(`already been consumed by execution/${firstTaskId}/${firstExecutionId}`, "u"));
        assert.match(String(error), /ask the human to send a new standalone confirmation message/iu);
        return true;
      }
    );
  });
});

test("one transcript anchor cannot record consent for an execution in another task", async () => {
  await withUserMessage(confirmation, async (rootDir, runtimeLogOptions) => {
    seedTask(rootDir, firstTaskId, [firstExecutionId]);
    seedTask(rootDir, secondTaskId, [secondExecutionId]);
    await recordConsent(rootDir, runtimeLogOptions, firstTaskId, firstExecutionId, firstConsentId);

    await assert.rejects(
      recordConsent(rootDir, runtimeLogOptions, secondTaskId, secondExecutionId, secondConsentId),
      new RegExp(`already been consumed by execution/${firstTaskId}/${firstExecutionId}`, "u")
    );
  });
});

test("the same execution can idempotently reverify one transcript anchor", async () => {
  await withUserMessage(confirmation, async (rootDir, runtimeLogOptions) => {
    seedTask(rootDir, firstTaskId, [firstExecutionId]);
    await recordConsent(rootDir, runtimeLogOptions, firstTaskId, firstExecutionId, firstConsentId);
    await recordConsent(rootDir, runtimeLogOptions, firstTaskId, firstExecutionId, secondConsentId);

    assert.equal(existsSync(consentPath(rootDir, firstTaskId, firstConsentId)), true);
    assert.equal(existsSync(consentPath(rootDir, firstTaskId, secondConsentId)), true);
  });
});

test("inline Review consent also enforces the anchor uniqueness constraint", async () => {
  await withUserMessage(confirmation, async (rootDir, runtimeLogOptions) => {
    seedTask(rootDir, firstTaskId, [firstExecutionId, secondExecutionId]);
    await reviewWithTranscriptConsent(
      rootDir,
      runtimeLogOptions,
      firstExecutionId,
      firstReviewId,
      firstConsentId
    );

    await assert.rejects(
      reviewWithTranscriptConsent(
        rootDir,
        runtimeLogOptions,
        secondExecutionId,
        secondReviewId,
        secondConsentId
      ),
      new RegExp(`already been consumed by execution/${firstTaskId}/${firstExecutionId}`, "u")
    );
    assert.equal(existsSync(reviewPath(rootDir, firstTaskId, secondReviewId)), false);
  });
});

async function withUserMessage(
  message: string,
  run: (
    rootDir: string,
    runtimeLogOptions: { readonly runtimeLogRoots: { readonly codex: ReadonlyArray<string> } }
  ) => Promise<void>
): Promise<void> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-consent-utterance-hardening-"));
  try {
    const logRoot = path.join(rootDir, "runtime-logs");
    mkdirSync(logRoot, { recursive: true });
    writeFileSync(
      path.join(logRoot, `rollout-2026-08-05T00-00-00-${session.sessionId}.jsonl`),
      `${JSON.stringify({
        timestamp: "2026-08-05T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message }
      })}\n`,
      "utf8"
    );
    await run(rootDir, { runtimeLogRoots: { codex: [logRoot] } });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

async function recordConsent(
  rootDir: string,
  runtimeLogOptions: { readonly runtimeLogRoots: { readonly codex: ReadonlyArray<string> } },
  taskId: string,
  executionId: string,
  consentId: string
): Promise<void> {
  await makeRecordExecutionConsentService({
    rootInput: rootDir,
    coordinator: makeJournaledWriteCoordinator({
      rootDir,
      attribution: writeAttribution("owner", "worker")
    }),
    artifactStore: makeMarkdownArtifactStore({ rootDir }),
    generateConsentId: () => consentId,
    now: () => "2026-08-05T00:00:02.000Z",
    runtimeLogOptions
  }).recordConsent({
    taskId,
    executionId,
    actor,
    session,
    utterance: confirmation
  });
}

async function reviewWithTranscriptConsent(
  rootDir: string,
  runtimeLogOptions: { readonly runtimeLogRoots: { readonly codex: ReadonlyArray<string> } },
  executionId: string,
  reviewId: string,
  consentId: string
): Promise<void> {
  await makeReviewExecutionService({
    rootInput: rootDir,
    coordinator: makeJournaledWriteCoordinator({
      rootDir,
      attribution: writeAttribution("owner", "worker")
    }),
    artifactStore: makeMarkdownArtifactStore({ rootDir }),
    generateReviewId: () => reviewId,
    generateConsentId: () => consentId,
    now: () => "2026-08-05T00:00:02.000Z",
    runtimeLogOptions
  }).reviewExecution({
    taskId: firstTaskId,
    executionId,
    reviewer: actor,
    reviewerSession: session,
    findings: "The execution satisfies the task contract.",
    evidenceChecked: [],
    rationale: "The submitted evidence supports approval.",
    verdict: "approved",
    archiveWarningsAcknowledged: false,
    consentUtterance: confirmation
  });
}

function seedTask(rootDir: string, taskId: string, executionIds: ReadonlyArray<string>): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(path.join(taskRoot, "executions"), { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task/v1",
    `task_id: ${taskId}`,
    "title: Consent anchor hardening",
    "lifecycle:",
    "  status: in_review",
    "  engine: local",
    "---",
    ""
  ].join("\n"), "utf8");
  for (const executionId of executionIds) {
    writeFileSync(path.join(taskRoot, "executions", `${executionId}.md`), `${JSON.stringify({
      schema: "execution/v2",
      execution_id: executionId,
      task_ref: `task/${taskId}`,
      state: "submitted",
      primary_actor: actor,
      claimed_at: "2026-08-05T00:00:00.000Z",
      submitted_at: "2026-08-05T00:00:00.000Z",
      closed_at: null,
      session_bindings: [{
        binding_id: `primary:${session.sessionId}`,
        session_ref: `session/${session.sessionId}`,
        role: "primary",
        archive_status: "complete",
        attached_at: "2026-08-05T00:00:00.000Z",
        session,
        capture_range: null
      }],
      outputs: [],
      submission: {
        completion_claim: `Complete ${executionId}`,
        deliverables: [executionId],
        evidence_refs: [],
        verification_notes: ["targeted tests passed"],
        known_gaps: [],
        residual_risks: []
      }
    }, null, 2)}\n`, "utf8");
  }
}

function consentPath(rootDir: string, taskId: string, consentId: string): string {
  return path.join(rootDir, "harness/tasks", taskId, "consents", `${consentId}.md`);
}

function reviewPath(rootDir: string, taskId: string, reviewId: string): string {
  return path.join(rootDir, "harness/tasks", taskId, "reviews", `${reviewId}.md`);
}
