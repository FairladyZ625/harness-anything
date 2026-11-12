// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { checkoutTaskWorktree } from "../src/task-worktree.ts";
import { noWorktreeSetup } from "../src/worktree-setup.ts";
import { adoptRuntimes } from "../src/runtime-spawn-adoption.ts";
import { scheduleFallbackContinuation } from "../src/runtime-spawn-fallback.ts";
import { runtimeSpawnError } from "../src/runtime-spawn-errors.ts";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDispatchStream, readDispatchStream } from "../src/dispatch-stream.ts";
import { settleScheduledRuntime } from "../src/schedule-action-runtime.ts";
import {
  scheduleMissionWithOutcomeProtocol,
  scheduleOccurrenceSettlementOwner,
  scheduleOutcomeFromRuntime,
} from "../src/schedule-runtime-outcome.ts";
import { publishExit } from "./runtime-spawn-settlement.fixtures.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import type { RuntimeAttemptTerminal } from "../src/runtime-spawn-types.ts";
import { active } from "./runtime-spawn-settlement.fixtures.ts";
import { dispatchLifecycleReadOf, lifecycleEvent } from "./dispatch-lifecycle-read.fixtures.ts";

const replayDispatchId = "dispatch_0123456789abcdef01234567",
  replayRuntimeSessionId = "runtime_replay00000000000000000000",
  binding = {
    actor: {
      principal: { kind: "human", id: "operator" } as never,
      executor: { kind: "agent", id: `runtime-session:${replayRuntimeSessionId}` },
    },
    source: "local" as const,
  };

function acceptedReplay(fallbackState: "scheduled" | null) {
  const options = { instanceId: "provider-a", source: "local" as const, dispatchId: replayDispatchId },
    events = ["R", "S", "X"].map((type) => lifecycleEvent(type as "R" | "S" | "X", replayRuntimeSessionId, options)),
    outcome = lifecycleEvent("O", replayRuntimeSessionId, options);
  events.push({
    ...outcome,
    payload: { ...outcome.payload, attempt: { classification: "worker_stop", fallbackState } },
  } as typeof outcome);
  const read = dispatchLifecycleReadOf(() => events);
  return { readDispatchLifecycle: async (query: Parameters<typeof read>[0]) => read(query) };
}

test("occurrence settlement owner follows the linked dispatch subject", () => {
  const dispatchId = "dispatch_0123456789abcdef01234567";
  const projection = (squadRun?: unknown) =>
    ({
      readRuntimeDispatchById: (id: string) =>
        id === dispatchId && squadRun !== undefined
          ? { event: { payload: { squadRun } } }
          : id === dispatchId
            ? { event: { payload: {} } }
            : null,
    }) as never;
  assert.equal(
    scheduleOccurrenceSettlementOwner(projection({ squadRunId: "squad_0123456789abcdef01234567" }), dispatchId),
    "squad-coordinator",
  );
  assert.equal(scheduleOccurrenceSettlementOwner(projection(), dispatchId), "runtime-attempt");
  assert.equal(scheduleOccurrenceSettlementOwner(projection(), undefined), "runtime-attempt");
});

test("scheduled missions receive the daemon-owned outcome protocol", () => {
  assert.equal(
    scheduleMissionWithOutcomeProtocol("Inspect the repository.\n"),
    [
      "Inspect the repository.",
      "",
      "# Schedule outcome protocol",
      "Your final response's last non-empty line must be exactly one of:",
      "HARNESS-OUTCOME: succeeded",
      "HARNESS-OUTCOME: failed",
    ].join("\n"),
  );
});

test("schedule outcome requires an exact verdict on the last non-empty line", () => {
  assert.equal(scheduleOutcomeFromRuntime("succeeded", "done\nHARNESS-OUTCOME: succeeded\n\n"), "succeeded");
  assert.equal(scheduleOutcomeFromRuntime("succeeded", "not done\nHARNESS-OUTCOME: failed"), "failed");
  assert.equal(scheduleOutcomeFromRuntime("succeeded", "HARNESS-OUTCOME: failed\nmore text"), "unknown");
  assert.equal(scheduleOutcomeFromRuntime("succeeded", " HARNESS-OUTCOME: succeeded"), "unknown");
  assert.equal(scheduleOutcomeFromRuntime("succeeded", "done"), "unknown");
  assert.equal(scheduleOutcomeFromRuntime("failed", "HARNESS-OUTCOME: succeeded"), "failed");
  assert.equal(scheduleOutcomeFromRuntime("unknown", "HARNESS-OUTCOME: succeeded"), "unknown");
  assert.equal(scheduleOutcomeFromRuntime("cancelled", "HARNESS-OUTCOME: succeeded"), "cancelled");
});

for (const outcome of ["stopped", "failed"] as const) {
  test(`a replayed persisted ${outcome} terminal still notifies the Schedule settlement entry`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-terminal-replay-"));
    try {
      // task_cd7fb6fc36171d90d3c77c7893: the daemon died between the stream's terminal append and
      // its ledger settlement (gui-e2e-6h occurrence_b86c1beb, 2026-10-16). The adoption replay
      // must re-emit the settlement notification or the claimed occurrence stays running forever.
      const schedule = {
        scheduleId: "replay-schedule",
        occurrenceId: "occurrence_replay0000000000000000",
        claimFence: "claim_replay",
        mode: "detect",
      } as const;
      const stream = openDispatchStream(rootDir, {
        dispatchId: replayDispatchId,
        taskId: null,
        executionId: null,
        runtimeSessionId: replayRuntimeSessionId,
        instanceId: "provider-a",
        startedAt: "2026-10-16T23:02:30.617Z",
        dispatchOpId: "replay-dispatch-op",
        kindId: "codex",
        permissionMode: "bypass",
        binding,
        cwd: rootDir,
        prompt: "settle replayed terminal",
        mission: "settle replayed terminal",
        model: "model-a",
        reasoningEffort: null,
        fast: false,
        schedule,
      });
      stream.appendTerminalOutcome(
        {
          payload: {
            runtimeSessionId: replayRuntimeSessionId,
            outcome,
            ...(outcome === "failed" ? { reasonCode: "review_result_missing" } : {}),
            exitCode: 0,
            resultRef:
              "artifact:runtime-result/sha256/0000000000000000000000000000000000000000000000000000000000000000",
            result: null,
            dispatchId: replayDispatchId,
            endedAt: "2026-10-16T23:20:04.290Z",
          },
          body: "Worker stopped after a normal exit without a submitted delivery.",
          reason: "Worker stopped after a normal exit without a submitted delivery.",
        },
        "2026-10-16T23:20:04.290Z",
      );
      const terminals: RuntimeAttemptTerminal[] = [],
        runtime = active({
          process: {
            pid: 2_147_483_647,
            onOutput: () => undefined,
            onErrorOutput: () => undefined,
            onExit: () => undefined,
            terminate: () => undefined,
          },
          runtimeSessionId: replayRuntimeSessionId,
          dispatchId: replayDispatchId,
          dispatchOpId: "replay-dispatch-op",
          binding,
          task: null,
          schedule,
          squadId: null,
          delegatedBy: null,
          cwd: rootDir,
          prompt: "settle replayed terminal",
          onExitCommand: null,
          reasoningEffort: null,
          fast: false,
          startedAt: "2026-10-16T23:02:30.617Z",
          stream,
        }),
        published: string[] = [],
        context = {
          exiting: new Set<string>(),
          processes: new Map([[runtime.runtimeSessionId, runtime]]),
          input: {
            repoId: "canonical",
            rootDir,
            now: () => "2026-10-16T23:43:09.000Z",
            stream: { publish: () => ({}) },
            onAttemptTerminal: async (terminal: RuntimeAttemptTerminal) => {
              terminals.push(terminal);
            },
          },
          resultMediaType: "text/markdown",
          runtimeResultText: () => "",
          markProtocolError: () => undefined,
          publishRuntimeEvent: async (type: string) => {
            published.push(type);
            return {};
          },
          settleFallback: async () => {
            throw new Error("a replayed terminal must not re-enter the fallback chain");
          },
        } as unknown as RuntimeSpawnerContext;
      await publishExit(context, runtime, 0);
      assert.deepEqual(published, ["runtime_session_exited", "runtime_session_outcome_observed"]);
      assert.equal(terminals.length, 1, `settlement entry must fire once: ${JSON.stringify(terminals)}`);
      assert.equal(terminals[0]?.schedule?.scheduleId, "replay-schedule");
      assert.equal(terminals[0]?.schedule?.claimFence, "claim_replay");
      assert.equal(terminals[0]?.outcome, outcome === "failed" ? "failed" : "unknown");
      assert.equal(terminals[0]?.runtimeSessionId, replayRuntimeSessionId);
      assert.equal(terminals[0]?.endedAt, "2026-10-16T23:20:04.290Z");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}

test("a replayed terminal behind a scheduled fallback keeps settlement for the continuation", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-terminal-replay-fallback-"));
  try {
    const schedule = {
      scheduleId: "replay-fallback-schedule",
      occurrenceId: "occurrence_replayfb00000000000000",
      claimFence: "claim_replay_fb",
      mode: "detect",
    } as const;
    const stream = openDispatchStream(rootDir, {
      dispatchId: replayDispatchId,
      taskId: null,
      executionId: null,
      runtimeSessionId: replayRuntimeSessionId,
      instanceId: "provider-a",
      startedAt: "2026-10-16T23:02:30.617Z",
      dispatchOpId: "replay-dispatch-op-fb",
      kindId: "codex",
      permissionMode: "bypass",
      binding,
      cwd: rootDir,
      prompt: "settle replayed terminal",
      mission: "settle replayed terminal",
      model: "model-a",
      reasoningEffort: null,
      fast: false,
      schedule,
    });
    stream.appendTerminalOutcome(
      {
        payload: {
          runtimeSessionId: replayRuntimeSessionId,
          outcome: "unknown",
          exitCode: null,
          resultRef: "artifact:runtime-result/sha256/0000000000000000000000000000000000000000000000000000000000000000",
          result: null,
          dispatchId: replayDispatchId,
          endedAt: "2026-10-16T23:20:04.290Z",
        },
        body: "provider disconnected",
        reason: "provider disconnected",
      },
      "2026-10-16T23:20:04.290Z",
    );
    stream.appendFallbackState(
      {
        state: "scheduled",
        delayMs: 1_000,
        notBeforeAt: "2026-10-16T23:21:04.290Z",
        nextProvider: { instance: "provider-b" },
      },
      "2026-10-16T23:20:04.300Z",
    );
    const terminals: RuntimeAttemptTerminal[] = [],
      runtime = active({
        process: {
          pid: 2_147_483_647,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          terminate: () => undefined,
        },
        runtimeSessionId: replayRuntimeSessionId,
        dispatchId: replayDispatchId,
        dispatchOpId: "replay-dispatch-op-fb",
        binding,
        task: null,
        schedule,
        squadId: null,
        delegatedBy: null,
        fallbackAttempt: {
          attemptGroupId: "attempt_replay",
          attemptIndex: 0,
          candidateIndex: 0,
          retryRound: 0,
          rootDispatchKey: "replay",
          originalMission: "settle replayed terminal",
          candidates: [
            { instance: "provider-a", model: "model-a" },
            { instance: "provider-b", model: "model-a" },
          ],
        },
        cwd: rootDir,
        prompt: "settle replayed terminal",
        onExitCommand: null,
        reasoningEffort: null,
        fast: false,
        startedAt: "2026-10-16T23:02:30.617Z",
        stream: { ref: `runtime-stream:${replayDispatchId}` } as never,
      }),
      context = {
        exiting: new Set<string>(),
        processes: new Map([[runtime.runtimeSessionId, runtime]]),
        input: {
          repoId: "canonical",
          rootDir,
          now: () => "2026-10-16T23:43:09.000Z",
          remote: acceptedReplay("scheduled"),
          stream: { publish: () => ({}) },
          onAttemptTerminal: async (terminal: RuntimeAttemptTerminal) => {
            terminals.push(terminal);
          },
        },
        resultMediaType: "text/markdown",
        runtimeResultText: () => "",
        markProtocolError: () => undefined,
        publishRuntimeEvent: async () => ({}),
        settleFallback: async () => {
          throw new Error("a replayed terminal must not re-enter the fallback chain");
        },
      } as unknown as RuntimeSpawnerContext;
    await publishExit(context, runtime, 1);
    assert.equal(terminals.length, 0, "the pending continuation owns this occurrence's settlement");
    assert.equal(
      readDispatchStream(rootDir, replayDispatchId)?.records.find((record) => record.kind === "fallback_state")?.state,
      "scheduled",
      "the transcript retains the raw observation for replay",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a replayed terminal whose exit is already published does not re-notify settlement", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-terminal-replay-published-"));
  try {
    // task_cd7fb6fc36171d90d3c77c7893 round 2: a fleet edge adopts an exited runtime through a
    // stale replica whose session still shows outcome=null even though the center already
    // settled it (PR #3776: fleet-runtime-assignment-ownership, release counted twice). The
    // settlement is queued ahead of the exit publication in the same write chain, so a ledger
    // that already shows the exit has already taken the settlement: the replay republishes the
    // terminal events and must not re-enter the settlement entry.
    const schedule = {
      scheduleId: "replay-published-schedule",
      occurrenceId: "occurrence_replaypub000000000000",
      claimFence: "claim_replay_pub",
      mode: "detect",
    } as const;
    const stream = openDispatchStream(rootDir, {
      dispatchId: replayDispatchId,
      taskId: null,
      executionId: null,
      runtimeSessionId: replayRuntimeSessionId,
      instanceId: "provider-a",
      startedAt: "2026-10-16T23:02:30.617Z",
      dispatchOpId: "replay-dispatch-op-pub",
      kindId: "codex",
      permissionMode: "bypass",
      binding,
      cwd: rootDir,
      prompt: "settle replayed terminal",
      mission: "settle replayed terminal",
      model: "model-a",
      reasoningEffort: null,
      fast: false,
      schedule,
    });
    stream.appendTerminalOutcome(
      {
        payload: {
          runtimeSessionId: replayRuntimeSessionId,
          outcome: "stopped",
          exitCode: 0,
          resultRef: "artifact:runtime-result/sha256/0000000000000000000000000000000000000000000000000000000000000000",
          result: null,
          dispatchId: replayDispatchId,
          endedAt: "2026-10-16T23:20:04.290Z",
        },
        body: "Worker stopped after a normal exit without a submitted delivery.",
        reason: "Worker stopped after a normal exit without a submitted delivery.",
      },
      "2026-10-16T23:20:04.290Z",
    );
    const terminals: RuntimeAttemptTerminal[] = [],
      published: string[] = [],
      runtime = active({
        process: {
          pid: 2_147_483_647,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          terminate: () => undefined,
        },
        runtimeSessionId: replayRuntimeSessionId,
        dispatchId: replayDispatchId,
        dispatchOpId: "replay-dispatch-op-pub",
        binding,
        task: null,
        schedule,
        squadId: null,
        delegatedBy: null,
        cwd: rootDir,
        prompt: "settle replayed terminal",
        onExitCommand: null,
        reasoningEffort: null,
        fast: false,
        startedAt: "2026-10-16T23:02:30.617Z",
        stream: { ref: `runtime-stream:${replayDispatchId}` } as never,
      }),
      context = {
        exiting: new Set<string>(),
        processes: new Map([[runtime.runtimeSessionId, runtime]]),
        input: {
          repoId: "canonical",
          rootDir,
          now: () => "2026-10-16T23:43:09.000Z",
          remote: acceptedReplay(null),
          stream: { publish: () => ({}) },
          onAttemptTerminal: async (terminal: RuntimeAttemptTerminal) => {
            terminals.push(terminal);
          },
        },
        resultMediaType: "text/markdown",
        runtimeResultText: () => "",
        markProtocolError: () => undefined,
        publishRuntimeEvent: async (type: string) => {
          published.push(type);
          return {};
        },
        settleFallback: async () => {
          throw new Error("a replayed terminal must not re-enter the fallback chain");
        },
      } as unknown as RuntimeSpawnerContext;
    await publishExit(context, runtime, 0, true);
    assert.deepEqual(published, ["runtime_session_exited", "runtime_session_outcome_observed"]);
    assert.equal(terminals.length, 0, "an already-settled exit must not be settled again");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("settlement ignores a replayed terminal whose occurrence is already settled", async () => {
  const run: { action: { kind: string } }[] = [],
    cell = {
      rootDir: mkdtempSync(path.join(tmpdir(), "schedule-settle-idempotent-")),
      projection: {
        getEntity: (_kind: string, _id: string) => ({
          value: {
            scheduleId: "settled-schedule",
            status: {
              activeRun: null,
              lastRun: { occurrenceId: "occurrence_settled00000000000000", claimFence: "claim_old" },
            },
          },
        }),
      },
      cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    },
    terminal: RuntimeAttemptTerminal = {
      runtimeSessionId: replayRuntimeSessionId,
      dispatchId: replayDispatchId,
      task: null,
      schedule: {
        scheduleId: "settled-schedule",
        occurrenceId: "occurrence_settled00000000000000",
        claimFence: "claim_old",
        mode: "detect",
      },
      outcome: "unknown",
      reason: null,
      endedAt: "2026-10-16T23:20:04.290Z",
      binding,
    };
  try {
    await settleScheduledRuntime(cell as never, terminal, async (action) => {
      run.push({ action });
      return { outcome: "applied" } as never;
    });
    assert.deepEqual(run, [], "an already-settled claim must not be re-linked or re-settled");
  } finally {
    rmSync(cell.rootDir, { recursive: true, force: true });
  }
});

test("interrupted reviewer exhaustion replays the frozen terminal, releases its snapshot and notifies its Schedule claim", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "reviewer-exhaustion-replay-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Reviewer Replay Test");
  git("config", "user.email", "reviewer-replay@example.invalid");
  git("commit", "--allow-empty", "-qm", "frozen snapshot");
  const checkout = (await checkoutTaskWorktree(
    rootDir,
    "review-task",
    {
      branch: "review-task",
      path: ".worktrees/review-task",
    },
    noWorktreeSetup(),
    undefined,
    undefined,
    { pinnedCommit: git("rev-parse", "HEAD") },
  ))!;
  const marker = path.join(checkout.cwd, "snapshot-marker");
  writeFileSync(marker, "frozen snapshot");
  const schedule = {
      scheduleId: "exhaustion",
      occurrenceId: "occurrence_exhaustion",
      claimFence: "claim_exhaustion",
      mode: "detect",
    } as const,
    options = { instanceId: "provider-a", source: "local" as const, dispatchId: replayDispatchId },
    events = ["R", "S", "X"].map((type) => lifecycleEvent(type as "R" | "S" | "X", replayRuntimeSessionId, options)),
    outcome = lifecycleEvent("O", replayRuntimeSessionId, options),
    payload = {
      ...outcome.payload,
      outcome: "failed",
      endedAt: "2026-11-11T00:00:00.000Z",
      attempt: {
        classification: "provider_quota",
        fallbackState: "scheduled",
        fallbackSchedule: { notBeforeAt: "2099-01-01T00:00:00.000Z", nextProvider: { instance: "provider-b" } },
      },
    },
    read = dispatchLifecycleReadOf(() => events),
    stream = openDispatchStream(rootDir, {
      dispatchId: replayDispatchId,
      runtimeSessionId: replayRuntimeSessionId,
      taskId: null,
      executionId: null,
      instanceId: "provider-a",
      startedAt: "2026-11-11T00:00:00.000Z",
      dispatchOpId: "replay-op",
      kindId: "codex",
      permissionMode: "read-only",
      binding: { ...binding, actor: { ...binding.actor, principal: { personId: "operator" } } },
      prompt: "Review frozen snapshot",
      role: "reviewer",
      cwd: checkout.cwd,
      model: "model-a",
      reasoningEffort: null,
      schedule,
      fallbackAttempt: {
        attemptGroupId: replayDispatchId,
        attemptIndex: 0,
        rootDispatchKey: "reviewer-replay",
        originalMission: "Review frozen snapshot",
        candidates: [{ instance: "provider-a" }, { instance: "provider-b" }],
      },
    });
  events.push({ ...outcome, payload } as typeof outcome);
  stream.appendAttemptOutcome(
    {
      attemptGroupId: replayDispatchId,
      attemptIndex: 0,
      classification: "provider_quota",
      reason: "quota exhausted",
      provider: { instance: "provider-a", model: "model-a", kind: "codex" },
    },
    "2026-11-11T00:00:00.000Z",
  );
  const terminal = {
    payload: { ...payload, attempt: { classification: "provider_quota", fallbackState: "exhausted" } },
    reason: "continuation launch refused",
    body: "original frozen result",
  } as const;
  stream.appendTerminalOutcome(terminal as never, "2026-11-11T00:01:00.000Z");
  const notifications: RuntimeAttemptTerminal[] = [],
    publications: unknown[] = [],
    interrupted = new Error("center unavailable");
  let rejectPublication = true;
  const openContext = () => {
    const context = {
      processes: new Map(),
      exiting: new Set(),
      runtimeSpawnError,
      input: {
        rootDir,
        now: () => "2026-11-11T00:02:00.000Z",
        remote: {
          readDispatchLifecycle: async (query) => read(query),
          readRuntimeSession: async () => ({
            runtimeSessionId: replayRuntimeSessionId,
            instanceId: "provider-a",
            outcome: "failed",
            liveness: "exited",
          }),
        },
        schedule: () => assert.fail("a persisted terminal must be replayed before a future fallback timer"),
        onAttemptTerminal: async (value: RuntimeAttemptTerminal) => {
          notifications.push(value);
        },
      },
      publishRuntimeEvent: async (type, value, opId, _binding, body) => {
        publications.push({ type, payload: value, opId, body });
        if (rejectPublication) throw interrupted;
        events.push({ ...lifecycleEvent("O", replayRuntimeSessionId, options), payload: value } as typeof outcome);
        return {};
      },
      reconcileFallback: (dispatchId) =>
        scheduleFallbackContinuation({
          context,
          ...{ closed: () => false },
          dispatchId,
          launch: async () => assert.fail("restart must not launch after durable exhaustion"),
        }),
    } as RuntimeSpawnerContext;
    return context;
  };
  await assert.rejects(openContext().reconcileFallback(replayDispatchId), interrupted);
  assert.equal(existsSync(marker), true, "unaccepted terminal keeps the frozen snapshot");
  assert.equal(read({ by: "dispatch", dispatchIds: [replayDispatchId] }).rows[0]?.policy.groupSettled, false);
  rejectPublication = false;
  assert.equal((await adoptRuntimes(openContext()))[0]?.outcome, "settled");
  assert.deepEqual(publications[1], publications[0]);
  assert.equal(read({ by: "dispatch", dispatchIds: [replayDispatchId] }).rows[0]?.policy.groupSettled, true);
  assert.equal(existsSync(checkout.cwd), false, "accepted group closure releases the snapshot");
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0]?.schedule, schedule);
  assert.equal(notifications[0]?.endedAt, terminal.payload.endedAt);
  await adoptRuntimes(openContext());
  assert.equal(notifications.length, 1, "the matching Schedule claim is notified once");
});

// A spool is replay evidence, never a replacement for a missing center schedule.
test("fallback refuses a local stream plan when the canonical schedule is missing", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-fallback-no-local-plan-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stream = openDispatchStream(rootDir, {
    dispatchId: replayDispatchId,
    runtimeSessionId: replayRuntimeSessionId,
    taskId: null,
    executionId: null,
    instanceId: "provider-a",
    startedAt: "2026-11-11T00:00:00.000Z",
    cwd: rootDir,
    binding: { ...binding, actor: { ...binding.actor, principal: { personId: "operator" } } },
    fallbackAttempt: {
      attemptGroupId: replayDispatchId,
      attemptIndex: 0,
      rootDispatchKey: "local-plan",
      originalMission: "mission",
      candidates: [{ instance: "provider-a" }, { instance: "provider-b" }],
    },
  });
  stream.appendAttemptOutcome(
    {
      attemptGroupId: replayDispatchId,
      attemptIndex: 0,
      classification: "provider_quota",
      reason: "quota",
      provider: { instance: "provider-a", model: "model-a", kind: "codex" },
    },
    "2026-11-11T00:00:00.000Z",
  );
  stream.appendFallbackState(
    {
      state: "scheduled",
      delayMs: 1000,
      notBeforeAt: "2099-01-01T00:00:00.000Z",
      nextProvider: { instance: "provider-b" },
    },
    "2026-11-11T00:00:00.000Z",
  );
  const accepted = acceptedReplay("scheduled"),
    context = {
      input: {
        rootDir,
        now: () => "2026-11-11T00:00:00.000Z",
        remote: {
          readDispatchLifecycle: async (query) => {
            const read = await accepted.readDispatchLifecycle(query);
            return {
              ...read,
              rows: read.rows.map((row) => ({ ...row, successor: { ...row.successor, schedule: null } })),
            };
          },
        },
        schedule: () => assert.fail("local plan cannot schedule a successor"),
      },
    } as unknown as RuntimeSpawnerContext;
  await assert.rejects(
    scheduleFallbackContinuation({
      context,
      dispatchId: replayDispatchId,
      launch: async () => assert.fail("local plan cannot launch"),
    }),
    { code: "runtime_event_missing" },
  );
});
