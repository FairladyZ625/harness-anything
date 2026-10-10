// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import { actionDeclarations, makeTaskEventReader } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { keycloakRealm, serveKeycloak } from "./keycloak.fixtures.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

const ciBin = mkdtempSync(path.join(tmpdir(), "ha-submit-ci-bin-"));
const originalPath = process.env.PATH;
before(() => {
  writeProviderExecutable(
    path.join(ciBin, "gh"),
    'if (process.argv[2] !== "run" || process.argv[3] !== "list") process.exit(1); console.log("[]");\n',
  );
  process.env.PATH = `${ciBin}${path.delimiter}${originalPath ?? ""}`;
});
after(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(ciBin, { recursive: true, force: true });
});

const owner = withPolicyGroup(
    {
      actor: {
        principal: { personId: "person-failure-owner" },
        executor: { kind: "agent" as const, id: "failure-owner" },
      },
      source: "local" as const,
    },
    "contributor",
  ),
  otherWriter = withPolicyGroup(
    {
      actor: {
        principal: { personId: "person-failure-other" },
        executor: { kind: "agent" as const, id: "failure-other" },
      },
      source: "local" as const,
    },
    "contributor",
  ),
  reviewer = withPolicyGroup(
    {
      actor: { principal: { personId: "person-failure-reviewer" }, executor: null },
      source: "local" as const,
    },
    "maintainer",
  ),
  // The owning person with the maintainer tier too: it may close its task, and still may not review it.
  selfReviewer = withPolicyGroup(owner, "maintainer");

test("Task execution rejects with the exact Action criterion and performs no rejected mutation", async (context) => {
  const rootDir = workspace("criteria"),
    repoId = workspaceId("action-failure-criteria"),
    taskId = "task-action-failure",
    executionId = "execution-action-failure";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "action-failure-criteria" });
    const created = await cell.run({ kind: "task-create", taskId, title: "Action failure criteria" }, owner);
    assert.equal(created.outcome, "applied");
    await waitForFixturePublication(cell, created.opId, owner);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, owner)).outcome, "applied");

    const leaseRejected = await assertRejectedWithoutMutation(
      rootDir,
      repoId,
      () => cell!.run({ kind: "task-submit", taskId, executionId }, otherWriter),
      ["repo-cell-proof/proofFor.SubmitExecution"],
    );
    assert.deepEqual(leaseRejected.diagnostic, {
      kind: "validation",
      entity: `task ${taskId} execution ${executionId}`,
      field: "lease",
      actual: "held by principal=person-failure-owner, executor=agent:failure-owner",
      expectation:
        "The actor owns the active lease or the submitted execution being amended, or owns the task with --as-owner. " +
        "When no lease is held, ha task start reconnects to the active execution first. " +
        "Then retry " +
        `ha task submit ${taskId} [--execution-id <execution-id>] [--commit <commit>] [--amend] [--as-owner].`,
    });
    context.diagnostic(`submit proof rejection=${JSON.stringify(leaseRejected)}`);
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
    const started = await cell.run({ kind: "task-start", taskId, executionId }, owner);
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    await waitForFixturePublication(cell, started.opId, owner);

    const missingCloseout = await assertRejectedWithoutMutation(
      rootDir,
      repoId,
      () => cell!.run({ kind: "task-submit", taskId, executionId }, owner),
      [],
    );
    assert.equal(missingCloseout.code, "closeout_placeholder");
    writeFileSync(path.join(rootDir, "README.md"), "# Action failure delivery\n");
    git(rootDir, "add", "README.md");
    git(rootDir, "commit", "-qm", "test: action failure delivery");
    writeFileSync(
      path.join(rootDir, "harness", String((created as Record<string, unknown>).packagePath), "closeout.md"),
      `## Summary\nReady for exact failure attribution at ${git(rootDir, "rev-parse", "HEAD")}.\n` +
        "## Verification\nAction criterion integration assertions.\n## Residual Risk\nNone.\n" +
        "## Same Mechanism Elsewhere\nShared action refusal contracts.\n",
    );
    const submitted = await cell.run({ kind: "task-submit", taskId, executionId }, owner);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));

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
    assert.deepEqual(invalidVerdict.nextActions, [
      `ha task review-execution ${taskId} [--execution-id <execution-id>] --review-id <review-id> ` +
        "[--from-file <from-file>] [--json-input <json|@->]",
    ]);
    assert.doesNotMatch(invalidVerdict.nextActions.join("\n"), /<task-id>/u);
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({
        verdict: "approved",
        reason: "Self review must be rejected.",
        evidenceChecked: ["integration"],
      }),
    );
    // The physical report is present so the failure under test stays the independence proof.
    const selfReport = path.join(
      rootDir,
      "harness",
      String((created as Record<string, unknown>).packagePath),
      "artifacts",
      "reports",
      "self.md",
    );
    mkdirSync(path.dirname(selfReport), { recursive: true });
    writeFileSync(selfReport, "# Review self\n\nPhysical review findings.\n");
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
      () => cell!.run({ kind: "task-complete", taskId, executionId }, selfReviewer),
      ["closeout-readiness/closeoutReadiness"],
    );

    const deniedBinding = {
      ...owner,
      keycloakAuthorization: undefined,
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

// dec_D60FAA451F24160E970323B6F3 CH4: creator-only guards are gone and Keycloak decides who may act, but
// three checks are not Keycloak's to switch off. Both people here hold every declared action on the
// repository; each refusal below is reached with the policy decision already "allowed".
test("holding every action in Keycloak does not lift self-review, lease, or human-consent checks", async (context) => {
  const served = await serveKeycloak(),
    rootDir = workspace("bottom-lines"),
    repoId = workspaceId("action-failure-bottom-lines"),
    taskId = "task-bottom-lines",
    executionId = "execution-bottom-lines",
    everyAction = actionDeclarations.map((declaration) => declaration.kind),
    authorized = (personId: string, executorId: string) => {
      served.keycloak.account(personId);
      served.keycloak.permit(personId, repoId, everyAction);
      return {
        actor: { principal: { personId }, executor: { kind: "agent" as const, id: executorId } },
        source: "local" as const,
        keycloakAuthorization: {
          session: {
            personId,
            accessToken: `token-${personId}`,
            url: served.url,
            realm: keycloakRealm,
            clientId: "harness-center",
          },
        },
      };
    },
    alice = authorized("person-bottom-alice", "alice-agent"),
    bob = authorized("person-bottom-bob", "bob-agent"),
    allowedByKeycloak = (receipt: { readonly authorizationDecision?: unknown }, label: string) =>
      assert.deepEqual(
        [
          (receipt.authorizationDecision as { policyRef?: string } | undefined)?.policyRef,
          (receipt.authorizationDecision as { outcome?: string } | undefined)?.outcome,
        ],
        ["keycloak-policy@1", "allowed"],
        `${label}: ${JSON.stringify(receipt)}`,
      );
  // The strict closeout profile is the one that requires review and human consent before completion.
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness", "harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n" +
      "settings:\n  defaultVertical: software/coding\n  defaultPreset: standard-task\n  defaultProfile: baseline\n" +
      "  closeout:\n    profile: strict\n",
  );
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "action-failure-bottom-lines" });
    const created = await cell.run({ kind: "task-create", taskId, title: "Bottom lines" }, alice);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    allowedByKeycloak(created, "create");
    await waitForFixturePublication(cell, created.opId, alice);
    const packagePath = String((created as Record<string, unknown>).packagePath);
    await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, alice),
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, alice)).outcome, "applied");
    const fact = await cell.run(
      {
        kind: "fact-record",
        taskId,
        statement: "README contains the bottom-line delivery.",
        evidenceSource: "README.md",
        confidence: "high",
        memoryClass: "episodic",
        memoryTags: [],
      },
      alice,
    );
    assert.equal(fact.outcome, "applied", JSON.stringify(fact));

    // 1. Writing a task takes its lease. Bob may submit tasks; this execution's lease is Alice's.
    const withoutLease = await assertRejectedWithoutMutation(
      rootDir,
      repoId,
      () => cell!.run({ kind: "task-submit", taskId, executionId }, bob),
      ["repo-cell-proof/proofFor.SubmitExecution"],
    );
    allowedByKeycloak(withoutLease, "submit without the lease");
    assert.equal(withoutLease.diagnostic?.kind === "validation" && withoutLease.diagnostic.field, "lease");
    const progressWithoutLease = await cell.run(
      { kind: "task-progress-append", taskId, text: "Bob writes into a task he holds no lease on." },
      bob,
    );
    assert.equal(progressWithoutLease.outcome, "op_rejected", JSON.stringify(progressWithoutLease));
    assert.notEqual(progressWithoutLease.code, "authorization_denied");
    context.diagnostic(`progress without lease code=${progressWithoutLease.code}`);

    writeFileSync(path.join(rootDir, "README.md"), "# Bottom line delivery\n");
    git(rootDir, "add", "README.md");
    git(rootDir, "commit", "-qm", "test: bottom line delivery");
    writeFileSync(
      path.join(rootDir, "harness", packagePath, "closeout.md"),
      `## Summary\nReady at ${git(rootDir, "rev-parse", "HEAD")}.\n` +
        "## Verification\nBottom-line integration assertions.\n## Residual Risk\nNone.\n" +
        "## Same Mechanism Elsewhere\nShared action refusal contracts.\n",
    );
    assert.equal((await cell.run({ kind: "task-submit", taskId, executionId }, alice)).outcome, "applied");
    // Commanding the cut is a permission now: Alice holds it, and having created the task is not what grants it.
    const forwarded = await cell.run(
      { kind: "task-adjudicate", taskId, executionId, forward: true, reason: "Forward for independent review." },
      alice,
    );
    assert.equal(forwarded.outcome, "applied", JSON.stringify(forwarded));

    // 2. Nobody reviews their own execution, whatever they are permitted to do.
    const report = (name: string) => {
      const file = path.join(rootDir, "harness", packagePath, "artifacts", "reports", `${name}.md`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `# Review ${name}\n\nPhysical review findings.\n`);
    };
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Checked.", evidenceChecked: ["integration"] }),
    );
    report("self");
    const selfReview = await assertRejectedWithoutMutation(
      rootDir,
      repoId,
      () =>
        cell!.run(
          { kind: "task-review-execution", taskId, executionId, reviewId: "review-self", fromFile: "review.json" },
          alice,
        ),
      ["repo-cell-proof/proofFor.RecordReview"],
    );
    allowedByKeycloak(selfReview, "self review");
    report("bob");
    const reviewed = await cell.run(
      { kind: "task-review-execution", taskId, executionId, reviewId: "review-bob", fromFile: "review.json" },
      bob,
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));

    // 3. An approved review is not consent. Completion waits for the recorded human consent.
    //    (Completion first publishes the review artifacts, so this refusal is checked on the task, not the ledger.)
    const withoutConsent = await cell.run({ kind: "task-complete", taskId, executionId }, alice);
    assert.equal(withoutConsent.outcome, "op_rejected", JSON.stringify(withoutConsent));
    assert.deepEqual(withoutConsent.transition, { from: "in_review/review", to: "in_review/review" });
    allowedByKeycloak(withoutConsent, "complete without consent");
    assert.equal(withoutConsent.code, "consent_missing", JSON.stringify(withoutConsent));
    // Positive control: the same person passes that check once the consent is on record.
    const consented = await cell.run(
      { kind: "task-review-consent", taskId, executionId, reviewId: "review-bob" },
      alice,
    );
    assert.equal(consented.outcome, "applied", JSON.stringify(consented));
    const afterConsent = await cell.run({ kind: "task-complete", taskId, executionId }, alice);
    assert.notEqual(afterConsent.code, "consent_missing", JSON.stringify(afterConsent));
    context.diagnostic(`complete after consent outcome=${afterConsent.outcome} code=${afterConsent.code ?? ""}`);
  } finally {
    await cell?.close();
    await served.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("post-accept response loss remains operational and never invents an Action criterion", async () => {
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
    await waitForFixturePublication(cell, created.opId, owner);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
    armed = true;
    const receipt = await cell.run({ kind: "task-start", taskId, executionId: "execution-operational" }, owner);
    assert.equal(receipt.outcome, "pending", JSON.stringify(receipt));
    assert.equal(receipt.status, "accepted_durable");
    assert.ok(receipt.acceptance?.memberOpIds.includes(receipt.opId));
    assert.equal(receipt.projection?.state, "pending");
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
