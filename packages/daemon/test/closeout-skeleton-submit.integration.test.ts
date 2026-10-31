// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/storage";
import { isTaskEvent } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

/**
 * dec_E369B8616F50A6208B293997E7 CH2: task create materializes a fixed closeout skeleton and submit
 * reads it as authored prose. The red→green contrast this test carries is one body on both sides:
 * the canonically materialized `closeout.md`, untouched, now submits; before this change the same
 * scaffold comparison rejected it as `closeout_placeholder`.
 */
test("the closeout skeleton materialized with the task submits untouched", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-closeout-skeleton-")),
    ledger = path.join(rootDir, "harness"),
    repoId = workspaceId("closeout-skeleton"),
    taskId = "task-closeout-skeleton",
    executionId = "execution-closeout-skeleton",
    binding = withPolicyGroup(
      {
        actor: { principal: { personId: "owner" }, executor: { kind: "agent" as const, id: "worker-skeleton" } },
        source: "local" as const,
      },
      "admin",
    );
  initRepo(rootDir);
  mkdirSync(ledger);
  initRepo(ledger);
  const cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "skeleton-fixture" });
  try {
    // docs-task is artifact-delivering: the delivery is an accepted artifact, not a Git commit, which
    // keeps this test on the closeout boundary alone.
    const created = await cell.run(
      { kind: "task-create", taskId, title: "Closeout skeleton", presetId: "docs-task" },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    const packagePath = String((created as { readonly packagePath?: string }).packagePath),
      closeoutPath = path.join(ledger, packagePath, "closeout.md"),
      skeleton = readFileSync(closeoutPath, "utf8");
    assert.deepEqual(
      [...skeleton.matchAll(/^## .+$/gmu)].map((match) => match[0]),
      ["## Summary", "## Verification", "## Residual Risk", "## Same Mechanism Elsewhere"],
    );
    await realizeTaskPlanFixture(
      rootDir,
      packagePath,
      async (documentPath) => {
        const receipt = await cell.run({ kind: "doc-submit", paths: [documentPath] }, binding);
        await waitForFixturePublication(cell, receipt.opId, binding);
        return receipt;
      },
      "Closeout skeleton",
    );
    const started = await cell.run({ kind: "task-start", taskId, executionId }, binding);
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    await waitForFixturePublication(cell, started.opId, binding);
    mkdirSync(path.join(ledger, packagePath, "artifacts"), { recursive: true });
    writeFileSync(path.join(ledger, packagePath, "artifacts/report.md"), "# Evidence\n\nSkeleton boundary.\n");
    const artifact = await cell.run({ kind: "doc-submit", taskId }, binding);
    assert.equal(artifact.outcome, "applied", JSON.stringify(artifact));

    // The untouched skeleton — prompt sentences and all — is a valid authored closeout.
    const submitted = await cell.run({ kind: "task-submit", taskId, executionId }, binding);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    await waitForFixturePublication(cell, submitted.opId, binding);
    const packet = makeTaskEventReader({ repoId, rootDir })
      .read()
      .events.flatMap((event) =>
        isTaskEvent(event) && event.taskId === taskId && event.type === "execution_submitted"
          ? [event.payload.execution.submission!]
          : [],
      )
      .at(-1)!;
    // Recorded verbatim: the claim is the scaffold's own Summary paragraph, unfiltered by heading
    // normalization or locale. Compare against the skeleton body rather than a hardcoded sentence.
    const summaryStart = skeleton.indexOf("## Summary\n"),
      summaryEnd = skeleton.indexOf("\n## Verification", summaryStart);
    assert.equal(packet.completionClaim, skeleton.slice(summaryStart + "## Summary\n".length, summaryEnd).trim());
    assert.equal(packet.verificationNotes.length, 1);
    assert.deepEqual(packet.knownGaps, packet.residualRisks);

    // Negative: every heading present but no prose in Summary derives no claim, so the Submission
    // schema rejects the cut. The refusal names the real defect, not a scaffold comparison.
    writeFileSync(
      closeoutPath,
      "# Closeout\n\n## Summary\n\n## Verification\n\n## Residual Risk\n\n## Same Mechanism Elsewhere\n",
    );
    const empty = await cell.run({ kind: "task-submit", taskId, executionId, amend: true }, binding);
    assert.notEqual(empty.outcome, "applied", JSON.stringify(empty));
    // The Submission schema's own validation code names the empty fields; no placeholder code exists.
    assert.equal(empty.code, "invalid_submission", JSON.stringify(empty));
    assert.match(JSON.stringify(empty.diagnostic), /completionClaim/u);
    assert.doesNotMatch(JSON.stringify(empty), /placeholder/u);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
