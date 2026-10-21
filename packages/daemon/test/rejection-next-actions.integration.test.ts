// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, makeTaskProjection } from "@harness-anything/kernel";
import { parseThinCommand } from "@harness-anything/cli/internal/cli/thin-command";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { rejectHostAction } from "../src/daemon-host-errors.ts";
import { withAuthorizationDecision } from "../src/repo-cell-authorization.ts";
import { settleSquadChildAssignment } from "../src/repo-cell-squad-child.ts";
import { failed } from "../src/repo-cell-settlement.ts";
import { publishExecutedVerticalScript } from "../src/vertical-script-actions.ts";
import { readWorkerRemoteCommit } from "../src/runtime-worker-push.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { commitDelivery } from "./review-independence.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

function writeCloseout(rootDir: string, packagePath: unknown): void {
  writeFileSync(
    path.join(rootDir, "harness", String(packagePath), "closeout.md"),
    `# Closeout\n\n## Summary\n\nDelivery ${git(rootDir, "rev-parse", "fixture-delivery")} is ready.\n\n` +
      "## Verification\n\nIntegration assertions exercise the lifecycle refusals.\n\n" +
      "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nShared lifecycle authorization.\n",
  );
}

test("submit lease refusals name the state-specific command that advances the execution", async () => {
  const rootDir = workspace("submit-exit"),
    taskId = "task-submit-exit",
    executionId = "exec-submit-exit",
    holder = binding("holder"),
    reviewer = withPolicyGroup(binding("reviewer"), "maintainer");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId: workspaceId("submit-exit"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "submit-exit",
    });
    const created = await cell.run({ kind: "task-create", taskId, title: "Submit exit" }, holder);
    assert.equal(created.outcome, "applied");
    await waitForFixturePublication(cell, created.opId, holder);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, holder),
    );
    const rejectedTransition = await cell.run({ kind: "task-transition", taskId, status: "done" }, holder);
    assert.equal(rejectedTransition.code, "invalid_transition", JSON.stringify(rejectedTransition));
    assert.deepEqual(rejectedTransition.nextActions, [
      `ha task start ${taskId} [--stack-on <stack-on>] [--execution-id <execution-id>] [--ttl-ms <ttl-ms>] [--dry-run]`,
    ]);
    writeCloseout(rootDir, (created as Record<string, unknown>).packagePath);
    const withoutLease = await cell.run({ kind: "task-submit", taskId, executionId }, holder);
    assert.equal(withoutLease.code, "lease_required", JSON.stringify(withoutLease));
    assert.deepEqual(
      withoutLease.unmetCriteria?.map(({ ref }) => ref),
      ["repo-cell-proof/proofFor.SubmitExecution"],
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, holder)).outcome, "applied");
    const submitted = await cell.run({ kind: "task-submit", taskId, executionId }, holder);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));

    const alreadySubmitted = await cell.run({ kind: "task-submit", taskId, executionId }, holder);
    assert.equal(alreadySubmitted.outcome, "applied", JSON.stringify(alreadySubmitted));
    assert.equal(alreadySubmitted.opId, submitted.opId, "the original holder resumes the same cut");
    const otherHolder = await cell.run({ kind: "task-submit", taskId, executionId }, binding("other-holder"));
    assert.equal(otherHolder.code, "lease_required", JSON.stringify(otherHolder));
    // The refusal names the owning creator's two real lanes (2026-09-30 defect: it named none, so
    // an owner with a patched branch had to dispatch another worker to resubmit).
    assert.match(String(otherHolder.rejectionExplanation), /Only the original submission holder/u);
    assert.match(String(otherHolder.rejectionExplanation), /ha task submit task-submit-exit --amend --as-owner/u);
    assertSubmitHintsParse(String(otherHolder.rejectionExplanation));
    assert.match(String(otherHolder.rejectionExplanation), /ha task adjudicate task-submit-exit --return\./u);
    const otherSettle = await cell.run({ kind: "task-settle", taskId }, binding("other-holder"));
    assert.equal(otherSettle.code, "lease_required", JSON.stringify(otherSettle));
    assert.match(String(otherSettle.rejectionExplanation), /ha task submit task-submit-exit --amend --as-owner/u);
    assertSubmitHintsParse(String(otherSettle.rejectionExplanation));
    assert.equal(
      (
        await cell.run(
          { kind: "task-adjudicate", taskId, executionId, forward: true, reason: "Forward submit-exit cut." },
          holder,
        )
      ).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Independent review.", evidenceChecked: ["integration"] }),
    );
    const reportDir = path.join(
      rootDir,
      "harness",
      String((created as Record<string, unknown>).packagePath),
      "artifacts",
      "reports",
    );
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(path.join(reportDir, "submit-exit.md"), "# Review submit-exit\n\nPhysical review findings.\n");
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-review-execution",
            taskId,
            executionId,
            reviewId: "review-submit-exit",
            fromFile: "review.json",
          },
          reviewer,
        )
      ).outcome,
      "applied",
    );
    // After a recorded verdict the cut sits in in_review; the owner's rejoin refusal must name the
    // same-cut return order with the recorded review id.
    const ownerRejoin = await cell.run(
      { kind: "task-submit", taskId, executionId, asOwner: true },
      binding("other-holder"),
    );
    assert.equal(ownerRejoin.code, "lease_required", JSON.stringify(ownerRejoin));
    assert.match(
      String(ownerRejoin.rejectionExplanation),
      /ha task adjudicate task-submit-exit --return --review-id review-submit-exit\./u,
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("progress lease mismatch names the holder and a release plus re-entry route that terminates", async () => {
  const rootDir = workspace("progress-exit"),
    taskId = "task-progress-exit",
    executionId = "exec-progress-exit",
    holder = binding("holder"),
    next = binding("next");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId: workspaceId("progress-exit"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "progress-exit",
    });
    const created = await cell.run({ kind: "task-create", taskId, title: "Progress exit" }, holder);
    assert.equal(created.outcome, "applied");
    await waitForFixturePublication(cell, created.opId, holder);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, holder),
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, holder)).outcome, "applied");
    const rejected = await cell.run({ kind: "task-progress-append", taskId, text: "Wrong holder." }, next);
    assert.equal(rejected.code, "progress_lease_mismatch", JSON.stringify(rejected));
    assert.equal((await cell.run({ kind: "task-release", taskId }, holder)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, next)).outcome, "applied");
    assert.equal(
      (await cell.run({ kind: "task-progress-append", taskId, text: "Recovered holder." }, next)).outcome,
      "applied",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("start rejection identifies the active execution and its reuse command", async (context) => {
  const rootDir = workspace("start-reuse"),
    taskId = "task-start-reuse",
    executionId = "exec-start-reuse",
    owner = binding("owner");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId: workspaceId("start-reuse"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "start-reuse",
    });
    const created = await cell.run({ kind: "task-create", taskId, title: "Start reuse" }, owner);
    assert.equal(created.outcome, "applied");
    await waitForFixturePublication(cell, created.opId, owner);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, owner)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-release", taskId }, owner)).outcome, "applied");
    const rejected = await cell.run({ kind: "task-start", taskId, executionId: "exec-replacement" }, owner);
    assert.equal(rejected.code, "invalid_transition", JSON.stringify(rejected));
    assert.deepEqual(rejected.diagnostic, {
      kind: "validation",
      entity: `task ${taskId}`,
      field: "executionId",
      actual: `active execution=${executionId} status=active node=implementation`,
      expectation: `Current round already has active execution exec-start-reuse; run ha task start ${taskId} without --execution-id, or with --execution-id exec-start-reuse, to rejoin it`,
    });
    context.diagnostic(`invalid_transition receipt=${JSON.stringify(rejected)}`);
    assert.equal((await cell.run({ kind: "task-start", taskId }, owner)).outcome, "applied");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("executor declaration rejection names its eligibility rule and review command", async (context) => {
  const rootDir = workspace("declare-assigned"),
    taskId = "task-declare-assigned",
    executionId = "exec-declare-assigned",
    worker = binding("assigned-worker");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId: workspaceId("declare-assigned"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "declare-assigned",
    });
    const created = await cell.run({ kind: "task-create", taskId, title: "Declare assigned" }, worker);
    assert.equal(created.outcome, "applied");
    await waitForFixturePublication(cell, created.opId, worker);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, worker),
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, worker)).outcome, "applied");
    writeCloseout(rootDir, (created as Record<string, unknown>).packagePath);
    assert.equal((await cell.run({ kind: "task-submit", taskId, executionId }, worker)).outcome, "applied");
    const rejected = await cell.run(
      { kind: "task-declare-executor", taskId, executionId, agent: "assigned-worker", reason: "Already assigned" },
      worker,
    );
    assert.equal(rejected.code, "invalid_proof", JSON.stringify(rejected));
    assert.deepEqual(rejected.diagnostic, {
      kind: "validation",
      entity: `execution ${executionId}`,
      field: "declareExecutor",
      actual: "status=submitted node=review executor=agent:assigned-worker",
      expectation:
        "Use declare-executor only when status=submitted node=review executor=none; this assigned execution " +
        `must continue with ha task review-execution ${taskId} --execution-id ${executionId} ` +
        "--review-id <review-id> --from-file <review.json>",
    });
    context.diagnostic(`invalid_proof receipt=${JSON.stringify(rejected)}`);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("executor declaration and completion context refusals name projection rebuild and the exact retry", async () => {
  const rootDir = workspace("projection-exits"),
    repoId = workspaceId("projection-exits"),
    taskId = "task-projection-exits",
    executionId = "exec-projection-exits",
    owner = withPolicyGroup(
      { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" as const },
      "admin",
    ),
    declarer = binding("declared-executor"),
    cache = path.join(rootDir, ".harness/cache/task.sqlite");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "projection-exits-one" });
    const created = await cell.run({ kind: "task-create", taskId, title: "Projection exits" }, owner);
    assert.equal(created.outcome, "applied");
    await waitForFixturePublication(cell, created.opId, owner);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, owner)).outcome, "applied");
    const fact = await cell.run(
      {
        kind: "fact-record",
        taskId,
        statement: "Completion requirements are checked after projection recovery.",
        evidenceSource: "test:projection-exits",
        confidence: "high",
        memoryClass: "semantic",
        memoryTags: [],
      },
      owner,
    );
    assert.equal(fact.outcome, "applied", JSON.stringify(fact));
    const deliveryRoot = path.join(rootDir, ".worktrees", taskId);
    await commitDelivery(cell, deliveryRoot);
    assert.equal(git(deliveryRoot, "diff", "--name-only", "HEAD^", "HEAD"), "README.md");
    writeCloseout(rootDir, (created as Record<string, unknown>).packagePath);
    const submitted = await cell.run({ kind: "task-submit", taskId, executionId }, owner);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    const submittedEvent = makeTaskEventReader({ repoId: cell.repoId, rootDir }).readEvent(submitted.opId);
    assert.equal(submittedEvent?.type, "execution_submitted");
    if (submittedEvent?.type !== "execution_submitted") throw new Error("submitted execution event missing");
    assert.equal(
      submittedEvent.payload.execution.submission?.commitSha,
      git(deliveryRoot, "rev-parse", "HEAD"),
      "refusal diagnostics require a real submitted code cut",
    );
    const projection = makeTaskProjection({ rootDir, eventStore: makeTaskEventReader({ repoId, rootDir }) });
    const submittedRevision = projection.read(taskId).snapshot.revision;
    projection.close();
    await cell.close();
    cell = undefined;

    mutate(cache, "DELETE FROM task_snapshot WHERE task_id = ?", taskId);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "projection-exits-two" });
    const declaration = await cell.run(
      { kind: "task-declare-executor", taskId, executionId, reason: "Recover omitted executor" },
      declarer,
    );
    assert.equal(declaration.code, "content_not_ready", JSON.stringify(declaration));
    assert.equal((await cell.run({ kind: "projection-rebuild" }, declarer)).outcome, "applied");
    const withoutDispatch = await cell.run(
      { kind: "task-declare-executor", taskId, executionId, reason: "Recover omitted executor" },
      declarer,
    );
    assert.equal(withoutDispatch.code, "invalid_proof", JSON.stringify(withoutDispatch));
    await cell.close();
    cell = undefined;

    mutate(cache, "DELETE FROM task_package WHERE task_id = ?", taskId);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "projection-exits-three" });
    const metadata = await cell.run({ kind: "task-complete", taskId, executionId }, owner);
    assert.equal(metadata.code, "projection_unknown", JSON.stringify(metadata));
    assert.deepEqual((metadata as Record<string, unknown>).next, [
      {
        action: "ha daemon projection rebuild",
        reason: "Rebuild the unavailable canonical task projection before retrying completion.",
        authority: "person-owner",
        readCut: { revision: submittedRevision, iteration: 0, executionId },
      },
    ]);
    assert.equal((await cell.run({ kind: "projection-rebuild" }, owner)).outcome, "applied");
    const retry = await cell.run({ kind: "task-complete", taskId, executionId }, owner);
    assert.equal(retry.code, "delivery_missing", JSON.stringify(retry));
    const retryNext = (retry as Record<string, unknown>).next as readonly { action: string }[];
    assert.match(retryNext[0]?.action ?? "", /Merge the delivery with node tools\/pr-merge\.mjs/u);
    assert.doesNotMatch(JSON.stringify(retry), /task ci|ci observe/u);
    await cell.close();
    cell = undefined;

    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "projection-exits-four" });
    mutate(cache, "DELETE FROM preset_snapshot");
    const closeout = await cell.run({ kind: "task-complete", taskId, executionId }, owner);
    assert.equal(closeout.code, "delivery_missing", JSON.stringify(closeout));
    assert.equal((await cell.run({ kind: "projection-rebuild" }, owner)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-complete", taskId, executionId }, owner)).code, "delivery_missing");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("symptom task_5df51336056c76d54946b231a7: decision propose packet issues name the field instead of a bare invalid_command", async () => {
  const rootDir = workspace("decision-packet-issues"),
    repoId = workspaceId("decision-packet-issues");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "decision-packet-issues" });
    const rejected = await cell.run(
      {
        kind: "decision-propose",
        body: "# Over-length whyNot\n\nKeep packet diagnostics specific to the rejected field.\n",
        jsonInput: JSON.stringify({
          title: "Over-length whyNot",
          question: "Does the packet validator name the problem?",
          riskTier: "medium",
          urgency: "medium",
          vertical: "default",
          preset: "default",
          decisionClass: "ordinary",
          appliesTo: { modules: ["daemon"], productLines: [] },
          chosen: [{ id: "CH1", text: "Use events" }],
          rejected: [{ id: "RJ1", text: "Use files", whyNot: "x".repeat(200) }],
          claims: [],
          fulfillments: [],
        }),
      },
      binding("decision-packet-issues"),
    );
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "invalid_command");
    assert.match(String(rejected.rejectionExplanation), /whyNot/u);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("symptom task_6edcc0d990dae7e42f4bc93ff9 (review-execution before submit): review before submission names the required state instead of a bare invalid_command", async () => {
  const rootDir = workspace("review-before-submit"),
    taskId = "task-review-before-submit",
    executionId = "exec-review-before-submit",
    owner = binding("review-before-submit-owner"),
    reviewer = withPolicyGroup(binding("review-before-submit-reviewer"), "maintainer");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId: workspaceId("review-before-submit"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "review-before-submit",
    });
    const created = await cell.run({ kind: "task-create", taskId, title: "Review before submit" }, owner);
    assert.equal(created.outcome, "applied");
    await waitForFixturePublication(cell, created.opId, owner);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, owner)).outcome, "applied");
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Independent review.", evidenceChecked: ["integration"] }),
    );
    const rejected = await cell.run(
      { kind: "task-review-execution", taskId, executionId, reviewId: "review-early", fromFile: "review.json" },
      reviewer,
    );
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "invalid_transition", JSON.stringify(rejected));
    assert.match(String(rejected.rejectionExplanation), /submitted execution/u);
    assert.deepEqual(rejected.diagnostic, {
      kind: "validation",
      entity: `execution ${executionId}`,
      field: "status",
      actual: "active",
      expectation: "Execution status must be submitted on the current task iteration before review",
    });
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("symptom task_6edcc0d990dae7e42f4bc93ff9 (submit packet): a submission packet on task submit names the closeout route instead of a bare invalid_command", async () => {
  const rootDir = workspace("submit-packet"),
    taskId = "task-submit-packet",
    executionId = "exec-submit-packet",
    holder = binding("holder");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId: workspaceId("submit-packet"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "submit-packet",
    });
    const created = await cell.run({ kind: "task-create", taskId, title: "Submit packet" }, holder);
    assert.equal(created.outcome, "applied");
    await waitForFixturePublication(cell, created.opId, holder);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, holder),
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, holder)).outcome, "applied");
    const rejected = await cell.run({ kind: "task-submit", taskId, executionId, fromFile: "sub.json" }, holder);
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "invalid_command", JSON.stringify(rejected));
    assert.match(String(rejected.rejectionExplanation), /Write closeout\.md/u);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("symptom task_6edcc0d990dae7e42f4bc93ff9 (complete --path): code-doc reconcile against a ledger-internal path names the Git-root requirement instead of a bare invalid_proof", async () => {
  const rootDir = workspace("reconcile-wrong-root"),
    taskId = "task-reconcile-wrong-root",
    executionId = "exec-reconcile-wrong-root",
    holder = binding("holder");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId: workspaceId("reconcile-wrong-root"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "reconcile-wrong-root",
    });
    const created = await cell.run({ kind: "task-create", taskId, title: "Reconcile wrong root" }, holder);
    assert.equal(created.outcome, "applied");
    await waitForFixturePublication(cell, created.opId, holder);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, holder),
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, holder)).outcome, "applied");
    const deliveryRoot = path.join(rootDir, ".worktrees", taskId);
    await commitDelivery(cell, deliveryRoot);
    assert.equal(git(deliveryRoot, "diff", "--name-only", "HEAD^", "HEAD"), "README.md");
    writeCloseout(rootDir, (created as Record<string, unknown>).packagePath);
    const submitted = await cell.run({ kind: "task-submit", taskId, executionId }, holder);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    const submittedEvent = makeTaskEventReader({ repoId: cell.repoId, rootDir }).readEvent(submitted.opId);
    assert.equal(submittedEvent?.type, "execution_submitted");
    if (submittedEvent?.type !== "execution_submitted") throw new Error("submitted execution event missing");
    assert.equal(
      submittedEvent.payload.execution.submission?.commitSha,
      git(deliveryRoot, "rev-parse", "HEAD"),
      "refusal diagnostics require a real submitted code cut",
    );
    const rejected = await cell.run(
      { kind: "task-code-doc-reconcile", taskId, paths: ["harness/agents/x.json"] },
      withPolicyGroup(holder, "contributor"),
    );
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "invalid_proof", JSON.stringify(rejected));
    assert.match(String(rejected.rejectionExplanation), /harness\/agents\/x\.json/u);
    assert.match(String(rejected.rejectionExplanation), /relative to the Git repository/u);
    assert.deepEqual(rejected.diagnostic, {
      kind: "validation",
      entity: "code-doc reconciliation",
      field: "paths[0]",
      actual: "harness/agents/x.json",
      expectation: "Path must be relative to the Git repository that owns the submitted commit",
    });
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("symptom task_356fe6c7a05cb987d93a807b46: relation relate against a nonexistent entity names the missing ref instead of a bare entity_not_found", async () => {
  const rootDir = workspace("relation-entity-not-found"),
    repoId = workspaceId("relation-entity-not-found");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "relation-entity-not-found" });
    const rejected = await cell.run(
      {
        kind: "relation-relate",
        sourceRef: "task/task-does-not-exist-1",
        targetRef: "task/task-does-not-exist-2",
        relationType: "depends-on",
        expectedVersion: 0,
      },
      binding("relation-entity-not-found"),
    );
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "entity_not_found", JSON.stringify(rejected));
    assert.match(String(rejected.rejectionExplanation), /task-does-not-exist-1 does not exist/u);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("review-execution against a nonexistent task names the missing task", async () => {
  const rootDir = workspace("review-task-not-found"),
    repoId = workspaceId("review-task-not-found");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "review-task-not-found" });
    const rejected = await cell.run(
      { kind: "task-review-execution", taskId: "task-does-not-exist", reviewId: "review-missing" },
      binding("review-task-not-found"),
    );
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "entity_not_found", JSON.stringify(rejected));
    assert.match(String(rejected.rejectionExplanation), /Task task-does-not-exist does not exist/u);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("task reads against a task id the projection does not have answer task_not_found naming the requested id", async () => {
  const rootDir = workspace("task-read-not-found"),
    repoId = workspaceId("task-read-not-found"),
    reader = binding("task-read-not-found");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "task-read-not-found" });
    // A short prefix and a full-length id that was never created are the same question:
    // does the canonical projection hold this task?
    for (const taskId of ["task_9bfc3029", "task_00000000000000000000000000"]) {
      for (const kind of ["task-show", "task-read-set", "task-review"] as const) {
        const shown = await cell.run({ kind, taskId }, reader);
        assert.equal(shown.outcome, "op_rejected", `${kind} ${JSON.stringify(shown)}`);
        assert.equal(shown.code, "task_not_found", `${kind} ${JSON.stringify(shown)}`);
        assert.match(String(shown.rejectionExplanation), new RegExp(taskId, "u"), kind);
      }
      const dispatches = await cell.read("repo.task.dispatches", { taskId }, reader).then(
        () => null,
        (error: Error & { code?: string }) => error,
      );
      assert.equal(dispatches?.code, "task_not_found", String(dispatches));
      assert.match(String(dispatches?.message), new RegExp(taskId, "u"));
    }
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a business refusal keeps its own sentence and no refusal can carry a credential out", async () => {
  const rootDir = workspace("explanation-exposure"),
    repoId = workspaceId("explanation-exposure"),
    actor = binding("explanation-exposure");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "explanation-exposure" });
    // Half one, end to end: an ordinary guard rejection stays self-describing. The report is what
    // makes the refusal actionable, so it has to survive the outbound boundary verbatim.
    const rejected = await cell.run(
      {
        kind: "relation-relate",
        sourceRef: "task/task-explanation-missing",
        targetRef: "task/task-explanation-other",
        relationType: "depends-on",
        expectedVersion: 0,
      },
      actor,
    );
    assert.equal(rejected.code, "entity_not_found", JSON.stringify(rejected));
    assert.match(String(rejected.rejectionExplanation), /task-explanation-missing does not exist/u);

    // Half two: `delivery_publish_failed` is a *mixed* code. Its push producers author the detail
    // ("no Harness-managed worktree branch", "supported only for GitHub repositories") and the git/gh
    // relay branch redacts what it forwards, so the boundary must keep the authored sentence instead
    // of replacing it with a generic one that names the wrong cause. A credential inside it still
    // cannot leave.
    const leaked = failed(
      "op-leak",
      Object.assign(
        new Error(
          "git push failed: remote: https://x-access-token:ghp_realtokenvalue123@github.com/acme/repo.git\n" +
            "fatal: Authentication failed for 'https://github.com/acme/repo.git/'",
        ),
        { code: "delivery_publish_failed" },
      ),
    );
    assert.equal(leaked.outcome, "op_rejected", JSON.stringify(leaked));
    assert.equal(leaked.code, "delivery_publish_failed");
    const leakedText = String(leaked.rejectionExplanation);
    assert.doesNotMatch(leakedText, /ghp_realtokenvalue123/u, leakedText);
    assert.match(leakedText, /git push failed/u, "the relayed cause survives, minus the credential");

    // The lock's message nests a Git error under the workspace path, which is exactly where a
    // remote URL with an embedded credential surfaces. The authored frame is the operator's only
    // clue to who holds the lock, so the frame stays and the credential inside it is scrubbed.
    const locked = failed(
      "op-lock",
      Object.assign(
        new Error(`Workspace writer lock is held for ${rootDir}: fetch failed for Bearer abcdefghijklmnop`),
        { code: "writer_rejected" },
      ),
    );
    const lockedText = String(locked.rejectionExplanation);
    assert.doesNotMatch(lockedText, /abcdefghijklmnop/u, lockedText);
    assert.match(lockedText, /Workspace writer lock is held/u, "the operator's diagnostic survives");

    // The same rule for any other code: the sentence stays, the token goes.
    const scrubbed = failed(
      "op-scrub",
      Object.assign(new Error("Settings write refused: Authorization: Bearer sk-live-abcdefghijklmnop"), {
        code: "settings_write_requires_principal",
      }),
    );
    const scrubbedText = String(scrubbed.rejectionExplanation);
    assert.match(scrubbedText, /Settings write refused/u, "the authored sentence survives");
    assert.doesNotMatch(scrubbedText, /sk-live-abcdefghijklmnop/u, scrubbedText);

    // A latch's real failure is what tells an operator whether to reattach or fix the store; a GUI
    // read test asserts that text, so the boundary has to keep it.
    const latched = failed(
      "op-latch",
      Object.assign(new Error("Repository projection is unavailable: task bootstrap event identity is invalid"), {
        code: "repo_unavailable",
      }),
    );
    assert.match(String(latched.rejectionExplanation), /task bootstrap event identity is invalid/u);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// Every denylisted code used to be asserted only through a synthetic `failed()` call, so a producer
// that authored a *better* sentence could be silently replaced by the denylist and no test noticed.
// These drive the real producers and assert the sentence that reaches the receipt.
test("a task with no managed worktree publishes a refusal naming the missing branch, not a credential hint", async () => {
  const rootDir = workspace("push-no-worktree"),
    repoId = workspaceId("push-no-worktree"),
    taskId = "task_push_no_worktree",
    actor = binding("push-no-worktree");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "push-no-worktree" });
    // `task-package-artifact` has no repository-diff output shape, so `taskWorktreeBinding` is null
    // and the push refuses before it ever reads a credential or shells out to git.
    const created = await cell.run(
      { kind: "task-create", taskId, title: "Push without a worktree", presetId: "docs-task" },
      actor,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const pushed = await cell.run({ kind: "task-push", taskId }, actor);
    assert.equal(pushed.outcome, "op_rejected", JSON.stringify(pushed));
    assert.equal(pushed.code, "delivery_publish_failed", JSON.stringify(pushed));
    const explanation = String(pushed.rejectionExplanation);
    // The operator's cause: no managed worktree branch, not a GitHub credential problem.
    assert.match(explanation, /has no Harness-managed repository worktree branch to publish/u, explanation);
    assert.doesNotMatch(explanation, /Check the GitHub credential and push access/u, explanation);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a squad child refusal names the child's own code instead of dumping its receipt", async () => {
  // `settleSquadChildAssignment` is the real producer of the four child codes. A released child whose
  // release is refused must report the daemon's sentence plus the child's code — never the child
  // receipt, which carries raw evidence and sometimes a remote's stderr.
  const taskId = "task_squad_child_release",
    cell = {
      projection: {
        read: () => ({
          snapshot: {
            task: { taskId, status: "active" },
            lease: { executionId: "exec-child", version: 1 },
          },
        }),
      },
      taskSurfaceWrite: () => ({
        outcome: "op_rejected",
        code: "invalid_transition",
        evidence: "raw",
        message: "remote: ghp_realtokenvalue123",
        summary: "lease release refused by the remote",
      }),
      cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    } as never;
  await assert.rejects(
    settleSquadChildAssignment(
      cell,
      { taskId, runtimeSessionId: null, reason: "stage ended" },
      { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" },
      async () => ({}) as never,
    ),
    (error: Error & { code?: string; message: string }) => {
      assert.equal(error.code, "invalid_transition");
      assert.match(error.message, /The squad child lease was not released\./u);
      assert.match(error.message, /\(code: invalid_transition\)/u);
      assert.doesNotMatch(error.message, /ghp_realtokenvalue123|raw/u, error.message);
      return true;
    },
  );
});

test("a vertical script rejection names the status and report keys, never the report values", () => {
  // `publishExecutedVerticalScript` is the producer; its report can echo authored file contents, so
  // it reduces the report to its key names. Drive the real function with a failing plan.
  const prepared = {
      action: { scriptId: "vertical:software-coding:decision-conformance", dryRun: false },
      writePatterns: [],
      producePatterns: [],
    },
    stdout = JSON.stringify({
      schema: "vertical-script-plan/v1",
      scriptId: "vertical:software-coding:decision-conformance",
      ok: false,
      status: "rejected",
      report: { decisionCount: 3, findings: [{ path: "harness/secret.md", body: "ghp_realtokenvalue123" }] },
      warnings: [],
      changes: [],
    });
  assert.throws(
    () => publishExecutedVerticalScript({} as never, { prepared: prepared as never, stdout }),
    (error: Error & { code?: string; message: string }) => {
      assert.equal(error.code, "script_reported_failure");
      assert.match(error.message, /reported status rejected/u);
      assert.match(error.message, /report fields: decisionCount, findings/u);
      assert.doesNotMatch(error.message, /ghp_realtokenvalue123|harness\/secret\.md/u, error.message);
      return true;
    },
  );
});

test("the receipt boundary scrubs an explanation a caller hands over directly", () => {
  // `withAuthorizationDecision` is the last write for a durable receipt and accepts an explanation
  // from its caller. The executor-claim catch used to pass the raw thrown message through it, which
  // is how a remote URL reached the receipt; the boundary now scrubs whatever it is given.
  const receipt = withAuthorizationDecision(
    failed(
      "op-executor-claim",
      Object.assign(new Error("executor binding failed"), { code: "executor_binding_invalid" }),
    ),
    { outcome: "allowed", policyRef: "policy/repository", nextActions: [], reasonCodes: [] },
    [],
    "git push failed: https://x-access-token:ghp_realtokenvalue123@github.com/acme/repo.git",
  );
  const explanation = String(receipt.rejectionExplanation);
  assert.doesNotMatch(explanation, /ghp_realtokenvalue123/u, explanation);
  assert.match(explanation, /git push failed/u, "the caller's sentence survives the scrub");
});

test("a host-caught rejection keeps its explanation and drops the credential", () => {
  const receipt = rejectHostAction(
    { kind: "task-push", taskId: "task_host_reject" },
    "repo_unavailable",
    "attach failed fetching https://x-access-token:ghp_realtokenvalue123@github.com/acme/repo.git",
  );
  const explanation = String(receipt.rejectionExplanation);
  assert.match(explanation, /attach failed fetching/u);
  assert.doesNotMatch(explanation, /ghp_realtokenvalue123/u, explanation);
});

test(
  "a remote-triggered push refusal keeps the scrubbed remote text, not a credential hint",
  { skip: process.platform === "win32" ? "requires POSIX shell-script executables resolved through PATH" : false },
  async () => {
    // `delivery_publish_failed` has one remaining relayed producer: `readWorkerRemoteCommit` forwards
    // git's own stderr through `errorDetail`, which scrubs it. The receipt must keep that sentence —
    // it names what the remote actually said — and must not carry the token the URL embedded in it.
    const root = mkdtempSync(path.join(tmpdir(), "ha-push-relay-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      // An `ext::` transport whose helper prints a credential-bearing remote line to stderr: this is
      // the exact shape of a git failure that relays far-end text, without needing a live network.
      const helper = path.join(root, "relay.sh");
      writeFileSync(
        helper,
        '#!/bin/sh\necho "remote: https://x-access-token:ghp_realtokenvalue123@github.com/acme/repo.git" >&2\nexit 1\n',
        { mode: 0o755 },
      );
      execFileSync("git", ["-C", root, "config", "protocol.ext.allow", "always"]);
      execFileSync("git", ["-C", root, "remote", "add", "origin", `ext::${helper}`]);
      await assert.rejects(
        readWorkerRemoteCommit(root, "task_push_relay"),
        (error: Error & { code?: string; message: string }) => {
          assert.equal(error.code, "delivery_publish_failed");
          assert.match(
            error.message,
            /remote: https:\/\/x-access-token:REDACTED@github\.com|remote: https:\/\//u,
            error.message,
          );
          assert.doesNotMatch(error.message, /ghp_realtokenvalue123/u, error.message);
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a relayed remote refusal scrubs hosted-provider logins, not only github token prefixes",
  { skip: process.platform === "win32" ? "requires POSIX shell-script executables resolved through PATH" : false },
  async () => {
    // GitLab is a first-class hosting provider (hosting-provider.ts, tools/git-hooks/git-askpass),
    // and its PAT reaches git as URL userinfo (`https://oauth2:glpat-…@host`) — a shape the
    // token-prefix rules never matched. Git strips userinfo from its own stderr, so the ext:: relay
    // is the honest way to feed the shape a less careful remote or proxy can still print.
    const root = mkdtempSync(path.join(tmpdir(), "ha-push-provider-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      const helper = path.join(root, "relay.sh");
      writeFileSync(
        helper,
        "#!/bin/sh\n" +
          "echo \"fatal: unable to access 'https://oauth2:glpat-AbCdEf1234567890xyz@gitlab.com/acme/repo.git/': " +
          'The requested URL returned error: 403" >&2\n' +
          'echo "remote: https://user:pa55w0rd@bitbucket.internal/team/repo.git" >&2\n' +
          "exit 1\n",
        { mode: 0o755 },
      );
      execFileSync("git", ["-C", root, "config", "protocol.ext.allow", "always"]);
      execFileSync("git", ["-C", root, "remote", "add", "origin", `ext::${helper}`]);
      let thrown: (Error & { code?: string; message: string }) | undefined;
      await assert.rejects(
        readWorkerRemoteCommit(root, "task_push_provider"),
        (error: Error & { code?: string; message: string }) => {
          thrown = error;
          assert.equal(error.code, "delivery_publish_failed");
          assert.doesNotMatch(error.message, /glpat-AbCdEf1234567890xyz|pa55w0rd/u, error.message);
          assert.match(error.message, /gitlab\.com/u, "the remote that failed stays named");
          return true;
        },
      );
      const explanation = String(failed("op-provider", thrown).rejectionExplanation);
      assert.doesNotMatch(explanation, /glpat-AbCdEf1234567890xyz|pa55w0rd/u, explanation);
      assert.match(explanation, /gitlab\.com/u, explanation);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("a task push to an unusable origin explains the cause without exporting this host's paths", async () => {
  const rootDir = workspace("push-dead-origin"),
    repoId = workspaceId("push-dead-origin"),
    taskId = "task_push_dead_origin",
    executionId = "exec-push-dead-origin",
    holder = binding("push-dead-origin");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "push-dead-origin" });
    const created = await cell.run({ kind: "task-create", taskId, title: "Push to a dead origin" }, holder);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, holder);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, holder),
    );
    writeCloseout(rootDir, (created as Record<string, unknown>).packagePath);
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, holder)).outcome, "applied");
    // An origin that is a local path makes git echo this host's filesystem into the refusal, which
    // cross-node surfaces and agent prompts must not receive; the remote-side cause still explains
    // the failure. This drives the real write-queue task-push path end to end.
    const mirror = path.join(rootDir, "missing-mirror.git");
    git(rootDir, "remote", "add", "origin", mirror);
    const pushed = await cell.run({ kind: "task-push", taskId }, holder);
    assert.equal(pushed.outcome, "op_rejected", JSON.stringify(pushed));
    assert.equal(pushed.code, "delivery_publish_failed", JSON.stringify(pushed));
    const explanation = String(pushed.rejectionExplanation);
    assert.match(explanation, /does not appear to be a git repository|No such file|not found/iu, explanation);
    assert.ok(!explanation.includes(mirror), explanation);
    assert.ok(!explanation.includes(rootDir), explanation);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// A `submit --amend` hint is copy-paste runnable only when the CLI's own parser accepts it; the
// positional task id must lead the flags (task_2c609a85f436dce0ca98435f6d symptom).
function assertSubmitHintsParse(text: string): void {
  const commands = [...text.matchAll(/ha task submit \S+ --amend(?: --as-owner)?/gu)].map((match) => match[0]);
  assert.ok(commands.length > 0, `no copyable submit --amend hint in ${text}`);
  for (const command of commands) assert.ok(parseThinCommand(command.slice("ha ".length).split(" ")).ok, command);
}

function binding(executorId: string) {
  return withPolicyGroup(
    {
      actor: { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: executorId } },
      source: "local" as const,
    },
    "admin",
  );
}
function mutate(cache: string, sql: string, ...values: readonly string[]): void {
  const database = new DatabaseSync(cache);
  try {
    database.prepare(sql).run(...values);
  } finally {
    database.close();
  }
}
function workspace(name: string): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), `ha-rejection-${name}-`));
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Rejection Test");
  git(rootDir, "config", "user.email", "rejection@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
  writeFileSync(path.join(rootDir, "README.md"), "# Lifecycle fixture delivery\n");
  git(rootDir, "add", "README.md");
  git(rootDir, "commit", "--quiet", "-m", "fixture delivery");
  git(rootDir, "tag", "fixture-delivery");
  return rootDir;
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", args, { cwd: rootDir, encoding: "utf8", windowsHide: true }).trim();
}
