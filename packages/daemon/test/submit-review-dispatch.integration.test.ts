// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { waitForFixturePublication } from "./repo-settings.fixture.ts";
import { executionId, fixture, owner, taskId } from "./task-completion-review.fixture.ts";

type ChildFixture = Awaited<ReturnType<typeof fixture>>;

async function runChildSlice(
  f: ChildFixture,
  childTaskId: string,
  childExecutionId: string,
  create: Readonly<Record<string, unknown>>,
) {
  const created = (await f.run({
    kind: "task-create",
    taskId: childTaskId,
    title: `Subtask ${childTaskId}`,
    parentTaskId: taskId,
    ...create,
  })) as Record<string, unknown>;
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  await waitForFixturePublication(f.cell(), String(created.opId), owner);
  const packagePath = String(created.packagePath);
  await realizeTaskPlanFixture(f.root, packagePath, (planPath) => f.run({ kind: "doc-submit", paths: [planPath] }));
  assert.equal(
    (await f.run({ kind: "task-start", taskId: childTaskId, executionId: childExecutionId })).outcome,
    "applied",
  );
  assert.equal(
    (
      await f.run({
        kind: "fact-record",
        taskId: childTaskId,
        statement: "README contains the reviewed delivery.",
        evidenceSource: "README.md",
        confidence: "high",
        memoryClass: "episodic",
        memoryTags: [],
      })
    ).outcome,
    "applied",
  );
  const delivery = execFileSync("git", ["-C", f.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(
    path.join(f.root, "harness", packagePath, "closeout.md"),
    `# Closeout\n\n## Summary\n\nReviewed delivery ${delivery}\n\n## Verification\n\nREADME bytes checked.\n\n` +
      "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nReview dispatch retry.\n",
  );
  const submitted = (await f.run({
    kind: "task-submit",
    taskId: childTaskId,
    executionId: childExecutionId,
  })) as Record<string, unknown>;
  assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
  return { created, packagePath };
}

function childContract(root: string, packagePath: string) {
  return JSON.parse(readFileSync(path.join(root, "harness", packagePath, "task-contract.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

function createdTask(events: ReturnType<ChildFixture["events"]>, childTaskId: string) {
  const event = events.find((entry) => entry.type === "task_bootstrapped" && entry.payload.task.taskId === childTaskId);
  assert.ok(event?.type === "task_bootstrapped", `task_bootstrapped event for ${childTaskId}`);
  return event.payload.task;
}

test(
  "a submit under a review-disabled closeout profile freezes no dispatch and never launches a reviewer",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, { closeoutProfile: "standard" });
    try {
      await f.install();
      assert.equal(f.launches.length, 0, "review-disabled profiles must not dispatch at submit");
      assert.equal(
        f.events().filter((event) => event.type === "runtime_dispatch_requested").length,
        0,
        "no reviewer dispatch event may be recorded for a review-disabled cut",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "a failed review dispatch leaves the accepted submission submitted and stays retryable from complete",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, { autoSubmit: false });
    try {
      await f.install();
      f.disableInstances();
      const submitted = (await f.submit()) as Record<string, unknown>;
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
      const reviewStep = ((submitted.steps as Record<string, unknown>[] | undefined) ?? []).find(
        (step) => step.code === "review_missing",
      );
      assert.ok(reviewStep, `the failed dispatch must surface as a step: ${JSON.stringify(submitted)}`);
      assert.equal(f.launches.length, 0);
      assert.equal(
        f.events().filter((event) => event.type === "execution_submitted").length,
        1,
        "the accepted submission is recorded even though the review dispatch failed",
      );
      const completed = await f.complete();
      assert.equal(completed.code, "review_missing", JSON.stringify(completed));
      assert.equal(f.launches.length, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  "an amended submission is a new cut: submit dispatches a fresh reviewer under the same frozen declaration",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, { autoSubmit: false });
    try {
      await f.install();
      await f.submit();
      assert.equal(f.launches.length, 1);
      const closeoutPath = path.join(f.root, "harness", f.packagePath, "closeout.md");
      writeFileSync(
        closeoutPath,
        readFileSync(closeoutPath, "utf8").replace("Reviewed delivery ", "Amended reviewed delivery "),
      );
      let amended = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
      for (let attempt = 0; amended.outcome === "pending" && attempt < 4; attempt += 1) {
        await waitForFixturePublication(f.cell(), amended.opId, owner);
        amended = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
      }
      assert.equal(amended.outcome, "applied", JSON.stringify(amended));
      assert.equal(f.launches.length, 2, "the amended cut owns its own review dispatch");
      const dispatches = f
        .events()
        .filter(
          (event) =>
            event.type === "runtime_dispatch_requested" && !event.payload.idempotencyKey.includes(":fallback:"),
        );
      assert.equal(dispatches.length, 2);
      assert.notEqual(
        dispatches[0]!.payload.idempotencyKey,
        dispatches[1]!.payload.idempotencyKey,
        "each submitted cut gets its own dispatch attempt",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "a lightweight subtask under a milestone parent resolves the repository default preset, inherits vertical and locale, and completes with zero review or consent work",
  { timeout: 30_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, {
      autoSubmit: false,
      closeoutProfile: "strict",
      create: { presetId: "create-milestone", taskClass: "milestone", locale: "zh-CN" },
    });
    try {
      await f.install();
      const { created, packagePath } = await runChildSlice(f, "task-lightweight-child", "execution-lightweight-child", {
        profileId: "lightweight",
      });
      const child = createdTask(f.events(), "task-lightweight-child");
      assert.equal(child.metadata?.parentTaskId, taskId, "the child keeps its canonical parent reference");
      assert.equal(
        child.metadata?.presetId,
        "standard-task",
        "the child resolves the repository default preset, not the milestone parent's preset",
      );
      assert.equal(child.metadata?.verticalId, "software/coding", "the child inherits the parent vertical");
      assert.equal(child.metadata?.profileId, "lightweight");
      assert.equal(child.taskClass, "standard", "the child is a plain executable slice, not a milestone");
      assert.equal(
        childContract(f.root, packagePath).locale,
        "zh-CN",
        "the child inherits the parent locale, not the repository default",
      );
      assert.deepEqual(
        child.closeoutOverrides,
        { review: false, consent: false },
        "the profile's closeout overrides freeze into the task",
      );
      assert.equal(f.launches.length, 0, "a lightweight submit must not launch a reviewer");
      assert.equal(
        f.events().filter((event) => event.type === "runtime_dispatch_requested").length,
        0,
        "a lightweight submit must not record a reviewer dispatch",
      );
      assert.equal(
        typeof created.packagePath === "string" && created.packagePath.length > 0,
        true,
        "the child owns its own package path",
      );
      const completed = (await f.run({
        kind: "task-complete",
        taskId: "task-lightweight-child",
        executionId: "execution-lightweight-child",
      })) as Record<string, unknown>;
      assert.equal(
        completed.outcome,
        "applied",
        `a lightweight child completes without review or consent: ${JSON.stringify(completed)}`,
      );
      assert.equal(f.launches.length, 0, "completion must not dispatch a reviewer either");
      // The frozen task cannot be silently re-bound: a preset upgrade with an unchanged snapshot
      // refuses outright, and any real upgrade re-validates immutable fields in the projection.
      const upgrade = (await f.run({
        kind: "preset-upgrade",
        taskId: "task-lightweight-child",
      })) as Record<string, unknown>;
      assert.equal(upgrade.outcome, "op_rejected", JSON.stringify(upgrade));
      assert.equal(upgrade.code, "snapshot_current", JSON.stringify(upgrade));
    } finally {
      await f.close();
    }
  },
);

test(
  "a lightweight subtask under a docs-task parent also resolves the repository default preset, and explicit flags still win",
  { timeout: 30_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, {
      autoSubmit: false,
      closeoutProfile: "strict",
      create: { presetId: "docs-task" },
    });
    try {
      await f.install();
      await runChildSlice(f, "task-docs-child", "execution-docs-child", { profileId: "lightweight" });
      const docsChild = createdTask(f.events(), "task-docs-child");
      assert.equal(docsChild.metadata?.presetId, "standard-task", "a docs parent does not push its preset down");
      assert.equal(docsChild.metadata?.profileId, "lightweight");
      const explicit = (await f.run({
        kind: "task-create",
        taskId: "task-explicit-child",
        title: "Explicit preset subtask",
        parentTaskId: taskId,
        presetId: "worker-dispatch",
        profileId: "lightweight",
      })) as Record<string, unknown>;
      assert.equal(explicit.outcome, "applied", JSON.stringify(explicit));
      const explicitChild = createdTask(f.events(), "task-explicit-child");
      assert.equal(
        explicitChild.metadata?.presetId,
        "worker-dispatch",
        "an explicit --preset still wins over the repository default",
      );
      // A preset that declares no lightweight profile fails closed instead of falling back.
      const missing = (await f.run({
        kind: "task-create",
        taskId: "task-missing-profile-child",
        title: "Missing profile subtask",
        parentTaskId: taskId,
        presetId: "docs-task",
        profileId: "lightweight",
      })) as Record<string, unknown>;
      assert.equal(missing.outcome, "op_rejected", JSON.stringify(missing));
      assert.equal(missing.code, "missing_profile", JSON.stringify(missing));
    } finally {
      await f.close();
    }
  },
);

test(
  "a baseline-profile sibling under identical strict settings still dispatches an independent reviewer",
  { timeout: 30_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, {
      autoSubmit: false,
      closeoutProfile: "strict",
      create: { presetId: "standard-task" },
    });
    try {
      await f.install();
      await runChildSlice(f, "task-standard-child", "execution-standard-child", {});
      const child = createdTask(f.events(), "task-standard-child");
      assert.equal(child.closeoutOverrides, undefined, "the baseline child freezes no closeout override");
      assert.equal(child.completionGateIds.includes("code-doc-reconciliation"), true);
      assert.equal(
        f.events().filter((event) => event.type === "runtime_dispatch_requested").length,
        1,
        "the standard sibling triggers the review dispatch the lightweight child skipped",
      );
      assert.equal(f.launches.length, 1, "the standard sibling launches a reviewer");
    } finally {
      await f.close();
    }
  },
);
