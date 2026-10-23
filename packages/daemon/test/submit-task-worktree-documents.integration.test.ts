// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isTaskEvent, makeTaskEventReader } from "@harness-anything/kernel";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { seedBuiltinSchedules } from "../src/schedule-builtin-executor.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

test("task submit carries new artifacts from its bound worktree into the center cut", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-submit-worktree-docs-")),
    ledger = path.join(rootDir, "harness"),
    taskId = "task-submit-doc-carry",
    executionId = "execution-submit-doc-carry",
    repoId = workspaceId("submit-doc-carry"),
    holder = withPolicyGroup(
      {
        actor: { principal: { personId: "owner" }, executor: { kind: "agent" as const, id: "worker" } },
        source: "local" as const,
      },
      "admin",
    );
  initRepo(rootDir);
  git(rootDir, "branch", "-M", "main");
  writeFileSync(path.join(rootDir, ".gitignore"), "harness/\n.harness/\n.worktrees/\n");
  git(rootDir, "add", ".gitignore");
  git(rootDir, "commit", "-qm", "test: fixture exclusions");
  mkdirSync(ledger);
  initRepo(ledger);
  writeFileSync(path.join(ledger, "harness.yaml"), "settings:\n  closeout:\n    profile: strict\n");
  const cell = await openBootstrappedRepoCell({
    repoId,
    rootDir: canonicalRoot(rootDir),
    ownerId: "submit-worktree-docs-fixture",
  });
  try {
    await seedBuiltinSchedules({ cell, binding: holder });
    const created = await cell.run({ kind: "task-create", taskId, title: "Submit worktree documents" }, holder);
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
      "Submit worktree documents",
    );
    writeFileSync(
      path.join(ledger, packagePath, "closeout.md"),
      "## Summary\nThe task worktree artifact is submitted with the repository cut.\n" +
        "## Verification\nThe integration fixture inspected the durable submission event.\n" +
        "## Residual Risk\nNo additional risk in this fixture.\n" +
        "## Same Mechanism Elsewhere\nNew task-package files must cross the same document acceptance path.\n",
    );
    const closeout = await cell.run({ kind: "doc-submit", taskId }, holder);
    assert.equal(closeout.outcome, "applied", JSON.stringify(closeout));
    await waitForFixturePublication(cell, closeout.opId, holder);

    const started = await cell.run({ kind: "task-start", taskId, executionId }, holder);
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    await waitForFixturePublication(cell, started.opId, holder);
    const worker = path.join(rootDir, ".worktrees", taskId),
      artifactPath = `${packagePath}/artifacts/worker-generated.md`,
      canonicalArtifact = path.join(ledger, artifactPath),
      workerArtifact = path.join(worker, "harness", artifactPath),
      closeoutPath = `${packagePath}/closeout.md`,
      canonicalCloseout = path.join(ledger, closeoutPath),
      workerCloseout = path.join(worker, "harness", closeoutPath),
      revisedCloseout =
        "## Summary\nTask submit carries the revised closeout with the repository cut.\n" +
        "## Verification\nThe integration fixture inspected the durable submission event.\n" +
        "## Residual Risk\nNo additional risk in this fixture.\n" +
        "## Same Mechanism Elsewhere\nNew task-package files must cross the same document acceptance path.\n";
    unlinkSync(workerCloseout);
    writeFileSync(workerCloseout, revisedCloseout);
    mkdirSync(path.dirname(workerArtifact), { recursive: true });
    writeFileSync(workerArtifact, "# Worker generated artifact\n");
    assert.equal(existsSync(canonicalArtifact), false, "new files are not hard-linked into the canonical ledger");
    assert.doesNotMatch(readFileSync(canonicalCloseout, "utf8"), /revised closeout/u);
    mkdirSync(path.join(worker, "src"), { recursive: true });
    writeFileSync(path.join(worker, "src", "delivery.ts"), "export const delivered = true;\n");
    git(worker, "add", "src/delivery.ts");
    git(worker, "commit", "-qm", "test: repository delivery");
    const deliveryHead = git(worker, "rev-parse", "HEAD");

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
    assert.equal(event.payload.execution.submission?.commitSha, deliveryHead);
    assert.ok(
      event.payload.execution.submission?.artifacts?.some((artifact) => artifact.path === artifactPath),
      `submission must accept ${artifactPath} from the task worktree`,
    );
    assert.ok(event.payload.execution.submission?.changedFiles?.includes("src/delivery.ts"));
    assert.ok(event.payload.execution.submission?.productionDelta);
    assert.equal(readFileSync(canonicalCloseout, "utf8"), revisedCloseout);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
