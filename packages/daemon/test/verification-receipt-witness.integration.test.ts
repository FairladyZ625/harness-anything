// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { currentGateRun, isTaskEvent } from "@harness-anything/kernel";
import { makeTaskEventReader } from "@harness-anything/storage";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";

test("standard-task verified profile blocks missing, stale, folded, and mismatched receipts and passes valid frozen cut", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-verified-receipt-")),
    ledger = path.join(root, "harness"),
    repoId = workspaceId("verified-receipt"),
    taskId = "task-verified-code",
    executionId = "execution-verified-code",
    worker = withPolicyGroup(
      {
        actor: { principal: { personId: "coding-owner" }, executor: { kind: "agent" as const, id: "task-worker" } },
        source: "local" as const,
      },
      "admin",
    ),
    owner = withPolicyGroup(
      { actor: { principal: { personId: "coding-owner" }, executor: null }, source: "local" as const },
      "admin",
    );

  initRepo(root);
  git(root, "branch", "-M", "main");
  writeFileSync(path.join(root, ".gitignore"), "harness/\n.harness/\n.worktrees/\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-qm", "test: fixture exclusions");
  mkdirSync(ledger);
  initRepo(ledger);

  const cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "verified-fixture" });
  const applied = async (action: Record<string, unknown> & { kind: string }, binding = worker) => {
    const receipt = await cell.run(action, binding);
    assert.ok(
      receipt.outcome === "applied" || (receipt.outcome === "pending" && receipt.acceptance !== null),
      JSON.stringify(receipt),
    );
    if (receipt.acceptance !== null) await waitForFixturePublication(cell, receipt.opId, binding);
    return receipt;
  };
  const events = (targetTaskId = taskId) =>
    makeTaskEventReader({ repoId, rootDir: root })
      .read()
      .events.filter(isTaskEvent)
      .filter((e) => e.taskId === targetTaskId);

  try {
    const created = await applied({
      kind: "task-create",
      taskId,
      title: "Verified coding task",
      presetId: "standard-task",
      profileId: "verified",
      riskTier: "low",
    });
    const packagePath = String((created as { packagePath?: string }).packagePath);
    await realizeTaskPlanFixture(
      root,
      packagePath,
      (documentPath) => applied({ kind: "doc-submit", paths: [documentPath] }),
      "Verified coding task",
    );
    await applied({ kind: "task-start", taskId, executionId });

    const worktreeRoot = path.join(root, ".worktrees", taskId);
    writeFileSync(path.join(worktreeRoot, "feature.txt"), "v1\n");
    git(worktreeRoot, "add", "feature.txt");
    git(worktreeRoot, "commit", "-qm", "feat: first commit");
    const oldSha = git(worktreeRoot, "rev-parse", "HEAD");

    writeFileSync(path.join(worktreeRoot, "feature.txt"), "v2\n");
    git(worktreeRoot, "add", "feature.txt");
    git(worktreeRoot, "commit", "-qm", "feat: current commit");
    const currentSha = git(worktreeRoot, "rev-parse", "HEAD");
    assert.notEqual(oldSha, currentSha);

    const artifactsDir = path.join(ledger, packagePath, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(
      path.join(ledger, packagePath, "closeout.md"),
      "## Summary\nImplemented feature v2.\n## Verification\nVerified receipt check.\n## Residual Risk\nNone.\n## Same Mechanism Elsewhere\nChecked.\n",
    );
    git(root, "update-ref", "refs/remotes/origin/main", currentSha);

    // 1. Missing receipt: submit runs witness, records fail, complete rejects with gate_witness_missing
    await applied({ kind: "doc-submit", taskId });
    const missingSubmit = await applied({ kind: "task-submit", taskId, executionId });
    await applied({ kind: "task-annotate", taskId, executionId, note: `merge_commit_sha:${currentSha}` }, owner);
    assert.match(JSON.stringify(missingSubmit), /artifacts\/verification-receipt\.json/u);
    const missingWitness = events().findLast((e) => e.type === "completion_gate_verified")!;
    assert.equal(missingWitness.payload.witness.result, "fail");
    assert.equal(currentGateRun(missingWitness.payload.execution, "verification-receipt")?.result, "fail");
    const missingComplete = await cell.run({ kind: "task-complete", taskId, executionId }, owner);
    assert.equal(missingComplete.outcome, "op_rejected", JSON.stringify(missingComplete));
    assert.equal(missingComplete.code, "gate_witness_missing");
    console.log("VERIFIED_MISSING_RECEIPT=" + JSON.stringify({ submit: missingSubmit, complete: missingComplete }));

    // 2. Stale commitSha (oldSha !== currentSha)
    const receiptPath = path.join(artifactsDir, "verification-receipt.json");
    writeFileSync(
      receiptPath,
      JSON.stringify({ commitSha: oldSha, passed: 12, failed: 0, timedOut: 0, unexecuted: 0, total: 12 }),
    );
    await applied({ kind: "doc-submit", taskId });
    const staleSubmit = await applied({ kind: "task-submit", taskId, executionId, amend: true });
    assert.match(JSON.stringify(staleSubmit), /commitSha/u);
    const staleWitness = events().findLast((e) => e.type === "completion_gate_verified")!;
    assert.equal(staleWitness.payload.witness.result, "fail");
    const staleComplete = await cell.run({ kind: "task-complete", taskId, executionId }, owner);
    assert.equal(staleComplete.outcome, "op_rejected");
    assert.equal(staleComplete.code, "gate_witness_missing");
    console.log("VERIFIED_STALE_SHA=" + JSON.stringify({ submit: staleSubmit, complete: staleComplete }));

    // 3. Positive control: unexecuted: 2 folded into total: 12
    writeFileSync(
      receiptPath,
      JSON.stringify({ passed: 10, failed: 0, timedOut: 0, unexecuted: 2, total: 12, commitSha: currentSha }),
    );
    await applied({ kind: "doc-submit", taskId });
    const unexecutedSubmit = await applied({ kind: "task-submit", taskId, executionId, amend: true });
    const unexecutedWitness = events().findLast((e) => e.type === "completion_gate_verified")!;
    assert.equal(unexecutedWitness.payload.witness.result, "fail");
    assert.equal(currentGateRun(unexecutedWitness.payload.execution, "verification-receipt")?.result, "fail");
    const unexecutedComplete = await cell.run({ kind: "task-complete", taskId, executionId }, owner);
    assert.equal(unexecutedComplete.outcome, "op_rejected");
    assert.equal(unexecutedComplete.code, "gate_witness_missing");
    console.log("VERIFIED_UNEXECUTED_2=" + JSON.stringify({ submit: unexecutedSubmit, complete: unexecutedComplete }));

    // 4. Four-state sum mismatch (passed: 10, failed: 0, timedOut: 0, unexecuted: 0, total: 12)
    writeFileSync(
      receiptPath,
      JSON.stringify({ passed: 10, failed: 0, timedOut: 0, unexecuted: 0, total: 12, commitSha: currentSha }),
    );
    await applied({ kind: "doc-submit", taskId });
    const sumSubmit = await applied({ kind: "task-submit", taskId, executionId, amend: true });
    const sumWitness = events().findLast((e) => e.type === "completion_gate_verified")!;
    assert.equal(sumWitness.payload.witness.result, "fail");
    const sumComplete = await cell.run({ kind: "task-complete", taskId, executionId }, owner);
    assert.equal(sumComplete.outcome, "op_rejected");
    assert.equal(sumComplete.code, "gate_witness_missing");
    console.log("VERIFIED_SUM_MISMATCH=" + JSON.stringify({ submit: sumSubmit, complete: sumComplete }));

    // 5. Valid receipt matching currentSha and all four-state invariants -> pass & task complete succeeds
    writeFileSync(
      receiptPath,
      JSON.stringify({ passed: 12, failed: 0, timedOut: 0, unexecuted: 0, total: 12, commitSha: currentSha }),
    );
    await applied({ kind: "doc-submit", taskId });
    await applied({ kind: "task-submit", taskId, executionId, amend: true });
    const passWitness = events().findLast((e) => e.type === "completion_gate_verified")!;
    assert.equal(passWitness.payload.witness.result, "pass");
    assert.equal(currentGateRun(passWitness.payload.execution, "verification-receipt")?.result, "pass");
    assert.deepEqual(passWitness.payload.witness.predicate, {
      commitSha: currentSha,
      passed: 12,
      failed: 0,
      timedOut: 0,
      unexecuted: 0,
      total: 12,
    });
    const completed = await cell.run({ kind: "task-complete", taskId, executionId }, owner);
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    await waitForFixturePublication(cell, completed.opId, owner);
    assert.ok(events().findLast((e) => e.type === "task_completed"));
    console.log("VERIFIED_PASS_COMPLETED=" + JSON.stringify(completed));

    // 6. Baseline profile stays unaffected (no receipt required)
    const baselineTaskId = "task-baseline-code",
      baselineExecutionId = "execution-baseline-code";
    const baselineCreated = await applied({
      kind: "task-create",
      taskId: baselineTaskId,
      title: "Baseline coding task",
      presetId: "standard-task",
      profileId: "baseline",
      riskTier: "low",
    });
    const baselinePackagePath = String((baselineCreated as { packagePath?: string }).packagePath);
    await realizeTaskPlanFixture(
      root,
      baselinePackagePath,
      (documentPath) => applied({ kind: "doc-submit", paths: [documentPath] }),
      "Baseline coding task",
    );
    await applied({ kind: "task-start", taskId: baselineTaskId, executionId: baselineExecutionId });
    const baselineWorktree = path.join(root, ".worktrees", baselineTaskId);
    writeFileSync(path.join(baselineWorktree, "baseline.txt"), "baseline\n");
    git(baselineWorktree, "add", "baseline.txt");
    git(baselineWorktree, "commit", "-qm", "feat: baseline commit");
    const baselineSha = git(baselineWorktree, "rev-parse", "HEAD");
    git(root, "update-ref", "refs/remotes/origin/main", baselineSha);
    writeFileSync(
      path.join(ledger, baselinePackagePath, "closeout.md"),
      "## Summary\nBaseline delivery.\n## Verification\nChecked.\n## Residual Risk\nNone.\n## Same Mechanism Elsewhere\nNone.\n",
    );
    await applied({ kind: "doc-submit", taskId: baselineTaskId });
    await applied({ kind: "task-submit", taskId: baselineTaskId, executionId: baselineExecutionId });
    await applied(
      {
        kind: "task-annotate",
        taskId: baselineTaskId,
        executionId: baselineExecutionId,
        note: `merge_commit_sha:${baselineSha}`,
      },
      owner,
    );
    const baselineCompleted = await cell.run(
      { kind: "task-complete", taskId: baselineTaskId, executionId: baselineExecutionId },
      owner,
    );
    assert.equal(baselineCompleted.outcome, "applied", JSON.stringify(baselineCompleted));
  } finally {
    await cell.close();
    rmSync(root, { recursive: true, force: true });
  }
});
