// harness-test-tier: fast
/**
 * dec_6A77D43B8523823ABA1F5E4D3C CH5: the closeout judgment reads the center's triage journal.
 *
 * These tests pin the seam between the journal and the judgment, which is where the whole feature
 * lives or dies: a categorized finding must stay unresolved until a record for *its own cut digest*
 * exists, and a record written for another digest must not settle it.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { type CloseoutSnapshot, submissionDigest } from "@harness-anything/kernel";
import { repoCellTaskQueryJudgmentsFor } from "../src/repo-cell.ts";
import { reviewTriageStorePath } from "../src/review-finding-triage.ts";

const digest = `sha256:${"d".repeat(64)}` as const,
  commit = "e".repeat(40);

function cut(findings: readonly Record<string, unknown>[]) {
  const submission = {
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
    execution = {
      schema: "execution/v1",
      executionId: "exec-1",
      taskId: "task_1",
      iteration: 1,
      state: "submitted",
      actor: { principal: { personId: "person_a" }, executor: null },
      deliveryBaseline: { kind: "commit", commitSha: "a".repeat(40) },
      submission,
      submittedAt: "2026-10-26T00:00:00.000Z",
      gateRuns: [],
      reviews: [],
    },
    review = {
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
      iteration: 1,
      contentDigest: digest,
      submissionDigest: submissionDigest(submission as never),
      reviewedAt: "2026-10-26T00:01:00.000Z",
      findings,
      resolutions: [],
    };
  return {
    snapshot: {
      task: { status: "in_review", iteration: 1, completionGateIds: [], taskId: "task_1", taskClass: "standard" },
      executions: [execution],
      reviews: [review],
      consents: [],
      gateWitnesses: [],
    } as unknown as CloseoutSnapshot,
    submissionDigest: review.submissionDigest,
  };
}

const availability = { consents: "known", gateWitnesses: "known" } as const;

/**
 * The judgment also reads repository settings and the delivery status, so the stub answers those
 * the way an unconfigured repository does. Only the triage journal varies between these tests.
 */
function projection(snapshot: CloseoutSnapshot): never {
  return {
    read: () => ({
      snapshot,
      packagePath: "harness/tasks/task_1",
      status: "ready",
      watermark: 2,
      sourceRevision: 2,
    }),
    readDocument: (target: string) => ({
      watermark: 2,
      sourceRevision: 2,
      document: {
        path: target,
        blobSha256: "0".repeat(64),
        workspaceRevision: 2,
        body: target.endsWith("task-contract.json")
          ? JSON.stringify({
              documents: [
                {
                  slot: "task.closeout",
                  path: "closeout.md",
                  templateRef: "template://planning/closeout@1",
                  locale: "en-US",
                },
              ],
            })
          : "## Summary\nDelivered.\n## Verification\nVerified.\n## Residual Risk\nNone.\n" +
            "## Same Mechanism Elsewhere\nChecked.\n",
      },
    }),
    readRelationQuery: () => ({ rows: [], status: "ready" }),
    readPresetSnapshot: () => ({ snapshot: null, status: "ready" }),
    readTaskChildCounts: () => ({}),
    getEntity: () => null,
  } as never;
}

function journal(rootDir: string, records: readonly Record<string, unknown>[]): void {
  const file = reviewTriageStorePath(rootDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ schema: "review-finding-triage-store/v1", records }), "utf8");
}

/**
 * One triage record for review-1/F1. `mintedFor` is the digest the record claims to answer, and the
 * reviewer's blocker claim buys a Critic that agrees — so the record is *capable* of unlocking a cut.
 * Both cases below use this same record, differing only in `mintedFor`; that is what makes the
 * foreign-digest case a real negative instead of one that escalates for an unrelated reason.
 */
function recordMintedFor(mintedFor: string): Record<string, unknown> {
  return {
    schema: "review-finding-triage/v1",
    reviewId: "review-1",
    findingId: "F1",
    targetDigest: mintedFor,
    selected: "non_blocking",
    probabilities: { blocker: 0.02, non_blocking: 0.9, nit: 0.03, pre_existing: 0.03, false_positive: 0.02 },
    model: "reviewer-model",
    bindingDigest: mintedFor,
    decidedAt: "2026-10-26T00:02:00.000Z",
    critic: {
      selected: "non_blocking",
      probabilities: { blocker: 0.02, non_blocking: 0.92, nit: 0.02, pre_existing: 0.02, false_positive: 0.02 },
      model: "critic-model",
      bindingDigest: mintedFor,
      decidedAt: "2026-10-26T00:03:00.000Z",
    },
    target: { kind: "task", id: "task_1", digest: mintedFor },
    thresholds: {},
    rulesVersion: "rules-v1",
    inputDigest: mintedFor,
  };
}

test("triage remains cut-bound settlement data without controlling review consent", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-triage-seam-"));
  try {
    const { snapshot, submissionDigest: cutDigest } = cut([
      { findingId: "F1", blocking: true, text: "Drops the fence.", category: "correctness" },
    ]);
    const before = repoCellTaskQueryJudgmentsFor(projection(snapshot), root).closeout(snapshot, availability);
    assert.equal(before.blocker, undefined, "untriaged finding does not block consent");

    journal(root, [recordMintedFor(cutDigest)]);

    const after = repoCellTaskQueryJudgmentsFor(projection(snapshot), root).closeout(snapshot, availability);
    assert.equal(after.blocker, undefined, "triage answer does not change the consent judgment");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record minted for another cut digest does not settle this one", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-triage-seam-"));
  try {
    const { snapshot } = cut([{ findingId: "F1", blocking: true, text: "Drops the fence.", category: "correctness" }]),
      otherDigest = `sha256:${"f".repeat(64)}`;
    // Same ids, same disposition, same agreeing Critic — only the digest differs. An id-only match
    // would unlock the gate here, which is exactly the B-3 defect this case pins.
    journal(root, [recordMintedFor(otherDigest)]);

    const judgment = repoCellTaskQueryJudgmentsFor(projection(snapshot), root).closeout(snapshot, availability);
    assert.equal(judgment.blocker, undefined, "an old cut's answer cannot affect the consent judgment");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cut with no categorized finding is judged without the journal", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-triage-seam-"));
  try {
    const { snapshot } = cut([]);
    assert.notEqual(
      repoCellTaskQueryJudgmentsFor(projection(snapshot), root).closeout(snapshot, availability).blocker,
      "review",
      "the legacy per-review path still completes a cut whose reviewer emitted no category",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
