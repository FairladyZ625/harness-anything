// harness-test-tier: integration
import assert from "node:assert/strict";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isTaskEvent, makeTaskEventReader } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

test("a real artifact-only task submits without claiming its baseline merge paths", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-artifact-only-submit-")),
    ledger = path.join(rootDir, "harness"),
    taskId = "task-artifact-only",
    executionId = "execution-artifact-only",
    repoId = workspaceId("artifact-only-submit"),
    holder = withRoleBinding(
      {
        actor: { principal: { personId: "owner" }, executor: { kind: "agent" as const, id: "worker" } },
        source: "local" as const,
      },
      "owner",
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
    mkdirSync(path.join(ledger, packagePath, "artifacts"), { recursive: true });
    writeFileSync(path.join(ledger, packagePath, "artifacts/report.md"), "# Accepted report\n");
    writeFileSync(
      path.join(ledger, packagePath, "closeout.md"),
      "## Summary\nDelivered artifact:artifacts/report.md.\n" +
        "## Verification\nArtifact bytes accepted.\n" +
        "## Residual Risk\nNo public implementation delivered.\n" +
        "## Same Mechanism Elsewhere\nBaseline belongs to another task.\n",
    );
    const docs = await cell.run({ kind: "doc-submit", taskId }, holder);
    assert.equal(docs.outcome, "applied", JSON.stringify(docs));
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
    assert.deepEqual(event.payload.execution.submission?.outputs, [
      `Artifact-Anchor: ${packagePath}/artifacts/report.md@${docs.revision}`,
    ]);
    const execution = readFileSync(path.join(ledger, packagePath, "executions", `${executionId}.md`), "utf8"),
      section = execution.slice(execution.indexOf("## Deliverables"), execution.indexOf("## Outputs"));
    assert.match(section, /- none/u);
    assert.doesNotMatch(section, /foreign\.txt/u);
    console.log(`Observed execution Deliverables:\n${section}`);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
