// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { currentGateRun, isTaskEvent, submissionDigest } from "@harness-anything/kernel";
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
  const seenCuts = new Set<string>();
  const latestSubmittedCut = () => {
    const submitted = events().findLast((e) => e.type === "execution_submitted");
    assert.ok(submitted && submitted.payload.execution.submission, "expected execution_submitted event");
    const digest = submissionDigest(submitted.payload.execution.submission);
    assert.equal(seenCuts.has(digest), false, `expected distinct submission digest, saw ${digest} again`);
    seenCuts.add(digest);
    return { digest, submission: submitted.payload.execution.submission };
  };
  const witnessForCut = (cutDigest: string) =>
    events().find(
      (e) => e.type === "completion_gate_verified" && e.payload.witness.basis?.submissionDigest === cutDigest,
    );
  const settledRunForCut = (cutDigest: string) => {
    const event = events().findLast(
      (e) =>
        (e.type === "gate_run_changed" || e.type === "completion_gate_verified") &&
        currentGateRun(e.payload.execution, "verification-receipt")?.submissionDigest === cutDigest,
    );
    return event ? currentGateRun(event.payload.execution, "verification-receipt") : undefined;
  };

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

    // 1. Missing receipt: host records availability=unavailable/result=null via witness_unavailable and blocks complete
    await applied({ kind: "doc-submit", taskId });
    const missingSubmit = await applied({ kind: "task-submit", taskId, executionId });
    await applied({ kind: "task-annotate", taskId, executionId, note: `merge_commit_sha:${currentSha}` }, owner);
    const missingCut = latestSubmittedCut();
    const missingRun = settledRunForCut(missingCut.digest);
    assert.equal(missingRun?.state, "completed");
    assert.equal(missingRun?.availability, "unavailable");
    assert.equal(missingRun?.result, null);
    assert.match(missingRun?.diagnostic ?? "", /absent from the frozen submission/u);
    assert.equal(witnessForCut(missingCut.digest), undefined);
    const missingComplete = await cell.run({ kind: "task-complete", taskId, executionId }, owner);
    assert.equal(missingComplete.outcome, "op_rejected", JSON.stringify(missingComplete));
    assert.equal(missingComplete.code, "gate_witness_missing");
    console.log(
      "VERIFIED_MISSING_RECEIPT=" +
        JSON.stringify({ submit: missingSubmit, gateRun: missingRun, complete: missingComplete }),
    );

    // 2. Stale commitSha (oldSha !== currentSha), bound to this cut's submissionDigest and runId
    const receiptPath = path.join(artifactsDir, "verification-receipt.json");
    writeFileSync(
      receiptPath,
      JSON.stringify({ commitSha: oldSha, passed: 12, failed: 0, timedOut: 0, unexecuted: 0, total: 12 }),
    );
    await applied({ kind: "doc-submit", taskId });
    const staleSubmit = await applied({ kind: "task-submit", taskId, executionId, amend: true });
    const staleCut = latestSubmittedCut();
    const staleWitness = witnessForCut(staleCut.digest);
    assert.ok(staleWitness, "expected completion_gate_verified bound to stale cut");
    const staleRun = currentGateRun(staleWitness.payload.execution, "verification-receipt")!;
    assert.equal(staleRun.submissionDigest, staleCut.digest);
    assert.equal(staleRun.availability, "available");
    assert.equal(staleRun.result, "fail");
    assert.equal(staleWitness.payload.witness.provenance?.runId, staleRun.runId);
    assert.equal(staleWitness.payload.witness.result, "fail");
    assert.match(staleWitness.payload.witness.diagnostic, /does not match frozen commitSha/u);
    const staleComplete = await cell.run({ kind: "task-complete", taskId, executionId }, owner);
    assert.equal(staleComplete.outcome, "op_rejected");
    assert.equal(staleComplete.code, "gate_witness_missing");
    console.log("VERIFIED_STALE_SHA=" + JSON.stringify({ submit: staleSubmit, complete: staleComplete }));

    // 3. Positive control: unexecuted: 2 folded into total: 12, bound to this cut's submissionDigest and runId
    writeFileSync(
      receiptPath,
      JSON.stringify({ passed: 10, failed: 0, timedOut: 0, unexecuted: 2, total: 12, commitSha: currentSha }),
    );
    await applied({ kind: "doc-submit", taskId });
    const unexecutedSubmit = await applied({ kind: "task-submit", taskId, executionId, amend: true });
    const unexecutedCut = latestSubmittedCut();
    const unexecutedWitness = witnessForCut(unexecutedCut.digest);
    assert.ok(unexecutedWitness, "expected completion_gate_verified bound to unexecuted cut");
    const unexecutedRun = currentGateRun(unexecutedWitness.payload.execution, "verification-receipt")!;
    assert.equal(unexecutedRun.submissionDigest, unexecutedCut.digest);
    assert.equal(unexecutedRun.availability, "available");
    assert.equal(unexecutedRun.result, "fail");
    assert.equal(unexecutedWitness.payload.witness.provenance?.runId, unexecutedRun.runId);
    assert.equal(unexecutedWitness.payload.witness.result, "fail");
    assert.match(unexecutedWitness.payload.witness.diagnostic, /Non-passing outcomes present: .*unexecuted=2/u);
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
    const sumCut = latestSubmittedCut();
    const sumWitness = witnessForCut(sumCut.digest);
    assert.ok(sumWitness, "expected completion_gate_verified bound to sum-mismatch cut");
    const sumRun = currentGateRun(sumWitness.payload.execution, "verification-receipt")!;
    assert.equal(sumRun.submissionDigest, sumCut.digest);
    assert.equal(sumRun.availability, "available");
    assert.equal(sumRun.result, "fail");
    assert.equal(sumWitness.payload.witness.provenance?.runId, sumRun.runId);
    assert.equal(sumWitness.payload.witness.result, "fail");
    assert.match(sumWitness.payload.witness.diagnostic, /Four-state count sum mismatch: .* = 10 !== total\(12\)/u);
    const sumComplete = await cell.run({ kind: "task-complete", taskId, executionId }, owner);
    assert.equal(sumComplete.outcome, "op_rejected");
    assert.equal(sumComplete.code, "gate_witness_missing");
    console.log("VERIFIED_SUM_MISMATCH=" + JSON.stringify({ submit: sumSubmit, complete: sumComplete }));

    // 5. 455+ frozen artifacts + earlier-sorting archive alias + valid root receipt -> ~600B pass & task complete succeeds
    const bulkDir = path.join(artifactsDir, "bulk");
    mkdirSync(bulkDir, { recursive: true });
    for (let index = 0; index < 455; index += 1) {
      writeFileSync(path.join(bulkDir, `item-${String(index).padStart(3, "0")}.txt`), `artifact-${index}\n`);
    }
    const archiveAliasDir = path.join(artifactsDir, "archive", "artifacts");
    mkdirSync(archiveAliasDir, { recursive: true });
    writeFileSync(
      path.join(archiveAliasDir, "verification-receipt.json"),
      JSON.stringify({ commitSha: oldSha, passed: 1, failed: 0, timedOut: 0, unexecuted: 4, total: 5 }),
    );
    writeFileSync(
      receiptPath,
      JSON.stringify({ passed: 12, failed: 0, timedOut: 0, unexecuted: 0, total: 12, commitSha: currentSha }),
    );
    await applied({ kind: "doc-submit", taskId });
    await applied({ kind: "task-submit", taskId, executionId, amend: true });
    const passCut = latestSubmittedCut();
    assert.ok((passCut.submission.artifacts?.length ?? 0) >= 455, "expected 455+ frozen artifacts");
    const passWitness = witnessForCut(passCut.digest);
    assert.ok(passWitness, "expected completion_gate_verified bound to pass cut");
    const passRun = currentGateRun(passWitness.payload.execution, "verification-receipt")!;
    assert.equal(passRun.submissionDigest, passCut.digest);
    assert.equal(passWitness.payload.witness.provenance?.runId, passRun.runId);
    assert.equal(passWitness.payload.witness.result, "pass");
    assert.equal(passRun.result, "pass");
    assert.equal(passWitness.payload.witness.subjects.length, 1);
    assert.equal(passWitness.payload.witness.subjects[0]!.path, `${packagePath}/artifacts/verification-receipt.json`);
    const scriptFrameBytes = Buffer.byteLength(
      JSON.stringify({
        schema: "preset-script-result/v1",
        produces: [
          {
            capabilityId: "completion-witness",
            payload: {
              result: passWitness.payload.witness.result,
              subjects: passWitness.payload.witness.subjects,
              predicateType: passWitness.payload.witness.predicateType,
              predicate: passWitness.payload.witness.predicate,
              diagnostic: passWitness.payload.witness.diagnostic,
            },
          },
        ],
      }) + "\n",
    );
    assert.ok(scriptFrameBytes <= 1024, `expected bounded witness frame <= 1024B, got ${scriptFrameBytes}`);
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
    console.log(
      "VERIFIED_PASS_COMPLETED=" +
        JSON.stringify({
          artifactCount: passCut.submission.artifacts?.length ?? 0,
          scriptFrameBytes,
          completed,
        }),
    );

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
