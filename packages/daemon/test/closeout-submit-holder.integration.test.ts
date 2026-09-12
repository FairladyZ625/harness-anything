// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isTaskEvent, makeTaskEventReader } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

test("closeout submit preserves holder authority and resumes one cut after a discarded response", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-closeout-holder-")),
    ledger = path.join(rootDir, "harness"),
    repoId = workspaceId("closeout-holder"),
    taskId = "task-closeout-holder",
    executionId = "execution-closeout-holder",
    holder = {
      actor: { principal: { personId: "owner" }, executor: { kind: "agent" as const, id: "worker-holder" } },
      source: "local" as const,
    },
    other = {
      actor: { principal: holder.actor.principal, executor: { kind: "agent" as const, id: "worker-other" } },
      source: "local" as const,
    };
  initRepo(rootDir);
  mkdirSync(ledger);
  initRepo(ledger);
  const cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "holder-fixture" });
  try {
    const created = await cell.run(
      { kind: "task-create", taskId, title: "Holder closeout", presetId: "docs-task" },
      holder,
    );
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
      "Holder closeout",
    );
    const started = await cell.run({ kind: "task-start", taskId, executionId }, holder);
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    await waitForFixturePublication(cell, started.opId, holder);
    const closeoutPath = path.join(ledger, packagePath, "closeout.md"),
      artifacts = path.join(ledger, packagePath, "artifacts"),
      completeBodyTemplate =
        "## Summary\nDelivered the private report.\n" +
        "## Verification\n- Targeted test passed.\n- Real publication observed.\n" +
        "## Residual Risk\n- 已知缺口：pending external audit.\n- Accepted risk: manual review.\n" +
        "## Same Mechanism Elsewhere\n- Sibling known gap remains unverified.\n";
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(path.join(artifacts, "report.md"), "# Evidence\n\nHolder-bound receipt under test.\n");
    const artifactReceipt = await cell.run({ kind: "doc-submit", taskId }, holder);
    assert.equal(artifactReceipt.outcome, "applied", JSON.stringify(artifactReceipt));
    const completeBody = completeBodyTemplate.replace(
      "Delivered the private report.",
      `Delivered the private report. artifact:${packagePath}/artifacts/report.md@${artifactReceipt.revision}`,
    );
    writeFileSync(closeoutPath, completeBody.replace(/## Verification\n[\s\S]*?(?=## Residual Risk)/u, ""));
    const submit = async () => {
      let receipt = await cell.run({ kind: "task-submit", taskId, executionId }, holder);
      for (let attempt = 0; receipt.outcome === "pending" && attempt < 4; attempt += 1) {
        await waitForFixturePublication(cell, receipt.opId, holder);
        receipt = await cell.run({ kind: "task-submit", taskId, executionId }, holder);
      }
      return receipt;
    };
    const missing = await submit();
    assert.equal(missing.outcome, "op_rejected", JSON.stringify(missing));
    assert.equal(missing.code, "closeout_placeholder", JSON.stringify(missing));
    assert.match(JSON.stringify(missing.next), /Verification/u);
    const foreign = await cell.run({ kind: "task-submit", taskId, executionId }, other);
    assert.equal(foreign.outcome, "op_rejected", JSON.stringify(foreign));
    assert.match(String(foreign.code), /lease/u);
    writeFileSync(closeoutPath, completeBody);
    const submitted = await submit();
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    await waitForFixturePublication(cell, submitted.opId, holder);
    const events = () =>
        makeTaskEventReader({ repoId, rootDir })
          .read()
          .events.filter(
            (event) => isTaskEvent(event) && event.taskId === taskId && event.type === "execution_submitted",
          ),
      before = events();
    assert.equal(before.length, 1);
    const first = before[0]!;
    assert.ok(isTaskEvent(first) && first.type === "execution_submitted");
    const packet = first.payload.execution.submission!;
    assert.deepEqual(packet.knownGaps, [
      "- 已知缺口：pending external audit.\n- Accepted risk: manual review.",
      "- Sibling known gap remains unverified.",
    ]);
    assert.deepEqual(packet.verificationNotes, ["- Targeted test passed.\n- Real publication observed."]);
    assert.ok(packet.deliverables.some((item) => item.endsWith("/artifacts/report.md")));
    const originalCut = packet.commitSha;
    git(rootDir, "commit", "--allow-empty", "-qm", "test: move public head after delivery");
    git(ledger, "commit", "--allow-empty", "-qm", "test: move ledger head after delivery");
    assert.notEqual(git(ledger, "rev-parse", "HEAD"), originalCut);
    const repeated = await submit();
    assert.equal(repeated.outcome, "applied", JSON.stringify(repeated));
    assert.equal(repeated.opId, submitted.opId);
    assert.deepEqual(events(), before, "discarding the response must not create another submission event");
    writeFileSync(
      closeoutPath,
      completeBody.replace("Delivered the private report.", "Delivered the amended private report."),
    );
    let amended = await cell.run({ kind: "task-submit", taskId, executionId, amend: true }, holder);
    for (let attempt = 0; amended.outcome === "pending" && attempt < 4; attempt += 1) {
      await waitForFixturePublication(cell, amended.opId, holder);
      amended = await cell.run({ kind: "task-submit", taskId, executionId, amend: true }, holder);
    }
    assert.equal(amended.outcome, "applied", JSON.stringify(amended));
    await waitForFixturePublication(cell, amended.opId, holder);
    assert.notEqual(amended.opId, submitted.opId);
    assert.equal(events().length, 2);
    const amendedRetry = await submit();
    assert.equal(amendedRetry.outcome, "applied", JSON.stringify(amendedRetry));
    assert.equal(amendedRetry.opId, amended.opId, "retry must point-read the latest amendment");
    assert.equal(events().length, 2);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
