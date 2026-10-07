// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeTaskEventReader, makeTaskProjection, blockingOf } from "@harness-anything/kernel";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { assertTaskDispatchPrerequisites } from "../src/task-dispatch-admission.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const owner = withPolicyGroup(
  { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" as const },
  "admin",
);
const reviewer = withPolicyGroup(
  {
    actor: { principal: { personId: "person-reviewer" }, executor: { kind: "agent" as const, id: "reviewer" } },
    source: "local" as const,
  },
  "maintainer",
);
const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("stack start checks out the approved delivery and freezes that exact baseline before dispatch", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-stack-start-")),
    repoId = workspaceId("stack-start");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "commit", "--allow-empty", "-qm", "base");
  mkdirSync(path.join(root, "harness"));
  const cell = await openBootstrappedRepoCell({ rootDir: canonicalRoot(root), repoId, ownerId: "stack-start" });
  const projection = makeTaskProjection({ rootDir: root, eventStore: makeTaskEventReader({ rootDir: root, repoId }) });
  t.after(async () => {
    projection.close();
    await cell.close();
    rmSync(root, { recursive: true, force: true });
  });
  const packages = new Map<string, string>();
  for (const taskId of ["task_stack_base", "task_stack_work", "task_stack_negative"]) {
    const created = await cell.run({ kind: "task-create", taskId, title: taskId }, owner);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const packagePath = String((created as unknown as { packagePath: string }).packagePath);
    packages.set(taskId, packagePath);
    await realizeTaskPlanFixture(root, packagePath, (planPath: string) =>
      cell.run({ kind: "doc-submit", paths: [planPath] }, owner),
    );
  }
  const run = async (action: Record<string, unknown>, binding = owner) => {
    const receipt = await cell.run(action, binding);
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    return receipt;
  };
  await run({ kind: "task-start", taskId: "task_stack_base", executionId: "exe-base" });
  await cell.settlePendingMaterialization("stack delivery");
  const worktree = path.join(root, ".worktrees/task_stack_base");
  writeFileSync(path.join(worktree, "delivery.txt"), "reviewed base\n");
  git(worktree, "add", "delivery.txt");
  git(worktree, "commit", "-qm", "delivery");
  const anchor = git(worktree, "rev-parse", "HEAD");
  writeFileSync(
    path.join(root, "harness", packages.get("task_stack_base")!, "closeout.md"),
    `# Closeout\n\n## Summary\n\nDelivery ${anchor}.\n\n## Verification\n\nFixture passed.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nChecked.\n`,
  );
  await run({ kind: "task-submit", taskId: "task_stack_base", executionId: "exe-base" });
  await run({
    kind: "task-adjudicate",
    taskId: "task_stack_base",
    executionId: "exe-base",
    forward: true,
    reason: "Review cut.",
  });
  for (const taskId of ["task_stack_work", "task_stack_negative"])
    await run({
      kind: "relation-relate",
      sourceRef: `task/${taskId}`,
      targetRef: "task/task_stack_base",
      relationType: "depends-on",
      rationale: "Explicit stacked implementation dependency",
      expectedVersion: 0,
    });
  await assert.rejects(
    cell.run({ kind: "task-start", taskId: "task_stack_negative", stackOn: "task_stack_base" }, owner),
    /consented approved upstream cut/u,
  );
  writeFileSync(
    path.join(root, "review.json"),
    JSON.stringify({ verdict: "approved", reason: "Reviewed.", evidenceChecked: ["delivery.txt"] }),
  );
  const reports = path.join(root, "harness", packages.get("task_stack_base")!, "artifacts/reports");
  mkdirSync(reports, { recursive: true });
  writeFileSync(path.join(reports, "stack.md"), "# Review\n\nPhysical cut checked.\n");
  await run(
    {
      kind: "task-review-execution",
      taskId: "task_stack_base",
      executionId: "exe-base",
      reviewId: "review-stack",
      fromFile: "review.json",
    },
    reviewer,
  );
  await assert.rejects(
    cell.run({ kind: "task-start", taskId: "task_stack_negative", stackOn: "task_stack_base" }, owner),
    /consented approved upstream cut/u,
  );
  await run({
    kind: "task-review-consent",
    taskId: "task_stack_base",
    executionId: "exe-base",
    reviewId: "review-stack",
  });
  // Main advances independently; the explicit anchor is neither HEAD nor merge-base(main, delivery).
  writeFileSync(path.join(root, "main.txt"), "main advance\n");
  git(root, "add", "main.txt");
  git(root, "commit", "-qm", "main advances");
  assert.notEqual(git(root, "rev-parse", "HEAD"), anchor);
  await run({ kind: "task-start", taskId: "task_stack_work", executionId: "exe-work", stackOn: "task_stack_base" });
  const events = makeTaskEventReader({ rootDir: root, repoId }).read().events;
  const execution = events.flatMap((event) =>
    event.schema === "task-event/v1" &&
    event.type === "execution_started" &&
    event.payload.execution.executionId === "exe-work"
      ? [event.payload.execution]
      : [],
  )[0]!;
  assert.deepEqual(execution.deliveryBaseline, {
    kind: "commit",
    commitSha: anchor,
    stackOn: { taskId: "task_stack_base", executionId: "exe-base" },
  });
  assert.equal(git(path.join(root, ".worktrees/task_stack_work"), "rev-parse", "HEAD"), anchor);
  assert.doesNotThrow(() => assertTaskDispatchPrerequisites(projection, "task_stack_work"));
  assert.throws(() => assertTaskDispatchPrerequisites(projection, "task_stack_negative"), /prerequisites/u);
  const rows = projection.readTaskDependencyClosure(["task/task_stack_work"]).rows;
  assert.equal(
    blockingOf(
      [
        { taskId: "task_stack_work", status: "active" },
        { taskId: "task_stack_base", status: "in_review" },
      ],
      rows,
    )[0]!.state,
    "blocked",
  );
});
