// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  approvedReviewsForExecution,
  consentedApprovedReviewForExecution,
  submissionDigest,
  submissionId,
} from "../../kernel/src/index.ts";
import { lifecycleHarness } from "./task-lifecycle-test-harness.ts";

test("G29 submit publishes only its frozen targets while preserving unrelated bytes", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    mkdirSync(path.join(harness.rootDir, "harness"), { recursive: true });
    const sentinel = path.join(harness.rootDir, "harness/unrelated.bin");
    writeFileSync(sentinel, Buffer.from([0, 1, 2, 255]));
    const before = readFileSync(sentinel);

    harness.kill("after_event_write");
    await assert.rejects(harness.submit("execution-1"), /killpoint:after_event_write/u);
    assert.equal(harness.eventStore.recover().status, "committed");
    harness.projection.catchUp();

    const read = await harness.service.read("task-1");
    assert.equal(read.snapshot.executions[0]?.state, "submitted");
    assert.equal(read.snapshot.task?.status, "in_review");
    assert.equal(read.snapshot.task?.currentNode, "review");
    assert.deepEqual(
      read.snapshot.edgesTaken.map((edge) => edge.on),
      ["submitted"],
    );
    assert.equal(read.snapshot.lease, null);
    assert.deepEqual(readFileSync(sentinel), before);
  } finally {
    await harness.cleanup();
  }
});

test("a submission amendment supersedes the bad packet and makes code-doc reconciliation valid", async () => {
  const harness = lifecycleHarness(),
    badCommitSha = "b".repeat(40);
  try {
    await harness.create();
    await harness.start("execution-1");
    await harness.submit("execution-1", "op-submit-bad", "wrong cut", badCommitSha);

    await assert.rejects(harness.reconcile("execution-1", "a".repeat(40)), /submitted commit/u);
    const amended = await harness.amend("execution-1", "op-submit-amend", "corrected cut");
    assert.equal(amended.outcome, "applied");
    assert.equal(amended.snapshot.executions[0]?.submission?.commitSha, "a".repeat(40));

    const submissions = harness.eventStore.read().events.filter((event) => event.type === "execution_submitted");
    assert.equal(submissions.length, 2);
    assert.equal(submissions[0]?.payload.execution.submission?.commitSha, badCommitSha);
    if (submissions[0]?.type !== "execution_submitted" || !submissions[0].payload.execution.submission)
      throw new Error("initial submission event missing");
    assert.equal(
      submissions[1]?.payload.supersedesSubmissionId,
      submissionId(submissions[0].payload.execution.submission),
    );

    const reconciled = await harness.reconcile("execution-1", "a".repeat(40), "op-code-doc-after-amend");
    assert.equal(reconciled.outcome, "applied");
    assert.equal(reconciled.snapshot.codeDocWitnesses[0]?.commitSha, "a".repeat(40));
  } finally {
    await harness.cleanup();
  }
});

test("an amendment makes prior Review and consent pins stale until explicit consent is renewed", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    await harness.submit("execution-1", "op-submit-original", "original claim");
    await harness.review("execution-1", "acceptance", "approved", "op-review-original");
    await harness.consent("execution-1", "op-consent-original");

    const amended = await harness.amend("execution-1", "op-submit-amend", "corrected claim");
    const execution = amended.snapshot.executions[0];
    if (execution?.schema !== "execution/v1") throw new Error("native execution missing");
    assert.deepEqual(approvedReviewsForExecution(amended.snapshot.reviews, execution), []);
    assert.equal(
      consentedApprovedReviewForExecution(amended.snapshot.reviews, amended.snapshot.consents, {
        ...execution,
        submittedAt: amended.snapshot.consents[0]!.consentedAt,
      }),
      undefined,
      "the old consent stays stale even when the amendment shares its millisecond",
    );
    await assert.rejects(harness.complete("execution-1", "op-complete-stale"), /approved Review/u);

    await harness.consent("execution-1", "op-consent-amended", "review-op-review-original");
    const consented = (await harness.service.read("task-1")).snapshot.consents.at(-1);
    assert.equal(consented?.submissionDigest, submissionDigest(execution.submission!));
    const completed = await harness.complete("execution-1", "op-complete-amended");
    assert.equal(completed.outcome, "applied");
    assert.equal(completed.snapshot.task?.status, "done");

    await assert.rejects(harness.amend("execution-1", "op-amend-completed"), /current submitted execution/u);
    await assert.rejects(harness.amend("execution-other", "op-amend-other"), /current submitted execution/u);
  } finally {
    await harness.cleanup();
  }
});
