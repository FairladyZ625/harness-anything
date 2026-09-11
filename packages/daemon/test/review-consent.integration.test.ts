// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { makeTaskEventReader, reviewDigest } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const ciBin = mkdtempSync(path.join(tmpdir(), "ha-submit-ci-bin-"));
const originalPath = process.env.PATH;
before(() => {
  writeProviderExecutable(
    path.join(ciBin, "gh"),
    'if (process.argv[2] !== "run" || process.argv[3] !== "list") process.exit(1); console.log("[]");\n',
  );
  process.env.PATH = `${ciBin}${path.delimiter}${originalPath ?? ""}`;
});
after(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(ciBin, { recursive: true, force: true });
});

function writeCloseout(rootDir: string, packagePath: unknown): void {
  writeFileSync(
    path.join(rootDir, "harness", String(packagePath), "closeout.md"),
    `# Closeout\n\n## Summary\n\nDelivery ${git(rootDir, "rev-parse", "fixture-delivery")} is ready.\n\n` +
      "## Verification\n\nIntegration assertions exercise the lifecycle refusals.\n\n" +
      "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nShared lifecycle authorization.\n",
  );
}

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
  writeFileSync(path.join(rootDir, "README.md"), "# Lifecycle fixture delivery\n");
  git(rootDir, "add", "README.md");
  git(rootDir, "commit", "--quiet", "-m", "fixture delivery");
  git(rootDir, "tag", "fixture-delivery");
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("review-consent derives the recorded Review digests without a packet and rejects retired packet inputs", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-consent-derived-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const repoId = workspaceId("consent-derived"),
    taskId = "task-derived",
    executionId = "execution-derived",
    binding = withRoleBinding({ actor, source: "local" as const }, "repo-write");
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
    const store = () => makeTaskEventReader({ repoId, rootDir });
    const created = await cell.run({ kind: "task-create", taskId, title: "Derived consent" }, binding);
    await waitForFixturePublication(cell, created.opId, binding);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    await cell.run({ kind: "task-start", taskId, executionId }, binding);
    writeCloseout(rootDir, (created as Record<string, unknown>).packagePath);
    assert.equal((await cell.run({ kind: "task-submit", taskId, executionId }, binding)).outcome, "applied");
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
        { kind: "task-review-consent", taskId, executionId, reviewId: "review-typo" },
        binding,
      )) as unknown as Record<string, unknown>;
    assert.deepEqual({ outcome: typo.outcome, code: typo.code }, { outcome: "op_rejected", code: "invalid_command" });
    assert.equal(store().readHead()?.revision, beforeTypo);

    const beforeOutsiderConsent = store().readHead()?.revision,
      outsiderConsent = (await cell.run(
        { kind: "task-review-consent", taskId },
        { actor: outsider, source: "local" },
      )) as unknown as Record<string, unknown>;
    assert.deepEqual(
      { outcome: outsiderConsent.outcome, code: outsiderConsent.code },
      { outcome: "op_rejected", code: "actor_unauthorized" },
    );
    assert.equal(store().readHead()?.revision, beforeOutsiderConsent);

    const consented = (await cell.run(
      { kind: "task-review-consent", taskId },
      withRoleBinding({ actor: ownerFromAnotherAgent, source: "local" }, "repo-write"),
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
          predicate: "hasRoleBinding",
          satisfied: true,
          role: "repo-write",
          matched: {
            actor: { kind: "person", id: actor.principal.personId },
            role: "repo-write",
            target: "settings/repository",
            source: "declared",
            expiresAt: null,
          },
        },
      ],
    );

    // Negative control: the retired operator-supplied packet is rejected at the input boundary.
    const mismatchTaskId = "task-mismatch",
      mismatchExecutionId = "execution-mismatch";
    const mismatchCreated = await cell.run(
      { kind: "task-create", taskId: mismatchTaskId, title: "Mismatch consent" },
      binding,
    );
    await waitForFixturePublication(cell, mismatchCreated.opId, binding);
    await realizeTaskPlanFixture(
      rootDir,
      String((mismatchCreated as Record<string, unknown>).packagePath),
      (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    await cell.run({ kind: "task-start", taskId: mismatchTaskId, executionId: mismatchExecutionId }, binding);
    writeCloseout(rootDir, (mismatchCreated as Record<string, unknown>).packagePath);
    assert.equal(
      (await cell.run({ kind: "task-submit", taskId: mismatchTaskId, executionId: mismatchExecutionId }, binding))
        .outcome,
      "applied",
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
    for (const retiredInput of [
      { consentId: "consent-mismatch" },
      { fromFile: "consent.json" },
      { jsonInput: JSON.stringify({ reviewDigest: flipped, contentDigest: mismatchReviewed.contentDigest }) },
      { reviewDigest: flipped },
      { contentDigest: mismatchReviewed.contentDigest },
    ]) {
      const beforeMismatch = store().readHead()?.revision,
        mismatch = (await cell.run(
          {
            kind: "task-review-consent",
            taskId: mismatchTaskId,
            executionId: mismatchExecutionId,
            reviewId: "review-mismatch",
            ...retiredInput,
          },
          binding,
        )) as unknown as Record<string, unknown>;
      assert.deepEqual(
        { outcome: mismatch.outcome, code: mismatch.code },
        { outcome: "op_rejected", code: "invalid_command" },
        JSON.stringify(retiredInput),
      );
      assert.equal(store().readHead()?.revision, beforeMismatch);
    }

    const reviewlessTaskId = "task-reviewless",
      reviewlessExecutionId = "execution-reviewless";
    const reviewlessCreated = await cell.run(
      { kind: "task-create", taskId: reviewlessTaskId, title: "Reviewless consent" },
      binding,
    );
    await waitForFixturePublication(cell, reviewlessCreated.opId, binding);
    await realizeTaskPlanFixture(
      rootDir,
      String((reviewlessCreated as Record<string, unknown>).packagePath),
      (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    await cell.run({ kind: "task-start", taskId: reviewlessTaskId, executionId: reviewlessExecutionId }, binding);
    writeCloseout(rootDir, (reviewlessCreated as Record<string, unknown>).packagePath);
    assert.equal(
      (await cell.run({ kind: "task-submit", taskId: reviewlessTaskId, executionId: reviewlessExecutionId }, binding))
        .outcome,
      "applied",
    );
    const reviewless = (await cell.run(
      { kind: "task-review-consent", taskId: reviewlessTaskId },
      binding,
    )) as unknown as Record<string, unknown>;
    assert.deepEqual(
      { outcome: reviewless.outcome, code: reviewless.code },
      { outcome: "op_rejected", code: "invalid_command" },
    );

    const ambiguousTaskId = "task-ambiguous",
      ambiguousExecutionId = "execution-ambiguous";
    const ambiguousCreated = await cell.run(
      { kind: "task-create", taskId: ambiguousTaskId, title: "Ambiguous consent" },
      binding,
    );
    await waitForFixturePublication(cell, ambiguousCreated.opId, binding);
    await realizeTaskPlanFixture(
      rootDir,
      String((ambiguousCreated as Record<string, unknown>).packagePath),
      (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    await cell.run({ kind: "task-start", taskId: ambiguousTaskId, executionId: ambiguousExecutionId }, binding);
    writeCloseout(rootDir, (ambiguousCreated as Record<string, unknown>).packagePath);
    assert.equal(
      (await cell.run({ kind: "task-submit", taskId: ambiguousTaskId, executionId: ambiguousExecutionId }, binding))
        .outcome,
      "applied",
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
      { kind: "task-review-consent", taskId: ambiguousTaskId },
      binding,
    )) as unknown as Record<string, unknown>;
    assert.deepEqual(
      { outcome: ambiguous.outcome, code: ambiguous.code },
      { outcome: "op_rejected", code: "invalid_command" },
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
