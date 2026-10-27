// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const RESPONSE_VALIDATOR = "task-lifecycle-review-transitions/respondReview.validate",
  RESPONSE_PROOF = "repo-cell-proof/proofFor.RespondReview";

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Respond Review Test");
  git(rootDir, "config", "user.email", "respond-review@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
  writeFileSync(path.join(rootDir, "README.md"), "# Lifecycle fixture delivery\n");
  git(rootDir, "add", "README.md");
  git(rootDir, "commit", "--quiet", "-m", "fixture delivery");
  git(rootDir, "tag", "fixture-delivery");
}

function writeCloseout(rootDir: string, taskId: string, packagePath: unknown, round: string): void {
  const body =
      `# Closeout\n\n## Summary\n\nRound ${round} delivers ${git(rootDir, "rev-parse", "fixture-delivery")}.\n\n` +
      "## Verification\n\nIntegration assertions exercise the rework response round.\n\n" +
      "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nShared lifecycle response guard.\n",
    packageRoot = String(packagePath),
    worktree = path.join(rootDir, ".worktrees", taskId),
    roots = [rootDir, ...(existsSync(path.join(worktree, "harness", packageRoot)) ? [worktree] : [])];
  for (const root of roots) {
    const closeout = path.join(root, "harness", packageRoot, "closeout.md");
    mkdirSync(path.dirname(closeout), { recursive: true });
    writeFileSync(closeout, body);
  }
}

function writeReviewReport(rootDir: string, packagePath: unknown, reviewId: string, body?: string): void {
  const stem = reviewId.startsWith("review-") ? reviewId.slice("review-".length) : reviewId,
    report = path.join(rootDir, "harness", String(packagePath), "artifacts", "reports", `${stem}.md`);
  mkdirSync(path.dirname(report), { recursive: true });
  writeFileSync(report, body ?? `# Review ${reviewId}\n\nIndependent review findings recorded.\n`);
}

function binding(executorId: string, personId = "person-respond-owner") {
  return withPolicyGroup(
    {
      actor: { principal: { personId }, executor: { kind: "agent" as const, id: executorId } },
      source: "local" as const,
    },
    "admin",
  );
}

function respondAction(taskId: string, executionId: string, responses: readonly Record<string, unknown>[]) {
  return {
    kind: "task-respond-review",
    taskId,
    executionId,
    jsonInput: JSON.stringify({ responses }),
  } as const;
}

const findingResponse = (reviewId: string, findingId: string, disposition: "adopt" | "rebut" = "adopt") => ({
  reviewId,
  findingId,
  disposition,
  rationale: "The second cut addresses the blocking review finding.",
});

test("a returned cut registers its response and re-freezes the delivery for the next review", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-respond-rework-")),
    repoId = workspaceId("respond-rework"),
    taskId = "task-respond-rework",
    firstExecutionId = "exec-respond-r1",
    secondExecutionId = "exec-respond-r2",
    reviewId = "review-respond-r1",
    owner = binding("respond-worker"),
    reviewer = binding("respond-reviewer", "person-respond-reviewer");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "respond-rework" });
    const store = () => makeTaskEventReader({ repoId, rootDir }),
      created = await cell.run({ kind: "task-create", taskId, title: "Respond rework" }, owner);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, owner);
    const packagePath = String((created as Record<string, unknown>).packagePath);
    await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );

    // Round 0: the cut that gets returned.
    assert.equal(
      (await cell.run({ kind: "task-start", taskId, executionId: firstExecutionId }, owner)).outcome,
      "applied",
    );
    writeCloseout(rootDir, taskId, packagePath, "one");
    assert.equal(
      (await cell.run({ kind: "task-submit", taskId, executionId: firstExecutionId }, owner)).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "review-changes.json"),
      JSON.stringify({
        verdict: "changes_requested",
        reason: "The verification claim needs a second pass.",
        evidenceChecked: ["closeout"],
        findings: [{ findingId: "F1", blocking: true, text: "The closeout does not show the verification run." }],
        resolutions: [],
      }),
    );
    writeReviewReport(rootDir, packagePath, reviewId);
    const returned = await cell.run(
      {
        kind: "task-review-execution",
        taskId,
        executionId: firstExecutionId,
        reviewId,
        fromFile: "review-changes.json",
      },
      reviewer,
    );
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));
    const returnedEvent = store().readEvent(String(returned.opId));
    if (returnedEvent?.type !== "review_recorded") throw new Error("returned review event missing");
    assert.equal(returnedEvent.payload.task.iteration, 1);

    // Round 1: rework, then answer the blocking finding.
    assert.equal(
      (await cell.run({ kind: "task-start", taskId, executionId: secondExecutionId }, owner)).outcome,
      "applied",
    );
    // A response that names a finding the review never recorded is the one rejection the worker can
    // still reach here. The receipt must carry that sentence: the invocation criterion is a place to
    // attribute a failure, never a replacement for the failure's reason.
    const unknownFinding = await cell.run(
      respondAction(taskId, secondExecutionId, [{ ...findingResponse(reviewId, "F2"), disposition: "adopt" as const }]),
      owner,
    );
    assert.equal(unknownFinding.outcome, "op_rejected", JSON.stringify(unknownFinding));
    assert.equal(unknownFinding.code, "invalid_transition", JSON.stringify(unknownFinding));
    assert.match(
      String(unknownFinding.rejectionExplanation),
      new RegExp(`blocking finding ${reviewId}/F2 does not exist`, "u"),
    );
    assert.deepEqual(
      unknownFinding.unmetCriteria?.map(({ ref }) => ref),
      [RESPONSE_VALIDATOR],
      JSON.stringify(unknownFinding),
    );

    const responded = await cell.run(
      respondAction(taskId, secondExecutionId, [findingResponse(reviewId, "F1")]),
      owner,
    );
    assert.equal(responded.outcome, "applied", JSON.stringify(responded));
    const respondedEvent = store().readEvent(String(responded.opId));
    if (respondedEvent?.type !== "task_review_responded") throw new Error("response event missing");
    assert.deepEqual(
      respondedEvent.payload.responses.map(({ reviewId: review, findingId, disposition }) => ({
        review,
        findingId,
        disposition,
      })),
      [{ review: reviewId, findingId: "F1", disposition: "adopt" }],
    );

    // The resubmission freezes the response into the new cut, so the re-review can verify it.
    writeCloseout(rootDir, taskId, packagePath, "two");
    const resubmitted = await cell.run({ kind: "task-submit", taskId, executionId: secondExecutionId }, owner);
    assert.equal(resubmitted.outcome, "applied", JSON.stringify(resubmitted));
    const submittedEvent = store().readEvent(String(resubmitted.opId));
    if (submittedEvent?.type !== "execution_submitted") throw new Error("resubmission event missing");
    assert.deepEqual(
      submittedEvent.payload.execution.submission?.reviewResponses?.map(({ reviewId: review, findingId }) => ({
        review,
        findingId,
      })),
      [{ review: reviewId, findingId: "F1" }],
    );

    writeFileSync(
      path.join(rootDir, "review-approved.json"),
      JSON.stringify({
        verdict: "approved",
        reason: "The second cut answers the blocking finding.",
        evidenceChecked: ["closeout", "review response"],
        findings: [],
        resolutions: [],
      }),
    );
    writeReviewReport(rootDir, packagePath, "review-respond-r2");
    const reReviewed = await cell.run(
      {
        kind: "task-review-execution",
        taskId,
        executionId: secondExecutionId,
        reviewId: "review-respond-r2",
        fromFile: "review-approved.json",
      },
      reviewer,
    );
    assert.equal(reReviewed.outcome, "applied", JSON.stringify(reReviewed));
    const reReviewEvent = store().readEvent(String(reReviewed.opId));
    if (reReviewEvent?.type !== "review_recorded") throw new Error("re-review event missing");
    assert.deepEqual(
      {
        execution: reReviewEvent.payload.review.executionId,
        iteration: reReviewEvent.payload.review.iteration,
        verdict: reReviewEvent.payload.review.verdict,
      },
      { execution: secondExecutionId, iteration: 1, verdict: "approved" },
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a response rejected for its actor proof names that proof criterion instead of an invalid store", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-respond-proof-")),
    repoId = workspaceId("respond-proof"),
    taskId = "task-respond-proof",
    executionId = "exec-respond-proof",
    reviewId = "review-respond-proof";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "respond-proof" });
    const owner = binding("respond-proof-worker"),
      reviewer = binding("respond-proof-reviewer", "person-respond-proof-reviewer"),
      created = await cell.run({ kind: "task-create", taskId, title: "Respond proof" }, owner);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, owner);
    const packagePath = String((created as Record<string, unknown>).packagePath);
    await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, owner)).outcome, "applied");
    writeCloseout(rootDir, taskId, packagePath, "one");
    assert.equal((await cell.run({ kind: "task-submit", taskId, executionId }, owner)).outcome, "applied");
    writeFileSync(
      path.join(rootDir, "review-changes.json"),
      JSON.stringify({
        verdict: "changes_requested",
        reason: "Returned for a second round.",
        evidenceChecked: ["closeout"],
        findings: [{ findingId: "F1", blocking: true, text: "Address the verification gap." }],
        resolutions: [],
      }),
    );
    writeReviewReport(rootDir, packagePath, reviewId);
    assert.equal(
      (
        await cell.run(
          { kind: "task-review-execution", taskId, executionId, reviewId, fromFile: "review-changes.json" },
          reviewer,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId, executionId: "exec-respond-proof-r2" }, owner)).outcome,
      "applied",
    );

    // Same task, same review, but no lease for this executor: the proof criterion is what failed, so
    // that is what the receipt has to name.
    const unauthorized = await cell.run(
      respondAction(taskId, "exec-respond-proof-r2", [findingResponse(reviewId, "F1")]),
      binding("respond-proof-outsider", "person-respond-proof-outsider"),
    );
    assert.equal(unauthorized.outcome, "op_rejected", JSON.stringify(unauthorized));
    assert.equal(unauthorized.code, "actor_unauthorized", JSON.stringify(unauthorized));
    assert.deepEqual(
      unauthorized.unmetCriteria?.map(({ ref }) => ref),
      [RESPONSE_PROOF],
      JSON.stringify(unauthorized),
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
