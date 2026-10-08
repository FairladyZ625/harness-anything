// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createScheduleV1, registerDaemonRepo } from "@harness-anything/kernel";
import { performOpenRegistered } from "../src/daemon-host-registry.ts";
import type { DaemonHostRegistryContext } from "../src/daemon-host-context.ts";
import type { RepoCell, RepoCellStatus } from "../src/repo-cell-types.ts";
import { makeScheduleScheduler } from "../src/schedule-scheduler.ts";
import { rosterRepo } from "./daemon-host-recovery.fixture.ts";

test("A: registry attached recovery wakes a skipped due builtin without refreshing duplicate status", async (t) => {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-attached-wakeup-"))),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    now = "2026-08-27T10:01:00.000Z",
    actor = { principal: { personId: "wakeup-probe" }, executor: null },
    cells = new Map<string, RepoCell>(),
    timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
  rosterRepo(rootDir, "recovering");
  const registered = registerDaemonRepo({
    canonicalRoot: rootDir,
    repoId: "recovering",
    userRoot,
    createConvenienceLinks: false,
  }).repo;
  function repository(repoId: string, everyMs: number) {
    const schedule = createScheduleV1({
      scheduleId: `builtin-${repoId}`,
      name: repoId,
      mode: "detect",
      state: "armed",
      actor,
      occurredAt: "2026-08-27T10:00:00.000Z",
      spec: {
        trigger: { kind: "interval", everyMs, anchorAt: "2026-08-27T10:00:00.000Z" },
        target: { kind: "builtin", builtinId: "ci-observe" },
        mission: "Wakeup probe",
      },
    });
    const actions: string[] = [];
    let state: RepoCellStatus["state"] = "attached",
      inFlight = 0,
      cursor = schedule.status.automaticEvaluatedThrough;
    const cell = {
      status: () => ({
        repoId,
        rootDir,
        mode: "local",
        state,
        generation: 1,
        queueDepth: 0,
        lastError: null,
        causeClass: null,
        recoveryMs: 0,
      }),
      run: async (action: Readonly<Record<string, unknown>>) => {
        inFlight += 1;
        try {
          actions.push(String(action.kind));
          if (action.kind === "schedule-list")
            return {
              outcome: "applied",
              evidence: "schedule-list:1",
              schedules: [
                {
                  ...schedule,
                  definitionRevision: 1,
                  status: { ...schedule.status, automaticEvaluatedThrough: cursor },
                  nextRunAt: null,
                },
              ],
            };
          assert.equal(action.kind, "schedule-run-now");
          cursor = String(action.scheduledFor);
          return { outcome: "applied" };
        } finally {
          inFlight -= 1;
        }
      },
    } as unknown as RepoCell;
    return {
      cell,
      actions,
      setState: (value: RepoCellStatus["state"]) => {
        state = value;
      },
      inFlight: () => inFlight,
    };
  }
  const recovering = repository("recovering", 60_000),
    distant = repository("distant", 6 * 3_600_000),
    scheduler = makeScheduleScheduler({
      cells,
      now: () => now,
      localBinding: () => ({ actor, source: "local" }),
      setTimer: (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (timer) => {
        (timer as unknown as (typeof timers)[number]).cleared = true;
      },
    });
  let onStatus!: (status: RepoCellStatus) => void,
    notifications = 0;
  const context = {
    input: {
      daemonId: "wakeup-probe",
      userRoot,
      onRepoStatusChange: () => {
        notifications += 1;
      },
    },
    cells,
    warming: new Map(),
    unavailable: new Map(),
    closing: false,
    scheduleScheduler: scheduler,
    writerEpochFence: () => undefined,
    runtimePorts: {},
    settleWarming: () => {},
    openCell: async (input: Parameters<DaemonHostRegistryContext["openCell"]>[0]) => {
      onStatus = input.onStatus!;
      return recovering.cell;
    },
  } as unknown as DaemonHostRegistryContext;
  try {
    await performOpenRegistered(context, {
      repoId: registered.repoId,
      canonicalRoot: rootDir,
      authoredBranch: registered.authoredBranch!,
      mode: "local",
    });
    cells.set("distant", distant.cell);
    recovering.setState("unavailable");
    onStatus(recovering.cell.status());
    await scheduler.start(); // completed reconciliation, rather than an outstanding await
    assert.deepEqual(recovering.actions, []);
    assert.equal(recovering.inFlight() + distant.inFlight(), 0);
    const sleeping = timers.filter((timer) => !timer.cleared);
    assert.equal(sleeping.length, 1);
    assert.equal(sleeping[0]!.delay, 6 * 3_600_000 - 60_000);
    recovering.setState("attached");
    onStatus(recovering.cell.status());
    await new Promise<void>((resolve) => setImmediate(resolve)); // drain queued status work, without firing timers
    assert.equal(notifications, 2);
    assert.deepEqual(recovering.actions, ["schedule-list"]);
    assert.equal(sleeping[0]!.cleared, true);
    assert.equal(recovering.inFlight() + distant.inFlight(), 0);
    const due = timers.filter((timer) => !timer.cleared);
    assert.equal(due.length, 1);
    assert.equal(due[0]!.delay, 0);
    onStatus(recovering.cell.status());
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(notifications, 3);
    assert.deepEqual(recovering.actions, ["schedule-list"], "attached -> attached must not refresh again");
    assert.equal(timers.filter((timer) => !timer.cleared).length, 1);
    due[0]!.cleared = true;
    due[0]!.callback();
    await scheduler.refresh();
    assert.equal(recovering.actions.filter((kind) => kind === "schedule-run-now").length, 1);
    t.diagnostic(
      "A regression: start settled; inFlight=0; sleep=21540000ms; recovery clears sleep, lists once, arms 0ms, duplicate attached does not refresh, and the due timer claims once.",
    );
  } finally {
    scheduler.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
