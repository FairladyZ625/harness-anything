// harness-test-tier: integration
import assert from "node:assert/strict";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readSubmissionArtifact } from "../src/submission-artifacts.ts";
import { isTaskEvent, makeTaskEventReader } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

async function submitBaselineTask(artifact: boolean) {
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
  const cell = await openBootstrappedRepoCell({
    repoId,
    rootDir: canonicalRoot(rootDir),
    ownerId: "artifact-only-fixture",
  });
  try {
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
    assert.deepEqual(event.payload.execution.submission?.deliverables, []);
    assert.deepEqual(
      event.payload.execution.submission?.outputs,
      artifact ? [`Artifact-Anchor: ${packagePath}/artifacts/report.md@${docs.revision}`] : [],
    );
    if (!artifact) {
      const completed = await cell.run({ kind: "task-complete", taskId, executionId }, holder);
      assert.equal(completed.outcome, "op_rejected", JSON.stringify(completed));
      assert.equal(completed.code, "fact_missing");
      assert.doesNotMatch(JSON.stringify(completed), /code_doc_missing/);
      // Completion preparation reconciles the empty manifest itself; the holder has no path to supply.
      const [codeDoc] = completed.gateChecks as readonly { gate: string; status: string; witnessRef: string }[];
      assert.deepEqual([codeDoc?.gate, codeDoc?.status], ["code-doc-reconciliation", "pass"]);
      assert.match(String(codeDoc?.witnessRef), /^event:code-doc-/u);
    }
    const execution = readFileSync(path.join(ledger, packagePath, "executions", `${executionId}.md`), "utf8"),
      section = execution.slice(execution.indexOf("## Deliverables"), execution.indexOf("## Outputs"));
    assert.match(section, /- none/u);
    assert.doesNotMatch(section, /foreign\.txt/u);
    console.log(`Observed execution Deliverables:\n${section}`);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

test("a real artifact-only task submits without claiming its baseline merge paths", () => submitBaselineTask(true));

test("a baseline closeout-only task reconciles its empty manifest at completion and still requires a Fact", () =>
  submitBaselineTask(false));

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
