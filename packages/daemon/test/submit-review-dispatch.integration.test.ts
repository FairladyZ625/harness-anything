// harness-test-tier: integration
import { revokeTestPolicyActions } from "./keycloak-policy.fixtures.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { waitForFixturePublication } from "./repo-settings.fixture.ts";
import { executionId, fixture, owner, reviewerExecutionBinding, taskId } from "./task-completion-review.fixture.ts";
import { reviewDispatchKey } from "../src/task-review-dispatch.ts";

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
  "a submit under a review-disabled closeout profile freezes no dispatch and never launches a reviewer",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, {
      closeoutProfile: "standard",
      autoForward: false,
    });
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
  "submit automatically dispatches the accepted cut and complete never dispatches a reviewer",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, { autoSubmit: false });
    try {
      await f.install();
      const submitted = (await f.submit()) as Record<string, unknown>;
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
      assert.equal(f.launches.length, 1, "submit must dispatch the reviewer without owner forward");
      assert.equal(
        f.events().filter((event) => event.type === "execution_submitted").length,
        1,
        "the accepted submission is recorded before dispatch",
      );
      const resumed = await f.run({ kind: "task-submit", taskId, executionId });
      assert.equal(resumed.outcome, "applied", JSON.stringify(resumed));
      assert.equal(f.launches.length, 1, "resumed submit shares the cut dispatch identity");
      const completed = await f.complete();
      assert.equal(completed.outcome, "op_rejected", JSON.stringify(completed));
      assert.equal(f.launches.length, 1);
    } finally {
      await f.close();
    }
  },
);

test("submit and amend dispatch their own frozen cuts without owner forward", { timeout: 20_000 }, async () => {
  const f = await fixture(false, true, false, false, false, undefined, { autoSubmit: false });
  try {
    await f.install();
    const reportPath = path.join(f.root, "harness", f.packagePath, "artifacts", "independent.md");
    writeFileSync(reportPath, "Corrected job=41; SQL range 0–336h.\n");
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
    assert.equal(f.launches.length, 2, "amend dispatches the replacement cut through the same port");
    const dispatches = f
      .events()
      .filter(
        (event) => event.type === "runtime_dispatch_requested" && !event.payload.dispatchKey.includes(":fallback:"),
      );
    assert.equal(dispatches.length, 2);
    const dispatch = dispatches[1]!;
    assert.ok(dispatch.type === "runtime_dispatch_requested");
    const read = await f
      .cell()
      .run(
        { kind: "doc-show", path: `${f.packagePath}/artifacts/independent.md`, raw: true },
        reviewerExecutionBinding(dispatch.payload.runtimeSessionId, dispatch.payload.dispatchId),
      );
    assert.equal(read.outcome, "applied", JSON.stringify(read));
    assert.equal(read.evidence, "Corrected job=41; SQL range 0–336h.\n");
    assert.match(f.launches[0]!.prompt, /ha task show.*--json/u);
    assert.doesNotMatch(
      f.launches[0]!.prompt,
      /# Living Deliverable Protocol|推送后用 `gh pr create --head <task-id>` 开 PR，正文遵循本仓库的 PR 规范。/u,
      "reviewer dispatches carry no worker delivery protocols",
    );
  } finally {
    await f.close();
  }
});

test(
  "a lightweight subtask under a work parent resolves the repository default preset, inherits vertical and locale, and completes with zero review or consent work",
  { timeout: 30_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, {
      autoSubmit: false,
      closeoutProfile: "strict",
      create: { presetId: "create-work", taskClass: "work", locale: "zh-CN" },
    });
    try {
      await f.install();
      const { created, packagePath } = await runChildSlice(
        f,
        "task-lightweight-child",
        "execution-lightweight-child",
        { profileId: "lightweight" },
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
      // A preset that declares no lightweight profile fails closed instead of falling back, and the
      // rejection names its own profiles and the presets that do declare lightweight.
      const missing = (await f.run({
        kind: "task-create",
        taskId: "task-missing-profile-child",
        title: "Missing profile subtask",
        parentTaskId: taskId,
        presetId: "decision-conformance",
        profileId: "lightweight",
      })) as Record<string, unknown>;
      assert.equal(missing.outcome, "op_rejected", JSON.stringify(missing));
      assert.equal(missing.code, "missing_profile", JSON.stringify(missing));
      // docs-task declares lightweight too: a declaration or document fix completes under strict settings
      // with no Fact, no reviewer launch, and no consent.
      const launchesBefore = f.launches.length;
      await runChildSlice(
        f,
        "task-docs-lightweight-child",
        "execution-docs-lightweight-child",
        { presetId: "docs-task", profileId: "lightweight" },
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
      assert.match(
        JSON.stringify(missing),
        /Profile lightweight is unavailable on preset decision-conformance; its profiles: baseline\. Presets that declare lightweight: docs-task, standard-task, worker-dispatch\./u,
      );
    } finally {
      await f.close();
    }
  },
);

test("a baseline-profile sibling under strict settings dispatches at submit", { timeout: 30_000 }, async () => {
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
      "the standard sibling dispatches automatically",
    );
    assert.equal(f.launches.length, 1, "submit launches the standard sibling reviewer");
  } finally {
    await f.close();
  }
});

test(
  "forward's explicit reviewer overrides the cut's frozen claim and reports the argument source",
  {
    timeout: 30_000,
  },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, { autoSubmit: false });
    try {
      await f.install();
      const settings = await f.runPrincipal({
        kind: "settings-update",
        roles: { defaultReviewer: "missing-reviewer" },
        dispatchKey: "freeze-missing",
      });
      assert.equal(settings.outcome, "applied", JSON.stringify(settings));
      assert.equal((await f.submit()).outcome, "applied");
      const forwarded = (await f.run({
        kind: "task-adjudicate",
        taskId,
        forward: true,
        reviewer: "closeout-reviewer",
        reason: "Review frozen cut.",
      })) as unknown as Record<string, unknown>;
      assert.equal(forwarded.outcome, "applied", JSON.stringify(forwarded));
      assert.equal(forwarded.reviewerId, "closeout-reviewer");
      assert.equal(forwarded.reviewerSource, "argument");
      const state = (await f.cell().read("repo.tasks.list")).rows.find((row) => row.taskId === taskId);
      assert.equal(state?.snapshot.task?.status, "in_review");
      assert.equal(f.launches.length, 1);
    } finally {
      await f.close();
    }
  },
);

test("explicit reviewer selection dispatches beside the automatic reviewer and retries reuse its identity", async () => {
  const f = await fixture(false, true, false, false, false, undefined, { autoSubmit: false });
  try {
    await f.install();
    assert.equal(
      (
        await f.run({
          kind: "agent-install",
          declaration: {
            schema: "agent-declaration/v1",
            id: "alternate-reviewer",
            name: "Alternate reviewer",
            instructions: "Independently inspect the submitted cut.",
            runtimes: [{ type: "codex", model: "review-model" }],
            instance: "review-first",
            role: "reviewer",
          },
        })
      ).outcome,
      "applied",
    );
    await f.submit();
    assert.equal(f.launches.length, 1);
    const action = {
      kind: "task-adjudicate",
      taskId,
      forward: true,
      reviewer: "alternate-reviewer",
      reason: "Request an additional independent reviewer.",
    };
    const selected = await f.run(action);
    assert.equal(selected.outcome, "applied", JSON.stringify(selected));
    assert.equal(f.launches.length, 2);
    assert.equal((await f.run(action)).outcome, "applied");
    const retry = await f.run({ kind: "task-dispatch-review", taskIds: [taskId], agentId: "alternate-reviewer" });
    assert.equal(retry.outcome, "applied", JSON.stringify(retry));
    assert.equal(
      f.launches.length,
      2,
      "both owner selection and dispatch-review reuse the selected reviewer's dispatch",
    );
    const dispatches = f.events().filter((event) => event.type === "runtime_dispatch_requested");
    assert.deepEqual(
      dispatches.map((event) => event.payload.agentId),
      ["closeout-reviewer", "alternate-reviewer"],
    );
  } finally {
    await f.close();
  }
});

test("legacy base-key dispatch for an alternate reviewer is reused by reroute and dispatch-review", async () => {
  const f = await fixture(false, true, false, false, false, undefined, {
    autoSubmit: false,
    closeoutProfile: "strict",
  });
  try {
    const configured = await f.runPrincipal({
      kind: "settings-update",
      roles: { defaultReviewer: "missing-reviewer" },
      dispatchKey: "freeze-missing-reviewer",
    });
    assert.equal(configured.outcome, "applied", JSON.stringify(configured));
    await f.submit();
    assert.equal(f.launches.length, 0, "the frozen reviewer is not installed, so submit has no dispatch row");
    const installed = await f.run({
      kind: "agent-install",
      declaration: {
        schema: "agent-declaration/v1",
        id: "alternate-reviewer",
        name: "Alternate reviewer",
        instructions: "Independently inspect the submitted cut.",
        runtimes: [{ type: "codex", model: "review-model" }],
        instance: "review-first",
        role: "reviewer",
      },
    });
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    const shown = JSON.parse(String((await f.run({ kind: "task-show", taskId })).evidence)) as {
        executions: Parameters<typeof reviewDispatchKey>[1][];
      },
      execution = shown.executions.find((item) => item.executionId === executionId);
    assert.ok(execution?.submission);
    const legacyKey = reviewDispatchKey(taskId, execution);
    const legacy = await f.cell().spawnRuntime(
      {
        agentId: "alternate-reviewer",
        role: "reviewer",
        taskId,
        executionId,
        cwd: { scope: "repo-root" },
        dispatchKey: legacyKey,
        prompt: "Review the bound submission cut.",
      },
      owner,
    );
    assert.equal(legacy.outcome, "applied", JSON.stringify(legacy));
    assert.equal(f.launches.length, 1);

    const rerouted = await f.run({
      kind: "task-adjudicate",
      taskId,
      executionId,
      forward: true,
      reviewer: "alternate-reviewer",
      reason: "Retry the selected reviewer on the same cut.",
    });
    assert.equal(rerouted.outcome, "applied", JSON.stringify(rerouted));
    assert.equal(f.launches.length, 1, "the owner reroute must reuse the live legacy dispatch");

    const retry = await f.run({
      kind: "task-dispatch-review",
      taskIds: [taskId],
      agentId: "alternate-reviewer",
    });
    assert.equal(retry.outcome, "applied", JSON.stringify(retry));
    const step = (retry as Record<string, unknown>).dispatches as { outcome: string; dispatchKey?: string }[];
    assert.equal(step[0]?.outcome, "already_dispatched", JSON.stringify(step[0]));
    assert.equal(f.launches.length, 1, "dispatch-review must recognize the legacy key as well");
  } finally {
    await f.close();
  }
});

test(
  "resumed submit keeps frozen reviewer over settings and recovers dispatch without adjudication",
  {
    timeout: 30_000,
  },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, { autoSubmit: false });
    try {
      await f.install();
      const settings = await f.runPrincipal({
        kind: "settings-update",
        roles: { defaultReviewer: "missing-reviewer" },
        dispatchKey: "freeze-missing",
      });
      assert.equal(settings.outcome, "applied", JSON.stringify(settings));
      assert.equal((await f.submit()).outcome, "applied");
      assert.equal(
        (
          await f.runPrincipal({
            kind: "settings-update",
            roles: { defaultReviewer: "closeout-reviewer" },
            dispatchKey: "change-default",
          })
        ).outcome,
        "applied",
      );
      const resumed = await f.run({ kind: "task-submit", taskId, executionId });
      assert.equal(resumed.outcome, "applied", JSON.stringify(resumed));
      assert.match(JSON.stringify(resumed), /missing-reviewer/u);
      assert.match(JSON.stringify(resumed), /already in_review/u);
      assert.match(JSON.stringify(resumed), /ha task dispatch-review task-completion-review --agent missing-reviewer/u);
      const state = (await f.cell().read("repo.tasks.list")).rows.find((row) => row.taskId === taskId);
      assert.equal(state?.snapshot.task?.status, "in_review");
      assert.equal(f.launches.length, 0);
      const recovered = await f.run({ kind: "task-dispatch-review", taskIds: [taskId], agentId: "closeout-reviewer" });
      assert.equal(recovered.outcome, "applied", JSON.stringify(recovered));
      assert.equal(f.launches.length, 1);
      const retry = await f.run({ kind: "task-dispatch-review", taskIds: [taskId], agentId: "closeout-reviewer" });
      assert.match(JSON.stringify(retry), /already_dispatched/u);
      assert.equal(f.launches.length, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  "amending an in-review cut dispatches the reviewer for the replaced cut once, through the forward's path",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false);
    try {
      await f.install();
      assert.equal(f.launches.length, 1, "the forward dispatches the first cut's reviewer");
      const closeoutPath = path.join(f.root, "harness", f.packagePath, "closeout.md");
      writeFileSync(
        closeoutPath,
        readFileSync(closeoutPath, "utf8").replace("Reviewed delivery ", "Amended reviewed delivery "),
      );
      const amend = async () => {
        let amended = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
        for (let attempt = 0; amended.outcome === "pending" && attempt < 4; attempt += 1) {
          await waitForFixturePublication(f.cell(), amended.opId, owner);
          amended = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
        }
        assert.equal(amended.outcome, "applied", JSON.stringify(amended));
        return amended as Record<string, unknown>;
      };
      const amended = await amend(),
        reviewDispatches = () =>
          f
            .events()
            .filter(
              (event) =>
                event.type === "runtime_dispatch_requested" && event.payload.dispatchKey.startsWith("task-review:"),
            );
      assert.equal(f.launches.length, 2, "the amended in-review cut gets its own reviewer dispatch");
      assert.equal(reviewDispatches().length, 2);
      const step = (amended.steps as readonly Record<string, unknown>[]).at(-1)!;
      assert.equal(typeof step.dispatchId, "string", JSON.stringify(amended));
      const dispatch = reviewDispatches().at(-1)!;
      assert.ok(dispatch.type === "runtime_dispatch_requested");
      const shown = await f
        .cell()
        .run(
          { kind: "task-show", taskId },
          reviewerExecutionBinding(dispatch.payload.runtimeSessionId, dispatch.payload.dispatchId),
        );
      assert.equal(shown.outcome, "applied", JSON.stringify(shown));
      const execution = JSON.parse(String(shown.evidence)).executions.find(
        (candidate: { executionId: string }) => candidate.executionId === executionId,
      );
      assert.match(execution.submission.completionClaim, /Amended reviewed delivery/u);
      await amend();
      assert.equal(f.launches.length, 2, "re-amending the same cut never opens a second concurrent review");
      assert.equal(reviewDispatches().length, 2);
    } finally {
      await f.close();
    }
  },
);

test("automatic submit dispatch cannot lend its authorization decision to runtime-spawn", async () => {
  const f = await fixture(false, true, false, false, false, undefined, { autoSubmit: false });
  try {
    await f.install();
    revokeTestPolicyActions(owner.actor.principal.personId, "completion-review", ["runtime-spawn"]);
    const result = await f.submit();
    assert.equal(result.outcome, "applied", JSON.stringify(result));
    assert.equal(f.launches.length, 0, "submit remains authorized, but reviewer launch has no permission");
    assert.equal(
      f.events().some((event) => event.type === "runtime_dispatch_requested"),
      false,
    );
  } finally {
    await f.close();
  }
});
