// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { makeTaskEventReader, reviewDigest } from "@harness-anything/kernel";
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

function writeReviewReport(rootDir: string, packagePath: unknown, reviewId: string, body?: string): string {
  const stem = reviewId.startsWith("review-") ? reviewId.slice("review-".length) : reviewId,
    report = path.join(rootDir, "harness", String(packagePath), "artifacts", "reports", `${stem}.md`);
  mkdirSync(path.dirname(report), { recursive: true });
  writeFileSync(report, body ?? `# Review ${reviewId}\n\nIndependent review findings recorded.\n`);
  return report;
}

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
    assert.equal(
      (
        await cell.run(
          { kind: "task-adjudicate", taskId, executionId, forward: true, reason: "Owner forwards the cut." },
          binding,
        )
      ).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Independent review passed.", evidenceChecked: ["tests"] }),
    );
    writeReviewReport(rootDir, (created as Record<string, unknown>).packagePath, "review-derived");
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
    writeReviewReport(rootDir, (mismatchCreated as Record<string, unknown>).packagePath, "review-mismatch");
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
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-adjudicate",
            taskId: ambiguousTaskId,
            executionId: ambiguousExecutionId,
            forward: true,
            reason: "Owner forwards the ambiguous-review fixture.",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    for (const reviewId of ["review-a", "review-b"]) {
      writeReviewReport(rootDir, (ambiguousCreated as Record<string, unknown>).packagePath, reviewId);
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
    }
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

function writeSelectionCloseout(rootDir: string, packagePath: unknown): void {
  writeFileSync(
    path.join(rootDir, "harness", String(packagePath), "closeout.md"),
    `# Closeout\n\n## Summary\n\nDelivery ${git(rootDir, "rev-parse", "fixture-delivery")} is ready.\n\n` +
      "## Verification\n\nIntegration assertions exercise the execution selection.\n\n" +
      "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nShared lifecycle authorization.\n",
  );
}

test("review-execution without --execution-id derives the sole current submitted execution across a changes_requested round", async () => {
  const rootDir = workspace("selection-round"),
    taskId = "task-selection-round",
    firstExecutionId = "exec-selection-r1",
    secondExecutionId = "exec-selection-r2",
    owner = binding("selection-owner"),
    reviewer = withRoleBinding(binding("selection-reviewer"), "arbiter");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId: workspaceId("selection-round"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "selection-round",
    });
    const store = () => makeTaskEventReader({ repoId: workspaceId("selection-round"), rootDir }),
      created = await cell.run({ kind: "task-create", taskId, title: "Selection round" }, owner);
    await waitForFixturePublication(cell, created.opId, owner);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
    await cell.run({ kind: "task-start", taskId, executionId: firstExecutionId }, owner);
    writeSelectionCloseout(rootDir, (created as Record<string, unknown>).packagePath);
    assert.equal(
      (await cell.run({ kind: "task-submit", taskId, executionId: firstExecutionId }, owner)).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-adjudicate",
            taskId,
            executionId: firstExecutionId,
            forward: true,
            reason: "Owner forwards round one.",
          },
          owner,
        )
      ).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "review-changes.json"),
      JSON.stringify({
        verdict: "changes_requested",
        reason: "Exercise a second implementation round.",
        evidenceChecked: ["first-round receipt"],
      }),
    );
    writeReviewReport(rootDir, (created as Record<string, unknown>).packagePath, "review-selection-r1");
    const returned = await cell.run(
      {
        kind: "task-review-execution",
        taskId,
        executionId: firstExecutionId,
        reviewId: "review-selection-r1",
        fromFile: "review-changes.json",
      },
      reviewer,
    );
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));
    const returnedEvent = store().readEvent(String(returned.opId));
    if (returnedEvent?.type !== "review_recorded") throw new Error("returned review event missing");
    assert.equal(returnedEvent.payload.execution.state, "submitted");
    assert.equal(returnedEvent.payload.execution.iteration, 0);
    assert.equal(returnedEvent.payload.task.iteration, 0);
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-adjudicate",
            taskId,
            executionId: firstExecutionId,
            return: true,
            reviewId: "review-selection-r1",
            reason: "Owner accepts the review findings and returns the cut.",
          },
          owner,
        )
      ).outcome,
      "applied",
    );

    await cell.run({ kind: "task-start", taskId, executionId: secondExecutionId }, owner);
    writeSelectionCloseout(rootDir, (created as Record<string, unknown>).packagePath);
    assert.equal(
      (await cell.run({ kind: "task-submit", taskId, executionId: secondExecutionId }, owner)).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-adjudicate",
            taskId,
            executionId: secondExecutionId,
            forward: true,
            reason: "Owner forwards round two.",
          },
          owner,
        )
      ).outcome,
      "applied",
    );

    // The transition guards make a second concurrent submitted execution unreachable, so ambiguity
    // cannot be constructed through the lifecycle: starting is refused while a submitted cut exists.
    const refusedStart = await cell.run({ kind: "task-start", taskId, executionId: "exec-selection-r3" }, owner);
    assert.equal(refusedStart.outcome, "op_rejected", JSON.stringify(refusedStart));
    assert.equal(refusedStart.code, "invalid_transition", JSON.stringify(refusedStart));

    writeFileSync(
      path.join(rootDir, "review-approved.json"),
      JSON.stringify({ verdict: "approved", reason: "Second round passes.", evidenceChecked: ["second round"] }),
    );
    writeReviewReport(rootDir, (created as Record<string, unknown>).packagePath, "review-selection-r2");
    const reviewed = await cell.run(
      {
        kind: "task-review-execution",
        taskId,
        reviewId: "review-selection-r2",
        fromFile: "review-approved.json",
      },
      reviewer,
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    const reviewedEvent = store().readEvent(String(reviewed.opId));
    if (reviewedEvent?.type !== "review_recorded") throw new Error("second review event missing");
    assert.equal(reviewedEvent.payload.review.executionId, secondExecutionId);
    assert.equal(reviewedEvent.payload.review.iteration, 1);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("review-execution without --execution-id names the resubmission command while no submitted execution exists", async () => {
  const rootDir = workspace("selection-empty"),
    taskId = "task-selection-empty",
    firstExecutionId = "exec-selection-empty",
    owner = binding("selection-empty-owner"),
    reviewer = withRoleBinding(binding("selection-empty-reviewer"), "arbiter");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId: workspaceId("selection-empty"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "selection-empty",
    });
    const created = await cell.run({ kind: "task-create", taskId, title: "Selection empty" }, owner);
    await waitForFixturePublication(cell, created.opId, owner);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
    await cell.run({ kind: "task-start", taskId, executionId: firstExecutionId }, owner);
    writeSelectionCloseout(rootDir, (created as Record<string, unknown>).packagePath);
    assert.equal(
      (await cell.run({ kind: "task-submit", taskId, executionId: firstExecutionId }, owner)).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-adjudicate",
            taskId,
            executionId: firstExecutionId,
            forward: true,
            reason: "Owner forwards the selection fixture.",
          },
          owner,
        )
      ).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "review-changes.json"),
      JSON.stringify({
        verdict: "changes_requested",
        reason: "Return to implementation before any resubmission.",
        evidenceChecked: ["first-round receipt"],
      }),
    );
    writeReviewReport(rootDir, (created as Record<string, unknown>).packagePath, "review-selection-empty");
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-review-execution",
            taskId,
            executionId: firstExecutionId,
            reviewId: "review-selection-empty",
            fromFile: "review-changes.json",
          },
          reviewer,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-adjudicate",
            taskId,
            executionId: firstExecutionId,
            return: true,
            reviewId: "review-selection-empty",
            reason: "Owner returns the cut before resubmission.",
          },
          owner,
        )
      ).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "review-approved.json"),
      JSON.stringify({ verdict: "approved", reason: "No cut to review yet.", evidenceChecked: ["none"] }),
    );
    const rejected = await cell.run(
      { kind: "task-review-execution", taskId, reviewId: "review-selection-early", fromFile: "review-approved.json" },
      reviewer,
    );
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "invalid_command", JSON.stringify(rejected));
    assert.match(String(rejected.rejectionExplanation), /ha task show/u);
    assert.match(String(rejected.rejectionExplanation), /ha task submit/u);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("review-execution and review-consent require a substantive physical report on disk", async () => {
  const rootDir = workspace("physical-report"),
    taskId = "task-physical-report",
    executionId = "exec-physical-report",
    owner = binding("physical-owner"),
    reviewer = withRoleBinding(binding("physical-reviewer"), "arbiter");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId: workspaceId("physical-report"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "physical-report",
    });
    const created = await cell.run({ kind: "task-create", taskId, title: "Physical report" }, owner);
    await waitForFixturePublication(cell, created.opId, owner);
    const packagePath = (created as Record<string, unknown>).packagePath;
    await realizeTaskPlanFixture(rootDir, String(packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
    await cell.run({ kind: "task-start", taskId, executionId }, owner);
    writeSelectionCloseout(rootDir, packagePath);
    assert.equal((await cell.run({ kind: "task-submit", taskId, executionId }, owner)).outcome, "applied");
    assert.equal(
      (
        await cell.run(
          { kind: "task-adjudicate", taskId, executionId, forward: true, reason: "Owner forwards the cut." },
          owner,
        )
      ).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Independent review passed.", evidenceChecked: ["tests"] }),
    );
    const record = (reviewId: string, extra: Record<string, unknown> = { fromFile: "review.json" }) =>
      cell!.run(
        { kind: "task-review-execution", taskId, executionId, reviewId, ...extra } as never,
        reviewer,
      ) as Promise<Record<string, unknown>>;
    const consent = (reviewId: string) =>
      cell!.run({ kind: "task-review-consent", taskId, executionId, reviewId }, owner) as Promise<
        Record<string, unknown>
      >;

    // No landed report: the record itself is refused, whether the packet arrives by file or by
    // in-memory JSON injection.
    const absent = await record("review-absent");
    assert.deepEqual(
      { outcome: absent.outcome, code: absent.code },
      { outcome: "op_rejected", code: "review_report_missing" },
      JSON.stringify(absent),
    );
    assert.match(String(absent.rejectionExplanation), /artifacts\/reports\/absent\.md/u);
    const injected = await record("review-injected", {
      jsonInput: JSON.stringify({ verdict: "approved", reason: "injected", evidenceChecked: ["none"] }),
    });
    assert.deepEqual(
      { outcome: injected.outcome, code: injected.code },
      { outcome: "op_rejected", code: "review_report_missing" },
      JSON.stringify(injected),
    );

    // An empty report and a crash-output placeholder are invalid, not missing.
    writeReviewReport(rootDir, packagePath, "review-empty", "");
    const empty = await record("review-empty");
    assert.deepEqual(
      { outcome: empty.outcome, code: empty.code },
      { outcome: "op_rejected", code: "review_report_invalid" },
      JSON.stringify(empty),
    );
    writeReviewReport(rootDir, packagePath, "review-crashed", "Connection error.\n");
    const crashed = await record("review-crashed");
    assert.deepEqual(
      { outcome: crashed.outcome, code: crashed.code },
      { outcome: "op_rejected", code: "review_report_invalid" },
      JSON.stringify(crashed),
    );

    // A substantive report records cleanly.
    const reportPath = writeReviewReport(rootDir, packagePath, "review-landed");
    const landed = await record("review-landed");
    assert.equal(landed.outcome, "applied", JSON.stringify(landed));

    // Consent re-verifies the physical report: deleting or degrading it after the record blocks signing.
    rmSync(reportPath);
    const missing = await consent("review-landed");
    assert.deepEqual(
      { outcome: missing.outcome, code: missing.code },
      { outcome: "op_rejected", code: "review_report_missing" },
      JSON.stringify(missing),
    );
    writeReviewReport(rootDir, packagePath, "review-landed", "turn.failed: rate_limit\n");
    const degraded = await consent("review-landed");
    assert.deepEqual(
      { outcome: degraded.outcome, code: degraded.code },
      { outcome: "op_rejected", code: "review_report_invalid" },
      JSON.stringify(degraded),
    );
    writeReviewReport(rootDir, packagePath, "review-landed");
    assert.equal((await consent("review-landed")).outcome, "applied");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function binding(executorId: string) {
  return {
    actor: { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: executorId } },
    source: "local" as const,
  };
}
function workspace(name: string): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), `ha-review-selection-${name}-`));
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Review Selection Test");
  git(rootDir, "config", "user.email", "review-selection@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
  writeFileSync(path.join(rootDir, "README.md"), "# Lifecycle fixture delivery\n");
  git(rootDir, "add", "README.md");
  git(rootDir, "commit", "--quiet", "-m", "fixture delivery");
  git(rootDir, "tag", "fixture-delivery");
  return rootDir;
}
