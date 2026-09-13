// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const ciBin = mkdtempSync(path.join(tmpdir(), "ha-review-selection-ci-bin-"));
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
      "## Verification\n\nIntegration assertions exercise the execution selection.\n\n" +
      "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nShared lifecycle authorization.\n",
  );
}

test("review-execution without --execution-id derives the sole current submitted execution across a changes_requested round", async () => {
  const rootDir = workspace("selection-round"),
    taskId = "task-selection-round",
    firstExecutionId = "exec-selection-r1",
    secondExecutionId = "exec-selection-r2",
    owner = binding("selection-owner"),
    reviewer = withRoleBinding(binding("selection-reviewer"), "arbiter");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId: workspaceId("selection-round"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "selection-round",
    });
    const store = () => makeTaskEventReader({ repoId: workspaceId("selection-round"), rootDir }),
      created = await cell.run({ kind: "task-create", taskId, title: "Selection round" }, owner);
    await waitForFixturePublication(cell, created.opId, owner);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
    await cell.run({ kind: "task-start", taskId, executionId: firstExecutionId }, owner);
    writeCloseout(rootDir, (created as Record<string, unknown>).packagePath);
    assert.equal(
      (await cell.run({ kind: "task-submit", taskId, executionId: firstExecutionId }, owner)).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "review-changes.json"),
      JSON.stringify({
        verdict: "changes_requested",
        reason: "Exercise a second implementation round.",
        evidenceChecked: ["first-round receipt"],
      }),
    );
    const returned = await cell.run(
      {
        kind: "task-review-execution",
        taskId,
        executionId: firstExecutionId,
        reviewId: "review-selection-r1",
        fromFile: "review-changes.json",
      },
      reviewer,
    );
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));
    const returnedEvent = store().readEvent(String(returned.opId));
    if (returnedEvent?.type !== "review_recorded") throw new Error("returned review event missing");
    assert.equal(returnedEvent.payload.execution.state, "changes_requested");
    assert.equal(returnedEvent.payload.execution.iteration, 0);
    assert.equal(returnedEvent.payload.task.iteration, 1);

    await cell.run({ kind: "task-start", taskId, executionId: secondExecutionId }, owner);
    writeCloseout(rootDir, (created as Record<string, unknown>).packagePath);
    assert.equal(
      (await cell.run({ kind: "task-submit", taskId, executionId: secondExecutionId }, owner)).outcome,
      "applied",
    );

    // The transition guards make a second concurrent submitted execution unreachable, so ambiguity
    // cannot be constructed through the lifecycle: starting is refused while a submitted cut exists.
    const refusedStart = await cell.run({ kind: "task-start", taskId, executionId: "exec-selection-r3" }, owner);
    assert.equal(refusedStart.outcome, "op_rejected", JSON.stringify(refusedStart));
    assert.equal(refusedStart.code, "invalid_transition", JSON.stringify(refusedStart));

    writeFileSync(
      path.join(rootDir, "review-approved.json"),
      JSON.stringify({ verdict: "approved", reason: "Second round passes.", evidenceChecked: ["second round"] }),
    );
    const reviewed = await cell.run(
      {
        kind: "task-review-execution",
        taskId,
        reviewId: "review-selection-r2",
        fromFile: "review-approved.json",
      },
      reviewer,
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    const reviewedEvent = store().readEvent(String(reviewed.opId));
    if (reviewedEvent?.type !== "review_recorded") throw new Error("second review event missing");
    assert.equal(reviewedEvent.payload.review.executionId, secondExecutionId);
    assert.equal(reviewedEvent.payload.review.iteration, 1);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("review-execution without --execution-id names the resubmission command while no submitted execution exists", async () => {
  const rootDir = workspace("selection-empty"),
    taskId = "task-selection-empty",
    firstExecutionId = "exec-selection-empty",
    owner = binding("selection-empty-owner"),
    reviewer = withRoleBinding(binding("selection-empty-reviewer"), "arbiter");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId: workspaceId("selection-empty"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "selection-empty",
    });
    const created = await cell.run({ kind: "task-create", taskId, title: "Selection empty" }, owner);
    await waitForFixturePublication(cell, created.opId, owner);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
    await cell.run({ kind: "task-start", taskId, executionId: firstExecutionId }, owner);
    writeCloseout(rootDir, (created as Record<string, unknown>).packagePath);
    assert.equal(
      (await cell.run({ kind: "task-submit", taskId, executionId: firstExecutionId }, owner)).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "review-changes.json"),
      JSON.stringify({
        verdict: "changes_requested",
        reason: "Return to implementation before any resubmission.",
        evidenceChecked: ["first-round receipt"],
      }),
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-review-execution",
            taskId,
            executionId: firstExecutionId,
            reviewId: "review-selection-empty",
            fromFile: "review-changes.json",
          },
          reviewer,
        )
      ).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "review-approved.json"),
      JSON.stringify({ verdict: "approved", reason: "No cut to review yet.", evidenceChecked: ["none"] }),
    );
    const rejected = await cell.run(
      { kind: "task-review-execution", taskId, reviewId: "review-selection-early", fromFile: "review-approved.json" },
      reviewer,
    );
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "invalid_command", JSON.stringify(rejected));
    assert.match(String(rejected.rejectionExplanation), /ha task show/u);
    assert.match(String(rejected.rejectionExplanation), /ha task submit/u);
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
function workspace(name: string): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), `ha-review-selection-${name}-`));
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Review Selection Test");
  git(rootDir, "config", "user.email", "review-selection@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
  writeFileSync(path.join(rootDir, "README.md"), "# Lifecycle fixture delivery\n");
  git(rootDir, "add", "README.md");
  git(rootDir, "commit", "--quiet", "-m", "fixture delivery");
  git(rootDir, "tag", "fixture-delivery");
  return rootDir;
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", args, { cwd: rootDir, encoding: "utf-8", windowsHide: true }).trim();
}
