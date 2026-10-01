// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createScheduleV1, type DaemonRepoMode, type ScheduleV1 } from "@harness-anything/kernel";
import { makeScheduleScheduler } from "../src/schedule-scheduler.ts";
import type { RepoCell } from "../src/repo-cell.ts";

const actor = { principal: { personId: "schedule-scheduler-test" }, executor: null } as const;
const localBinding = () => ({ actor, source: "local" as const });

test("raw RepoCell schedule-list receipt is normalized and arms one Schedule", async () => {
  const clock = fakeClock("2026-08-27T10:00:00.000Z"),
    repo = fixtureRepo("receipt-evidence", "local", [schedule("e2e-probe")]),
    scheduler = makeScheduleScheduler({
      cells: new Map([[repo.repoId, repo.cell]]),
      localBinding,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
  await scheduler.start();
  assert.equal(clock.liveTimers().length, 1);
  assert.equal(clock.liveTimers()[0]!.delayMs, 30 * 60_000);
  scheduler.close();
});

test("an invalid Schedule row does not prevent healthy occurrences from arming", async () => {
  const clock = fakeClock("2026-08-27T10:00:00.000Z"),
    healthy = schedule("healthy-probe"),
    repo = fixtureRepo("invalid-row", "local", [healthy]);
  repo.listReceipts.push({
    outcome: "applied",
    opId: "read:schedule-list:invalid-row",
    revision: 2,
    evidence: "schedule-list:2",
    schedules: [
      {
        scheduleId: "legacy-probe",
        state: "invalid",
        invalidReason: 'schedule is missing required field "mode".',
        definitionRevision: 1,
      },
      { ...healthy, definitionRevision: 2, nextRunAt: "2026-08-27T10:30:00.000Z" },
    ],
  });
  const scheduler = makeScheduleScheduler({
    cells: new Map([[repo.repoId, repo.cell]]),
    localBinding,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await scheduler.start();
  assert.equal(clock.liveTimers().length, 1);
  assert.equal(clock.liveTimers()[0]!.delayMs, 30 * 60_000);
  scheduler.close();
});

test("projection-pending Schedule reads retry silently and then arm", async () => {
  const clock = fakeClock("2026-08-27T10:00:00.000Z"),
    repo = fixtureRepo("projection-pending", "local", [schedule("e2e-probe")]),
    warnings: string[] = [],
    originalWarn = console.warn;
  repo.listReceipts.push({
    outcome: "op_rejected",
    opId: "read:schedule-list:projection-pending",
    code: "projection_pending",
    origin: "daemon",
    nextAction: "Entity projection is catching up (4096/41333); retry the read.",
    evidence: "rejection:projection_pending",
  });
  console.warn = (message?: unknown) => warnings.push(String(message));
  const scheduler = makeScheduleScheduler({
    cells: new Map([[repo.repoId, repo.cell]]),
    localBinding,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  try {
    await scheduler.start();
    assert.equal(clock.liveTimers().length, 1);
    assert.equal(clock.liveTimers()[0]!.delayMs, 1_000);
    clock.liveTimers()[0]!.callback();
    await scheduler.refresh();
    assert.equal(clock.liveTimers().length, 1);
    assert.equal(clock.liveTimers()[0]!.delayMs, 30 * 60_000);
    assert.deepEqual(warnings, []);
  } finally {
    console.warn = originalWarn;
    scheduler.close();
  }
});

test("rejected Schedule reads report their code without parsing rejection evidence", async () => {
  const clock = fakeClock("2026-08-27T10:00:00.000Z"),
    repo = fixtureRepo("rejected", "local", []),
    warnings: string[] = [],
    originalWarn = console.warn;
  repo.listReceipts.push({
    outcome: "op_rejected",
    opId: "read:schedule-list:rejected",
    code: "repo_unavailable",
    origin: "daemon",
    nextAction: "Repair the repository data shape.",
    evidence: "rejection:repo_unavailable",
  });
  console.warn = (message?: unknown) => warnings.push(String(message));
  const scheduler = makeScheduleScheduler({
    cells: new Map([[repo.repoId, repo.cell]]),
    localBinding,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  try {
    await scheduler.start();
    assert.deepEqual(warnings, [
      "[schedule-scheduler] rejected refresh failed: Schedule list rejected: repo_unavailable.",
    ]);
    assert.equal(clock.liveTimers().length, 0);
  } finally {
    console.warn = originalWarn;
    scheduler.close();
  }
});

test("a Schedule rejection that latches its RepoCell is reported once as skipped", async () => {
  const clock = fakeClock("2026-08-27T10:00:00.000Z"),
    repo = fixtureRepo("latched", "local", []),
    warnings: string[] = [],
    originalWarn = console.warn;
  repo.listReceipts.push({
    outcome: "op_rejected",
    opId: "read:schedule-list:latched",
    code: "service_rejected",
    origin: "daemon",
    nextAction: "fact event payload is invalid",
    evidence: "rejection:service_rejected",
  });
  repo.latchOnRejection = true;
  console.warn = (message?: unknown) => warnings.push(String(message));
  const scheduler = makeScheduleScheduler({
    cells: new Map([[repo.repoId, repo.cell]]),
    localBinding,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  try {
    await scheduler.start();
    await scheduler.refresh();
    assert.deepEqual(warnings, ["[schedule-scheduler] latched skipped: Schedule list rejected: service_rejected."]);
    assert.equal(repo.actions.length, 1);
  } finally {
    console.warn = originalWarn;
    scheduler.close();
  }
});

test("unavailable RepoCells are outside scheduler refresh", async () => {
  const clock = fakeClock("2026-08-27T10:00:00.000Z"),
    repo = fixtureRepo("unavailable", "local", [schedule("never-read")]),
    scheduler = makeScheduleScheduler({
      cells: new Map([[repo.repoId, repo.cell]]),
      localBinding,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
  repo.state = "unavailable";
  await scheduler.start();
  assert.deepEqual(repo.actions, []);
  assert.equal(clock.liveTimers().length, 0);
  scheduler.close();
});

test("one nearest timer launches different due Schedules concurrently", async () => {
  const clock = fakeClock("2026-08-27T10:00:00.000Z"),
    first = fixtureRepo("first", "local", [schedule("heartbeat-a")]),
    second = fixtureRepo("second", "local", [schedule("heartbeat-b")]),
    releases: Array<() => void> = [],
    started: string[] = [];
  for (const repo of [first, second])
    repo.onFire = async (scheduleId) => {
      started.push(scheduleId);
      await new Promise<void>((resolve) => releases.push(resolve));
    };
  const scheduler = makeScheduleScheduler({
    cells: new Map([
      [first.repoId, first.cell],
      [second.repoId, second.cell],
    ]),
    localBinding,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await scheduler.start();
  assert.equal(clock.liveTimers().length, 1);
  assert.equal(clock.liveTimers()[0]!.delayMs, 30 * 60_000);

  clock.value = "2026-08-27T10:30:00.000Z";
  clock.liveTimers()[0]!.callback();
  void scheduler.refresh();
  await waitUntil(() => started.length === 2);
  assert.deepEqual(started.sort(), ["heartbeat-a", "heartbeat-b"]);
  releases.forEach((release) => release());
  await scheduler.refresh();
  assert.equal(clock.liveTimers().length, 1);
  assert.equal(clock.liveTimers()[0]!.delayMs, 30 * 60_000);
  scheduler.close();
});

test("a long stop aggregates missed intervals and never catches them up", async () => {
  const clock = fakeClock("2026-08-27T12:10:00.000Z"),
    repo = fixtureRepo("missed", "local", [schedule("heartbeat")]),
    scheduler = makeScheduleScheduler({
      cells: new Map([[repo.repoId, repo.cell]]),
      localBinding,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
  await scheduler.start();
  assert.deepEqual(repo.missed, [
    {
      scheduleId: "heartbeat",
      from: "2026-08-27T10:30:00.000Z",
      to: "2026-08-27T12:00:00.000Z",
      count: 4,
      reason: "scheduler_unavailable",
    },
  ]);
  assert.deepEqual(repo.fired, []);
  assert.equal(clock.liveTimers()[0]!.delayMs, 20 * 60_000);
  scheduler.close();
});

test("a cron Schedule arms at the next declared wall-clock occurrence", async () => {
  const clock = fakeClock("2026-08-27T18:00:00.000Z"),
    daily = schedule("daily-wall-clock");
  daily.spec = {
    ...daily.spec,
    trigger: { kind: "cron", expression: "30 2 * * *", timezone: "Asia/Taipei" },
  };
  daily.status.automaticEvaluatedThrough = "2026-08-26T18:30:00.000Z";
  const repo = fixtureRepo("cron-wall-clock", "local", [daily]),
    scheduler = makeScheduleScheduler({
      cells: new Map([[repo.repoId, repo.cell]]),
      localBinding,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
  await scheduler.start();
  assert.deepEqual(repo.missed, []);
  assert.equal(clock.liveTimers()[0]!.delayMs, 30 * 60_000);
  scheduler.close();
});

test("an active Schedule records the next tick as single-flight missed", async () => {
  const clock = fakeClock("2026-08-27T10:30:00.000Z"),
    active = schedule("active");
  active.status.activeRun = {
    occurrenceId: "manual-active",
    kind: "manual",
    scheduledFor: "2026-08-27T10:20:00.000Z",
    claimedAt: "2026-08-27T10:20:00.000Z",
    nodeId: "local",
    assignmentId: null,
    claimFence: "claim-active",
    attemptIndex: 0,
  };
  const repo = fixtureRepo("single-flight", "local", [active]),
    scheduler = makeScheduleScheduler({
      cells: new Map([[repo.repoId, repo.cell]]),
      localBinding,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
  await scheduler.start();
  assert.equal(repo.missed[0]?.reason, "single_flight");
  assert.equal(repo.missed[0]?.count, 1);
  assert.deepEqual(repo.fired, []);
  scheduler.close();
});

test("a builtin Schedule arms on its local node and never on a remote-edge mirror", async () => {
  const clock = fakeClock("2026-08-27T10:00:00.000Z"),
    builtin = createScheduleV1({
      scheduleId: "builtin-ledger-backup",
      name: "Ledger backup",
      mode: "detect",
      spec: {
        trigger: { kind: "interval", everyMs: 30 * 60_000, anchorAt: "2026-08-27T10:00:00.000Z" },
        target: { kind: "builtin", builtinId: "ledger-backup" },
        mission: "System ledger backup.",
      },
      actor,
      occurredAt: "2026-08-27T10:00:00.000Z",
    }) as MutableSchedule,
    local = fixtureRepo("builtin-local", "local", [builtin]),
    edgeActions: string[] = [],
    edge = fixtureRepo("builtin-edge", "remote-edge", [builtin]);
  const scheduler = makeScheduleScheduler({
    cells: new Map([
      [local.repoId, local.cell],
      [edge.repoId, edge.cell],
    ]),
    localBinding,
    remoteEdgeAction: async (_repoId, _rootDir, action) => {
      edgeActions.push(String(action.kind));
      return edge.execute(action);
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await scheduler.start();
  // One timer, armed by the local canonical cell only.
  assert.equal(clock.liveTimers().length, 1);
  assert.equal(clock.liveTimers()[0]!.delayMs, 30 * 60_000);
  assert.deepEqual(edgeActions, ["schedule-list"]);

  clock.value = "2026-08-27T10:30:00.000Z";
  clock.liveTimers()[0]!.callback();
  await scheduler.refresh();
  assert.deepEqual(local.fired, ["builtin-ledger-backup"]);
  assert.deepEqual(edge.fired, []);
  scheduler.close();
});

test("remote-center installs no timer while remote-edge uses its assignment action", async () => {
  const clock = fakeClock("2026-08-27T10:00:00.000Z"),
    center = fixtureRepo("center", "remote-center", [schedule("center-schedule")]),
    edge = fixtureRepo("edge", "remote-edge", [schedule("edge-schedule")]),
    edgeActions: string[] = [],
    scheduler = makeScheduleScheduler({
      cells: new Map([
        [center.repoId, center.cell],
        [edge.repoId, edge.cell],
      ]),
      localBinding,
      remoteEdgeAction: async (_repoId, _rootDir, action) => {
        edgeActions.push(String(action.kind));
        return edge.execute(action);
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
  await scheduler.start();
  assert.deepEqual(center.actions, []);
  assert.deepEqual(edgeActions, ["schedule-list"]);
  assert.equal(clock.liveTimers().length, 1);

  clock.value = "2026-08-27T10:30:00.000Z";
  clock.liveTimers()[0]!.callback();
  await scheduler.refresh();
  assert.equal(edgeActions.includes("schedule-run-now"), true);
  assert.deepEqual(edge.fired, ["edge-schedule"]);
  scheduler.close();
});

test("a remote-edge Schedule read that cannot reach the center retries on backoff and re-arms on recovery", async () => {
  const clock = fakeClock("2026-08-27T10:00:00.000Z"),
    edge = fixtureRepo("edge-unreachable", "remote-edge", [schedule("edge-schedule")]),
    warnings: string[] = [],
    originalWarn = console.warn,
    originalRandom = Math.random;
  let centerReachable = false,
    listCalls = 0;
  console.warn = (message?: unknown) => warnings.push(String(message));
  // Full jitter draws from [1, ceiling]; pinning the draw to the top reads the ceiling itself.
  Math.random = () => 0.999_999;
  const scheduler = makeScheduleScheduler({
    cells: new Map([[edge.repoId, edge.cell]]),
    localBinding,
    remoteEdgeAction: async (_repoId, _rootDir, action) => {
      listCalls += 1;
      if (!centerReachable)
        throw Object.assign(new Error("connect ECONNREFUSED 10.211.55.2:7444"), { code: "ECONNREFUSED" });
      return edge.execute(action);
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  try {
    await scheduler.start();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      assert.equal(clock.liveTimers().length, 1);
      delays.push(clock.liveTimers()[0]!.delayMs);
      clock.liveTimers()[0]!.callback();
      await waitUntil(() => clock.liveTimers().length === 1);
    }
    assert.deepEqual(delays, [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000]);
    assert.deepEqual(warnings, [
      "[schedule-scheduler] edge-unreachable refresh failed, retrying: connect ECONNREFUSED 10.211.55.2:7444",
    ]);

    centerReachable = true;
    const callsBeforeRecovery = listCalls;
    assert.equal(clock.liveTimers().length, 1);
    clock.liveTimers()[0]!.callback();
    await waitUntil(() => listCalls > callsBeforeRecovery && clock.liveTimers().length === 1);
    assert.equal(clock.liveTimers().length, 1);
    assert.equal(clock.liveTimers()[0]!.delayMs, 30 * 60_000);

    // A later outage starts a fresh streak: it backs off from the floor and is reported once more.
    centerReachable = false;
    await scheduler.refresh();
    assert.equal(clock.liveTimers()[0]!.delayMs, 250);
    assert.equal(warnings.length, 2);
  } finally {
    console.warn = originalWarn;
    Math.random = originalRandom;
    scheduler.close();
  }
});

test("a local Schedule read failure installs no retry timer", async () => {
  const clock = fakeClock("2026-08-27T10:00:00.000Z"),
    repo = fixtureRepo("local-failure", "local", [schedule("local-schedule")]),
    originalWarn = console.warn;
  repo.cell.run = async () => {
    throw Object.assign(new Error("connect ECONNREFUSED 10.211.55.2:7444"), { code: "ECONNREFUSED" });
  };
  console.warn = () => {};
  const scheduler = makeScheduleScheduler({
    cells: new Map([[repo.repoId, repo.cell]]),
    localBinding,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  try {
    await scheduler.start();
    assert.equal(clock.liveTimers().length, 0);
  } finally {
    console.warn = originalWarn;
    scheduler.close();
  }
});

test("the repository admission window decides whether a late wake is claimed or recorded as missed", async (t) => {
  const lateWake = async (rootDir?: string) => {
    const clock = fakeClock("2026-08-27T10:35:00.000Z"),
      repo = fixtureRepo("late-wake", "local", [schedule("heartbeat")], rootDir),
      scheduler = makeScheduleScheduler({
        cells: new Map([[repo.repoId, repo.cell]]),
        localBinding,
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      });
    await scheduler.start();
    const armedDelayMs = clock.liveTimers()[0]!.delayMs;
    clock.liveTimers()[0]!.callback();
    await waitUntil(() => repo.fired.length > 0);
    scheduler.close();
    return { fired: repo.fired, missed: repo.missed.map(({ count, reason }) => ({ count, reason })), armedDelayMs };
  };
  const tenMinuteRoot = mkdtempSync(path.join(tmpdir(), "schedule-admission-window-"));
  t.after(() => rmSync(tenMinuteRoot, { recursive: true, force: true }));
  mkdirSync(path.join(tenMinuteRoot, "harness"));
  writeFileSync(
    path.join(tenMinuteRoot, "harness", "harness.yaml"),
    "schema: harness-anything/v1\nsettings:\n  schedule:\n    admissionWindowMs: 600000\n",
  );

  // The 10:30 occurrence is five minutes old: inside a ten-minute window it fires at once.
  assert.deepEqual(await lateWake(tenMinuteRoot), { fired: ["heartbeat"], missed: [], armedDelayMs: 0 });
  // No authored settings document means the declared default (one minute): it is missed, not caught up.
  assert.deepEqual(await lateWake(), {
    fired: [],
    missed: [{ count: 1, reason: "scheduler_unavailable" }],
    armedDelayMs: 25 * 60_000,
  });
});

test("manual runs do not move automatic cadence and enabling skips the paused window", async () => {
  const clock = fakeClock("2026-08-27T10:15:00.000Z"),
    heartbeat = schedule("heartbeat");
  heartbeat.status.lastRun = {
    occurrenceId: "manual-run",
    scheduledFor: "2026-08-27T10:10:00.000Z",
    endedAt: "2026-08-27T10:11:00.000Z",
    outcome: "succeeded",
    nodeId: "local",
    assignmentId: null,
    claimFence: "manual-claim",
    attemptIndex: 0,
  };
  const repo = fixtureRepo("cadence", "local", [heartbeat]),
    scheduler = makeScheduleScheduler({
      cells: new Map([[repo.repoId, repo.cell]]),
      localBinding,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
  await scheduler.start();
  assert.equal(clock.liveTimers()[0]!.delayMs, 15 * 60_000);

  heartbeat.state = "paused";
  await scheduler.refresh();
  assert.equal(clock.liveTimers().length, 0);
  heartbeat.state = "armed";
  heartbeat.updatedAt = "2026-08-27T12:00:00.000Z";
  clock.value = "2026-08-27T12:00:00.000Z";
  await scheduler.refresh();
  assert.deepEqual(repo.missed, []);
  assert.equal(clock.liveTimers()[0]!.delayMs, 30 * 60_000);
  scheduler.close();
});

test("a deleted Schedule disappears from scheduler refreshes and is never fired", async () => {
  const clock = fakeClock("2026-08-27T10:00:00.000Z"),
    rows = [schedule("retired")],
    repo = fixtureRepo("deleted", "local", rows),
    scheduler = makeScheduleScheduler({
      cells: new Map([[repo.repoId, repo.cell]]),
      localBinding,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
  await scheduler.start();
  assert.equal(clock.liveTimers().length, 1);
  rows.splice(0, rows.length);
  await scheduler.refresh();
  assert.equal(clock.liveTimers().length, 0);
  clock.value = "2026-08-27T10:30:00.000Z";
  assert.deepEqual(repo.fired, []);
  scheduler.close();
});

function schedule(scheduleId: string): MutableSchedule {
  return createScheduleV1({
    scheduleId,
    name: scheduleId,
    mode: "detect",
    spec: {
      trigger: { kind: "interval", everyMs: 30 * 60_000, anchorAt: "2026-08-27T10:00:00.000Z" },
      target: { kind: "agent", agentId: "codex", runtimeInstanceId: "runtime-local" },
      mission: `Run ${scheduleId}.`,
    },
    actor,
    occurredAt: "2026-08-27T10:00:00.000Z",
  }) as MutableSchedule;
}

type MutableSchedule = {
  -readonly [K in keyof ScheduleV1]: K extends "status" ? MutableRunView : ScheduleV1[K];
};
type MutableRunView = {
  -readonly [K in keyof ScheduleV1["status"]]: ScheduleV1["status"][K];
};

function fixtureRepo(repoId: string, mode: DaemonRepoMode, schedules: MutableSchedule[], rootDir = `/tmp/${repoId}`) {
  const actions: string[] = [],
    fired: string[] = [],
    missed: Array<{
      scheduleId: string;
      from: string;
      to: string;
      count: number;
      reason: string;
    }> = [];
  const fixture = {
    repoId,
    actions,
    fired,
    missed,
    listReceipts: [] as Array<Readonly<Record<string, unknown>>>,
    latchOnRejection: false,
    state: "attached" as "attached" | "unavailable",
    onFire: async (_scheduleId: string) => {},
    execute: async (action: Readonly<Record<string, unknown>>) => {
      actions.push(String(action.kind));
      if (action.kind === "schedule-list") {
        const queuedReceipt = fixture.listReceipts.shift();
        if (queuedReceipt) {
          if (fixture.latchOnRejection) fixture.state = "unavailable";
          return queuedReceipt;
        }
        const rows = schedules.map((value) => ({
          ...value,
          definitionRevision: 1,
          nextRunAt: value.state === "armed" ? "2026-08-27T10:30:00.000Z" : null,
        }));
        return {
          outcome: "applied",
          opId: `read:schedule-list:${repoId}`,
          revision: 1,
          evidence: "schedule-list:1",
          schedules: rows,
          visibility: "center",
          proof: {
            committedRevision: 1,
            appliedCut: 1,
            durable: true,
            canonicalVisible: true,
            worktreeVisible: null,
          },
          summary: `${rows.length} schedule(s)`,
        };
      }
      const value = schedules.find(({ scheduleId }) => scheduleId === action.scheduleId);
      assert.ok(value);
      if (action.kind === "schedule-missed") {
        const row = {
          scheduleId: value.scheduleId,
          from: String(action.from),
          to: String(action.to),
          count: Number(action.count),
          reason: String(action.reason),
        };
        missed.push(row);
        value.status.automaticEvaluatedThrough = row.to;
        value.status.missedCount += row.count;
        value.status.lastMissedAt = row.to;
        value.status.lastMissedReason = row.reason as ScheduleV1["status"]["lastMissedReason"];
        return { outcome: "applied" };
      }
      assert.equal(action.kind, "schedule-run-now");
      const scheduledFor = String(action.scheduledFor);
      fired.push(value.scheduleId);
      value.status.automaticEvaluatedThrough = scheduledFor;
      await fixture.onFire(value.scheduleId);
      return { outcome: "applied" };
    },
  };
  const cell = {
    status: () => ({
      repoId,
      rootDir,
      mode,
      state: fixture.state,
      generation: 1,
      queueDepth: 0,
      lastError: null,
      causeClass: null,
      recoveryMs: 0,
    }),
    run: fixture.execute,
  } as unknown as RepoCell;
  return Object.assign(fixture, { cell });
}

function fakeClock(initial: string) {
  type FakeTimer = {
    callback: () => void;
    delayMs: number;
    cleared: boolean;
    unref: () => void;
  };
  const timers: FakeTimer[] = [];
  const clock = {
    value: initial,
    now: () => clock.value,
    setTimer: (callback: () => void, delayMs: number) => {
      const timer: FakeTimer = {
        callback: () => {
          timer.cleared = true;
          callback();
        },
        delayMs,
        cleared: false,
        unref: () => {},
      };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle: ReturnType<typeof setTimeout>) => {
      (handle as unknown as FakeTimer).cleared = true;
    },
    liveTimers: () => timers.filter(({ cleared }) => !cleared),
  };
  return clock;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 20 && !predicate(); attempts += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}
