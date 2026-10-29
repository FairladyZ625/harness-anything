// harness-test-tier: integration
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isTaskEvent, makeTaskEventReader } from "@harness-anything/kernel";
import { readSubmissionArtifact } from "../src/submission-artifacts.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { seedBuiltinSchedules } from "../src/schedule-builtin-executor.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { removeTempStoreRoot } from "../../kernel/test/store/helpers.ts";

test("task submit refreshes rename-replaced artifacts and carries new worktree artifacts", async () => {
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
    const artifactPath = `${packagePath}/artifacts/worker-generated.md`,
      canonicalArtifact = path.join(ledger, artifactPath),
      originalArtifactBody = "# Existing worker artifact\n";
    mkdirSync(path.dirname(canonicalArtifact), { recursive: true });
    writeFileSync(canonicalArtifact, originalArtifactBody);
    const existingArtifact = await cell.run({ kind: "doc-submit", paths: [artifactPath] }, holder);
    assert.equal(existingArtifact.outcome, "applied", JSON.stringify(existingArtifact));
    await waitForFixturePublication(cell, existingArtifact.opId, holder);

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
      workerArtifact = path.join(worker, "harness", artifactPath),
      newArtifactPath = `${packagePath}/artifacts/worker-created.md`,
      canonicalNewArtifact = path.join(ledger, newArtifactPath),
      workerNewArtifact = path.join(worker, "harness", newArtifactPath),
      closeoutPath = `${packagePath}/closeout.md`,
      canonicalCloseout = path.join(ledger, closeoutPath),
      workerCloseout = path.join(worker, "harness", closeoutPath),
      artifactBody = "# Worker generated artifact\n",
      amendedArtifactBody = "# Renamed worker artifact\n",
      revisedCloseout =
        "## Summary\nTask submit carries the revised closeout with the repository cut.\n" +
        "## Verification\nThe integration fixture inspected the durable submission event.\n" +
        "## Residual Risk\nNo additional risk in this fixture.\n" +
        "## Same Mechanism Elsewhere\nNew task-package files must cross the same document acceptance path.\n";
    assert.equal(existsSync(workerArtifact), true, "existing task artifacts are mirrored into the worktree");
    const centerBeforeRename = statSync(canonicalArtifact),
      workerBeforeRename = statSync(workerArtifact);
    assert.equal(workerBeforeRename.dev, centerBeforeRename.dev);
    assert.equal(workerBeforeRename.ino, centerBeforeRename.ino, "worktree and center initially share a hard link");
    const replacementPath = path.join(path.dirname(workerArtifact), ".worker-generated.md.tmp");
    writeFileSync(replacementPath, amendedArtifactBody);
    renameSync(replacementPath, workerArtifact);
    assert.notEqual(
      statSync(workerArtifact).ino,
      statSync(canonicalArtifact).ino,
      "atomic replacement must break the worktree hard link",
    );
    assert.equal(readFileSync(canonicalArtifact, "utf8"), originalArtifactBody);

    unlinkSync(workerCloseout);
    writeFileSync(workerCloseout, revisedCloseout);
    mkdirSync(path.dirname(workerNewArtifact), { recursive: true });
    writeFileSync(workerNewArtifact, artifactBody);
    assert.equal(existsSync(canonicalNewArtifact), false, "new files are not hard-linked into the canonical ledger");
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
      `submission must refresh the changed hard-linked artifact ${artifactPath}`,
    );
    assert.ok(
      event.payload.execution.submission?.artifacts?.some((artifact) => artifact.path === newArtifactPath),
      `submission must also accept new artifact ${newArtifactPath} from the task worktree`,
    );
    assert.ok(event.payload.execution.submission?.changedFiles?.includes("src/delivery.ts"));
    assert.ok(event.payload.execution.submission?.productionDelta);
    assert.equal(readFileSync(canonicalCloseout, "utf8"), revisedCloseout);
    assert.equal(readFileSync(canonicalArtifact, "utf8"), amendedArtifactBody);
    const amendedAnchor = event.payload.execution.submission?.artifacts?.find(
      (artifact) => artifact.path === artifactPath,
    );
    assert.ok(amendedAnchor, `submission must freeze the renamed ${artifactPath} blob`);
    const contentReader = makeTaskEventReader({ repoId, rootDir });
    try {
      const frozenArtifact = readSubmissionArtifact(
        {
          store: contentReader,
          cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
        },
        packagePath,
        artifactPath,
        amendedAnchor.revision,
        amendedAnchor.blobSha256,
      );
      assert.equal(Buffer.from(frozenArtifact.body).toString("utf8"), amendedArtifactBody);
    } finally {
      await contentReader.drain();
    }
  } finally {
    await cell.close();
    removeTempStoreRoot(rootDir);
  }
});
