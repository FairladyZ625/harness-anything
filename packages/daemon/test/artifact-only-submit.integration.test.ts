// harness-test-tier: integration
import assert from "node:assert/strict";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { seedBuiltinSchedules } from "../src/schedule-builtin-executor.ts";
import { readSubmissionArtifact } from "../src/submission-artifacts.ts";
import { isTaskEvent, makeTaskEventReader } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const ciBin = mkdtempSync(path.join(tmpdir(), "ha-artifact-only-ci-")),
  originalPath = process.env.PATH;
before(() => {
  writeFileSync(path.join(ciBin, "gh"), "#!/usr/bin/env node\nprocess.stdout.write('[]');\n", { mode: 0o755 });
  process.env.PATH = `${ciBin}${path.delimiter}${originalPath ?? ""}`;
});
after(() => {
  process.env.PATH = originalPath;
  rmSync(ciBin, { recursive: true, force: true });
});

async function submitBaselineTask(artifact: boolean, publicChange?: "add" | "delete" | "empty-commit") {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-only-submit-")),
    ledger = path.join(rootDir, "harness"),
    taskId = "task-artifact-only",
    executionId = "execution-artifact-only",
    repoId = workspaceId("artifact-only-submit"),
    holder = withPolicyGroup(
      {
        actor: { principal: { personId: "owner" }, executor: { kind: "agent" as const, id: "worker" } },
        source: "local" as const,
      },
      "admin",
    );
  initRepo(rootDir);
  git(rootDir, "branch", "-M", "main");
  writeFileSync(path.join(rootDir, ".gitignore"), "harness/\n.worktrees/\n");
  git(rootDir, "add", ".gitignore");
  git(rootDir, "commit", "-qm", "test: fixture exclusions");
  git(rootDir, "checkout", "-qb", "other-task");
  writeFileSync(path.join(rootDir, "foreign.txt"), "Another task's delivery.\n");
  git(rootDir, "add", "foreign.txt");
  git(rootDir, "commit", "-qm", "test: foreign delivery");
  git(rootDir, "checkout", "-q", "main");
  git(rootDir, "merge", "--no-ff", "-qm", "test: foreign merge", "other-task");
  const baseline = git(rootDir, "rev-parse", "HEAD");
  mkdirSync(ledger);
  initRepo(ledger);
  writeFileSync(
    path.join(ledger, "harness.yaml"),
    "settings:\n  ci:\n    workflows: [rewrite-ci]\n  gates:\n    ci:\n      appliesTo: code\n      adapter: github-actions\n      branch: main\n      event: push\n      coverage: descendant\n      selection: newest\n  closeout:\n    profile: strict\n",
  );
  const cell = await openBootstrappedRepoCell({
    repoId,
    rootDir: canonicalRoot(rootDir),
    ownerId: "artifact-only-fixture",
  });
  try {
    await seedBuiltinSchedules({ cell, binding: holder });
    const created = await cell.run({ kind: "task-create", taskId, title: "Artifact-only task" }, holder);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, holder);
    const packagePath = String((created as { readonly packagePath?: string }).packagePath);
    await realizeTaskPlanFixture(
      rootDir,
      packagePath,
      async (documentPath) => {
        const receipt = await cell.run({ kind: "doc-submit", paths: [documentPath] }, holder);
        await waitForFixturePublication(cell, receipt.opId, holder);
        return receipt;
      },
      "Artifact-only task",
    );
    const started = await cell.run({ kind: "task-start", taskId, executionId }, holder);
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    await waitForFixturePublication(cell, started.opId, holder);
    const worker = path.join(rootDir, ".worktrees", taskId);
    assert.equal(git(worker, "rev-parse", "HEAD"), baseline);
    if (publicChange === "add") {
      writeFileSync(path.join(worker, "delivery.txt"), "Public delivery.\n");
      git(worker, "add", "delivery.txt");
      git(worker, "commit", "-qm", "test: public delivery");
    } else if (publicChange === "delete") {
      git(worker, "rm", "foreign.txt");
      git(worker, "commit", "-qm", "test: public deletion");
    } else if (publicChange === "empty-commit") {
      git(worker, "commit", "--allow-empty", "-qm", "test: empty delivery");
    }
    const deliveryHead = git(worker, "rev-parse", "HEAD"),
      hasPublicDiff = publicChange === "add" || publicChange === "delete";
    if (artifact) {
      mkdirSync(path.join(ledger, packagePath, "artifacts"), { recursive: true });
      writeFileSync(path.join(ledger, packagePath, "artifacts/report.md"), "# Accepted report\n");
    }
    writeFileSync(
      path.join(ledger, packagePath, "closeout.md"),
      (artifact
        ? "## Summary\nDelivered artifact:artifacts/report.md.\n"
        : "## Summary\nCompleted ledger coordination.\n") +
        "## Verification\nArtifact bytes accepted.\n" +
        "## Residual Risk\nNo public implementation delivered.\n" +
        "## Same Mechanism Elsewhere\nBaseline belongs to another task.\n",
    );
    const docs = await cell.run({ kind: "doc-submit", taskId }, holder);
    assert.equal(docs.outcome, "applied", JSON.stringify(docs));
    // The synced closeout is the hand-back; the receipt names the submit that turns it into a delivery.
    assert.deepEqual(
      ((docs as { next?: readonly { command: string }[] }).next ?? []).map((entry) => entry.command),
      [`ha task submit ${taskId}`],
    );
    await waitForFixturePublication(cell, docs.opId, holder);
    let submitted = await cell.run({ kind: "task-submit", taskId, executionId }, holder);
    for (let attempt = 0; submitted.outcome === "pending" && attempt < 4; attempt += 1) {
      await waitForFixturePublication(cell, submitted.opId, holder);
      submitted = await cell.run({ kind: "task-submit", taskId, executionId }, holder);
    }
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    await waitForFixturePublication(cell, submitted.opId, holder);
    const event = makeTaskEventReader({ repoId, rootDir })
      .read()
      .events.find((entry) => isTaskEvent(entry) && entry.type === "execution_submitted" && entry.taskId === taskId);
    assert.ok(event && isTaskEvent(event) && event.type === "execution_submitted");
    assert.equal(event.payload.execution.submission?.commitSha, hasPublicDiff ? deliveryHead : null);
    assert.equal(git(worker, "rev-parse", "HEAD"), deliveryHead, "submission must not create an empty commit");
    assert.deepEqual(event.payload.execution.submission?.deliverables, publicChange === "add" ? ["delivery.txt"] : []);
    assert.deepEqual(event.payload.execution.submission?.outputs, [
      ...(publicChange === "delete" ? ["Deleted-Production-Paths: foreign.txt"] : []),
      ...(artifact ? [`Artifact-Anchor: ${packagePath}/artifacts/report.md@${docs.revision}`] : []),
    ]);
    const forward = await cell.run(
      { kind: "task-adjudicate", taskId, executionId, forward: true, reason: "Owner forwards verified delivery." },
      holder,
    );
    assert.equal(forward.outcome, "applied", JSON.stringify(forward));
    await waitForFixturePublication(cell, forward.opId, holder);
    if (!artifact && !hasPublicDiff) {
      const completed = await cell.run({ kind: "task-complete", taskId, executionId }, holder);
      assert.equal(completed.outcome, "op_rejected", JSON.stringify(completed));
      assert.equal(completed.code, "fact_missing");
      assert.doesNotMatch(JSON.stringify(completed), /code_doc_missing/);
      assert.deepEqual(completed.gateChecks, [
        { gate: "ci", status: "not_applicable", witnessRef: null },
        { gate: "code-doc-reconciliation", status: "not_applicable", witnessRef: null },
      ]);
    }
    const fact = await cell.run(
      {
        kind: "fact-record",
        taskId,
        statement: "The public cut matches its submitted manifest.",
        evidenceSource: "test:public-cut",
        confidence: "high",
        memoryClass: "semantic",
        memoryTags: [],
      },
      holder,
    );
    assert.equal(fact.outcome, "applied", JSON.stringify(fact));
    await waitForFixturePublication(cell, fact.opId, holder);
    const reviewId = "review-public-cut",
      reportPath = `${packagePath}/artifacts/reports/public-cut.md`;
    mkdirSync(path.join(ledger, packagePath, "artifacts/reports"), { recursive: true });
    writeFileSync(path.join(ledger, reportPath), "# Review\nVerified submission manifest and completion evidence.\n");
    const report = await cell.run({ kind: "doc-submit", paths: [reportPath] }, holder);
    assert.equal(report.outcome, "applied", JSON.stringify(report));
    await waitForFixturePublication(cell, report.opId, holder);
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({
        verdict: "approved",
        reason: "Verified delivery cut.",
        evidenceChecked: ["submission manifest"],
      }),
    );
    const reviewer = withPolicyGroup(
        {
          actor: { principal: { personId: "reviewer" }, executor: { kind: "agent" as const, id: "reviewer" } },
          source: "local" as const,
        },
        "admin",
      ),
      reviewed = await cell.run(
        { kind: "task-review-execution", taskId, executionId, reviewId, fromFile: "review.json" },
        reviewer,
      );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    await waitForFixturePublication(cell, reviewed.opId, holder);
    const consent = await cell.run({ kind: "task-review-consent", taskId, executionId, reviewId }, holder);
    assert.equal(consent.outcome, "applied", JSON.stringify(consent));
    await waitForFixturePublication(cell, consent.opId, holder);
    const completed = await cell.run({ kind: "task-complete", taskId, executionId }, holder);
    assert.equal(completed.outcome, hasPublicDiff ? "op_rejected" : "applied", JSON.stringify(completed));
    if (hasPublicDiff) assert.equal(completed.code, "ci_missing");
    else {
      assert.equal(completed.stoppedAt, undefined);
      const shown = await cell.run({ kind: "task-show", taskId }, holder);
      assert.equal(JSON.parse(String(shown.evidence)).task.status, "done");
    }
    const execution = readFileSync(path.join(ledger, packagePath, "executions", `${executionId}.md`), "utf8"),
      section = execution.slice(execution.indexOf("## Deliverables"), execution.indexOf("## Outputs"));
    if (publicChange === "add") assert.match(section, /delivery\.txt/u);
    else assert.match(section, /- none/u);
    assert.doesNotMatch(section, /foreign\.txt/u);
    console.log(`Observed execution Deliverables:\n${section}`);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

test("a real artifact-only task submits without claiming its baseline merge paths", () => submitBaselineTask(true));

test("a closeout-only no-diff task completes after review, consent and a Fact", () => submitBaselineTask(false));

test("an empty public commit cannot force a CI witness for a no-diff delivery", () =>
  submitBaselineTask(true, "empty-commit"));

test("an added public path still requires main CI after review and consent", () => submitBaselineTask(true, "add"));

test("a deletion-only public cut still requires main CI after review and consent", () =>
  submitBaselineTask(true, "delete"));

test("a documentation amendment completes with newly accepted artifact paths on its own cut", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-amend-"));
  const ledger = path.join(rootDir, "harness"),
    taskId = "task-doc-amend",
    executionId = "execution-doc-amend";
  initRepo(rootDir);
  mkdirSync(ledger);
  initRepo(ledger);
  const holder = withPolicyGroup(
    { actor: { principal: { personId: "owner" }, executor: null }, source: "local" as const },
    "admin",
  );
  const cell = await openBootstrappedRepoCell({
    repoId: workspaceId("doc-amend"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "doc-amend-fixture",
  });
  const run = async (action: Parameters<typeof cell.run>[0]) => {
    let receipt = await cell.run(action, holder);
    for (let attempt = 0; receipt.outcome === "pending" && attempt < 4; attempt++) {
      await waitForFixturePublication(cell, receipt.opId, holder);
      receipt = await cell.run(action, holder);
    }
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    await waitForFixturePublication(cell, receipt.opId, holder);
    return receipt;
  };
  try {
    const created = await run({
      kind: "task-create",
      taskId,
      title: "Amend accepted documentation",
      presetId: "docs-task",
      profileId: "lightweight",
    });
    const packagePath = String((created as { packagePath?: string }).packagePath);
    await realizeTaskPlanFixture(
      rootDir,
      packagePath,
      (documentPath) => run({ kind: "doc-submit", paths: [documentPath] }),
      "Amend accepted documentation",
    );
    await run({ kind: "task-start", taskId, executionId });
    mkdirSync(path.join(ledger, packagePath, "artifacts"), { recursive: true });
    writeFileSync(path.join(ledger, packagePath, "artifacts/report.md"), "First accepted evidence.\n");
    writeFileSync(
      path.join(ledger, packagePath, "closeout.md"),
      "## Summary\nReviewed documentation and recorded the evidence.\n## Verification\nAccepted reports were read.\n## Residual Risk\nNo product implementation claimed.\n## Same Mechanism Elsewhere\nDocumentation revision must match its paths.\n",
    );
    await run({ kind: "doc-submit", taskId });
    await run({ kind: "task-submit", taskId, executionId });
    writeFileSync(path.join(ledger, packagePath, "artifacts/followup.md"), "Additional accepted evidence.\n");
    await run({ kind: "doc-submit", taskId });
    await run({ kind: "task-submit", taskId, executionId, amend: true });
    const amended = makeTaskEventReader({ repoId: workspaceId("doc-amend"), rootDir })
      .read()
      .events.findLast(
        (event) => isTaskEvent(event) && event.type === "execution_submitted" && event.taskId === taskId,
      );
    assert.ok(amended && isTaskEvent(amended) && amended.type === "execution_submitted");
    const submission = amended.payload.execution.submission!;
    assert.ok(submission.deliverables.includes(`${packagePath}/artifacts/followup.md`));
    assert.equal(submission.commitSha, null);
    const reader = makeTaskEventReader({ repoId: workspaceId("doc-amend"), rootDir }),
      reviewCell = {
        store: reader,
        cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
      };
    try {
      for (const anchor of submission.artifacts!) {
        const frozen = readSubmissionArtifact(reviewCell, packagePath, anchor.path, anchor.revision, anchor.blobSha256);
        assert.deepEqual(Buffer.from(frozen.body), readFileSync(path.join(ledger, anchor.path)));
      }
    } finally {
      await reader.drain();
    }
    await run({ kind: "task-complete", taskId, executionId });
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
