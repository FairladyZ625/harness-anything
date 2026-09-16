// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { executionId, fixture, owner, taskId } from "./task-completion-review.fixture.ts";

const reviewerActor = (runtimeSessionId: string) => ({
  actor: {
    principal: owner.actor.principal,
    executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
  },
  source: "local" as const,
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

test(
  "task dispatch-review launches one reviewer bound to the submitted cut without touching the implementation iteration",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    try {
      await f.install();
      const before = await showTask(f, taskId);
      const startedBefore = f.events().filter((event) => event.type === "execution_started").length;
      const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const steps = dispatchesOf(receipt);
      assert.equal(steps.length, 1);
      assert.equal(steps[0]!.outcome, "dispatched", JSON.stringify(steps[0]));
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
  "task dispatch-review expands a batch into one independent review dispatch per task",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    try {
      await f.install();
      const task2 = "task-completion-review-batch",
        execution2 = "execution-completion-review-batch";
      await f.submitExtraTask(task2, execution2);
      const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [taskId, task2] });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const steps = dispatchesOf(receipt);
      assert.equal(steps.length, 2);
      assert.deepEqual(
        steps.map((step) => [step.taskId, step.outcome]),
        [
          [taskId, "dispatched"],
          [task2, "dispatched"],
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
    const f = await fixture();
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
    const f = await fixture();
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
    const f = await fixture();
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
    const f = await fixture();
    try {
      await f.install();
      const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const { dispatchId, runtimeSessionId } = dispatchesOf(receipt)[0]! as Required<DispatchStep>;
      const outcome = await f.settleReview(dispatchId, runtimeSessionId, "done", "# Review\n\nApproved.\n");
      assert.equal(outcome, "succeeded");
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
    const f = await fixture();
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
      assert.match(steps[0]!.error ?? "", /no submitted execution/u);
      assert.equal(f.launches.length, 0, "no reviewer launch may happen without a submitted cut");
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
        "review_target_missing",
      );
    } finally {
      await f.close();
    }
  },
);
