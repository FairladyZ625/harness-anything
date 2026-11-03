// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

// Issue #4257: a low effective tier closes the Review gate. The submit and complete receipts must
// say so on their own, because nothing else in the flow tells a single session that review was
// skipped. A raised floor has already opened the gate, so the notice must stay absent there.
test("low-tier submit and complete receipts announce the waived review while medium and raised cuts stay silent", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-review-waiver-")),
    ledger = path.join(root, "harness"),
    repoId = workspaceId("review-waiver"),
    worker = withPolicyGroup(
      {
        actor: { principal: { personId: "owner" }, executor: { kind: "agent" as const, id: "worker" } },
        source: "local" as const,
      },
      "admin",
    ),
    owner = withPolicyGroup(
      { actor: { principal: { personId: "owner" }, executor: null }, source: "local" as const },
      "admin",
    );
  initRepo(root);
  mkdirSync(ledger);
  initRepo(ledger);
  const cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "review-waiver" });
  t.after(async () => {
    await cell.close();
    rmSync(root, { recursive: true, force: true });
  });

  const applied = async (action: Record<string, unknown> & { kind: string }, binding = worker) => {
    const receipt = await cell.run(action, binding);
    assert.ok(
      receipt.outcome === "applied" || (receipt.outcome === "pending" && receipt.acceptance !== null),
      JSON.stringify(receipt),
    );
    if (receipt.acceptance !== null) await waitForFixturePublication(cell, receipt.opId, binding);
    return receipt;
  };

  const createAndSubmit = async (
    taskId: string,
    executionId: string,
    riskTier?: "low" | "medium",
  ): Promise<Record<string, unknown>> => {
    const title = `Waiver ${taskId}`,
      created = await cell.run(
        { kind: "task-create", taskId, title, presetId: "docs-task", ...(riskTier ? { riskTier } : {}) },
        worker,
      );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, worker);
    const packagePath = String((created as { readonly packagePath?: string }).packagePath);
    await realizeTaskPlanFixture(
      root,
      packagePath,
      async (documentPath) => {
        const receipt = await cell.run({ kind: "doc-submit", paths: [documentPath] }, worker);
        await waitForFixturePublication(cell, receipt.opId, worker);
        return receipt;
      },
      title,
    );
    const started = await cell.run({ kind: "task-start", taskId, executionId }, worker);
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    await waitForFixturePublication(cell, started.opId, worker);
    mkdirSync(path.join(ledger, packagePath, "artifacts"), { recursive: true });
    writeFileSync(path.join(ledger, packagePath, "artifacts/report.md"), "# Accepted report\n");
    writeFileSync(
      path.join(ledger, packagePath, "closeout.md"),
      "## Summary\nDelivered the accepted report.\n" +
        "## Verification\nArtifact bytes accepted.\n" +
        "## Residual Risk\nNo public implementation delivered.\n" +
        "## Same Mechanism Elsewhere\nSubmit and complete share one receipt assembly point.\n",
    );
    await applied({ kind: "doc-submit", taskId });
    let submitted = await cell.run({ kind: "task-submit", taskId, executionId }, worker);
    for (let attempt = 0; submitted.outcome === "pending" && attempt < 4; attempt += 1) {
      await waitForFixturePublication(cell, submitted.opId, worker);
      submitted = await cell.run({ kind: "task-submit", taskId, executionId }, worker);
    }
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    return submitted as unknown as Record<string, unknown>;
  };

  const low = await createAndSubmit("task-waiver-low", "execution-waiver-low", "low");
  assert.equal((low.riskTierAssessment as Record<string, unknown>).effectiveTier, "low");
  assert.match(
    String(low.summary),
    /^task-submit: submitted \(execution: execution-waiver-low\)\nreview waived: effective risk tier low \(declared by worker\)$/u,
  );

  const completed = await cell.run(
    { kind: "task-complete", taskId: "task-waiver-low", executionId: "execution-waiver-low" },
    owner,
  );
  assert.equal(completed.outcome, "applied", JSON.stringify(completed));
  assert.match(
    String(completed.summary),
    /^task-complete: applied\nreview waived: effective risk tier low \(declared by worker\)$/u,
  );

  const medium = await createAndSubmit("task-waiver-medium", "execution-waiver-medium", "medium");
  assert.equal((medium.riskTierAssessment as Record<string, unknown>).effectiveTier, "medium");
  assert.doesNotMatch(String(medium.summary), /review waived/u);

  // A repository risk floor may raise a self-declared low tier. The gate is already open, so the
  // waiver sentence would be false and must not appear.
  mkdirSync(path.join(root, "tools"), { recursive: true });
  writeFileSync(
    path.join(root, "tools/task-risk-manifest.json"),
    JSON.stringify({
      schema: "task-risk-manifest/v1",
      scripts: [
        {
          id: "test-floor",
          command: [
            process.execPath,
            "-e",
            'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({schema:"task-risk-tier-result/v1",minimumTier:"medium",reasons:["test floor raised the declared low tier"]})));',
          ],
        },
      ],
    }),
  );
  const raised = await createAndSubmit("task-waiver-raised", "execution-waiver-raised", "low");
  const assessment = raised.riskTierAssessment as Record<string, unknown>;
  assert.equal(assessment.declaredTier, "low");
  assert.equal(assessment.effectiveTier, "medium");
  assert.doesNotMatch(String(raised.summary), /review waived/u);
});
