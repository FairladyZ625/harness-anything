// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test, { after, before } from "node:test";
import { makeTaskEventReader, makeTaskProjection } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

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
    reviewer = withRoleBinding(binding("reviewer"), "arbiter");
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
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Independent review.", evidenceChecked: ["integration"] }),
    );
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
      expectation: `Current round already has an active execution; run ha task start ${taskId} without --execution-id to reuse it`,
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
    owner = { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" as const },
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
    writeCloseout(rootDir, (created as Record<string, unknown>).packagePath);
    assert.equal((await cell.run({ kind: "task-submit", taskId, executionId }, owner)).outcome, "applied");
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
        action: "ha projection rebuild",
        reason: "Rebuild the unavailable canonical task projection before retrying completion.",
        authority: "person-owner",
        readCut: { revision: submittedRevision, iteration: 0, executionId },
      },
    ]);
    assert.equal((await cell.run({ kind: "projection-rebuild" }, owner)).outcome, "applied");
    const retry = await cell.run({ kind: "task-complete", taskId, executionId }, owner);
    assert.equal(retry.code, "ci_missing", JSON.stringify(retry));
    assert.deepEqual((retry as Record<string, unknown>).next, [
      {
        action: "ha ci observe pull",
        reason: "Publish a passing canonical ci checker witness for this execution cut.",
        authority: "person-owner",
        readCut: { revision: submittedRevision, iteration: 0, executionId },
      },
    ]);
    await cell.close();
    cell = undefined;

    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "projection-exits-four" });
    mutate(cache, "DELETE FROM preset_snapshot");
    const closeout = await cell.run({ kind: "task-complete", taskId, executionId }, owner);
    assert.equal(closeout.code, "ci_missing", JSON.stringify(closeout));
    assert.equal((await cell.run({ kind: "projection-rebuild" }, owner)).outcome, "applied");
    assert.equal((await cell.run({ kind: "task-complete", taskId, executionId }, owner)).code, "ci_missing");
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
        body: "# Over-length whyNot\n",
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
    reviewer = withRoleBinding(binding("review-before-submit-reviewer"), "arbiter");
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

function binding(executorId: string) {
  return {
    actor: { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: executorId } },
    source: "local" as const,
  };
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
