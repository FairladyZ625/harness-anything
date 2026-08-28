// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, reviewDigest } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } } as const;
const ownerFromAnotherAgent = {
    principal: actor.principal,
    executor: { kind: "agent", id: "other-owner-agent" },
  } as const,
  outsider = {
    principal: { personId: "person-outsider" },
    executor: { kind: "agent", id: "outsider-agent" },
  } as const;

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "RepoCell Test");
  git(rootDir, "config", "user.email", "repo-cell@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "config", "maintenance.auto", "false");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("review-consent derives the recorded Review digests without a packet and still rejects mismatched ones", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-consent-derived-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const repoId = workspaceId("consent-derived"),
    taskId = "task-derived",
    executionId = "execution-derived",
    binding = { actor, source: "local" as const };
  const reviewBinding = withRoleBinding(
    {
      actor: {
        principal: { personId: "person-reviewer" },
        executor: { kind: "agent" as const, id: "arbiter" },
      },
      source: "local" as const,
    },
    "arbiter",
  );
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "consent-derived" });
    const store = () => makeTaskEventStore({ repoId, rootDir });
    const created = await cell.run({ kind: "task-create", taskId, title: "Derived consent" }, binding);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    await cell.run({ kind: "task-start", taskId, executionId }, binding);
    const commitSha = git(rootDir, "rev-parse", "HEAD");
    writeFileSync(
      path.join(rootDir, "submission.json"),
      JSON.stringify({
        completionClaim: "Derived consent output is ready.",
        deliverables: ["derived consent"],
        outputs: ["machine files"],
        verificationNotes: ["tests"],
        knownGaps: [],
        residualRisks: [],
        commitSha,
      }),
    );
    await cell.run({ kind: "task-submit", taskId, executionId, fromFile: "submission.json" }, binding);
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Independent review passed.", evidenceChecked: ["tests"] }),
    );
    const reviewed = (await cell.run(
      { kind: "task-review-execution", taskId, executionId, reviewId: "review-derived", fromFile: "review.json" },
      reviewBinding,
    )) as unknown as Record<string, unknown>;
    const reviewEvent = store().readEvent(String(reviewed.opId));
    if (reviewEvent?.type !== "review_recorded") throw new Error("review event missing");

    const beforeTypo = store().readHead()?.revision,
      typo = (await cell.run(
        { kind: "task-review-consent", taskId, executionId, reviewId: "review-typo", consentId: "consent-typo" },
        binding,
      )) as unknown as Record<string, unknown>;
    assert.deepEqual({ outcome: typo.outcome, code: typo.code }, { outcome: "op_rejected", code: "invalid_command" });
    assert.match(String(typo.nextAction), /choose one of review-derived/u);
    assert.equal(store().readHead()?.revision, beforeTypo);

    const beforeOutsiderConsent = store().readHead()?.revision,
      outsiderConsent = (await cell.run(
        { kind: "task-review-consent", taskId, consentId: "consent-outsider" },
        { actor: outsider, source: "local" },
      )) as unknown as Record<string, unknown>;
    assert.deepEqual(
      { outcome: outsiderConsent.outcome, code: outsiderConsent.code },
      { outcome: "op_rejected", code: "actor_unauthorized" },
    );
    assert.equal(store().readHead()?.revision, beforeOutsiderConsent);

    const consented = (await cell.run(
      { kind: "task-review-consent", taskId, consentId: "consent-derived" },
      { actor: ownerFromAnotherAgent, source: "local" },
    )) as unknown as Record<string, unknown>;
    assert.equal(consented.outcome, "applied", JSON.stringify(consented));
    const consentEvent = store().readEvent(String(consented.opId));
    if (consentEvent?.type !== "review_consent_recorded") throw new Error("consent event missing");
    assert.equal(consentEvent.payload.consent.reviewDigest, reviewDigest(reviewEvent.payload.review));
    assert.equal(consentEvent.payload.consent.contentDigest, reviewEvent.payload.review.contentDigest);
    assert.deepEqual(
      { reviewDigest: consented.reviewDigest, contentDigest: consented.contentDigest },
      {
        reviewDigest: reviewDigest(reviewEvent.payload.review),
        contentDigest: reviewEvent.payload.review.contentDigest,
      },
    );
    assert.deepEqual(
      (
        consented.authorizationDecision as {
          readonly bindingsUsed: readonly Readonly<Record<string, unknown>>[];
        }
      ).bindingsUsed,
      [
        {
          predicate: "hasCommandClass",
          satisfied: true,
          role: "owner",
          matched: {
            actor: { kind: "person", id: actor.principal.personId },
            role: "owner",
            target: `execution/${executionId}`,
            source: "derived",
            expiresAt: null,
          },
        },
      ],
    );

    // Negative control: an operator-supplied packet with a well-formed but wrong digest must still be rejected.
    const mismatchTaskId = "task-mismatch",
      mismatchExecutionId = "execution-mismatch";
    const mismatchCreated = await cell.run(
      { kind: "task-create", taskId: mismatchTaskId, title: "Mismatch consent" },
      binding,
    );
    await realizeTaskPlanFixture(
      rootDir,
      String((mismatchCreated as Record<string, unknown>).packagePath),
      (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    await cell.run({ kind: "task-start", taskId: mismatchTaskId, executionId: mismatchExecutionId }, binding);
    writeFileSync(
      path.join(rootDir, "submission.json"),
      JSON.stringify({
        completionClaim: "Mismatch consent output is ready.",
        deliverables: ["mismatch consent"],
        outputs: ["machine files"],
        verificationNotes: ["tests"],
        knownGaps: [],
        residualRisks: [],
        commitSha,
      }),
    );
    await cell.run(
      { kind: "task-submit", taskId: mismatchTaskId, executionId: mismatchExecutionId, fromFile: "submission.json" },
      binding,
    );
    const mismatchReviewed = (await cell.run(
      {
        kind: "task-review-execution",
        taskId: mismatchTaskId,
        executionId: mismatchExecutionId,
        reviewId: "review-mismatch",
        fromFile: "review.json",
      },
      reviewBinding,
    )) as unknown as Record<string, unknown>;
    const real = String(mismatchReviewed.reviewDigest),
      flipped = `sha256:${real[7] === "0" ? "1" : "0"}${real.slice(8)}`;
    writeFileSync(
      path.join(rootDir, "consent.json"),
      JSON.stringify({ reviewDigest: flipped, contentDigest: mismatchReviewed.contentDigest }),
    );
    const beforeMismatch = store().readHead()?.revision,
      mismatch = (await cell.run(
        {
          kind: "task-review-consent",
          taskId: mismatchTaskId,
          executionId: mismatchExecutionId,
          reviewId: "review-mismatch",
          consentId: "consent-mismatch",
          fromFile: "consent.json",
        },
        binding,
      )) as unknown as Record<string, unknown>;
    assert.deepEqual(
      { outcome: mismatch.outcome, code: mismatch.code },
      { outcome: "op_rejected", code: "invalid_proof" },
    );
    assert.match(String(mismatch.nextAction), /bind the Review and reviewed content digests/u);
    assert.equal(store().readHead()?.revision, beforeMismatch);

    const reviewlessTaskId = "task-reviewless",
      reviewlessExecutionId = "execution-reviewless";
    const reviewlessCreated = await cell.run(
      { kind: "task-create", taskId: reviewlessTaskId, title: "Reviewless consent" },
      binding,
    );
    await realizeTaskPlanFixture(
      rootDir,
      String((reviewlessCreated as Record<string, unknown>).packagePath),
      (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    await cell.run({ kind: "task-start", taskId: reviewlessTaskId, executionId: reviewlessExecutionId }, binding);
    await cell.run(
      {
        kind: "task-submit",
        taskId: reviewlessTaskId,
        executionId: reviewlessExecutionId,
        fromFile: "submission.json",
      },
      binding,
    );
    const reviewless = (await cell.run(
      { kind: "task-review-consent", taskId: reviewlessTaskId, consentId: "consent-none" },
      binding,
    )) as unknown as Record<string, unknown>;
    assert.deepEqual(
      { outcome: reviewless.outcome, code: reviewless.code },
      { outcome: "op_rejected", code: "invalid_command" },
    );
    assert.match(String(reviewless.nextAction), /Approved Review candidates: none/u);
    assert.match(String(reviewless.nextAction), new RegExp(`ha task review-execution ${reviewlessTaskId}`, "u"));

    const ambiguousTaskId = "task-ambiguous",
      ambiguousExecutionId = "execution-ambiguous";
    const ambiguousCreated = await cell.run(
      { kind: "task-create", taskId: ambiguousTaskId, title: "Ambiguous consent" },
      binding,
    );
    await realizeTaskPlanFixture(
      rootDir,
      String((ambiguousCreated as Record<string, unknown>).packagePath),
      (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    await cell.run({ kind: "task-start", taskId: ambiguousTaskId, executionId: ambiguousExecutionId }, binding);
    await cell.run(
      { kind: "task-submit", taskId: ambiguousTaskId, executionId: ambiguousExecutionId, fromFile: "submission.json" },
      binding,
    );
    for (const reviewId of ["review-a", "review-b"])
      assert.equal(
        (
          await cell.run(
            {
              kind: "task-review-execution",
              taskId: ambiguousTaskId,
              executionId: ambiguousExecutionId,
              reviewId,
              fromFile: "review.json",
            },
            reviewBinding,
          )
        ).outcome,
        "applied",
      );
    const ambiguous = (await cell.run(
      { kind: "task-review-consent", taskId: ambiguousTaskId, consentId: "consent-ambiguous" },
      binding,
    )) as unknown as Record<string, unknown>;
    assert.deepEqual(
      { outcome: ambiguous.outcome, code: ambiguous.code },
      { outcome: "op_rejected", code: "invalid_command" },
    );
    assert.match(String(ambiguous.nextAction), /execution-ambiguous\/review-a/u);
    assert.match(String(ambiguous.nextAction), /execution-ambiguous\/review-b/u);
    assert.match(
      String(ambiguous.nextAction),
      /ha task review-consent task-ambiguous --execution-id execution-ambiguous --review-id review-a --consent-id consent-ambiguous/u,
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
