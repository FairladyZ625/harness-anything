// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { appendRuntimeWorkerRecord, readDispatchStreamSummary } from "../src/daemon-host/dispatch-stream.ts";
import { makeScheduleScheduler } from "../src/daemon-host/schedule-scheduler.ts";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";
import { latestSquadStates } from "./squad-run-state.fixture.ts";
import { assertChildrenClosed, binding, createSuiteHost, openFixture } from "./task-squad-orchestration.fixture.ts";

const suiteHost = createSuiteHost("boundaries-shared");

test("a leader batch outside summary windows fans out after writer restart", { timeout: 90_000 }, async (t) => {
  // A complete mission exceeds the 16 KiB summary head; provider output moves its
  // recovery snapshot outside the 128 KiB tail before the writer is replaced.
  const fixture = await openFixture(t, "large-control-recovery", {
      host: suiteHost,
      prompt: "Mission context.\n".repeat(2_000),
    }),
    initial = await fixture.status(),
    leader = initial.leaderTurns[0]!;
  for (let index = 0; index < 48; index += 1)
    appendRuntimeWorkerRecord(fixture.root, leader.dispatchId, {
      kind: "provider_event",
      event: { type: "item.started", item: { type: "reasoning", text: "x".repeat(4_096) } },
    });
  assert.equal(
    readDispatchStreamSummary(fixture.root, leader.dispatchId)?.records.some((row) => row.kind === "squad_run_state"),
    false,
    "the fixture must put the complete control snapshots outside the diagnostic summary",
  );
  await fixture.finish(
    leader.dispatchId,
    JSON.stringify({
      schema: "runtime-batch/v1",
      dispatches: [{ to: "one", prompt: realizedTaskPlan("Recovered worker mission"), ownedPaths: ["a.txt"] }],
    }),
    0,
    true,
  );
  await fixture.reopen();
  await fixture.until(async () => {
    const rows = (await fixture.cell.read("repo.task.dispatches", { taskId: fixture.taskId })).dispatches;
    return rows.some((row) => row.dispatchId === leader.dispatchId && row.outcome === "succeeded") ? true : null;
  }, "the adopted leader publishes its batch outcome");
  await fixture.cell.settlePendingMaterialization("leader outcome fans out");
  const running = await fixture.status();
  assert.equal(running.workerAttempts.length, 1, JSON.stringify(running));
  const worker = running.workerAttempts[0]!;
  assert.ok(worker.dispatchId && worker.runtimeSessionId && worker.taskId, JSON.stringify(worker));
  assert.equal(worker.rejection, null);
  const childRows = (await fixture.cell.read("repo.task.dispatches", { taskId: worker.taskId })).dispatches;
  assert.ok(childRows.some((row) => row.dispatchId === worker.dispatchId));
  await fixture.finish(worker.dispatchId, "Recovered worker completed");
  const callback = await fixture.waitStatus((state) => state.leaderTurns.length === 2);
  await fixture.finish(
    callback.leaderTurns[1]!.dispatchId,
    JSON.stringify({ schema: "squad-decision/v1", action: "converged", report: "# Recovered squad\nWorker verified." }),
  );
  const settled = await fixture.waitStatus((state) => state.status === "converged");
  assertChildrenClosed(fixture, settled.workerAttempts);
  t.diagnostic(JSON.stringify({ squadRunId: settled.squadRunId, leader, worker, status: settled.status }));
});

test("overlapping worker declarations reject the second child before execution", { timeout: 90_000 }, async (t) => {
  const fixture = await openFixture(t, "overlap", { host: suiteHost });
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
  "parent runtime delegation waits for accepted parent stop and retains its canonical lease",
  { timeout: 90_000 },
  async (t) => {
    const fixture = await openFixture(t, "runtime-caller", { host: suiteHost, runtimeCaller: true });
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

test(
  "scheduler preserves a Squad occurrence through a second leader turn and reclaims its worktree",
  { timeout: 90_000 },
  async (t) => {
    const fixture = await openFixture(t, "scheduled-squad", { host: suiteHost, startTaskSquad: false }),
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
    await fixture.until(
      () => (latestSquadStates(fixture.root).get(state.squadRunId)?.leaderTurns.length === 2 ? true : null),
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
    await fixture.until(
      () => (latestSquadStates(fixture.root).get(state.squadRunId)?.phase === "converged" ? true : null),
      "the scheduled Squad reaches a terminal converged state",
    );
    await fixture.until(async () => {
      const receipt = (await fixture.cell.run({ kind: "schedule-show", scheduleId }, binding)) as unknown as {
        readonly schedule: {
          readonly status: {
            readonly activeRun: unknown;
            readonly lastRun: { readonly outcome: string } | null;
          };
        };
      };
      return receipt.schedule.status.activeRun === null && receipt.schedule.status.lastRun?.outcome === "succeeded"
        ? true
        : null;
    }, "the Squad terminal state settles its occurrence claim");
    assert.equal(existsSync(occurrenceCwd), false, "settlement reclaims the remediation occurrence worktree");
  },
);
