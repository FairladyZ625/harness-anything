// harness-test-tier: integration
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/storage";
import { isTaskEvent } from "@harness-anything/kernel";
import { readSubmissionArtifact } from "@harness-anything/application/commands";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { seedBuiltinSchedules } from "../src/schedule-builtin-executor.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture, realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";
import { runWorktreeSetup, taskWorktreeDocumentBase } from "../src/worktree-setup.ts";

test("task submit refreshes worker artifacts and carries new worktree artifacts", async () => {
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
  writeFileSync(path.join(rootDir, ".gitignore"), "harness/\nledger-data/\n.harness/\n.worktrees/\n");
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
    assert.notEqual(workerBeforeRename.ino, centerBeforeRename.ino, "worktree files are independent from the center");
    const replacementPath = path.join(path.dirname(workerArtifact), ".worker-generated.md.tmp");
    writeFileSync(replacementPath, amendedArtifactBody);
    renameSync(replacementPath, workerArtifact);
    assert.notEqual(
      statSync(workerArtifact).ino,
      statSync(canonicalArtifact).ino,
      "atomic replacement keeps the worktree independent",
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
      `submission must refresh the changed worker artifact ${artifactPath}`,
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
    rmSync(rootDir, { recursive: true, force: true });
  }
});

for (const external of [false, true])
  test(`bidirectional single-root with ${external ? "renamed ignored ledger" : "ignored subrepo"} preserves canonical updates and refreshes clean worktrees`, async () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), "ha-dual-root-local-")),
      rootDir = path.join(temporaryRoot, "repo"),
      ledger = path.join(rootDir, external ? "ledger-data" : "harness"),
      taskId = "task-dual-root-local",
      executionId1 = "execution-dual-root-1",
      repoId = workspaceId("dual-root-local"),
      workerHolder = withPolicyGroup(
        {
          actor: { principal: { personId: "owner" }, executor: { kind: "agent" as const, id: "worker" } },
          source: "local" as const,
        },
        "admin",
      ),
      ceoActor = withPolicyGroup(
        {
          actor: { principal: { personId: "owner" }, executor: null },
          source: "local" as const,
        },
        "admin",
      );
    mkdirSync(rootDir);
    initRepo(rootDir);
    git(rootDir, "branch", "-M", "main");
    writeFileSync(path.join(rootDir, ".gitignore"), "harness/\nledger-data/\n.harness/\n.worktrees/\n");
    git(rootDir, "add", ".gitignore");
    git(rootDir, "commit", "-qm", "test: ignore subrepo harness");
    mkdirSync(ledger);
    initRepo(ledger);
    writeFileSync(path.join(ledger, "harness.yaml"), "settings:\n  closeout:\n    profile: strict\n");
    if (external) {
      mkdirSync(path.join(rootDir, "harness"));
      writeFileSync(path.join(rootDir, "harness", "harness.yaml"), "layout:\n  authoredRoot: ledger-data\n");
    }
    const cell = await openBootstrappedRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "dual-root-local-fixture",
    });
    try {
      await seedBuiltinSchedules({ cell, binding: workerHolder });
      const created = await cell.run({ kind: "task-create", taskId, title: "Dual root local test" }, ceoActor);
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      await waitForFixturePublication(cell, created.opId, ceoActor);
      const packagePath = String((created as { readonly packagePath?: string }).packagePath);
      writeFileSync(path.join(ledger, packagePath, "task_plan.md"), realizedTaskPlan("Dual root local test"));
      const planReceipt = await cell.run({ kind: "doc-submit", paths: [`${packagePath}/task_plan.md`] }, ceoActor);
      assert.equal(planReceipt.outcome, "applied", JSON.stringify(planReceipt));
      await waitForFixturePublication(cell, planReceipt.opId, ceoActor);
      const canonicalPlan = path.join(ledger, packagePath, "task_plan.md"),
        canonicalCloseout = path.join(ledger, packagePath, "closeout.md"),
        explainerPath = `${packagePath}/artifacts/explainer.html`,
        canonicalExplainer = path.join(ledger, explainerPath),
        planV1 = readFileSync(canonicalPlan, "utf8");

      // Leave canonical closeout as the untouched skeleton from task-create; start worker worktree.
      const started = await cell.run({ kind: "task-start", taskId, executionId: executionId1 }, workerHolder);
      assert.equal(started.outcome, "applied", JSON.stringify(started));
      await waitForFixturePublication(cell, started.opId, workerHolder);

      const worker = path.join(rootDir, ".worktrees", taskId),
        workerPlan = path.join(worker, external ? "ledger-data" : "harness", packagePath, "task_plan.md"),
        workerCloseout = path.join(worker, external ? "ledger-data" : "harness", packagePath, "closeout.md"),
        workerExplainer = path.join(worker, external ? "ledger-data" : "harness", explainerPath);
      assert.equal(readFileSync(workerPlan, "utf8"), planV1);

      // CEO updates canonical task_plan.md while worker worktree still holds v1.
      const planV2 = `${planV1}\n## Rework Round 2\nVerify single-root propagation.\n`;
      writeFileSync(canonicalPlan, planV2);
      const planSubmit = await cell.run({ kind: "doc-submit", paths: [`${packagePath}/task_plan.md`] }, ceoActor);
      assert.equal(planSubmit.outcome, "applied", JSON.stringify(planSubmit));
      await waitForFixturePublication(cell, planSubmit.opId, ceoActor);

      // Worker leaves workerPlan at v1, writes full closeout + explainer.html only inside worktree.
      const fullCloseout =
          "## Summary\nWorker implemented delivery and wrote closeout inside the worktree.\n" +
          "## Verification\nTargeted integration test inspected frozen event.\n" +
          "## Residual Risk\nNone.\n" +
          "## Same Mechanism Elsewhere\nChecked edge and external layouts.\n",
        explainerBody = "<!doctype html><html><body><h1>Single Root Explainer</h1></body></html>\n";
      writeFileSync(workerCloseout, fullCloseout);
      mkdirSync(path.dirname(workerExplainer), { recursive: true });
      writeFileSync(workerExplainer, explainerBody);
      mkdirSync(path.join(worker, "src"), { recursive: true });
      writeFileSync(path.join(worker, "src", "feature.ts"), "export const ok = true;\n");
      git(worker, "add", "src/feature.ts");
      git(worker, "commit", "-qm", "feat: dual root worktree change");

      let submitted = await cell.run({ kind: "task-submit", taskId, executionId: executionId1 }, workerHolder);
      for (let attempt = 0; submitted.outcome === "pending" && attempt < 4; attempt += 1) {
        await waitForFixturePublication(cell, submitted.opId, workerHolder);
        submitted = await cell.run({ kind: "task-submit", taskId, executionId: executionId1 }, workerHolder);
      }
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
      await waitForFixturePublication(cell, submitted.opId, workerHolder);

      assert.equal(
        readFileSync(canonicalCloseout, "utf8"),
        fullCloseout,
        "single submit must freeze the worktree closeout instead of canonical skeleton",
      );
      assert.equal(readFileSync(canonicalExplainer, "utf8"), explainerBody);
      assert.equal(
        readFileSync(canonicalPlan, "utf8"),
        planV2,
        "untouched v1 task_plan.md in worktree must never roll back canonical v2 task_plan.md",
      );
      const event = makeTaskEventReader({ repoId, rootDir })
        .read()
        .events.find((entry) => isTaskEvent(entry) && entry.type === "execution_submitted" && entry.taskId === taskId);
      assert.ok(event && isTaskEvent(event) && event.type === "execution_submitted");
      const explainerAnchor = event.payload.execution.submission?.artifacts?.find((a) => a.path === explainerPath);
      assert.ok(explainerAnchor, "submission must freeze explainer.html artifact from worktree");
      const contentReader = makeTaskEventReader({ repoId, rootDir });
      try {
        const frozen = readSubmissionArtifact(
          {
            store: contentReader,
            cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
          },
          packagePath,
          explainerPath,
          explainerAnchor.revision,
          explainerAnchor.blobSha256,
        );
        assert.equal(frozen.body, explainerBody);
      } finally {
        await contentReader.drain();
      }

      // Reverse sync on next dispatch / worktree setup: refreshes unmodified worker task_plan.md & base to v2.
      await runWorktreeSetup({ rootDir, cwd: worker, taskId, steps: [], fresh: false });
      assert.equal(
        readFileSync(workerPlan, "utf8"),
        planV2,
        "re-setup must refresh unmodified worktree task_plan.md to latest canonical v2",
      );
      assert.equal(
        readFileSync(taskWorktreeDocumentBase(worker, `${packagePath}/task_plan.md`), "utf8"),
        planV2,
        "taskWorktreeDocumentBase must align with refreshed canonical task_plan.md",
      );

      // Concurrent divergence: worker edits task_plan AND CEO updates canonical to v3 -> CAS rejects cleanly.
      const planV3 = `${planV2}\n## Round 3\nConcurrent edit check.\n`;
      writeFileSync(canonicalPlan, planV3);
      const planV3Submit = await cell.run({ kind: "doc-submit", paths: [`${packagePath}/task_plan.md`] }, ceoActor);
      assert.equal(planV3Submit.outcome, "applied", JSON.stringify(planV3Submit));
      await waitForFixturePublication(cell, planV3Submit.opId, ceoActor);

      writeFileSync(workerPlan, `${planV2}\n## Worker conflicting note\n`);
      const conflict = await cell.run({ kind: "doc-submit", taskId }, workerHolder);
      assert.equal(conflict.outcome, "op_rejected", JSON.stringify(conflict));
      assert.equal(readFileSync(canonicalPlan, "utf8"), planV3, "CAS conflict must keep canonical v3 intact");
    } finally {
      await cell.close();
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
