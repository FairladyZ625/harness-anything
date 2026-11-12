// harness-test-tier: fast
import { lifecycleSummaryFor } from "./dispatch-lifecycle-read.fixtures.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeSessionResult } from "../src/agent-runtime-contract.ts";
import { taskDispatchRowsSettled } from "../src/dispatch-read.ts";
import type { DaemonTaskDispatchesResult, TaskDispatchRow } from "../src/protocol/daemon-protocol.contract.ts";
import { orchestrateRuntimeSessionsAwait, type RuntimeAwaitContext } from "../src/runtime-orchestration.ts";

function sessionResult(
  runtimeSessionId: string,
  settlement: { outcome: string; exitCode: number; code?: string | null; reason?: string | null } | null,
  resultText?: string,
): AgentRuntimeSessionResult {
  return {
    ok: true,
    status: "ready",
    settlement: settlement && {
      outcome: settlement.outcome,
      exitCode: settlement.exitCode,
      code: settlement.code ?? null,
      reason: settlement.reason ?? null,
    },
    session: { runtimeSessionId, liveness: settlement ? "exited" : "live" },
    result: resultText ? { ref: "result:test", text: resultText } : null,
    watermark: 1,
    sourceRevision: 1,
  } as unknown as AgentRuntimeSessionResult;
}

function dispatchRow(overrides: Partial<TaskDispatchRow>): TaskDispatchRow {
  return {
    lifecycle: lifecycleSummaryFor({
      runtimeSessionId: "session",
      dispatchId: overrides.dispatchId ?? "dispatch-1",
      attemptSettled: overrides.outcome !== undefined && overrides.outcome !== null,
      outcome: overrides.outcome ?? null,
      process: overrides.status === "running" ? "alive" : undefined,
    }),
    dispatchId: "dispatch-1",
    taskId: "task-1",
    status: "running",
    outcome: null,
    fallbackState: null,
    nextDispatchId: null,
    exitCode: null,
    ...overrides,
  } as unknown as TaskDispatchRow;
}

function dispatchesResult(rows: readonly TaskDispatchRow[], overrides: Partial<DaemonTaskDispatchesResult> = {}) {
  return {
    ok: true,
    status: "ready",
    taskIds: ["task-1"],
    unavailableTaskIds: [],
    page: {},
    dispatches: rows,
    outcome: "unknown",
    exitCode: 1,
    watermark: 1,
    sourceRevision: 1,
    ...overrides,
  } as unknown as DaemonTaskDispatchesResult;
}

function awaitContext(input: {
  readonly sessions?: Readonly<Record<string, AgentRuntimeSessionResult[]>>;
  readonly missing?: readonly string[];
  readonly dispatches?: DaemonTaskDispatchesResult[];
  readonly connectionSignal?: AbortSignal;
}) {
  const sessionReads = new Map(Object.entries(input.sessions ?? {}).map(([id, reads]) => [id, [...reads]])),
    missing = new Set(input.missing ?? []),
    dispatchReads = [...(input.dispatches ?? [])],
    signals: { waits: number; release: () => void; pending: (() => void)[] } = {
      waits: 0,
      pending: [],
      release() {
        const waiters = this.pending.splice(0);
        for (const waiter of waiters) waiter();
      },
    },
    context: RuntimeAwaitContext = {
      readSession: async (runtimeSessionId) => {
        if (missing.has(runtimeSessionId))
          throw Object.assign(new Error(`runtime session ${runtimeSessionId} is not projected.`), {
            code: "runtime_session_not_found",
          });
        const reads = sessionReads.get(runtimeSessionId) ?? [];
        if (reads.length === 0) throw new Error(`no reads left for ${runtimeSessionId}`);
        return reads.shift()!;
      },
      readTaskDispatches: async () => {
        if (dispatchReads.length === 0) throw new Error("no dispatch reads left");
        return dispatchReads.shift()!;
      },
      awaitSignal: async () => {
        signals.waits += 1;
        // The parked wait resolves as soon as the test releases it — mirroring the runtime
        // signal wake, never a poll.
        await new Promise<void>((resolve) => signals.pending.push(resolve));
      },
      ...(input.connectionSignal ? { connectionSignal: input.connectionSignal } : {}),
      codedError: (code, message) => Object.assign(new Error(message), { code }),
    };
  return { context, signals };
}

test("sessions.await any returns on the first settled session and reports the rest in flight", async () => {
  const { context, signals } = awaitContext({
    sessions: {
      "sess-a": [sessionResult("sess-a", null), sessionResult("sess-a", { outcome: "succeeded", exitCode: 0 }, "done")],
      "sess-b": [sessionResult("sess-b", null), sessionResult("sess-b", null)],
    },
  });
  const pending = orchestrateRuntimeSessionsAwait({ runtimeSessionIds: ["sess-a", "sess-b"] }, context);
  // Let the first read cycle park on the signal, then release it.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signals.waits, 1);
  signals.release();
  const receipt = await pending;
  assert.equal(receipt.mode, "any");
  assert.equal(receipt.outcome, "succeeded");
  assert.equal(receipt.exitCode, 0);
  const settled = receipt.sessions as Array<Record<string, unknown>>;
  assert.deepEqual(
    settled.map((row) => row.runtimeSessionId),
    ["sess-a"],
  );
  assert.equal(settled[0]!.resultText, "done");
  assert.deepEqual(
    (receipt.inFlight as Array<Record<string, unknown>>).map((row) => row.runtimeSessionId),
    ["sess-b"],
  );
});

test("sessions.await all waits for every known session and aggregates the verdict", async () => {
  const { context, signals } = awaitContext({
    sessions: {
      "sess-a": [
        sessionResult("sess-a", { outcome: "succeeded", exitCode: 0 }),
        sessionResult("sess-a", { outcome: "succeeded", exitCode: 0 }),
      ],
      "sess-b": [
        sessionResult("sess-b", null),
        sessionResult("sess-b", { outcome: "failed", exitCode: 3, reason: "boom", code: "provider_exit" }),
      ],
    },
  });
  const pending = orchestrateRuntimeSessionsAwait({ runtimeSessionIds: ["sess-a", "sess-b"], mode: "all" }, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signals.waits, 1, "all must keep waiting while sess-b is live");
  signals.release();
  const receipt = await pending;
  assert.equal(receipt.outcome, "failed");
  assert.equal(receipt.exitCode, 1);
  assert.equal(receipt.code, "provider_exit");
  assert.equal(receipt.reason, "boom");
  assert.equal((receipt.sessions as unknown[]).length, 2);
});

test("sessions.await reports sessions absent from the local projection instead of waiting forever", async () => {
  const { context } = awaitContext({
    missing: ["sess-remote"],
    sessions: { "sess-a": [sessionResult("sess-a", { outcome: "succeeded", exitCode: 0 })] },
  });
  const receipt = await orchestrateRuntimeSessionsAwait({ runtimeSessionIds: ["sess-a", "sess-remote"] }, context);
  assert.deepEqual(receipt.unavailable, [{ runtimeSessionId: "sess-remote", code: "runtime_session_not_found" }]);
  assert.match(String(receipt.nextAction), /wait on the node that owns them/u);
  assert.equal(receipt.outcome, "succeeded");
});

test("sessions.await skips already-settled targets immediately without parking", async () => {
  const { context, signals } = awaitContext({
    sessions: {
      "sess-a": [sessionResult("sess-a", { outcome: "succeeded", exitCode: 0 })],
      "sess-b": [sessionResult("sess-b", { outcome: "cancelled", exitCode: 1 })],
    },
  });
  const receipt = await orchestrateRuntimeSessionsAwait(
    { runtimeSessionIds: ["sess-a", "sess-b"], mode: "all" },
    context,
  );
  assert.equal(signals.waits, 0);
  assert.equal(receipt.outcome, "failed");
  assert.equal((receipt.sessions as unknown[]).length, 2);
});

test("sessions.await all with an unavailable session cannot report success", async () => {
  const { context, signals } = awaitContext({
    missing: ["sess-remote"],
    sessions: { "sess-a": [sessionResult("sess-a", { outcome: "succeeded", exitCode: 0 })] },
  });
  const receipt = await orchestrateRuntimeSessionsAwait(
    { runtimeSessionIds: ["sess-a", "sess-remote"], mode: "all" },
    context,
  );
  assert.equal(signals.waits, 0, "an all-missing projection answers without parking");
  assert.equal(receipt.outcome, "failed");
  assert.equal(receipt.exitCode, 1);
});

test("sessions.await validates target shape and exclusivity", async () => {
  const { context } = awaitContext({});
  for (const payload of [
    {},
    { runtimeSessionIds: [] },
    { runtimeSessionIds: ["a", "a"] },
    { runtimeSessionIds: ["a"], taskIds: ["task-1"] },
    { mode: "sometimes", runtimeSessionIds: ["a"] },
  ]) {
    await assert.rejects(
      () => orchestrateRuntimeSessionsAwait(payload, context),
      (error: unknown) => (error as { code?: string }).code === "invalid_field",
      JSON.stringify(payload),
    );
  }
});

test("sessions.await preserves stopped as a terminal verdict without reporting success or parking", async () => {
  for (const mode of ["any", "all"] as const) {
    const { context, signals } = awaitContext({
      sessions: { stopped: [sessionResult("stopped", { outcome: "stopped", exitCode: 1 }, "checkpoint")] },
    });
    const receipt = await orchestrateRuntimeSessionsAwait({ runtimeSessionIds: ["stopped"], mode }, context);
    assert.equal(receipt.outcome, "stopped");
    assert.equal(receipt.exitCode, 1);
    assert.equal(signals.waits, 0);
  }
  for (const status of ["stopped", "blocked"] as const) {
    assert.equal(taskDispatchRowsSettled([dispatchRow({ status, outcome: "stopped" })]), true);
  }
});

test("sessions.await on taskIds waits for every dispatch row to settle", async () => {
  const { context, signals } = awaitContext({
    dispatches: [
      dispatchesResult([dispatchRow({ status: "running" })]),
      dispatchesResult([dispatchRow({ status: "succeeded", outcome: "succeeded", exitCode: 0 })], {
        outcome: "succeeded",
        exitCode: 0,
      }),
    ],
  });
  const pending = orchestrateRuntimeSessionsAwait({ taskIds: ["task-1"] }, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signals.waits, 1);
  signals.release();
  const receipt = await pending;
  assert.equal(receipt.mode, "all");
  assert.equal(receipt.outcome, "succeeded");
  assert.equal(receipt.exitCode, 0);
  assert.equal((receipt.dispatches as unknown[]).length, 1);
});

test("sessions.await on taskIds keeps waiting while the projection reports pending", async () => {
  const { context, signals } = awaitContext({
    dispatches: [
      dispatchesResult([], { status: "pending" }),
      dispatchesResult([dispatchRow({ status: "succeeded", outcome: "succeeded", exitCode: 0 })], {
        outcome: "succeeded",
        exitCode: 0,
      }),
    ],
  });
  const pending = orchestrateRuntimeSessionsAwait({ taskIds: ["task-1"] }, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signals.waits, 1, "a pending projection is not terminal");
  signals.release();
  const receipt = await pending;
  assert.equal(receipt.outcome, "succeeded");
});

test("dispatch awaits use the group policy and ignore obsolete fallback markers", () => {
  const waiting = lifecycleSummaryFor({
      runtimeSessionId: "session",
      dispatchId: "dispatch-1",
      attemptSettled: true,
      groupSettled: false,
      outcome: "failed",
    }),
    exhausted = lifecycleSummaryFor({
      runtimeSessionId: "session",
      dispatchId: "dispatch-1",
      attemptSettled: true,
      outcome: "failed",
    });
  assert.equal(taskDispatchRowsSettled([dispatchRow({ lifecycle: waiting, fallbackState: "exhausted" })]), false);
  assert.equal(taskDispatchRowsSettled([dispatchRow({ lifecycle: exhausted, fallbackState: "scheduled" })]), true);
  assert.equal(
    taskDispatchRowsSettled([dispatchRow({ lifecycle: exhausted }), dispatchRow({ lifecycle: waiting })]),
    false,
  );
});

test("a parked sessions.await ends when the connection that asked for it closes", async () => {
  const connection = new AbortController(),
    { context } = awaitContext({
      sessions: { "sess-live": [sessionResult("sess-live", null)] },
      connectionSignal: connection.signal,
    });
  const pending = orchestrateRuntimeSessionsAwait({ runtimeSessionIds: ["sess-live"] }, context);
  await new Promise((resolve) => setImmediate(resolve));
  connection.abort();
  const verdict = await Promise.race([
    pending.then(
      () => "settled",
      (error: unknown) =>
        (error as { readonly code?: unknown }).code === "client_disconnected" ? "abandoned" : "unexpected",
    ),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve("still-parked"), 500);
      timer.unref?.();
    }),
  ]);
  assert.equal(verdict, "abandoned", "the parked wait must end at the connection, not keep settle reads alive");
});

test("a sessions.await on an already-closed connection answers client_disconnected immediately", async () => {
  const connection = new AbortController(),
    { context } = awaitContext({
      sessions: { "sess-live": [sessionResult("sess-live", null)] },
      connectionSignal: connection.signal,
    });
  connection.abort();
  await assert.rejects(
    orchestrateRuntimeSessionsAwait({ runtimeSessionIds: ["sess-live"] }, context),
    (error: unknown) => {
      assert.equal((error as { readonly code?: unknown }).code, "client_disconnected");
      return true;
    },
  );
});

for (const target of ["sessions", "tasks"] as const) {
  test(`sessions.await retains a terminal notification during an asynchronous ${target} read`, async () => {
    const { createRuntimeOutcomeWaiters } = await import("../src/runtime-settlement.ts"),
      signals = createRuntimeOutcomeWaiters({
        readLifecycle: async () => ({ status: "ready", watermark: 0, sourceRevision: 0, rows: [], nextCursor: null }),
      });
    let reads = 0;
    const context: RuntimeAwaitContext = {
      signalVersion: signals.signalVersion,
      awaitSignal: signals.awaitSignal,
      readSession: async () => {
        const first = ++reads === 1;
        if (first) signals.notify();
        return sessionResult("sess-race", first ? null : { outcome: "succeeded", exitCode: 0 });
      },
      readTaskDispatches: async () => {
        const first = ++reads === 1;
        if (first) signals.notify();
        return dispatchesResult(
          [dispatchRow(first ? {} : { status: "succeeded", outcome: "succeeded", exitCode: 0 })],
          { exitCode: first ? 1 : 0 },
        );
      },
      codedError: (code, message) => Object.assign(new Error(message), { code }),
    };
    const pending = orchestrateRuntimeSessionsAwait(
      target === "sessions" ? { runtimeSessionIds: ["sess-race"] } : { taskIds: ["task-1"] },
      context,
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(reads, 2, "the stale in-flight snapshot must be re-read without waiting for the grace timer");
      assert.equal((await pending).exitCode, 0);
    } finally {
      signals.notify();
      await pending;
    }
  });
}

test("local outcome waiter waits for an accepted lifecycle terminal after process stop", async () => {
  const { lifecycleEvent, dispatchLifecycleReadOf } = await import("./dispatch-lifecycle-read.fixtures.ts"),
    { createRuntimeOutcomeWaiters } = await import("../src/runtime-settlement.ts"),
    runtimeSessionId = "session-outcome-waiter",
    source = "local" as const,
    events = [
      lifecycleEvent("R", runtimeSessionId, { instanceId: "instance", source }),
      lifecycleEvent("S", runtimeSessionId, { instanceId: "instance", source }),
    ],
    readPort = dispatchLifecycleReadOf(() => events),
    waiters = createRuntimeOutcomeWaiters({
      readLifecycle: (id) => readPort({ by: "session", runtimeSessionId: id }),
    });
  let settled = false;
  const pending = waiters.awaitOutcome(runtimeSessionId).then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  events.push(lifecycleEvent("X", runtimeSessionId, { instanceId: "instance", source }));
  waiters.notify();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "process stop alone does not settle a dispatch attempt");

  events.push(lifecycleEvent("O", runtimeSessionId, { instanceId: "instance", source }));
  waiters.notify();
  await pending;
  assert.equal(settled, true);
});

test("orchestration waits for canonical publication after local host-loss evidence", async () => {
  const { lifecycleEvent, dispatchLifecycleReadOf } = await import("./dispatch-lifecycle-read.fixtures.ts"),
    { runtimeOutcomeSettled } = await import("../src/runtime-settlement.ts"),
    runtimeSessionId = "session-publication",
    source = "local" as const,
    events = [lifecycleEvent("R", runtimeSessionId, { instanceId: "instance", source })],
    readLifecycle = dispatchLifecycleReadOf(() => events);
  events.push(lifecycleEvent("S", runtimeSessionId, { instanceId: "instance", source }));
  assert.equal(runtimeOutcomeSettled(await readLifecycle({ by: "session", runtimeSessionId })), false);
  events.push(lifecycleEvent("X", runtimeSessionId, { instanceId: "instance", source }));
  assert.equal(
    runtimeOutcomeSettled(await readLifecycle({ by: "session", runtimeSessionId })),
    false,
    "process exit proves stop but does not settle the attempt before its accepted outcome",
  );
  events.push(lifecycleEvent("O", runtimeSessionId, { instanceId: "instance", source }));
  assert.equal(runtimeOutcomeSettled(await readLifecycle({ by: "session", runtimeSessionId })), true);
});
