// harness-test-tier: integration
import { makeScheduleScheduler } from "../src/schedule-scheduler.ts";
import { latestSquadStates } from "../src/squad-run-state.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, makeTaskProjection } from "@harness-anything/storage";
import { isExecutionWipTask } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type { RuntimeLauncher } from "../src/runtime-spawn-types.ts";
import type { SquadRunReadResult } from "../src/squad-run-contract.ts";
type WorkerAttempt = SquadRunReadResult["run"]["workerAttempts"][number];
import { appendRuntimeWorkerRecord, readDispatchStreamHeader } from "../src/dispatch-stream.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { evidence, git } from "./task-surface.fixtures.ts";
import { realizedTaskPlan, realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { eventually } from "./schedule-actions.fixtures.ts";

const binding = withPolicyGroup(
  {
    actor: { principal: { personId: "squad-owner" }, executor: { kind: "agent" as const, id: "coordinator" } },
    source: "local" as const,
  },
  "admin",
);
type Provider = {
  prompt: string;
  cwd: string;
  dispatchId: string;
  sessionId: string;
  output?: (chunk: string) => void;
  exit?: (code: number | null) => void;
  process?: ReturnType<typeof spawn>;
};
type Status = {
  squadRunId: string;
  status: string;
  error: string | null;
  leaderTurns: Array<{ dispatchId: string; runtimeSessionId: string }>;
  workerAttempts: WorkerAttempt[];
  workerCallbackCount: number;
  pendingLeaderCallbackCount: number;
};

async function stopFixtureProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  } else {
    child.kill("SIGKILL");
  }
  await closed;
}

test(
  "squad children submit independently, resume one leader and integrate a verified local-remote delivery",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await openFixture(t, "delivery");
    const planningLeader = (await fixture.status()).leaderTurns[0].runtimeSessionId;
    assert.equal(fixture.task(fixture.taskId).snapshot.lease?.actor.executor?.id, `runtime-session:${planningLeader}`);
    await fixture.plan(["src/a.txt"], ["docs/"]);
    const running = await fixture.waitStatus(
      (state) => state.workerAttempts.length === 2 && state.workerAttempts.every((w) => w.runtimeSessionId),
    );
    const planningEvents = makeTaskEventReader({ repoId: fixture.repoId, rootDir: fixture.root }).read().events;
    const leaderRelease = planningEvents.findIndex(
      (event) =>
        event.type === "lease_released" &&
        event.taskId === fixture.taskId &&
        event.payload.releasedLease.actor.executor?.id === `runtime-session:${planningLeader}`,
    );
    const coordinatorReacquire = planningEvents.findIndex(
      (event, index) =>
        index > leaderRelease &&
        event.type === "execution_started" &&
        event.taskId === fixture.taskId &&
        event.actor.executor?.id === "coordinator",
    );
    assert.ok(
      leaderRelease >= 0 && coordinatorReacquire > leaderRelease,
      "leader release must precede coordinator callback reacquisition",
    );
    const staleLeaderWrite = await fixture.cell.run(
      {
        kind: "task-progress-append",
        taskId: fixture.taskId,
        text: "stale planning leader",
        executor: { kind: "agent", id: `runtime-session:${planningLeader}` },
      },
      binding,
    );
    assert.equal(staleLeaderWrite.code, "executor_binding_invalid");
    const [first, second] = running.workerAttempts;
    assert.ok(first.taskId && second.taskId && first.executionId && second.executionId);
    assert.notEqual(first.taskId, second.taskId);
    assert.notEqual(first.executionId, second.executionId);
    assert.notEqual(first.taskId, fixture.taskId);
    for (const child of running.workerAttempts) {
      const row = fixture.task(child.taskId!);
      assert.equal(row.snapshot.lease?.executionId, child.executionId);
      assert.match(
        readFileSync(path.join(fixture.root, "harness", row.packagePath!, "task_plan.md"), "utf8"),
        /worker mission/u,
      );
    }
    const heads: string[] = [];
    for (const [index, child] of running.workerAttempts.entries()) {
      assert.ok(child.worktree);
      const target = index === 0 ? "src/a.txt" : "docs/b.txt";
      mkdirSync(
        path.dirname(
          path.join(fixture.providers.find((provider) => provider.dispatchId === child.dispatchId)!.cwd, target),
        ),
        { recursive: true },
      );
      writeFileSync(
        path.join(fixture.providers.find((provider) => provider.dispatchId === child.dispatchId)!.cwd, target),
        `child ${index}\n`,
      );
      if (index === 1)
        writeFileSync(
          path.join(fixture.providers.find((provider) => provider.dispatchId === child.dispatchId)!.cwd, "outside.txt"),
          "ownership finding\n",
        );
      git(fixture.providers.find((provider) => provider.dispatchId === child.dispatchId)!.cwd, "add", ".");
      git(
        fixture.providers.find((provider) => provider.dispatchId === child.dispatchId)!.cwd,
        "commit",
        "-qm",
        `docs: child ${index} delivery`,
      );
      heads.push(
        git(fixture.providers.find((provider) => provider.dispatchId === child.dispatchId)!.cwd, "rev-parse", "HEAD"),
      );
      await fixture.submit(child, heads[index]);
      await fixture.finish(child.dispatchId!, "child delivery");
      if (index === 0) {
        await fixture.waitStatus((state) => state.workerCallbackCount === 1);
        assert.equal((await fixture.status()).leaderTurns.length, 1, "one live child keeps the leader suspended");
      }
    }
    const resumed = await fixture.waitStatus((state) => state.leaderTurns.length === 2);
    assert.equal(resumed.workerCallbackCount, 2);
    assert.deepEqual(
      latestSquadStates(fixture.root).get(resumed.squadRunId)?.workerAttempts[1].ownershipCheck?.outsidePaths,
      ["outside.txt"],
    );
    assert.equal(
      git(fixture.providers.find((provider) => provider.dispatchId === second.dispatchId)!.cwd, "rev-parse", "HEAD"),
      heads[1],
      "finding does not roll back delivery",
    );
    for (const child of resumed.workerAttempts) {
      assert.equal(fixture.task(child.taskId!).snapshot.lease, null);
      const submitted = makeTaskEventReader({ repoId: fixture.repoId, rootDir: fixture.root })
        .read()
        .events.filter((event) => event.type === "execution_submitted" && event.taskId === child.taskId);
      assert.equal(submitted.length, 1);
    }
    // Duplicate process notifications must not create another leader turn.
    for (const child of resumed.workerAttempts)
      fixture.providers.find((p) => p.dispatchId === child.dispatchId)!.exit!(0);
    await fixture.cell.settlePendingMaterialization("duplicate child notifications");
    assert.equal((await fixture.status()).leaderTurns.length, 2);
    const leader = fixture.providers.find((p) => p.dispatchId === resumed.leaderTurns[1].dispatchId)!;
    assert.match(leader.prompt, /outside\.txt/u);
    // The leader carries the commander delivery contract for the CEO, not the worker delivery
    // loop; the framework's one-line PR note may ride the task-bound mission, but the worker's
    // exact publication loop never does.
    assert.match(leader.prompt, /delivery contract with the CEO/u);
    assert.doesNotMatch(leader.prompt, /ha task push <task-id>|ha task pr <task-id>|task delivery commands/u);
    assert.match(leader.prompt, /Do not merge/u);
    await fixture.cell.settlePendingMaterialization("before public integration");
    git(fixture.root, "checkout", "-qb", "codex/mission-delivery");
    for (const head of heads) git(fixture.root, "cherry-pick", head);
    assert.equal(readFileSync(path.join(fixture.root, "src/a.txt"), "utf8"), "child 0\n");
    assert.equal(readFileSync(path.join(fixture.root, "docs/b.txt"), "utf8"), "child 1\n");
    const bare = fixture.bare;
    assert.equal(
      git(bare, "for-each-ref", "--format=%(refname)", "refs/heads/"),
      "",
      "child settlement leaves the configured remote unpublished",
    );
    git(fixture.root, "push", "origin", "codex/mission-delivery");
    assert.equal(git(bare, "rev-parse", "refs/heads/codex/mission-delivery"), git(fixture.root, "rev-parse", "HEAD"));
    assert.equal(git(bare, "for-each-ref", "--format=%(refname)", "refs/heads/codex/squad-"), "");
    await fixture.finish(
      leader.dispatchId,
      JSON.stringify({
        schema: "squad-decision/v1",
        action: "converged",
        report: "# Delivery\n\nIntegrated child evidence; local PR command verified.",
      }),
    );
    await fixture.waitStatus((state) => state.status === "converged");
    // dec_B3A15CC2/CH1: attribution follows the actual handoffs, not the first leader's terminal event.
    assertChildrenClosed(fixture, running.workerAttempts);
    const finalExecution = fixture.task(fixture.taskId).snapshot.executions.at(-1)!;
    assert.equal(finalExecution.actor.executor?.id, "coordinator");
    assert.notEqual(finalExecution.actor.executor?.id, `runtime-session:${planningLeader}`);
    assert.equal(
      (await fixture.cell.run({ kind: "task-release", taskId: fixture.taskId }, binding)).outcome,
      "applied",
    );
    await fixture.cell.settlePendingMaterialization("squad owner closeout");
    writeFileSync(
      path.join(fixture.root, "harness", fixture.task(fixture.taskId).packagePath!, "closeout.md"),
      `## Summary\nIntegrated child delivery ${git(fixture.root, "rev-parse", "HEAD")}.\n## Verification\nChild commits and synthesis checked.\n` +
        "## Residual Risk\nNo external PR created.\n## Same Mechanism Elsewhere\nExplicit handoff attribution.\n",
    );
    const ownerBinding = { ...binding, actor: { ...binding.actor, executor: null } };
    const settled = await fixture.cell.run({ kind: "task-settle", taskId: fixture.taskId }, ownerBinding);
    assert.equal(settled.outcome, "applied", JSON.stringify(settled));
    assert.deepEqual(fixture.task(fixture.taskId).snapshot.executions.at(-1)?.actor, finalExecution.actor);
    const recoveredSubmit = await fixture.cell.run({ kind: "task-settle", taskId: fixture.taskId }, ownerBinding);
    assert.equal(recoveredSubmit.outcome, "applied", JSON.stringify(recoveredSubmit));
    assert.equal(
      recoveredSubmit.opId,
      settled.opId,
      "owner resumes the same submission without restamping the planning leader",
    );
    const launches = fixture.providers.length;
    await fixture.reopen();
    const recovered = await fixture.status();
    assert.equal(recovered.status, "converged");
    assert.equal(recovered.leaderTurns.length, 2);
    assert.equal(fixture.providers.length, launches, "reopening the center must not dispatch another leader");
  },
);

test(
  "scheduler preserves a Squad occurrence through a second leader turn and reclaims its worktree",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await openFixture(t, "scheduled-squad"),
      scheduleId = "schedule-squad-e2e",
      initialProviderCount = fixture.providers.length;
    const created = await fixture.cell.run(
      {
        kind: "schedule-create",
        scheduleId,
        name: "Scheduled Squad",
        mode: "remediate",
        everyMs: 300_000,
        squadId: "squad",
        mission: "Inspect the scheduled Squad path and converge.",
        idempotencyKey: "create-scheduled-squad",
      },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const started = await fixture.cell.run(
      { kind: "schedule-run-now", scheduleId, idempotencyKey: "run-scheduled-squad" },
      binding,
    );
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const state = [...latestSquadStates(fixture.root).values()].find(
      (candidate) => candidate.subject.kind === "schedule-occurrence" && candidate.subject.scheduleId === scheduleId,
    );
    assert.ok(state, "the schedule claim creates a persisted Squad state");
    assert.equal(state.subject.kind, "schedule-occurrence");
    assert.equal(state.scheduleRuntime?.mode, "remediate");
    const scheduleRuntime = state.scheduleRuntime;
    assert.ok(scheduleRuntime?.worktree, "remediate occurrence worktree is retained with the run state");
    const occurrenceCwd = scheduleRuntime.worktree.cwd;
    assert.equal(existsSync(occurrenceCwd), true);
    const activeSchedule = (await fixture.cell.run({ kind: "schedule-show", scheduleId }, binding)) as unknown as {
      readonly schedule: { readonly status: { readonly activeRun: { readonly claimFence: string } | null } };
    };
    assert.equal(activeSchedule.schedule.status.activeRun?.claimFence, state.subject.claimFence);
    const duplicate = await fixture.cell.run(
      { kind: "schedule-run-now", scheduleId, idempotencyKey: "run-scheduled-squad-again" },
      binding,
    );
    assert.equal(duplicate.code, "schedule_single_flight_active");
    assert.equal(
      fixture.providers.length,
      initialProviderCount + 1,
      "the active occurrence owns one initial leader dispatch",
    );
    const scheduler = makeScheduleScheduler({
      cells: new Map([[fixture.repoId, fixture.cell]]),
      localBinding: () => binding,
      // Drive recovery explicitly; automatic cadence must not race this manual occurrence.
      setTimer: () => ({ unref() {} }) as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    });
    t.after(async () => scheduler.close());
    await scheduler.start();
    await fixture.finish(state.leaderTurns[0]!.dispatchId, "Leader returned an invalid decision; retry this turn.");
    assert.equal(
      await eventually(() => latestSquadStates(fixture.root).get(state.squadRunId)?.leaderTurns.length === 2),
      true,
      "an invalid first decision dispatches a second leader under the same claim",
    );
    await scheduler.refresh();
    const stillActive = (await fixture.cell.run({ kind: "schedule-show", scheduleId }, binding)) as unknown as {
      readonly schedule: { readonly status: { readonly activeRun: { readonly claimFence: string } | null } };
    };
    assert.equal(
      stillActive.schedule.status.activeRun?.claimFence,
      state.subject.claimFence,
      "scheduler recovery must leave Squad settlement to the coordinator after leader one exits",
    );
    assert.equal(existsSync(occurrenceCwd), true, "the second leader still owns its occurrence worktree");
    const secondLeader = latestSquadStates(fixture.root).get(state.squadRunId)!.leaderTurns[1]!;
    await fixture.finish(
      secondLeader.dispatchId,
      JSON.stringify({ schema: "squad-decision/v1", action: "converged", report: "Schedule Squad converged." }),
    );
    assert.equal(
      await eventually(() => latestSquadStates(fixture.root).get(state.squadRunId)?.phase === "converged"),
      true,
      "the scheduled Squad reaches a terminal converged state",
    );
    assert.equal(
      await eventually(async () => {
        const receipt = (await fixture.cell.run({ kind: "schedule-show", scheduleId }, binding)) as unknown as {
          readonly schedule: {
            readonly status: {
              readonly activeRun: unknown;
              readonly lastRun: { readonly outcome: string } | null;
            };
          };
        };
        return receipt.schedule.status.activeRun === null && receipt.schedule.status.lastRun?.outcome === "succeeded";
      }),
      true,
      "the Squad terminal state settles its occurrence claim",
    );
    assert.equal(existsSync(occurrenceCwd), false, "settlement reclaims the remediation occurrence worktree");
  },
);

for (const restart of [false, true])
  test(
    `targeted task publishes while same-squad child stays local (restart=${restart})`,
    { timeout: 30_000 },
    async (t) => {
      // Each independent repository has its own identity in the shared fixture realm.
      const fixture = await openFixture(t, `publication-owner-${restart}`);
      await fixture.plan(["a.txt"], ["b.txt"]);
      const running = await fixture.waitStatus(
        (state) => state.workerAttempts.length === 2 && state.workerAttempts.every((w) => w.runtimeSessionId),
      );
      const child = running.workerAttempts[0],
        taskId = "task_direct-targeted",
        created = await fixture.cell.run(
          {
            kind: "task-create",
            taskId,
            title: "Direct targeted",
            presetId: "standard-task",
          },
          binding,
        );
      assert.equal(created.outcome, "applied");
      await waitForFixturePublication(fixture.cell, created.opId, binding);
      await realizeTaskPlanFixture(fixture.root, String((created as Record<string, unknown>).packagePath), (planPath) =>
        fixture.cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
      );
      assert.equal((await fixture.cell.run({ kind: "task-start", taskId }, binding)).outcome, "applied");
      // Starting a repository-diff task materializes its task-named publication branch.
      const cwd = path.join(fixture.root, ".worktrees", taskId);
      const direct = await fixture.cell.spawnRuntime(
        {
          runtimeInstanceId: "stub",
          agentId: "leader",
          targetAgentId: "one",
          taskId,
          cwd: { scope: "repo-relative", path: `.worktrees/${taskId}` },
          prompt: "Deliver the directly targeted task.",
          dispatchKey: "direct-targeted",
        },
        binding,
      );
      const childHeader = readDispatchStreamHeader(fixture.root, child.dispatchId!)!,
        directHeader = readDispatchStreamHeader(fixture.root, String(direct.dispatchId))!;
      assert.equal(childHeader.squadId, "squad");
      assert.equal(directHeader.squadId, childHeader.squadId);
      assert.equal(childHeader.publicationOwner, "commander");
      assert.equal(directHeader.publicationOwner, "runtime");
      for (const directory of [
        fixture.providers.find((provider) => provider.dispatchId === child.dispatchId)!.cwd,
        cwd,
      ]) {
        writeFileSync(path.join(directory, "a.txt"), "delivery\n");
        git(directory, "add", "a.txt");
        git(directory, "commit", "-qm", "feat: targeted delivery");
      }
      await fixture.finish(child.dispatchId!, "child delivery", 0, restart);
      await fixture.finish(String(direct.dispatchId), "direct delivery", 0, restart);
      if (restart) await fixture.reopen();
      await fixture.waitStatus((state) => state.workerCallbackCount >= 1);
      await fixture.cell.settlePendingMaterialization("publication owner");
      const rows = (await fixture.cell.read("repo.task.dispatches", { taskId })).dispatches;
      assert.equal(rows[0]?.outcome, "succeeded");
      const childRows = (await fixture.cell.read("repo.task.dispatches", { taskId: child.taskId! })).dispatches;
      assert.equal(childRows[0]?.outcome, "succeeded");
      assert.equal(
        readFileSync(path.join(fixture.root, "harness", childRows[0].reportPath!), "utf8").trim(),
        "child delivery",
      );
      const report = readFileSync(path.join(fixture.root, "harness", rows[0].reportPath!), "utf8");
      assert.match(report, new RegExp(`Worker branch pushed at settlement: ${taskId} @`, "u"));
      assert.equal(
        git(fixture.bare, "for-each-ref", "--format=%(objectname)", `refs/heads/${taskId}`),
        git(cwd, "rev-parse", "HEAD"),
      );
      assert.equal(git(fixture.bare, "for-each-ref", "--format=%(refname)", `refs/heads/${taskId}--squad-`), "");
    },
  );

for (const ending of ["cancelled", "failed"] as const)
  test(`squad ${ending} closes child tasks and releases their WIP slots`, { timeout: 30_000 }, async (t) => {
    const fixture = await openFixture(t, `child-closeout-${ending}`);
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

function assertChildrenClosed(fixture: Awaited<ReturnType<typeof openFixture>>, children: readonly WorkerAttempt[]) {
  for (const child of children) {
    const row = fixture.task(child.taskId!),
      task = row.snapshot.task!;
    assert.equal(task.status, "cancelled", `child ${child.taskId} must end with its run`);
    assert.equal(row.snapshot.lease, null);
    assert.equal(
      isExecutionWipTask({
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        taskClass: task.taskClass,
        packageDisposition: task.packageDisposition ?? "active",
        hasCloseoutEvidence: false,
        hasOwnExecution: true,
        directChildCount: 0,
      }),
      false,
      "settled child must release WIP",
    );
  }
}

test("failed child wakes the leader with the failure after its sibling settles", { timeout: 30_000 }, async (t) => {
  const fixture = await openFixture(t, "failure");
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
    const fixture = await openFixture(t, "stage-wip-release", false, 2);
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

test("overlapping worker declarations reject the second child before execution", { timeout: 30_000 }, async (t) => {
  const fixture = await openFixture(t, "overlap");
  await fixture.plan(["src/"], ["SRC/a.txt"]);
  const state = await fixture.waitStatus(
    (value) => value.workerAttempts.length === 2 && value.workerAttempts[1].rejection !== null,
  );
  assert.ok(state.workerAttempts[0].runtimeSessionId);
  assert.match(state.workerAttempts[1].rejection ?? "", /Ownership conflict/u);
  assert.equal(state.workerAttempts[1].taskId, null);
  assert.equal(state.workerAttempts[1].runtimeSessionId, null);
  await fixture.finish(
    state.workerAttempts[0].dispatchId!,
    "first child completed\n```bash\ncloseout/submission/review/consent\n```",
  );
  const resumed = await fixture.waitStatus((value) => value.leaderTurns.length === 2);
  const callback = fixture.providers.find((provider) => provider.dispatchId === resumed.leaderTurns[1].dispatchId)!;
  assert.match(callback.prompt, /worker_rejected/u);
  assert.match(callback.prompt, /Ownership conflict/u);
  assert.match(callback.prompt, /closeout\/submission\/review\/consent/u);
  await fixture.finish(
    resumed.leaderTurns[1].dispatchId,
    JSON.stringify({
      schema: "squad-decision/v1",
      action: "converged",
      report: "# Overlap\n\nConflicting child rejected.",
    }),
  );
  await fixture.waitStatus((value) => value.status === "converged");
});

test(
  "a real parent runtime actor dispatches child plans through its canonical parent lease",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await openFixture(t, "runtime-caller", true);
    await fixture.plan(["a.txt"], ["b.txt"]);
    const running = await fixture.waitStatus(
      (state) => state.workerAttempts.length === 2 && state.workerAttempts.every((w) => w.runtimeSessionId),
    );
    for (const child of running.workerAttempts) {
      assert.ok(child.taskId && child.executionId);
      assert.equal(fixture.task(child.taskId).snapshot.task?.metadata?.parentTaskId, fixture.taskId);
      await fixture.finish(child.dispatchId!, "runtime caller child delivery");
    }
    const resumed = await fixture.waitStatus(
      (state) => state.leaderTurns.length === 2 && state.workerCallbackCount === 2,
    );
    assert.equal(resumed.pendingLeaderCallbackCount, 0, "same-cut child outcomes are consumed by one leader turn");
    await fixture.finish(
      resumed.leaderTurns[1].dispatchId,
      JSON.stringify({
        schema: "squad-decision/v1",
        action: "converged",
        report: "# Runtime caller\n\nChild plans published under the actual parent runtime identity.",
      }),
    );
    await fixture.waitStatus((state) => state.status === "converged");
    assertChildrenClosed(fixture, running.workerAttempts);
    await fixture.finish(fixture.parentDispatchId!, "parent caller completed");
  },
);

async function openFixture(
  t: { after(fn: () => Promise<void>): void },
  slug: string,
  runtimeCaller = false,
  wipLimit?: number,
) {
  const parent = mkdtempSync(path.join(tmpdir(), `ha-squad-e2e-${slug}-`)),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = workspaceId(`squad-e2e-${slug}`),
    taskId = `task-squad-e2e-${slug}`,
    providers: Provider[] = [];
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Task Surface Test");
  git(root, "config", "user.email", "task-surface@example.invalid");
  git(root, "commit", "--allow-empty", "-qm", "base");
  const bare = path.join(parent, "remote.git");
  git(parent, "init", "--bare", bare);
  git(root, "remote", "add", "origin", bare);
  mkdirSync(path.join(root, "harness"));
  // Workers deliver repository commits; the parent task below delivers the Squad synthesis report.
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings:\n  defaultVertical: software/coding\n  defaultPreset: standard-task\n  defaultProfile: baseline\n" +
      (wipLimit === undefined ? "" : `  tasks:\n    wipLimit: ${wipLimit}\n`),
  );
  writeFileSync(path.join(root, ".gitignore"), "harness/\n.harness/\n.worktrees/\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-qm", "test: fixture boundaries");
  // Squad orchestration exercises the external identity path. The product default remains
  // builtin when this selector is absent; this multi-process fixture must opt into Keycloak.
  mkdirSync(path.join(userRoot, "rbac"), { recursive: true });
  writeFileSync(
    path.join(userRoot, "rbac", "config.json"),
    JSON.stringify({ schema: "harness-managed-rbac/v1", mode: "external" }),
  );
  const runtimeLaunch: RuntimeLauncher = (prepared, persistence) => {
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    if (!child.pid) throw new Error("fixture worker child did not expose a pid");
    child.unref();
    const provider: Provider = {
      prompt: prepared.prompt,
      cwd: prepared.cwd,
      dispatchId: persistence.dispatchId,
      sessionId: prepared.args[0] ?? `provider-${persistence.dispatchId}`,
      process: child,
    };
    providers.push(provider);
    return {
      pid: child.pid,
      onOutput: (listener) => {
        provider.output = listener;
        queueMicrotask(() =>
          listener(JSON.stringify({ type: "thread.started", thread_id: provider.sessionId }) + "\n"),
        );
      },
      onErrorOutput: () => undefined,
      onExit: (listener) => {
        provider.exit = listener;
      },
      terminate: () => {
        void stopFixtureProcess(child);
      },
      terminateTree: () => stopFixtureProcess(child),
    };
  };
  const open = () =>
    openBootstrappedRepoCell({
      keycloakSession: async () => binding.keycloakAuthorization.session,
      repoId,
      rootDir: canonicalRoot(root),
      ownerId: `squad-${slug}`,
      runtimeDaemonRoute: {
        userRoot,
        daemonId: "test",
        endpoint: path.join(parent, "socket"),
      },
      runtimeInstances: () => [
        {
          schemaVersion: 2,
          instanceId: "stub",
          name: "Stub",
          kindId: "codex",
          installationId: "installation-stub",
          providerId: "openai",
          models: ["stub-model"],
          defaultModel: "stub-model",
          enabled: true,
          permissionMode: "workspace-write",
          codex: {},
          authMode: "subscription",
          authState: "configured",
          authReadiness: { status: "ready", code: null, hint: null },
          isolationState: "enforced",
        },
      ],
      prepareRuntimeLaunch: (instanceId, request) => ({
        definition: {
          schema: "agent-definition-snapshot/v1",
          configVersion: 1,
          instanceId,
          installationId: "installation-stub",
          kindId: "codex",
          providerId: "openai",
          model: "stub-model",
          reasoningEffort: null,
          baseUrl: null,
          authMode: "subscription",
        },
        installation: {
          installationId: "installation-stub",
          kindId: "codex",
          executablePath: "/fixture/stub",
          version: "1.0.0",
          observedAt: "2026-09-20T00:00:00.000Z",
        },
        executablePath: "/fixture/stub",
        args: request.providerSessionId ? [request.providerSessionId] : [],
        env: process.env,
        cwd: request.cwd,
        prompt: request.prompt,
      }),
      runtimeLaunch,
    });
  let cell = await open();
  t.after(async () => {
    await Promise.all(
      providers.flatMap((provider) => (provider.process ? [stopFixtureProcess(provider.process)] : [])),
    );
    await cell.close();
    rmSync(parent, { recursive: true, force: true });
  });
  for (const [id, role] of [
    ["leader", "commander"],
    ["one", "worker"],
    ["two", "worker"],
  ]) {
    const receipt = await cell.run(
      {
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id,
          name: id,
          role,
          instructions: "Perform the assigned role.",
          runtimes: [{ type: "codex" }],
        },
      },
      binding,
    );
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  }
  const installed = await cell.run(
    {
      kind: "squad-install",
      declaration: {
        schema: "squad-declaration/v1",
        id: "squad",
        name: "Squad",
        leader: "leader",
        workers: ["one", "two"],
        leaderTurnBudget: 4,
        roster: "Leader integrates two independent workers and writes artifacts/reports/{squadRunId}.md.",
      },
    },
    binding,
  );
  assert.equal(installed.outcome, "applied", JSON.stringify(installed));
  const created = await cell.run(
    { kind: "task-create", taskId, title: "Squad mission", presetId: "docs-task" },
    binding,
  );
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  await waitForFixturePublication(cell, created.opId, binding);
  await realizeTaskPlanFixture(root, String((created as Record<string, unknown>).packagePath), (planPath) =>
    cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
  );
  let squadBinding = binding,
    parentDispatchId: string | null = null;
  if (runtimeCaller) {
    const executing = await cell.run({ kind: "task-start", taskId }, binding);
    assert.equal(executing.outcome, "applied", JSON.stringify(executing));
    const caller = await cell.spawnRuntime(
      {
        runtimeInstanceId: "stub",
        agentId: "leader",
        taskId,
        cwd: { scope: "repo-root" },
        prompt: "Coordinate the mission through squad-run.",
        dispatchKey: "parent-caller",
      },
      binding,
    );
    parentDispatchId = String(caller.dispatchId);
    squadBinding = {
      ...binding,
      actor: {
        ...binding.actor,
        executor: { kind: "agent", id: `runtime-session:${String(caller.runtimeSessionId)}` },
      },
    };
  }
  const started = await cell.run(
    { kind: "squad-run", squadId: "squad", taskId, runtimeInstanceId: "stub", cwd: { scope: "repo-root" } },
    squadBinding,
  );
  assert.equal(started.outcome, "completed", JSON.stringify(started));
  const squadRunId = String(evidence(started).squadRunId);
  const status = async () =>
    evidence(await cell.run({ kind: "squad-status", squadRunId }, binding)) as unknown as Status;
  const task = (id: string) => {
    const projection = makeTaskProjection({
      rootDir: root,
      eventStore: makeTaskEventReader({ repoId, rootDir: root }),
    });
    try {
      projection.catchUp();
      return projection.read(id);
    } finally {
      projection.close();
    }
  };
  const finish = async (dispatchId: string, text: string, code = 0, offline = false) => {
    const provider = providers.find((row) => row.dispatchId === dispatchId)!;
    await stopFixtureProcess(provider.process!);
    if (offline)
      appendRuntimeWorkerRecord(root, dispatchId, {
        kind: "process_started",
        occurredAt: new Date().toISOString(),
        pid: provider.process?.pid,
      });
    for (const event of [
      { type: "thread.started", thread_id: provider.sessionId },
      {
        type: "item.completed",
        item: {
          id: "write",
          type: "file_change",
          changes: [{ path: "delivery.txt", kind: "add" }],
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: { id: "result", type: "agent_message", text },
      },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]) {
      if (offline)
        appendRuntimeWorkerRecord(root, dispatchId, {
          kind: "provider_event",
          occurredAt: new Date().toISOString(),
          event,
        });
      else provider.output!(JSON.stringify(event) + "\n");
    }
    appendRuntimeWorkerRecord(root, dispatchId, {
      kind: "process_exit",
      occurredAt: new Date().toISOString(),
      exitCode: code,
      signal: null,
    });
    if (!offline) provider.exit!(code);
  };
  const waitStatus = async (predicate: (state: Status) => unknown) => {
    let last: Status | undefined;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      last = await status();
      if (predicate(last)) return last;
      if (last.status === "failed") throw new Error(JSON.stringify(last));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Squad did not reach expected state: ${JSON.stringify(last)}`);
  };
  return {
    parent,
    root,
    bare,
    repoId,
    taskId,
    get cell() {
      return cell;
    },
    providers,
    status,
    task,
    finish,
    waitStatus,
    parentDispatchId,
    reopen: async () => {
      await cell.close();
      cell = await open();
    },
    plan: async (first: string[], second: string[]) => {
      const state = await status();
      await finish(
        state.leaderTurns[0].dispatchId,
        JSON.stringify({
          schema: "runtime-batch/v1",
          dispatches: [
            { to: "one", prompt: realizedTaskPlan("worker mission one"), ownedPaths: first },
            { to: "two", prompt: realizedTaskPlan("worker mission two"), ownedPaths: second },
          ],
        }),
      );
    },
    submit: async (child: WorkerAttempt, head: string) => {
      await cell.settlePendingMaterialization("child closeout fixture");
      const row = task(child.taskId!),
        holder = {
          ...binding,
          actor: {
            principal: binding.actor.principal,
            executor: { kind: "agent" as const, id: `runtime-session:${child.runtimeSessionId}` },
          },
        };
      writeFileSync(
        path.join(root, "harness", row.packagePath!, "closeout.md"),
        `# Closeout\n\n## Summary\n\nDelivered ${head}.\n\n## Verification\n\nCommitted child file contents inspected.\n\n## Residual Risk\n\nIntegration review remains.\n\n## Same Mechanism Elsewhere\n\nSibling delivery uses the same protocol.\n`,
      );
      const receipt = await cell.run(
        { kind: "task-submit", taskId: child.taskId!, executionId: child.executionId!, commitSha: head },
        holder,
      );
      assert.equal(receipt.outcome, "applied", `real child submit: ${JSON.stringify(receipt)}`);
    },
  };
}
