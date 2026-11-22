// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";
import { evidence } from "./task-surface.fixtures.ts";
import {
  assertChildrenClosed,
  binding,
  createSuiteHost,
  openFixture,
  type Status,
  type WorkerAttemptView,
} from "./task-squad-orchestration.fixture.ts";

const suiteHost = createSuiteHost("lifecycle-shared");

for (const ending of ["cancelled", "failed"] as const)
  test(`squad ${ending} closes child tasks and releases their WIP slots`, { timeout: 90_000 }, async (t) => {
    const fixture = await openFixture(t, `child-closeout-${ending}`, { host: suiteHost });
    const beforeWip = await fixture.cell.read("repo.tasks.wip", {}, binding);
    await fixture.plan(["a.txt"], ["b.txt"]);
    const running = await fixture.waitStatus(
      (state) => state.workerAttempts.length === 2 && state.workerAttempts.every((w) => w.runtimeSessionId),
    );
    for (const child of running.workerAttempts)
      assert.equal(fixture.task(child.taskId!).snapshot.task?.status, "active");
    if (ending === "cancelled") {
      const receipt = await fixture.cell.run({ kind: "squad-cancel", squadRunId: running.squadRunId }, binding);
      assert.equal(receipt.phase, "cancelled", JSON.stringify(receipt));
    } else {
      for (const child of running.workerAttempts) await fixture.finish(child.dispatchId!, "completed");
      const resumed = await fixture.waitStatus((state) => state.leaderTurns.length === 2);
      await fixture.finish(
        resumed.leaderTurns[1].dispatchId,
        JSON.stringify({ schema: "squad-decision/v1", action: "converged" }),
      );
      await fixture.waitStatus((state) => state.status === "failed");
      assert.equal((await fixture.status()).status, "failed");
    }
    assertChildrenClosed(fixture, running.workerAttempts);
    const afterWip = await fixture.cell.read("repo.tasks.wip", {}, binding);
    assert.equal(afterWip.counted.length, beforeWip.counted.length, "total WIP returns to the pre-stage count");
    await fixture.reopen();
    assertChildrenClosed(fixture, running.workerAttempts);
  });

test("failed child wakes the leader with the failure after its sibling settles", { timeout: 90_000 }, async (t) => {
  const fixture = await openFixture(t, "failure", { host: suiteHost });
  await fixture.plan(["a.txt"], ["b.txt"]);
  const running = await fixture.waitStatus(
    (state) => state.workerAttempts.length === 2 && state.workerAttempts.every((w) => w.runtimeSessionId),
  );
  await fixture.finish(running.workerAttempts[0].dispatchId!, "child could not complete", 1);
  await fixture.waitStatus((state) => state.workerCallbackCount === 1);
  assert.equal((await fixture.status()).leaderTurns.length, 1);
  await fixture.finish(running.workerAttempts[1].dispatchId!, "sibling completed");
  const resumed = await fixture.waitStatus((state) => state.leaderTurns.length === 2);
  const leader = fixture.providers.find((p) => p.dispatchId === resumed.leaderTurns[1].dispatchId)!;
  assert.match(leader.prompt, /failed/u);
  await fixture.finish(
    leader.dispatchId,
    JSON.stringify({
      schema: "squad-decision/v1",
      action: "converged",
      report: "# Failure review\n\nChild failed; delivery is incomplete.",
    }),
  );
  await fixture.waitStatus((state) => state.status === "converged");
  assertChildrenClosed(fixture, running.workerAttempts);
});

test(
  "ended stage assignments release their WIP slot before the next stage admits a worker",
  { timeout: 90_000 },
  async (t) => {
    // The limit fits the active parent plus one running assignment; a still-active
    // ended-stage assignment would exhaust it and reject the next stage's worker.
    const fixture = await openFixture(t, "stage-wip-release", { wipLimit: 2 });
    const counted = async () =>
      ((await fixture.cell.read("repo.tasks.wip", {}, binding)).counted as Array<{ taskId: string }>)
        .map((row) => row.taskId)
        .sort();
    const dispatchStage = (turn: { dispatchId: string }, to: string, owned: string[]) =>
      fixture.finish(
        turn.dispatchId,
        JSON.stringify({
          schema: "runtime-batch/v1",
          dispatches: [{ to, prompt: realizedTaskPlan(`stage ${to}`), ownedPaths: owned }],
        }),
      );
    await dispatchStage((await fixture.status()).leaderTurns[0], "one", ["a.txt"]);
    const stageOne = await fixture.waitStatus(
      (state) => state.workerAttempts.length === 1 && state.workerAttempts[0].runtimeSessionId !== null,
    );
    const first = stageOne.workerAttempts[0];
    assert.ok(first.taskId);
    assert.equal(fixture.task(first.taskId!).snapshot.task?.status, "active");
    assert.deepEqual(await counted(), [fixture.taskId, first.taskId!].sort());
    await fixture.finish(first.dispatchId!, "stage one delivered");
    const secondTurn = await fixture.waitStatus((state) => state.leaderTurns.length === 2);
    const settledFirst = fixture.task(first.taskId!);
    assert.equal(settledFirst.snapshot.task?.status, "cancelled", "ended stage assignment must leave the worktable");
    assert.equal(settledFirst.snapshot.lease, null);
    assert.deepEqual(await counted(), [fixture.taskId]);
    await dispatchStage(secondTurn.leaderTurns[1], "two", ["b.txt"]);
    const stageTwo = await fixture.waitStatus(
      (state) => state.workerAttempts.length === 2 && state.workerAttempts[1].runtimeSessionId !== null,
    );
    const second = stageTwo.workerAttempts[1];
    assert.ok(second.taskId);
    assert.equal(fixture.task(second.taskId!).snapshot.task?.status, "active");
    assert.deepEqual(await counted(), [fixture.taskId, second.taskId!].sort());
    await fixture.finish(second.dispatchId!, "stage two delivered");
    const thirdTurn = await fixture.waitStatus((state) => state.leaderTurns.length === 3);
    assert.equal(fixture.task(second.taskId!).snapshot.task?.status, "cancelled");
    assert.deepEqual(await counted(), [fixture.taskId]);
    await dispatchStage(thirdTurn.leaderTurns[2], "one", ["a.txt"]);
    const stageThree = await fixture.waitStatus(
      (state) => state.workerAttempts.length === 3 && state.workerAttempts[2].runtimeSessionId !== null,
    );
    const third = stageThree.workerAttempts[2];
    assert.ok(third.taskId);
    assert.deepEqual(await counted(), [fixture.taskId, third.taskId!].sort());
    await fixture.finish(third.dispatchId!, "stage three delivered");
    const finalTurn = await fixture.waitStatus((state) => state.leaderTurns.length === 4);
    await fixture.finish(
      finalTurn.leaderTurns[3].dispatchId,
      JSON.stringify({
        schema: "squad-decision/v1",
        action: "converged",
        report: "# Stages\n\nThree sequential stages each released their assignment slot.",
      }),
    );
    await fixture.waitStatus((state) => state.status === "converged");
    assertChildrenClosed(fixture, stageThree.workerAttempts);
    assert.deepEqual(await counted(), [fixture.taskId]);
  },
);

test(
  "shared suite host teardown cancels an active workers_running squad, runtimes and child tasks before lending the host",
  { timeout: 90_000 },
  async (t) => {
    const cleanupHost = createSuiteHost("active-workers-cleanup");
    let leakedSquadRunId = "",
      leakedParentTaskId = "",
      leakedWorkers: WorkerAttemptView[] = [];

    await t.test("first case returns while two workers remain active", async (sub) => {
      const first = await openFixture(sub, "leave-workers-active", { host: cleanupHost });
      await first.plan(["a.txt"], ["b.txt"]);
      const running = await first.waitStatus(
        (state) => state.workerAttempts.length === 2 && state.workerAttempts.every((worker) => worker.runtimeSessionId),
      );
      assert.equal(running.status, "workers_running");
      leakedSquadRunId = running.squadRunId;
      leakedParentTaskId = first.taskId;
      leakedWorkers = running.workerAttempts;
    });

    await t.test("next case receives a host with prior squad, runtimes, children and WIP settled", async (sub) => {
      const second = await openFixture(sub, "after-active-workers", { host: cleanupHost });
      const prior = evidence(
        await second.cell.run({ kind: "squad-status", squadRunId: leakedSquadRunId }, binding),
      ) as unknown as Status;
      assert.equal(prior.status, "cancelled");
      assert.ok(
        prior.leaderTurns.every((turn) => turn.status !== "running"),
        JSON.stringify(prior),
      );
      assert.ok(
        prior.workerAttempts.every((worker) => worker.status !== "running"),
        JSON.stringify(prior),
      );
      assertChildrenClosed(second, leakedWorkers);
      const priorParent = second.task(leakedParentTaskId);
      assert.equal(priorParent.snapshot.task?.status, "cancelled");
      assert.equal(priorParent.snapshot.lease, null);
      const wip = (await second.cell.read("repo.tasks.wip", {}, binding)).counted as Array<{ taskId: string }>;
      assert.deepEqual(
        wip.map((row) => row.taskId),
        [second.taskId],
        "prior active parent and child tasks must not leak WIP into the next shared-host case",
      );
    });
  },
);
