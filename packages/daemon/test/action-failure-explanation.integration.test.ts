// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const owner = {
    actor: {
      principal: { personId: "person-failure-owner" },
      executor: { kind: "agent" as const, id: "failure-owner" },
    },
    source: "local" as const,
  },
  otherWriter = {
    actor: {
      principal: { personId: "person-failure-other" },
      executor: { kind: "agent" as const, id: "failure-other" },
    },
    source: "local" as const,
  },
  reviewer = withRoleBinding(
    {
      actor: { principal: { personId: "person-failure-reviewer" }, executor: null },
      source: "local" as const,
    },
    "arbiter",
  ),
  selfReviewer = withRoleBinding(owner, "arbiter");

test("Task execution rejects with the exact Action criterion and performs no rejected mutation", async () => {
  const rootDir = workspace("criteria"),
    repoId = workspaceId("action-failure-criteria"),
    taskId = "task-action-failure",
    executionId = "execution-action-failure";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "action-failure-criteria" });
    const created = await cell.run({ kind: "task-create", taskId, title: "Action failure criteria" }, owner);
    assert.equal(created.outcome, "applied");
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, owner)).outcome, "applied");

    await assertRejectedWithoutMutation(
      rootDir,
      repoId,
      () => cell!.run({ kind: "task-submit", taskId, executionId }, otherWriter),
      ["actor-domain-services/heldLeaseForExecutionActor"],
    );
    await assertRejectedWithoutMutation(
      rootDir,
      repoId,
      () => cell!.run({ kind: "task-start", taskId, executionId: "execution-foreign" }, otherWriter),
      ["task-lifecycle-command-transitions/canStartExecution"],
    );

    assert.equal((await cell.run({ kind: "task-release", taskId }, owner)).outcome, "applied");
    await assertRejectedWithoutMutation(
      rootDir,
      repoId,
      () => cell!.run({ kind: "task-start", taskId, executionId, expectedVersion: 0 }, owner),
      ["task-lifecycle-contract-support/revisionIssues"],
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, owner)).outcome, "applied");

    await assertRejectedWithoutMutation(
      rootDir,
      repoId,
      () => cell!.run({ kind: "task-submit", taskId, executionId }, owner),
      ["task-lifecycle-command-transitions/submit.validate"],
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-submit",
            taskId,
            executionId,
            submission: {
              completionClaim: "Ready for exact failure attribution.",
              deliverables: ["receipt"],
              outputs: ["ActionResult"],
              verificationNotes: ["integration"],
              knownGaps: [],
              residualRisks: [],
              commitSha: "a".repeat(40),
            },
          },
          owner,
        )
      ).outcome,
      "applied",
    );

    await assertRejectedWithoutMutation(
      rootDir,
      repoId,
      () => cell!.run({ kind: "task-review-execution", taskId, executionId }, reviewer),
      ["task-lifecycle-review-transitions/review.validate"],
    );
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({
        verdict: "approve",
        reason: "The invalid verdict must retain its specific diagnostic.",
        evidenceChecked: ["integration"],
      }),
    );
    const invalidVerdict = await assertRejectedWithoutMutation(
      rootDir,
      repoId,
      () =>
        cell!.run(
          {
            kind: "task-review-execution",
            taskId,
            executionId,
            reviewId: "review-invalid-verdict",
            fromFile: "review.json",
          },
          reviewer,
        ),
      ["task-lifecycle-review-transitions/review.validate"],
    );
    assert.equal(invalidVerdict.code, "invalid_command");
    assert.deepEqual(invalidVerdict.diagnostic, {
      kind: "invalid-enum",
      field: "verdict",
      actual: "approve",
      allowedValues: ["approved", "changes_requested", "dismissed"],
    });
    assert.deepEqual(invalidVerdict.nextActions, []);
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({
        verdict: "approved",
        reason: "Self review must be rejected.",
        evidenceChecked: ["integration"],
      }),
    );
    await assertRejectedWithoutMutation(
      rootDir,
      repoId,
      () =>
        cell!.run(
          {
            kind: "task-review-execution",
            taskId,
            executionId,
            reviewId: "review-self",
            fromFile: "review.json",
          },
          selfReviewer,
        ),
      ["repo-cell-proof/proofFor.RecordReview"],
    );
    await assertRejectedWithoutMutation(
      rootDir,
      repoId,
      () => cell!.run({ kind: "task-complete", taskId, executionId }, owner),
      ["closeout-readiness/closeoutReadiness"],
    );

    const deniedBinding = {
      ...owner,
      roleBindings: [],
      authorizationBindingMode: "declared" as const,
    };
    const denied = await assertRejectedWithoutMutation(
      rootDir,
      repoId,
      () => cell!.run({ kind: "task-review-execution", taskId, executionId }, deniedBinding),
      [],
    );
    assert.equal(denied.code, "authorization_denied");
    assert.equal(denied.authorizationDecision.outcome, "denied");
    assert.ok(denied.authorizationDecision.reasonCodes.length > 0);
    assert.ok(denied.authorizationDecision.nextActions.length > 0);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("publication indeterminate remains operational and never invents an Action criterion", async () => {
  const rootDir = workspace("operational"),
    repoId = workspaceId("action-failure-operational"),
    taskId = "task-action-operational";
  let armed = false,
    cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "action-failure-operational",
      killpoint: (point) => {
        if (armed && point === "after_sqlite_commit")
          throw Object.assign(new Error("Query the stable receipt before retrying."), {
            code: "publication_indeterminate",
          });
      },
    });
    const created = await cell.run({ kind: "task-create", taskId, title: "Operational failure" }, owner);
    assert.equal(created.outcome, "applied");
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
    armed = true;
    const receipt = await cell.run({ kind: "task-start", taskId, executionId: "execution-operational" }, owner);
    assert.equal(receipt.outcome, "indeterminate", JSON.stringify(receipt));
    assert.equal(receipt.code, "publication_indeterminate");
    assert.deepEqual(receipt.unmetCriteria, []);
    assert.deepEqual(receipt.guidance, [{ kind: "retry-receipt", args: { opId: receipt.opId } }]);
    assert.doesNotMatch(JSON.stringify(receipt), /criteria\/publication_indeterminate/u);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function assertRejectedWithoutMutation(
  rootDir: string,
  repoId: ReturnType<typeof workspaceId>,
  run: () => ReturnType<Awaited<ReturnType<typeof openRepoCell>>["run"]>,
  expectedRefs: readonly string[],
) {
  const before = makeTaskEventReader({ repoId, rootDir }).read().events.length,
    receipt = await run(),
    after = makeTaskEventReader({ repoId, rootDir }).read().events.length;
  assert.notEqual(receipt.outcome, "applied", JSON.stringify(receipt));
  assert.equal(after, before, JSON.stringify(receipt));
  assert.deepEqual(receipt.unmetCriteria?.map(({ ref }) => ref) ?? [], expectedRefs, JSON.stringify(receipt));
  for (const criterion of receipt.unmetCriteria ?? []) {
    assert.deepEqual(Object.keys(criterion).sort(), ["explain", "failureCode", "ref"]);
    assert.ok(criterion.failureCode);
    assert.ok(criterion.explain);
  }
  return receipt;
}

function workspace(name: string): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), `ha-action-failure-${name}-`));
  initRepo(rootDir);
  return rootDir;
}
