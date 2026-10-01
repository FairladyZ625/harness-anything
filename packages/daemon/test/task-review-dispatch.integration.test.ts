// harness-test-tier: integration
import assert from "node:assert/strict";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { realizedDecisionBody, realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { executionId, fixture, owner, taskId } from "./task-completion-review.fixture.ts";

const reviewerActor = (runtimeSessionId: string) =>
  withRoleBinding(
    {
      actor: {
        principal: owner.actor.principal,
        executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
      },
      source: "local" as const,
    },
    "owner",
  );

test("decision dispatch-review passes spawn admission and launches once for the current digest", async () => {
  const f = await fixture(false, true, false, false, false, undefined, { autoSubmit: false });
  const runDecision = (action: Parameters<typeof f.run>[0]) => f.cell().run(action, withRoleBinding(owner, "owner"));
  try {
    await f.install();
    const proposed = await runDecision({
      kind: "decision-propose",
      body: realizedDecisionBody("Independent dispatch review"),
      jsonInput: JSON.stringify({
        title: "Independent dispatch review",
        question: "Should the proposal receive independent review?",
        riskTier: "high",
        urgency: "high",
        vertical: "software/coding",
        preset: "standard-task",
        decisionClass: "ordinary",
        appliesTo: { modules: ["daemon"], productLines: [] },
        chosen: [{ id: "CH1", text: "Require independent review" }],
        rejected: [{ id: "RJ1", text: "Self-review", whyNot: "Independent review is required" }],
        claims: [{ id: "C1", text: "The reviewer is independent.", loadBearing: true }],
        fulfillments: [],
      }),
    });
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
    const decisionId = JSON.parse(String(proposed.evidence)).decisionId as string,
      shown = await runDecision({ kind: "decision-show", decisionId, includeBody: true }),
      digest = JSON.parse(String(shown.evidence)).decision.currentReviewContentDigest as string,
      receipt = await runDecision({ kind: "decision-dispatch-review", decisionId, runtimeInstanceId: "review-first" });
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.equal(f.launches.length, 1);
    assert.match(f.launches[0]!.prompt, new RegExp(decisionId, "u"));
    assert.ok(f.launches[0]!.prompt.includes(digest));
    const requested = f.events().filter((event) => event.type === "runtime_dispatch_requested");
    assert.equal(requested.length, 1);
    assert.deepEqual(requested[0]!.payload.reviewTarget, { kind: "decision", decisionId, digest });
    const retry = await runDecision({ kind: "decision-dispatch-review", decisionId });
    assert.equal(retry.outcome, "applied", JSON.stringify(retry));
    assert.equal(f.launches.length, 1);
    const first = requested[0]!.payload;
    f.failPending();
    await f.awaitOutcome(first.runtimeSessionId);
    const redispatched = await runDecision({ kind: "decision-dispatch-review", decisionId });
    assert.equal(redispatched.outcome, "applied", JSON.stringify(redispatched));
    assert.equal(f.launches.length, 2, "an ended session without a review needs a new attempt");
    const second = f
      .events()
      .filter((event) => event.type === "runtime_dispatch_requested")
      .at(-1)!.payload;
    assert.notEqual(second.runtimeSessionId, first.runtimeSessionId);
    const reportRef = `decisions/decision-${decisionId}/artifacts/reports/${second.dispatchId}.md`;
    const reportPath = path.join(f.root, "harness", reportRef);
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, "# Review\n\nThe current Decision cut was reviewed.\n");
    const review = {
      kind: "decision-review",
      decisionId,
      reviewId: `review-${second.dispatchId}`,
      reviewContentDigest: digest,
      verdict: "approved",
      reason: "Independent dispatch review supports acceptance.",
      findings: [],
      evidenceChecked: [],
      reportRef,
    };
    await expectCoded(runDecision(review), "actor_unauthorized");
    await expectCoded(
      runDecision({
        ...review,
        decisionId: "decision-unrelated",
        executor: { kind: "agent", id: `runtime-session:${second.runtimeSessionId}` },
      }),
      "executor_binding_invalid",
    );
    await expectCoded(
      runDecision({
        ...review,
        reviewContentDigest: `sha256:${"0".repeat(64)}`,
        executor: { kind: "agent", id: `runtime-session:${second.runtimeSessionId}` },
      }),
      "invalid_transition",
    );
    const { kind, decisionId: reviewedDecisionId, ...packet } = review;
    const packetRef = `decisions/decision-${decisionId}/artifacts/reviews/${second.dispatchId}.json`;
    mkdirSync(path.dirname(path.join(f.root, "harness", packetRef)), { recursive: true });
    writeFileSync(path.join(f.root, "harness", packetRef), JSON.stringify(packet));
    const reviewed = await runDecision({
      kind,
      decisionId: reviewedDecisionId,
      fromFile: `harness/${packetRef}`,
      executor: { kind: "agent", id: `runtime-session:${second.runtimeSessionId}` },
    });
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    f.failPending();
    await f.awaitOutcome(second.runtimeSessionId);
    const registeredRetry = await runDecision({ kind: "decision-dispatch-review", decisionId });
    assert.equal(registeredRetry.outcome, "applied", JSON.stringify(registeredRetry));
    assert.equal(f.launches.length, 2, "a registered review must keep its ended dispatch idempotent");
    const accepted = await f.cell().run(
      {
        kind: "decision-accept",
        decisionId,
        reviewId: review.reviewId,
        expectedDigest: digest,
        rationale: "Independent review approved this cut.",
        judgmentOnlyRationale: "The reviewed decision needs no task.",
      },
      withRoleBinding(
        { actor: { principal: owner.actor.principal, executor: null }, source: "local" as const },
        "owner",
      ),
    );
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
  } finally {
    await f.close();
  }
});

type DispatchStep = {
  taskId: string;
  executionId?: string;
  dispatchId?: string;
  runtimeSessionId?: string;
  outcome: string;
  error?: string;
};

const dispatchesOf = (receipt: unknown): DispatchStep[] =>
  (receipt as Record<string, unknown>).dispatches as DispatchStep[];

/** Daemon facades convert coded failures into rejected receipts; accept either surface. */
async function expectCoded(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    const receipt = (await promise) as Record<string, unknown>;
    assert.equal(receipt.code, code, JSON.stringify(receipt));
  } catch (error) {
    assert.equal((error as { code?: string }).code, code, String(error));
  }
}

type TaskShow = {
  task: { iteration: number; status: string };
  executions: readonly { executionId: string; submission: unknown }[];
  lease: unknown;
};

const showTask = async (f: Awaited<ReturnType<typeof fixture>>, id: string): Promise<TaskShow> =>
  JSON.parse(String((await f.run({ kind: "task-show", taskId: id })).evidence)) as TaskShow;

const boundCuts = (f: Awaited<ReturnType<typeof fixture>>, runtimeSessionId: string): [string, string][] =>
  f
    .events()
    .filter(
      (event) =>
        event.type === "runtime_session_started" &&
        event.payload.runtimeSessionId === runtimeSessionId &&
        event.payload.taskBinding !== null &&
        event.payload.taskBinding !== undefined,
    )
    .map((event) => {
      const taskBinding = event.payload.taskBinding as { taskId: string; executionId: string };
      return [String(taskBinding.taskId), String(taskBinding.executionId)];
    });

async function spawnReviewerForKey(f: Awaited<ReturnType<typeof fixture>>, idempotencyKey: string): Promise<string> {
  const receipt = await f.cell().spawnRuntime(
    {
      agentId: "closeout-reviewer",
      role: "reviewer",
      taskId,
      executionId,
      cwd: { scope: "repo-root" },
      idempotencyKey,
      prompt: "Review the bound submission cut.",
    },
    owner,
  );
  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  assert.equal(typeof receipt.runtimeSessionId, "string", JSON.stringify(receipt));
  return String(receipt.runtimeSessionId);
}

test(
  "submitted cuts reject explicit dispatch-review and generic reviewer runtime ingress before owner forward",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, {
      closeoutProfile: "standard",
      autoForward: false,
    });
    try {
      await f.install();
      const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [taskId], executionId });
      assert.equal(receipt.outcome, "op_rejected", JSON.stringify(receipt));
      assert.match(dispatchesOf(receipt)[0]?.error ?? "", /awaits its owner's triage/u);
      await expectCoded(
        f.cell().spawnRuntime(
          {
            agentId: "closeout-reviewer",
            role: "reviewer",
            taskId,
            executionId,
            cwd: { scope: "repo-root" },
            idempotencyKey: "review-before-forward",
            prompt: "review",
          },
          owner,
        ),
        "review_admission_denied",
      );
      assert.equal(f.launches.length, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  "task dispatch-review launches one reviewer bound to the submitted cut without touching the implementation iteration",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, { closeoutProfile: "standard" });
    try {
      await f.install();
      const before = await showTask(f, taskId);
      const startedBefore = f.events().filter((event) => event.type === "execution_started").length;
      const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const steps = dispatchesOf(receipt);
      assert.equal(steps.length, 1);
      assert.equal(steps[0]!.outcome, "already_dispatched", JSON.stringify(steps[0]));
      assert.equal(steps[0]!.executionId, executionId);
      const dispatchId = steps[0]!.dispatchId!,
        runtimeSessionId = steps[0]!.runtimeSessionId!;
      assert.equal(f.launches.length, 1);
      assert.match(f.launches[0]!.prompt, new RegExp(`artifacts/reports/${dispatchId}\\.md`, "u"));
      assert.match(f.launches[0]!.prompt, /RecordReview/u);
      // The review dispatch did not start an implementation iteration and holds no lease.
      const after = await showTask(f, taskId);
      assert.equal(after.task.iteration, before.task.iteration, "implementation iteration must not move");
      assert.equal(after.executions.length, before.executions.length, "no new implementation execution may be opened");
      assert.equal(after.lease ?? null, null, "the reviewer holds no task lease");
      assert.equal(
        f.events().filter((event) => event.type === "execution_started").length,
        startedBefore,
        "the review dispatch opened no implementation execution",
      );
      assert.deepEqual(
        boundCuts(f, runtimeSessionId),
        [[taskId, executionId]],
        "one review execution binds exactly one task, at the submitted cut",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "reviewer runtime submission fences accept every current-cut key shape and reject both stale-cut shapes",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, { closeoutProfile: "standard" });
    try {
      await f.install();
      const initialDispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
      assert.ok(initialDispatch?.type === "runtime_dispatch_requested");
      const currentKey = initialDispatch.payload.idempotencyKey,
        currentSession = initialDispatch.payload.runtimeSessionId,
        attemptSession = await spawnReviewerForKey(f, `${currentKey}:attempt1`),
        legacyKey = currentKey.replace(/^task-review:/u, "complete-review:"),
        legacySession = await spawnReviewerForKey(f, legacyKey),
        legacySuffixSession = await spawnReviewerForKey(f, `${legacyKey}:upgrade-in-flight`);

      for (const [sessionId, reviewId] of [
        [currentSession, "review-current-cut"],
        [attemptSession, "review-current-cut-attempt1"],
        [legacySession, "review-current-cut-legacy"],
        [legacySuffixSession, "review-current-cut-legacy-suffix"],
      ] as const) {
        const reviewed = await f.review(sessionId, reviewId);
        assert.equal(reviewed.outcome, "applied", `${reviewId}: ${JSON.stringify(reviewed)}`);
      }

      const staleCurrentSession = await spawnReviewerForKey(f, currentKey),
        staleLegacySession = await spawnReviewerForKey(f, legacyKey),
        closeoutPath = path.join(f.root, "harness", f.packagePath, "closeout.md");
      writeFileSync(closeoutPath, `${readFileSync(closeoutPath, "utf8")}\nAmended verification evidence.\n`);
      const amended = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
      assert.equal(amended.outcome, "applied", JSON.stringify(amended));

      for (const [sessionId, reviewId] of [
        [staleCurrentSession, "review-stale-current-key"],
        [staleLegacySession, "review-stale-legacy-key"],
      ] as const) {
        const rejected = await f.review(sessionId, reviewId);
        assert.equal(rejected.outcome, "op_rejected", `${reviewId}: ${JSON.stringify(rejected)}`);
        assert.equal(rejected.code, "invalid_proof", `${reviewId}: ${JSON.stringify(rejected)}`);
      }
    } finally {
      await f.close();
    }
  },
);

test(
  "task dispatch-review expands a batch into one independent review dispatch per task",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, { closeoutProfile: "standard" });
    try {
      await f.install();
      const task2 = "task-completion-review-batch",
        execution2 = "execution-completion-review-batch";
      await f.submitExtraTask(task2, execution2);
      assert.equal(
        (
          await f.run({
            kind: "task-adjudicate",
            taskId: task2,
            executionId: execution2,
            forward: true,
            reason: "Owner forwards the second cut for independent review.",
          })
        ).outcome,
        "applied",
      );
      const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [taskId, task2] });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const steps = dispatchesOf(receipt);
      assert.equal(steps.length, 2);
      assert.deepEqual(
        steps.map((step) => [step.taskId, step.outcome]),
        [
          [taskId, "already_dispatched"],
          [task2, "already_dispatched"],
        ],
      );
      assert.notEqual(steps[0]!.dispatchId, steps[1]!.dispatchId, "each task gets its own review dispatch");
      assert.notEqual(steps[0]!.runtimeSessionId, steps[1]!.runtimeSessionId);
      assert.equal(f.launches.length, 2);
      for (const [index, expected] of [
        [0, [taskId, executionId]],
        [1, [task2, execution2]],
      ] as const) {
        assert.deepEqual(
          boundCuts(f, steps[index]!.runtimeSessionId!),
          [expected],
          "each review execution binds exactly one task and its submitted cut",
        );
        assert.match(f.launches[index]!.prompt, new RegExp(`artifacts/reports/${steps[index]!.dispatchId}\\.md`, "u"));
      }
      // Duplicate task ids in one invocation are rejected: one review execution never covers two tasks.
      await expectCoded(f.run({ kind: "task-dispatch-review", taskIds: [taskId, taskId] }), "invalid_command");
    } finally {
      await f.close();
    }
  },
);

test(
  "a reviewer runtime may only record a review; lifecycle writes that would mutate the implementation iteration are denied",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, { closeoutProfile: "standard" });
    try {
      await f.install();
      const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const runtimeSessionId = dispatchesOf(receipt)[0]!.runtimeSessionId!;
      const before = await showTask(f, taskId),
        startedBefore = f.events().filter((event) => event.type === "execution_started").length,
        denied = await f
          .cell()
          .run(
            { kind: "task-start", taskId, executionId: "execution-reviewer-escape" },
            reviewerActor(runtimeSessionId),
          );
      assert.equal(denied.outcome, "op_rejected", JSON.stringify(denied));
      assert.equal(denied.code, "runtime_reviewer_lifecycle_forbidden", JSON.stringify(denied));
      const after = await showTask(f, taskId);
      assert.equal(after.task.iteration, before.task.iteration, "the implementation iteration must not move");
      assert.equal(
        f.events().filter((event) => event.type === "execution_started").length,
        startedBefore,
        "the reviewer could not open an implementation execution",
      );
      const transition = await f
        .cell()
        .run(
          { kind: "task-transition", taskId, status: "cancelled", reason: "reviewer must not cancel tasks" },
          reviewerActor(runtimeSessionId),
        );
      assert.equal(transition.outcome, "op_rejected", JSON.stringify(transition));
      assert.equal(transition.code, "runtime_reviewer_lifecycle_forbidden", JSON.stringify(transition));
      // A reviewer cannot aim its review packet at another task's package either.
      const task2 = "task-completion-review-cross",
        execution2 = "execution-completion-review-cross";
      await f.submitExtraTask(task2, execution2);
      const crossTask = await f.cell().run(
        {
          kind: "task-review-execution",
          taskId: task2,
          executionId: execution2,
          reviewId: "review-cross-task",
          fromFile: "harness/missing.json",
          executor: { kind: "agent", id: `runtime-session:${runtimeSessionId}` },
        },
        reviewerActor(runtimeSessionId),
      );
      assert.equal(crossTask.outcome, "op_rejected", JSON.stringify(crossTask));
      assert.equal(crossTask.code, "executor_binding_invalid", JSON.stringify(crossTask));
    } finally {
      await f.close();
    }
  },
);

test(
  "a registered review keeps the runtime settlement honest even when the archive collides",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, { closeoutProfile: "standard" });
    try {
      await f.install();
      const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const { dispatchId, runtimeSessionId } = dispatchesOf(receipt)[0]! as Required<DispatchStep>;
      const review = await f.reviewDispatchedArtifacts(runtimeSessionId, dispatchId);
      assert.equal(review.outcome, "applied", JSON.stringify(review));
      // Force a divergent archive collision: the mission path the archive would write already
      // exists with different content. The review is registered, so settlement stays honest.
      const mission = path.join(f.root, "harness", f.packagePath, "artifacts", "missions", `${dispatchId}.md`);
      mkdirSync(path.dirname(mission), { recursive: true });
      writeFileSync(mission, "divergent pre-existing mission artifact\n");
      const outcome = await f.settleReview(dispatchId, runtimeSessionId, "Reviewed and recorded.");
      assert.equal(outcome, "succeeded", "a registered review must not settle as a failed dispatch");
    } finally {
      await f.close();
    }
  },
);

test(
  "an archive collision without a registered review still settles the reviewer dispatch as failed",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, { closeoutProfile: "standard" });
    try {
      await f.install();
      const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const { dispatchId, runtimeSessionId } = dispatchesOf(receipt)[0]! as Required<DispatchStep>;
      const mission = path.join(f.root, "harness", f.packagePath, "artifacts", "missions", `${dispatchId}.md`);
      mkdirSync(path.dirname(mission), { recursive: true });
      writeFileSync(mission, "divergent pre-existing mission artifact\n");
      const outcome = await f.settleReview(dispatchId, runtimeSessionId, "Reviewed without registering.");
      assert.equal(outcome, "failed", "an unregistered review still fails archive settlement honestly");
    } finally {
      await f.close();
    }
  },
);

test(
  "the reviewer report lands under the reviewed task's own package reports directory",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, { closeoutProfile: "standard" });
    try {
      await f.install();
      const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const { dispatchId, runtimeSessionId } = dispatchesOf(receipt)[0]! as Required<DispatchStep>;
      const outcome = await f.settleReview(dispatchId, runtimeSessionId, "done", "# Review\n\nApproved.\n");
      assert.equal(outcome, "unknown", "a report file alone is not a registered review witness");
      const report = path.join(f.root, "harness", f.packagePath, "artifacts", "reports", `${dispatchId}.md`);
      assert.ok(existsSync(report), `expected the authored report at ${report}`);
      const packet = report.replace(/\.md$/u, ".json");
      assert.equal(existsSync(packet), false, "no stray packet file is fabricated by the archive");
    } finally {
      await f.close();
    }
  },
);

test(
  "dispatch-review refuses a task with no submitted cut instead of binding the implementation execution",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, { closeoutProfile: "standard" });
    try {
      await f.install();
      const planned = "task-completion-review-planned";
      const plannedPackage = await f.createPlannedTask(planned);
      await realizeTaskPlanFixture(f.root, plannedPackage, (planPath) =>
        f.run({ kind: "doc-submit", paths: [planPath] }),
      );
      assert.equal(
        (await f.run({ kind: "task-start", taskId: planned, executionId: "execution-planned" })).outcome,
        "applied",
      );
      const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [planned] });
      assert.equal(receipt.outcome, "op_rejected", JSON.stringify(receipt));
      const steps = dispatchesOf(receipt);
      assert.equal(steps.length, 1);
      assert.equal(steps[0]!.outcome, "failed");
      assert.match(steps[0]!.error ?? "", /not at the in-review gate/u);
      assert.equal(f.launches.length, 1, "the planned task must not add a reviewer launch");
      // The internal spawn path enforces the same invariant.
      await expectCoded(
        f.cell().spawnRuntime(
          {
            agentId: "closeout-reviewer",
            role: "reviewer",
            taskId: planned,
            cwd: { scope: "repo-root" },
            idempotencyKey: "review-planned-target",
            prompt: "review",
          },
          owner,
        ),
        "review_admission_denied",
      );
    } finally {
      await f.close();
    }
  },
);
