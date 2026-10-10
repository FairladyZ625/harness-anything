// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  currentGateRun,
  isTaskEvent,
  makeTaskEventReader,
  emptyTaskLifecycleSnapshot,
  reduceTaskEvent,
} from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

import { researchPackage } from "./completion-command-source.fixture.ts";

test("declared command checks submitted CSV/PNG/JSON without code: seed red, amended seed green, cold replay retains both runs", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-completion-command-")),
    ledger = path.join(root, "harness"),
    repoId = workspaceId("completion-command"),
    taskId = "task-research",
    executionId = "execution-research",
    worker = withPolicyGroup(
      {
        actor: { principal: { personId: "research-owner" }, executor: { kind: "agent" as const, id: "task-worker" } },
        source: "local" as const,
      },
      "admin",
    ),
    owner = withPolicyGroup(
      { actor: { principal: { personId: "research-owner" }, executor: null }, source: "local" as const },
      "admin",
    );
  initRepo(root);
  git(root, "branch", "-M", "main");
  writeFileSync(path.join(root, ".gitignore"), "harness/\n.harness/\n.worktrees/\nsource/\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-qm", "test: fixture exclusions");
  mkdirSync(ledger);
  initRepo(ledger);
  const source = researchPackage(root);
  let cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "completion-fixture" });
  const applied = async (action: Record<string, unknown> & { kind: string }, binding = worker) => {
    const receipt = await cell.run(action, binding);
    assert.ok(
      receipt.outcome === "applied" || (receipt.outcome === "pending" && receipt.acceptance !== null),
      JSON.stringify(receipt),
    );
    if (receipt.acceptance !== null) await waitForFixturePublication(cell, receipt.opId, binding);
    return receipt;
  };
  try {
    await applied({ kind: "preset-install", packageSource: source });
    const validated = await cell.run({ kind: "vertical-validate", presetId: "research-checks" }, worker);
    assert.equal(JSON.parse(String(validated.evidence)).valid, true, JSON.stringify(validated));
    const invalidAssets = path.join(root, "source", "undeclared-source");
    cpSync(new URL("../../preset/assets/software-coding", import.meta.url), invalidAssets, { recursive: true });
    const verticalPath = path.join(invalidAssets, "vertical.json"),
      vertical = JSON.parse(readFileSync(verticalPath, "utf8"));
    vertical.completion.gates.ci.source = "research/undeclared";
    writeFileSync(verticalPath, JSON.stringify(vertical));
    const unknown = await cell.run({ kind: "vertical-validate", verticalSource: invalidAssets }, worker);
    const unknownReport = JSON.parse(String(unknown.evidence));
    assert.equal(unknownReport.valid, false, JSON.stringify(unknownReport));
    assert.match(JSON.stringify(unknownReport), /research\/undeclared/);
    console.log("W1_UNKNOWN_SOURCE_VALIDATE=" + JSON.stringify(unknownReport));
    const created = await applied({
        kind: "task-create",
        taskId,
        title: "Reproducible experiment",
        presetId: "research-checks",
        profileId: "experiment",
      }),
      packagePath = String((created as { packagePath?: string }).packagePath);
    await realizeTaskPlanFixture(
      root,
      packagePath,
      (documentPath) => applied({ kind: "doc-submit", paths: [documentPath] }),
      "Reproducible experiment",
    );
    await applied({ kind: "task-start", taskId, executionId });
    mkdirSync(path.join(ledger, packagePath, "artifacts"), { recursive: true });
    writeFileSync(path.join(ledger, packagePath, "artifacts/data.csv"), "x,y\n1,2\n");
    writeFileSync(
      path.join(path.dirname(source), "chart.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    writeFileSync(path.join(ledger, packagePath, "artifacts/experiment.json"), "{}\n");
    writeFileSync(
      path.join(ledger, packagePath, "closeout.md"),
      "## Summary\nSubmitted experiment artifacts.\n## Verification\nThe source checks all submitted input bytes and the seed.\n## Residual Risk\nExternal reproducibility is unverified.\n## Same Mechanism Elsewhere\nThis source is declared in the installed preset.\n",
    );
    await applied({
      kind: "task-artifact-add",
      taskId,
      source: path.join(path.dirname(source), "chart.png"),
      destination: "chart.png",
    });
    await applied({ kind: "doc-submit", taskId });
    const red = await applied({ kind: "task-submit", taskId, executionId });
    assert.match(JSON.stringify(red), /gates\.version-pinned\.predicate\.seed/);
    const failed = await cell.run({ kind: "task-complete", taskId, executionId }, owner);
    assert.equal(failed.outcome, "op_rejected", JSON.stringify(failed));
    console.log("W1_SEED_MISSING_RECEIPT=" + JSON.stringify({ submit: red, complete: failed }));
    const events = () =>
      makeTaskEventReader({ repoId, rootDir: root })
        .read()
        .events.filter(isTaskEvent)
        .filter((e) => e.taskId === taskId);
    const first = events().findLast((e) => e.type === "completion_gate_verified")!;
    assert.equal(first.payload.execution.submission?.commitSha, null);
    assert.equal(currentGateRun(first.payload.execution, "version-pinned")?.result, "fail");
    const frozen = first.payload.execution.submission!.completionContract;
    const failedRun = currentGateRun(first.payload.execution, "version-pinned")!;
    for (const kind of ["task-witness-claim", "task-witness-settle", "task-witness-rerun", "task-witness-revoke"]) {
      const denied = await cell.run(
        {
          kind,
          taskId,
          executionId,
          gateId: "version-pinned",
          runId: failedRun.runId,
          reason: "Task executor cannot act as the source or owner",
        },
        worker,
      );
      assert.equal(denied.outcome, "op_rejected", JSON.stringify(denied));
    }
    await applied(
      {
        kind: "task-witness-revoke",
        taskId,
        executionId,
        gateId: "version-pinned",
        runId: failedRun.runId,
        reason: "Owner withdraws this observation",
      },
      owner,
    );
    const revoked = events().findLast((e) => e.type === "gate_run_changed")!;
    assert.equal(currentGateRun(revoked.payload.execution, "version-pinned")?.state, "cancelled");
    await applied(
      {
        kind: "task-witness-rerun",
        taskId,
        executionId,
        gateId: "version-pinned",
        runId: failedRun.runId,
        reason: "Owner requests a second observation",
      },
      owner,
    );
    const repeated = events().findLast((e) => e.type === "completion_gate_verified")!;
    assert.equal(currentGateRun(repeated.payload.execution, "version-pinned")?.result, "fail");
    assert.equal(repeated.payload.execution.gateRuns.length, 2);
    // Both current package code and mutable authored bytes disagree with the accepted input cut.
    writeFileSync(path.join(source, "scripts/anchors.mjs"), "throw new Error('Current package must not run');");
    await applied({ kind: "preset-install", packageSource: source });
    writeFileSync(path.join(ledger, packagePath, "artifacts/experiment.json"), '{"seed":42}\n');
    await applied({ kind: "doc-submit", taskId });
    await applied({ kind: "task-submit", taskId, executionId, amend: true });
    const green = events().findLast((e) => e.type === "completion_gate_verified")!;
    assert.deepEqual(green.payload.execution.submission!.completionContract, frozen);
    assert.equal(currentGateRun(green.payload.execution, "version-pinned")?.result, "pass");
    assert.equal(green.payload.execution.gateRuns.length, 3);
    console.log("W1_SEED_REPAIRED_WITNESS=" + JSON.stringify(green.payload.witness));
    // This edit never enters doc-submit: an explicit owner rerun must still read accepted seed 42.
    writeFileSync(path.join(ledger, packagePath, "artifacts/experiment.json"), '{"seed":"mutable-workspace"}\n');
    const greenRun = currentGateRun(green.payload.execution, "version-pinned")!;
    await applied(
      {
        kind: "task-witness-rerun",
        taskId,
        executionId,
        gateId: "version-pinned",
        runId: greenRun.runId,
        reason: "Verify the frozen input independently of the workspace",
      },
      owner,
    );
    const frozenAgain = events().findLast((e) => e.type === "completion_gate_verified")!;
    assert.equal(currentGateRun(frozenAgain.payload.execution, "version-pinned")?.result, "pass");
    assert.deepEqual(frozenAgain.payload.witness.predicate, { seed: 42 });
    assert.throws(
      () =>
        reduceTaskEvent(
          {
            ...emptyTaskLifecycleSnapshot(first.workspaceRevision),
            task: first.payload.task,
            executions: [first.payload.execution],
          },
          { ...revoked, actor: worker.actor },
        ),
      /Only the task owner/,
    );
    writeFileSync(path.join(ledger, packagePath, "artifacts/experiment.json"), '{"seed":42}\n');
    await cell.close();
    cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "completion-restarted" });
    const completed = await cell.run({ kind: "task-complete", taskId, executionId }, owner);
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    console.log("W1_COLD_RESTART_COMPLETION=" + JSON.stringify(completed));
    await waitForFixturePublication(cell, completed.opId, owner);
    const final = events().findLast((e) => e.type === "task_completed")!;
    assert.equal(final.payload.execution.gateRuns.length, 4);
    assert.equal(currentGateRun(final.payload.execution, "version-pinned")?.result, "pass");
  } finally {
    await cell.close();
    rmSync(root, { recursive: true, force: true });
  }
});
