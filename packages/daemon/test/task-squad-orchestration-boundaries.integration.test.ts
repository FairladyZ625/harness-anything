// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import test from "node:test";
import { appendRuntimeWorkerRecord, readDispatchStreamSummary } from "../src/daemon-host/dispatch-stream.ts";
import { canonicalRoot } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { acquireWorkspaceLock } from "../src/daemon-host/repo-cell-lock.ts";
import { makeScheduleScheduler } from "../src/daemon-host/schedule-scheduler.ts";
import { activePhase } from "../src/daemon-host/squad-run-list.ts";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";
import { latestSquadStates } from "./squad-run-state.fixture.ts";
import {
  assertChildrenClosed,
  binding,
  createSuiteHost,
  openFixture,
  stopFixtureProcess,
  type HostBootstrapProbe,
} from "./task-squad-orchestration.fixture.ts";

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
    const fixture = await openFixture(t, "scheduled-squad", { host: suiteHost }),
      scheduleId = "schedule-squad-e2e",
      initialProviderCount = fixture.providers.length;
    assert.equal(
      activePhase((await fixture.status()).status),
      true,
      "a concurrent task-bound Squad is active before scheduling the occurrence",
    );
    assert.equal(initialProviderCount, 1, "the task-bound Squad already owns its active initial leader");
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
    assert.equal(
      activePhase((await fixture.status()).status),
      true,
      "settling the scheduled occurrence leaves the concurrent task-bound Squad active",
    );
  },
);

test(
  "failed host installation closes the writer lock, cell, projection reader and temp directory for standalone and shared hosts",
  { timeout: 90_000 },
  async (t) => {
    const verifyFailureCleanup = async (
      run: (onResourcesOpened: (probe: HostBootstrapProbe) => void) => Promise<unknown>,
    ) => {
      let captured: HostBootstrapProbe | null = null,
        projectionClosed = false;
      await assert.rejects(
        run((probe) => {
          captured = probe;
          assert.equal(existsSync(probe.parent), true);
          assert.equal(existsSync(probe.lockPath), true);
          assert.equal(probe.cell.status().state, "attached");
          const originalClose = probe.taskProjection.close.bind(probe.taskProjection);
          probe.taskProjection.close = () => {
            projectionClosed = true;
            originalClose();
          };
        }),
      );
      assert.ok(captured, "resources must open before squad-install fails");
      const probe = captured as HostBootstrapProbe;
      assert.throws(
        () => probe.cell.status(),
        /database is not open/u,
        "writer cell store must close on bootstrap failure",
      );
      assert.equal(projectionClosed, true, "projection reader must close on bootstrap failure");
      assert.equal(existsSync(probe.lockPath), false, "writer lock file must be removed");
      assert.equal(existsSync(probe.parent), false, "temporary fixture directory must be removed");
      mkdirSync(probe.root, { recursive: true });
      try {
        const relock = await acquireWorkspaceLock(probe.root);
        await relock.close();
      } finally {
        rmSync(probe.parent, { recursive: true, force: true });
      }
    };

    await verifyFailureCleanup((onResourcesOpened) =>
      openFixture(t, "install-fail-standalone", {
        squadWorkers: ["INVALID WORKER ID!"],
        onResourcesOpened,
      }),
    );

    await verifyFailureCleanup((onResourcesOpened) =>
      createSuiteHost("install-fail-shared", {
        squadWorkers: ["INVALID WORKER ID!"],
        onResourcesOpened,
      }).get(),
    );

    await verifyFailureCleanup((onResourcesOpened) =>
      openFixture(t, "install-fail-shared-consumer", {
        host: createSuiteHost("install-fail-shared-consumer", {
          squadWorkers: ["INVALID WORKER ID!"],
          onResourcesOpened,
        }),
      }),
    );
  },
);

test(
  "shared suite host evicts and closes a host after reopen or teardown failure so the next case gets a clean host",
  { timeout: 90_000 },
  async (t) => {
    const recoveryHost = createSuiteHost("reopen-eviction");
    let brokenRoot = "",
      brokenParent = "";

    await t.test("reopen failure evicts the broken shared host and preserves the original error", async (sub) => {
      const first = await openFixture(sub, "reopen-fails", { host: recoveryHost });
      brokenRoot = first.root;
      brokenParent = first.parent;
      let heldLock: Awaited<ReturnType<typeof acquireWorkspaceLock>> | null = null;
      try {
        await assert.rejects(
          () =>
            first.reopen(async () => {
              heldLock = await acquireWorkspaceLock(canonicalRoot(first.root));
            }),
          /Workspace writer lock is held/u,
        );
      } finally {
        await heldLock?.close();
      }
      assert.equal(existsSync(brokenParent), false, "failed reopen must close and remove the evicted host");
    });

    await t.test("next shared case receives a fresh clean host and succeeds at task-create", async (sub) => {
      const second = await openFixture(sub, "after-reopen-failure", { host: recoveryHost });
      assert.notEqual(second.root, brokenRoot, "next case must not reuse the evicted host");
      assert.equal(existsSync(second.parent), true);
      const created = await second.cell.run(
        { kind: "task-create", taskId: "task-clean-after-reopen-evict", title: "Clean host", presetId: "docs-task" },
        binding,
      );
      assert.equal(created.outcome, "applied", JSON.stringify(created));
    });

    let cleanupFn: (() => Promise<void>) | null = null;
    const third = await openFixture(
      {
        after: (fn) => {
          cleanupFn = fn;
        },
      },
      "teardown-fails",
      { host: recoveryHost },
    );
    const teardownBrokenRoot = third.root,
      teardownBrokenParent = third.parent;
    await third.cell.close();
    await assert.rejects(() => cleanupFn!(), /repo_unavailable/u);
    assert.equal(existsSync(teardownBrokenParent), false, "failed teardown must evict and remove the dirty host");

    await t.test("next shared case after teardown failure also gets a fresh clean host", async (sub) => {
      const fourth = await openFixture(sub, "after-teardown-failure", { host: recoveryHost });
      assert.notEqual(fourth.root, teardownBrokenRoot);
      const created = await fourth.cell.run(
        {
          kind: "task-create",
          taskId: "task-clean-after-teardown-evict",
          title: "Clean host 2",
          presetId: "docs-task",
        },
        binding,
      );
      assert.equal(created.outcome, "applied", JSON.stringify(created));
    });
  },
);

test(
  "a provider stop failure after logical cleanup rejects teardown and evicts the shared host",
  { timeout: 90_000 },
  async (t) => {
    const host = createSuiteHost("provider-stop-eviction");
    let cleanup!: () => Promise<void>;
    const first = await openFixture({ after: (fn) => (cleanup = fn) }, "provider-stop-denied", { host });
    const firstCell = first.cell;
    const provider = first.providers[0]!;
    assert.ok(provider.process);
    // Leave a real child for fixture teardown after the daemon stops the runtime's own process.
    const leftover = spawn("git", ["hash-object", "--stdin"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    provider.process = leftover;
    try {
      assert.ok(leftover.pid);
      const stopError = Object.assign(new Error("provider stop denied"), { code: "EPERM" });
      const denyStop = () => {
        assert.equal(first.task(first.taskId).snapshot.task?.status, "cancelled");
        throw stopError;
      };
      const kill = process.kill.bind(process);
      const signalMock =
        process.platform === "win32"
          ? t.mock.method(leftover, "kill", denyStop)
          : t.mock.method(process, "kill", (pid, signal) => {
              if (pid === -leftover.pid! && signal === "SIGKILL") denyStop();
              return kill(pid, signal);
            });
      try {
        await assert.rejects(cleanup, (error) => error === stopError);
      } finally {
        signalMock.mock.restore();
      }
      assert.throws(() => firstCell.status(), /database is not open/u);
      assert.equal(existsSync(first.parent), false, "failed provider stop must close and remove the evicted host");
    } finally {
      await stopFixtureProcess(leftover);
    }

    const second = await openFixture(t, "after-provider-stop-denied", { host });
    assert.notEqual(second.root, first.root);
    const created = await second.cell.run(
      { kind: "task-create", taskId: "task-clean-after-provider-stop", title: "Clean host", presetId: "docs-task" },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
  },
);
