// harness-test-tier: fast
/**
 * The checkpoint the mission asks for: a review that lands with categorized findings produces the
 * triage records, and the closeout judgment that read nothing before now reads them and unlocks.
 *
 * dec_6A77D43B8523823ABA1F5E4D3C CH3/CH5. This drives the *production* producer against a stub
 * Decisions provider, so a break in the wiring (host hook, target digest, journal write, judge read)
 * fails here instead of surfacing as a cut that can never settle.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { submissionDigest, type CloseoutSnapshot, type ExecutionV1, type ReviewV1 } from "@harness-anything/kernel";
import { repoCellTaskQueryJudgmentsFor } from "../src/repo-cell.ts";
import { readReviewTriageRecords } from "../src/review-finding-triage.ts";
import { makeReviewTriageProducer, reviewFindingThresholdsFromSettings } from "../src/review-triage-producer.ts";

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

/** A Decisions provider that always answers `non_blocking` with high confidence. */
function providers(selected = "non_blocking", probability = 0.95) {
  return {
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
      decide: async (request: { readonly subjectRef: string }) => ({
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
      }),
    },
  };
}

const snapshotFor = (review: ReviewV1): CloseoutSnapshot =>
  ({
    task: { status: "in_review", iteration: 0, completionGateIds: [], taskId: "task_1", taskClass: "standard" },
    executions: [cut([]).execution],
    reviews: [review],
    consents: [],
    gateWitnesses: [],
  }) as unknown as CloseoutSnapshot;

const availability = { consents: "known", gateWitnesses: "known" } as const;

function projection(snapshot: CloseoutSnapshot): never {
  return {
    read: () => ({ snapshot, packagePath: "harness/tasks/task_1", status: "ready", watermark: 2, sourceRevision: 2 }),
    readDocument: () => ({ watermark: 2, sourceRevision: 2, document: null }),
    readRelationQuery: () => ({ rows: [], status: "ready" }),
    readPresetSnapshot: () => ({ snapshot: null, status: "ready" }),
    readTaskChildCounts: () => ({}),
    getEntity: () => null,
  } as never;
}

test("a review with a categorized finding settles once the producer writes its triage", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-triage-produce-"));
  try {
    const { execution, review } = cut([
      { findingId: "F1", blocking: true, text: "Drops the fence.", category: "correctness" },
    ]);
    const before = repoCellTaskQueryJudgmentsFor(projection(snapshotFor(review)), rootDir).closeout(
      snapshotFor(review),
      availability,
    );
    assert.equal(before.blocker, "review", "no triage record yet: the cut is unresolved review");

    const settlement = await makeReviewTriageProducer({
      rootDir,
      providers: providers(),
      now: () => "2026-10-26T00:02:00.000Z",
      rulesVersion: "rules-v1",
    }).settleReviewCut({ taskId: "task_1", execution, reviews: [review] });
    assert.equal(settlement?.outcome, "escalated", "a reviewer blocker without a Critic escalates, never passes");

    const records = readReviewTriageRecords(rootDir);
    assert.equal(records.length, 1, "the producer wrote exactly one record for the finding");
    assert.equal(records[0]?.findingId, "F1");
    assert.equal(records[0]?.target.kind, "task");
    assert.equal(records[0]?.target.id, "task_1");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("an agreed non-blocking triage lets the cut settle, judged through the closeout gate", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-triage-produce-"));
  try {
    const { execution, review } = cut([
      { findingId: "F1", blocking: false, text: "Names a stale comment.", category: "correctness" },
    ]);
    await makeReviewTriageProducer({
      rootDir,
      providers: providers(),
      now: () => "2026-10-26T00:02:00.000Z",
      rulesVersion: "rules-v1",
    }).settleReviewCut({ taskId: "task_1", execution, reviews: [review] });

    const snapshot = snapshotFor(review),
      after = repoCellTaskQueryJudgmentsFor(projection(snapshot), rootDir).closeout(snapshot, availability);
    assert.notEqual(
      after.blocker,
      "review",
      "a high-confidence non-blocking triage on a finding the reviewer did not claim as blocking unlocks the gate",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a cut whose review filed no category never asks the provider", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-triage-produce-"));
  try {
    const { execution, review } = cut([]);
    let asked = 0;
    const spy = providers();
    spy.port.decide = async () => {
      asked += 1;
      throw new Error("must not be asked");
    };
    const settlement = await makeReviewTriageProducer({
      rootDir,
      providers: spy,
      now: () => "2026-10-26T00:02:00.000Z",
      rulesVersion: "rules-v1",
    }).settleReviewCut({ taskId: "task_1", execution, reviews: [review] });
    assert.equal(settlement, null, "no categorized finding means nothing enters settlement");
    assert.equal(asked, 0, "and the provider is not paid for an answer nobody reads");
    assert.equal(readReviewTriageRecords(rootDir).length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("repository threshold overrides raise the floors and cannot lower them", () => {
  assert.equal(reviewFindingThresholdsFromSettings(null), undefined);
  const raised = reviewFindingThresholdsFromSettings({
    review: { thresholds: { correctness: 95, migration: 99, securityAuth: 100 } },
  });
  assert.equal(raised?.correctness, 0.95);
  assert.equal(raised?.["ci-required"], 0.99);
  assert.equal(raised?.["data-loss"], 1);
  // A repository asking for less certainty than the decision's floor must not weaken it; the
  // settlement clamps upward, so the value handed over is the floor, not the request.
  const lowered = reviewFindingThresholdsFromSettings({
    review: { thresholds: { correctness: 10, migration: 10, securityAuth: 10 } },
  });
  assert.equal(lowered?.correctness, 0.1);
});
