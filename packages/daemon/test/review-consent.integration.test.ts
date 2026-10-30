// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { makeTaskEventReader } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
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

test("only the task owner can consent to a changes_requested review, and override needs its rationale", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-owner-review-override-")),
    repoId = workspaceId("owner-review-override"),
    taskId = "task-owner-review-override",
    executionId = "execution-owner-review-override",
    secondExecutionId = "execution-owner-review-override-2",
    ownerBinding = withPolicyGroup({ actor, source: "local" as const }, "maintainer"),
    reviewer = withPolicyGroup(
      {
        actor: { principal: { personId: "person-reviewer" }, executor: { kind: "agent" as const, id: "arbiter" } },
        source: "local" as const,
      },
      "maintainer",
    );
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "owner-review-override" });
    const store = () => makeTaskEventReader({ repoId, rootDir }),
      created = await cell.run({ kind: "task-create", taskId, title: "Owner review override" }, ownerBinding);
    await waitForFixturePublication(cell, created.opId, ownerBinding);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, ownerBinding),
    );
    await cell.run({ kind: "task-start", taskId, executionId }, ownerBinding);
    writeCloseout(rootDir, (created as Record<string, unknown>).packagePath);
    assert.equal((await cell.run({ kind: "task-submit", taskId, executionId }, ownerBinding)).outcome, "applied");

    writeFileSync(
      path.join(rootDir, "review-changes.json"),
      JSON.stringify({
        verdict: "changes_requested",
        reason: "Exercise a second implementation round.",
        evidenceChecked: ["first-round receipt"],
        findings: [{ findingId: "fixture-finding", blocking: true, text: "Fixture review requires another pass." }],
        resolutions: [],
      }),
    );
    writeReviewReport(rootDir, (created as Record<string, unknown>).packagePath, "review-selection-r1");
    const returned = await cell.run(
      {
        kind: "task-review-execution",
        taskId,
        executionId,
        reviewId: "review-selection-r1",
        fromFile: "review-changes.json",
      },
      reviewer,
    );
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));
    const returnedEvent = store().readEvent(String(returned.opId));
    if (returnedEvent?.type !== "review_recorded") throw new Error("returned review event missing");
    // Below the budget the verdict itself reopens the round: one write, closed cut, new iteration.
    assert.equal(returnedEvent.payload.execution.state, "changes_requested");
    assert.equal(returnedEvent.payload.task.status, "active");
    assert.equal(returnedEvent.payload.task.iteration, 1);

    await cell.run({ kind: "task-start", taskId, executionId: secondExecutionId }, ownerBinding);
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-respond-review",
            taskId,
            executionId: secondExecutionId,
            jsonInput: JSON.stringify({
              responses: [
                {
                  reviewId: "review-selection-r1",
                  findingId: "fixture-finding",
                  disposition: "adopt",
                  rationale: "The second cut addresses the blocking review finding.",
                },
              ],
            }),
          },
          ownerBinding,
        )
      ).outcome,
      "applied",
    );
    writeCloseout(rootDir, (created as Record<string, unknown>).packagePath);
    assert.equal(
      (await cell.run({ kind: "task-submit", taskId, executionId: secondExecutionId }, ownerBinding)).outcome,
      "applied",
    );

    // The transition guards make a second concurrent submitted execution unreachable, so ambiguity
    // cannot be constructed through the lifecycle: starting is refused while a submitted cut exists.
    const refusedStart = await cell.run({ kind: "task-start", taskId, executionId: "exec-selection-r3" }, ownerBinding);
    assert.equal(refusedStart.outcome, "op_rejected", JSON.stringify(refusedStart));
    assert.equal(refusedStart.code, "invalid_transition", JSON.stringify(refusedStart));

    writeFileSync(
      path.join(rootDir, "review-approved.json"),
      JSON.stringify({
        verdict: "approved",
        reason: "Second round passes.",
        evidenceChecked: ["second round"],
        findings: [],
        resolutions: [],
      }),
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

    // An approved cut stays at the gate: the manual return retired with the automatic loop, so
    // the owner's lanes are consent (or supersede) only.
    assert.equal(reviewedEvent.payload.task.status, "in_review");
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
    reviewer = withPolicyGroup(binding("selection-empty-reviewer"), "maintainer");
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
    writeCloseout(rootDir, (created as Record<string, unknown>).packagePath);
    assert.equal(
      (await cell.run({ kind: "task-submit", taskId, executionId: firstExecutionId }, owner)).outcome,
      "applied",
    );

    writeFileSync(
      path.join(rootDir, "review-changes.json"),
      JSON.stringify({
        verdict: "changes_requested",
        reason: "Return to implementation before any resubmission.",
        evidenceChecked: ["first-round receipt"],
        findings: [{ findingId: "fixture-finding", blocking: true, text: "Fixture review requires another pass." }],
        resolutions: [],
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

    writeFileSync(
      path.join(rootDir, "review-approved.json"),
      JSON.stringify({
        verdict: "approved",
        reason: "No cut to review yet.",
        evidenceChecked: ["none"],
        findings: [],
        resolutions: [],
      }),
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
    reviewer = withPolicyGroup(binding("physical-reviewer"), "maintainer");
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
    writeCloseout(rootDir, packagePath);
    assert.equal((await cell.run({ kind: "task-submit", taskId, executionId }, owner)).outcome, "applied");

    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({
        verdict: "approved",
        reason: "Independent review passed.",
        evidenceChecked: ["tests"],
        findings: [],
        resolutions: [],
      }),
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
      jsonInput: JSON.stringify({
        verdict: "approved",
        reason: "injected",
        evidenceChecked: ["none"],
        findings: [],
        resolutions: [],
      }),
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
    // A findingId belonged to the retired per-finding settlement surface; consent must refuse it
    // instead of silently deriving the same consent identity from a stale field.
    const staleFinding = await cell!.run(
      {
        kind: "task-review-consent",
        taskId,
        executionId,
        reviewId: "review-landed",
        findingId: "fixture-finding",
      } as never,
      owner,
    );
    assert.deepEqual(
      { outcome: staleFinding.outcome, code: staleFinding.code },
      { outcome: "op_rejected", code: "invalid_command" },
      JSON.stringify(staleFinding),
    );
    assert.equal((await consent("review-landed")).outcome, "applied");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function binding(executorId: string) {
  return withPolicyGroup(
    {
      actor: { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: executorId } },
      source: "local" as const,
    },
    "admin",
  );
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
