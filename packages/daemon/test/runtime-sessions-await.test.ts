// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeSessionResult } from "../src/agent-runtime-contract.ts";
import { taskDispatchRowSettled, taskDispatchRowsSettled } from "../src/dispatch-read.ts";
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

test("taskDispatchRowSettled honours fallback chains and the unknown-outcome grace", () => {
  const running = dispatchRow({ status: "running" }),
    scheduled = dispatchRow({ fallbackState: "scheduled" }),
    dispatchedTo = dispatchRow({
      status: "failed",
      outcome: "failed",
      fallbackState: "dispatched",
      nextDispatchId: "dispatch-2",
    }),
    dispatchedAway = dispatchRow({
      status: "failed",
      outcome: "failed",
      fallbackState: "dispatched",
      nextDispatchId: "dispatch-elsewhere",
    }),
    exhausted = dispatchRow({ fallbackState: "exhausted", status: "failed", outcome: "failed" }),
    justExited = dispatchRow({ status: "unknown", outcome: null }),
    unknownTerminal = dispatchRow({ status: "unknown", outcome: "unknown" }),
    succeeded = dispatchRow({ status: "succeeded", outcome: "succeeded" });
  const ids = ["dispatch-1", "dispatch-2"];
  assert.equal(taskDispatchRowSettled(running, ids), false);
  assert.equal(taskDispatchRowSettled(scheduled, ids), false);
  assert.equal(
    taskDispatchRowSettled(dispatchedTo, ids),
    true,
    "a dispatched row is terminal once its successor row is projected",
  );
  assert.equal(taskDispatchRowSettled(dispatchedAway, ids), false);
  assert.equal(taskDispatchRowSettled(exhausted, ids), true);
  assert.equal(taskDispatchRowSettled(justExited, ids), false, "status=unknown without outcome is still projecting");
  assert.equal(taskDispatchRowSettled(unknownTerminal, ids), true);
  assert.equal(taskDispatchRowSettled(succeeded, ids), true);
  assert.equal(taskDispatchRowsSettled([succeeded, unknownTerminal]), true);
  assert.equal(taskDispatchRowsSettled([succeeded, running]), false);
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
