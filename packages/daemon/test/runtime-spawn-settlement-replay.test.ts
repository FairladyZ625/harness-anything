// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
import { publishExit } from "../src/runtime-spawn-settlement.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import type { RuntimeAttemptTerminal } from "../src/runtime-spawn-types.ts";
import { active } from "./runtime-spawn-settlement.fixtures.ts";

const replayDispatchId = "dispatch_0123456789abcdef01234567",
  replayRuntimeSessionId = "runtime_replay00000000000000000000",
  binding = {
    actor: {
      principal: { kind: "human", id: "operator" } as never,
      executor: { kind: "agent", id: `runtime-session:${replayRuntimeSessionId}` },
    },
    source: "local" as const,
  };

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

test("a replayed persisted terminal still notifies the Schedule settlement entry", async () => {
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
      runtime = active({
        process: {
          pid: process.pid,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
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
        stream: { ref: `runtime-stream:${replayDispatchId}` } as never,
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
    assert.equal(terminals[0]?.outcome, "unknown");
    assert.equal(terminals[0]?.runtimeSessionId, replayRuntimeSessionId);
    assert.equal(terminals[0]?.endedAt, "2026-10-16T23:20:04.290Z");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

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
          pid: process.pid,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
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
    assert.equal(readDispatchStream(rootDir, replayDispatchId)?.fallbackState, "scheduled");
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
          pid: process.pid,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
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
