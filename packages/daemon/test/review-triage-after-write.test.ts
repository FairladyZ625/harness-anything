// harness-test-tier: fast
/**
 * dec_6A77D43B8523823ABA1F5E4D3C CH3/CH5: the host hook is the entry the first review found
 * unwired (`openReviewFindingTriage` had no caller in the whole tree). This test drives the hook
 * itself, not the producer it delegates to, so a break in the receipt contract, the cut selection,
 * or the no-category short-circuit fails here instead of silently leaving the journal unwritten.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { submissionDigest, type ExecutionV1, type ReviewV1 } from "@harness-anything/kernel";
import { readReviewTriageRecords } from "../src/review-finding-triage.ts";
import { settleReviewedCutAfterWrite } from "../src/review-triage-after-write.ts";

const digest = `sha256:${"a".repeat(64)}` as const,
  commit = "b".repeat(40);

function cut(findings: readonly Record<string, unknown>[]): { execution: ExecutionV1; review: ReviewV1 } {
  const execution = {
    schema: "execution/v1",
    executionId: "exec-1",
    taskId: "task_1",
    iteration: 0,
    state: "submitted",
    actor: { principal: { personId: "person_a" }, executor: null },
    deliveryBaseline: { kind: "commit", commitSha: "c".repeat(40) },
    submission: {
      commitSha: commit,
      deliverables: ["README.md"],
      outputs: [],
      completionClaim: "done",
      verificationNotes: [],
      knownGaps: [],
      residualRisks: [],
      completionContract: {
        presetSnapshotDigest: digest,
        gates: [],
        closeoutGates: { review: true, consent: false, factDisposition: false, codeDoc: false },
      },
    },
    submittedAt: "2026-10-26T00:00:00.000Z",
    gateRuns: [],
    reviews: [],
  } as unknown as ExecutionV1;
  const review = {
    schema: "review/v1",
    reviewId: "review-1",
    taskId: "task_1",
    executionId: "exec-1",
    verdict: "approved",
    actor: { principal: { personId: "person_a" }, executor: { kind: "agent", id: "reviewer" } },
    capabilityRef: "execution-review@v1",
    reason: "checked",
    evidenceChecked: ["README.md"],
    commitSha: commit,
    iteration: 0,
    contentDigest: digest,
    submissionDigest: submissionDigest(execution.submission!),
    reviewedAt: "2026-10-26T00:01:00.000Z",
    findings,
    resolutions: [],
  } as unknown as ReviewV1;
  return { execution, review };
}

function providers(selected = "non_blocking", probability = 0.95) {
  let asked = 0;
  return {
    asked: () => asked,
    list: () => [
      {
        schema: "decision-provider/v1" as const,
        providerId: "provider-a",
        name: "A",
        providerType: "decisions" as const,
        vendor: "openrouter" as const,
        model: "model-a",
        baseUrl: null,
        auth: { mode: "api-key" as const, credentialRef: "vault:provider-a" },
        enabled: true,
        configurationRevision: 1,
        probe: {} as never,
      },
    ],
    port: {
      decide: async (request: { readonly subjectRef: string }) => {
        asked += 1;
        return {
          disposition: "advisory" as const,
          authoritative: false as const,
          subjectRef: request.subjectRef,
          questionSetVersion: "review-finding-triage/v1",
          provider: {
            providerId: "provider-a",
            vendor: "openrouter" as const,
            requestedModel: "model-a",
            resolvedModel: "model-a",
            modelVersion: null,
            providerRoute: null,
          },
          usage: { inputTokens: 1, outputTokens: 1, reportedCost: null },
          latencyMs: 1,
          questionType: "choice" as const,
          distribution: {
            blocker: 0.01,
            non_blocking: probability,
            nit: 0.01,
            pre_existing: 0.01,
            false_positive: 0.01,
          },
          result: { type: "choice" as const, selected },
        };
      },
    },
  };
}

test("the host hook writes the triage journal for an applied review's categorized findings", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-triage-after-write-"));
  try {
    const { execution, review } = cut([
      { findingId: "F1", blocking: false, text: "Names a stale comment.", category: "correctness" },
    ]);
    const provider = providers();
    await settleReviewedCutAfterWrite({
      rootDir,
      readSnapshot: async () => ({ executions: [execution], reviews: [review] }),
      // The receipt the cell returns for an applied RecordReview names the task and the execution.
      receipt: { outcome: "applied", taskId: "task_1", executionId: "exec-1", reviewId: "review-1" },
      decisionProviders: provider,
      now: () => "2026-10-26T00:02:00.000Z",
    });
    const records = readReviewTriageRecords(rootDir);
    assert.equal(records.length, 1, "the hook is the writer the journal never had");
    assert.equal(records[0]?.findingId, "F1");
    assert.equal(records[0]?.target.id, "task_1");
    assert.equal(provider.asked(), 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a review that filed no category is left to the legacy path and never pays a provider", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-triage-after-write-"));
  try {
    const { execution, review } = cut([{ findingId: "F1", blocking: false, text: "Wording." }]);
    const provider = providers();
    await settleReviewedCutAfterWrite({
      rootDir,
      readSnapshot: async () => ({ executions: [execution], reviews: [review] }),
      receipt: { outcome: "applied", taskId: "task_1", executionId: "exec-1", reviewId: "review-1" },
      decisionProviders: provider,
      now: () => "2026-10-26T00:02:00.000Z",
    });
    assert.equal(readReviewTriageRecords(rootDir).length, 0);
    assert.equal(provider.asked(), 0, "no category, no question, no cost");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a receipt without an execution identity does nothing rather than settle the wrong cut", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-triage-after-write-"));
  try {
    let reads = 0;
    const provider = providers();
    await settleReviewedCutAfterWrite({
      rootDir,
      readSnapshot: async () => {
        reads += 1;
        return {};
      },
      receipt: { outcome: "applied", taskId: "task_1" },
      decisionProviders: provider,
      now: () => "2026-10-26T00:02:00.000Z",
    });
    assert.equal(reads, 0, "no execution means no cut to settle");
    assert.equal(readReviewTriageRecords(rootDir).length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
