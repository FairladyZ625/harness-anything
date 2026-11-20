// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { executionId, fixture, owner, taskId } from "./task-completion-review.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { waitForFixturePublication } from "./repo-settings.fixture.ts";

type Receipt = Record<string, unknown>;

async function taskStatus(f: Awaited<ReturnType<typeof fixture>>): Promise<{ status: string; iteration: number }> {
  const shown = (await f.run({ kind: "task-show", taskId })) as Receipt;
  const evidence = JSON.parse(String(shown.evidence)) as { task: { status: string; iteration: number } };
  return { status: evidence.task.status, iteration: evidence.task.iteration };
}

// A real low-risk cut is submitted by an implementation worker; the owner's semantic return must
// continue that worker, not require the owner to start one. The fixture's fake provider starts the
// source worker, and the rework continuation resumes or falls back with the same identity.
test("a review-exempt low-risk cut returns to rework and resumes its worker", async () => {
  const f = await fixture(false, true, false, false, false, {
    autoSubmit: false,
    autoProviderSession: true,
    guiDelivery: true,
    submitCommit: true,
    create: { riskTier: "low", presetId: "standard-task" },
  });
  try {
    await f.install();
    const worker = await f.cell().spawnRuntime(
      {
        agentId: "closeout-reviewer",
        role: "worker",
        taskId,
        runtimeInstanceId: "review-second",
        dispatchKey: "task-rework-lowrisk-worker",
        prompt: "Implement the low-risk first cut.",
      },
      owner,
    );
    assert.equal(worker.outcome, "applied", JSON.stringify(worker));
    const source = f
      .events()
      .find(
        (event) =>
          event.type === "runtime_dispatch_requested" && event.payload.dispatchKey === "task-rework-lowrisk-worker",
      );
    assert.ok(source?.type === "runtime_dispatch_requested");
    await f.waitForProviderBinding(source.payload.dispatchId, "review-provider-session");
    const workerBinding = withPolicyGroup(
      withPolicyGroup(
        {
          actor: {
            principal: owner.actor.principal,
            executor: { kind: "agent" as const, id: `runtime-session:${source.payload.runtimeSessionId}` },
          },
          source: "local" as const,
        },
        "contributor",
      ),
      "maintainer",
    );
    const submitted = await f.submit(executionId, workerBinding);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.deepEqual(await taskStatus(f), { status: "submitted", iteration: 0 });
    assert.equal(f.launches.length, 1, "a review-exempt cut dispatches no reviewer");

    // Retire the source worker before the return, so the continuation proves a stopped writer
    // instead of racing a live checkout.
    assert.equal((await f.cancel(source.payload.runtimeSessionId)).outcome, "applied");
    await f.reopen();

    const returned = (await f.run({
      kind: "task-rework",
      taskId,
      reason: "CEO semantic acceptance: narrow the assertion.",
    })) as Receipt;
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));
    assert.equal(f.launches.length, 2, JSON.stringify(returned));
    assert.deepEqual(await taskStatus(f), { status: "active", iteration: 1 });
    assert.match(f.launches.at(-1)!.prompt, /# Owner return/u);
    assert.match(f.launches.at(-1)!.prompt, /CEO semantic acceptance: narrow the assertion\./u);

    const returnEvent = f
      .events()
      .filter((event) => event.type === "submission_returned")
      .at(-1);
    assert.ok(returnEvent?.type === "submission_returned");
    assert.equal(returnEvent.payload.reviewId, undefined);
    assert.equal(returnEvent.payload.reason, "CEO semantic acceptance: narrow the assertion.");
  } finally {
    await f.close();
  }
});

type ChildFixture = Awaited<ReturnType<typeof fixture>>;

async function runChildSlice(
  f: ChildFixture,
  childTaskId: string,
  childExecutionId: string,
  create: Readonly<Record<string, unknown>>,
  options: { readonly factless?: boolean } = {},
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
  if (!options.factless)
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
  const deliveryRoot =
      created.outputShape === "repository-diff" ? path.join(f.root, ".worktrees", childTaskId) : f.root,
    delivery =
      created.outputShape === "repository-diff"
        ? (() => {
            writeFileSync(path.join(deliveryRoot, "README.md"), `# ${childTaskId} delivery\n`);
            execFileSync("git", ["-C", deliveryRoot, "add", "README.md"]);
            execFileSync("git", ["-C", deliveryRoot, "commit", "-qm", "test: child task delivery"]);
            return execFileSync("git", ["-C", deliveryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
          })()
        : execFileSync("git", ["-C", deliveryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    closeoutBody = options.factless
      ? `# Closeout\n\n## Summary\n\nReviewed delivery ${delivery}\n\n## Verification\n\nnode tools/x.test.mjs — exit 0.\n\n`
      : `# Closeout\n\n## Summary\n\nReviewed delivery ${delivery}\n\n## Verification\n\nREADME bytes checked.\n\n` +
        "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nReview dispatch retry.\n";
  if (created.outputShape !== "repository-diff") {
    // A documentation slice delivers authored evidence, not the bootstrap directory placeholder.
    const report = path.join(f.root, "harness", packagePath, "artifacts", "delivery.md");
    mkdirSync(path.dirname(report), { recursive: true });
    writeFileSync(report, `# ${childTaskId} delivery\nREADME bytes checked.\n`);
  }
  writeFileSync(path.join(f.root, "harness", packagePath, "closeout.md"), closeoutBody);
  const submitted = (await f.run({
    kind: "task-submit",
    taskId: childTaskId,
    executionId: childExecutionId,
  })) as Record<string, unknown>;
  assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
  execFileSync("git", ["-C", f.root, "update-ref", "refs/remotes/origin/main", delivery]);
  const annotated = (await f.run({
    kind: "task-annotate",
    taskId: childTaskId,
    executionId: childExecutionId,
    note: `merge_commit_sha:${delivery}`,
  })) as Record<string, unknown>;
  assert.equal(annotated.outcome, "applied", JSON.stringify(annotated));
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
  "a low-risk subtask under a work parent resolves the repository default preset, inherits vertical and locale, and completes with zero review or consent work",
  { timeout: 30_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, {
      autoSubmit: false,
      closeoutProfile: "strict",
      create: { presetId: "create-work", taskClass: "work", locale: "zh-CN" },
    });
    try {
      await f.install();
      const selectableLightweight = (await f.run({
        kind: "task-create",
        taskId: "task-user-selected-lightweight",
        title: "Reject a profile flow selector",
        riskTier: "low",
        profileId: "lightweight",
      })) as Record<string, unknown>;
      assert.equal(selectableLightweight.outcome, "op_rejected", JSON.stringify(selectableLightweight));
      assert.equal(selectableLightweight.code, "invalid_field", JSON.stringify(selectableLightweight));
      const { created, packagePath } = await runChildSlice(
        f,
        "task-lightweight-child",
        "execution-lightweight-child",
        { riskTier: "low" },
        { factless: true },
      );
      const child = createdTask(f.events(), "task-lightweight-child");
      assert.equal(child.metadata?.parentTaskId, taskId, "the child keeps its canonical parent reference");
      assert.equal(
        child.metadata?.presetId,
        "standard-task",
        "the child resolves the repository default preset, not the work parent's preset",
      );
      assert.equal(child.metadata?.verticalId, "software/coding", "the child inherits the parent vertical");
      assert.equal(child.metadata?.profileId, "lightweight");
      assert.equal(child.taskClass, "standard", "the child is a plain executable slice, not a work");
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
      const closeoutDescriptor = childContract(f.root, packagePath).documents.find(
        (document: { readonly slot?: string }) => document.slot === "task.closeout",
      );
      assert.equal(
        closeoutDescriptor?.templateRef,
        "template://planning/closeout-lightweight@1",
        "the lightweight closeout scaffold is frozen into the contract",
      );
      assert.equal(
        f
          .events()
          .filter((event) => event.type === "fact_recorded" && event.payload?.taskId === "task-lightweight-child")
          .length,
        0,
        "the lightweight child recorded no Fact; the closeout verification is its evidence",
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
        `a lightweight child completes without review, consent, or a fact: ${JSON.stringify(completed)}`,
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
  "a low-risk subtask under a docs-task parent also resolves the repository default preset, and explicit flags still win",
  { timeout: 30_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, {
      autoSubmit: false,
      closeoutProfile: "strict",
      create: { presetId: "docs-task" },
    });
    try {
      await f.install();
      await runChildSlice(f, "task-docs-child", "execution-docs-child", { riskTier: "low" });
      const docsChild = createdTask(f.events(), "task-docs-child");
      assert.equal(docsChild.metadata?.presetId, "standard-task", "a docs parent does not push its preset down");
      assert.equal(docsChild.metadata?.profileId, "lightweight");
      const explicit = (await f.run({
        kind: "task-create",
        taskId: "task-explicit-child",
        title: "Explicit preset subtask",
        parentTaskId: taskId,
        presetId: "worker-dispatch",
        riskTier: "low",
      })) as Record<string, unknown>;
      assert.equal(explicit.outcome, "applied", JSON.stringify(explicit));
      const explicitChild = createdTask(f.events(), "task-explicit-child");
      assert.equal(
        explicitChild.metadata?.presetId,
        "worker-dispatch",
        "an explicit --preset still wins over the repository default",
      );
      // A preset without a lightweight profile still accepts low risk and materializes its normal
      // default package; low is a flow choice, not a requirement that every preset carry a short profile.
      const missing = (await f.run({
        kind: "task-create",
        taskId: "task-missing-profile-child",
        title: "Missing profile subtask",
        parentTaskId: taskId,
        presetId: "decision-conformance",
        riskTier: "low",
      })) as Record<string, unknown>;
      assert.equal(missing.outcome, "applied", JSON.stringify(missing));
      const missingChild = createdTask(f.events(), "task-missing-profile-child");
      assert.equal(missingChild.metadata?.profileId, "baseline");
      // docs-task declares lightweight too: a declaration or document fix completes under strict settings
      // with no Fact, no reviewer launch, and no consent.
      const launchesBefore = f.launches.length;
      await runChildSlice(
        f,
        "task-docs-lightweight-child",
        "execution-docs-lightweight-child",
        { presetId: "docs-task", riskTier: "low" },
        { factless: true },
      );
      const docsLightweight = createdTask(f.events(), "task-docs-lightweight-child");
      assert.deepEqual(docsLightweight.closeoutOverrides, { review: false, consent: false });
      const docsCompleted = (await f.run({
        kind: "task-complete",
        taskId: "task-docs-lightweight-child",
        executionId: "execution-docs-lightweight-child",
      })) as Record<string, unknown>;
      assert.equal(docsCompleted.outcome, "applied", JSON.stringify(docsCompleted));
      assert.equal(f.launches.length, launchesBefore, "a lightweight docs-task never launches a reviewer");
    } finally {
      await f.close();
    }
  },
);

test("a baseline-profile sibling under strict settings dispatches at submit", { timeout: 30_000 }, async () => {
  const f = await fixture(false, true, false, false, false, {
    autoSubmit: false,
    closeoutProfile: "strict",
    create: { presetId: "standard-task" },
  });
  try {
    await f.install();
    await runChildSlice(f, "task-standard-child", "execution-standard-child", {});
    const child = createdTask(f.events(), "task-standard-child");
    assert.equal(child.closeoutOverrides, undefined, "the baseline child freezes no closeout override");
    assert.equal(
      child.completionGateIds.includes("code-doc-reconciliation"),
      false,
      "the standard preset no longer freezes the retired gate",
    );
    assert.equal(
      f.events().filter((event) => event.type === "runtime_dispatch_requested").length,
      1,
      "the standard sibling dispatches automatically",
    );
    assert.equal(f.launches.length, 1, "submit launches the standard sibling reviewer");
  } finally {
    await f.close();
  }
});
