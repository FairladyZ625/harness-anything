// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDispatchStream, type DispatchStallEvidence } from "../src/dispatch-stream.ts";
import { attachActiveRuntime, disposeActiveRuntimeObservations } from "../src/runtime-spawn-active.ts";
import { consumeProviderLine } from "../src/runtime-spawn-provider-stream.ts";
import { parseProviderFrame } from "../src/runtime-spawn-provider-frames.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";
import { active as runtimeFixture } from "./runtime-spawn-settlement.fixtures.ts";

/** Fake clock + timer queue: the watchdog test must decide deadline behavior without wall time. */
function installFakeClock(startMs: number) {
  const originalNow = Date.now,
    originalSetTimeout = globalThis.setTimeout,
    originalClearTimeout = globalThis.clearTimeout,
    timers: Array<{ readonly callback: () => void; readonly unref: () => void }> = [];
  let current = startMs;
  Date.now = () => current;
  globalThis.setTimeout = ((callback: () => void) => {
    const timer = { callback, unref: () => undefined };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer) => {
    const index = timers.indexOf(timer as (typeof timers)[number]);
    if (index >= 0) timers.splice(index, 1);
  }) as typeof clearTimeout;
  return {
    timers,
    set: (value: number) => {
      current = value;
    },
    restore: () => {
      Date.now = originalNow;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

function watchdogFixture(options: {
  readonly rootDir: string;
  readonly nowMs: number;
  readonly liveChildPids: readonly number[] | null;
  readonly inFlight: boolean;
  readonly captured: Array<{ readonly occurredAt: string; readonly evidence: DispatchStallEvidence | undefined }>;
}) {
  const dispatchId = "dispatch_0000000000000000000000aa",
    runtimeSessionId = "runtime_0000000000000000000000aa",
    baseStream = openDispatchStream(options.rootDir, {
      dispatchId,
      runtimeSessionId,
      startedAt: "2026-10-28T00:00:00.000Z",
    }),
    stream = {
      ...baseStream,
      appendStalled: (occurredAt: string, evidence?: DispatchStallEvidence) => {
        options.captured.push({ occurredAt, evidence });
        baseStream.appendStalled(occurredAt, evidence);
      },
    },
    runtime = runtimeFixture({
      process: {
        pid: 4321,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
        terminateTree: async () => undefined,
        liveDescendantPids: async () =>
          options.liveChildPids === null ? { available: false } : { available: true, pids: options.liveChildPids },
      },
      runtimeSessionId,
      dispatchId,
      stream: stream as never,
      cwd: options.rootDir,
      lastProgressAtMs: options.nowMs,
      stallTimeoutMs: 10_000,
    });
  if (options.inFlight)
    runtime.inFlightToolCalls.set("toolu_long_command", { startedAtMs: options.nowMs, timeoutMs: 30_000 });
  return runtime;
}

function watchdogContext(
  runtime: ActiveRuntime,
  rootDir: string,
  scheduled: Array<Promise<void>>,
  terminators: string[],
): RuntimeSpawnerContext {
  return {
    exiting: new Set<string>(),
    processes: new Map([[runtime.runtimeSessionId, runtime]]),
    input: {
      repoId: "canonical",
      rootDir,
      now: () => new Date(Date.now()).toISOString(),
      stream: { publish: () => undefined },
      schedule: (work: () => void | Promise<void>) => scheduled.push(Promise.resolve(work())),
    },
    resultMediaType: "text/plain; charset=utf-8",
    runtimeResultText: () => "",
    markProtocolError: () => undefined,
    publishRuntimeEvent: async () => ({}),
    publishExit: async (active: ActiveRuntime) => {
      terminators.push(active.runtimeSessionId);
    },
  } as unknown as RuntimeSpawnerContext;
}

async function fireNextTimer(
  clock: ReturnType<typeof installFakeClock>,
  scheduled: Array<Promise<void>>,
): Promise<void> {
  const timer = clock.timers.shift();
  assert.ok(timer, "the watchdog must have an armed timer");
  timer.callback();
  await Promise.all(scheduled.splice(0));
}

test("an in-flight tool call with live descendants defers the stall to the tool's own timeout", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-stall-deferral-")),
    nowMs = 1_000_000,
    clock = installFakeClock(nowMs);
  const captured: Array<{ occurredAt: string; evidence: DispatchStallEvidence | undefined }> = [],
    scheduled: Array<Promise<void>> = [],
    terminators: string[] = [];
  try {
    const runtime = watchdogFixture({ rootDir, nowMs, liveChildPids: [5555, 6666], inFlight: true, captured }),
      context = watchdogContext(runtime, rootDir, scheduled, terminators);
    attachActiveRuntime(context, runtime);
    assert.equal(clock.timers.length, 1);

    clock.set(nowMs + 10_000);
    await fireNextTimer(clock, scheduled);
    assert.equal(runtime.stalledAt, null, "a running tool with live children is not a stall");
    assert.deepEqual(terminators, []);
    assert.equal(clock.timers.length, 1, "the watchdog re-arms instead of cancelling");

    // The bound is the provider's own timeout (30_000) plus the settle grace (5_000).
    clock.set(nowMs + 35_000);
    await fireNextTimer(clock, scheduled);
    assert.equal(runtime.stalledAt, new Date(nowMs + 35_000).toISOString());
    assert.deepEqual(terminators, [runtime.runtimeSessionId]);
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0]?.evidence, {
      lastProgressAt: new Date(nowMs).toISOString(),
      stallTimeoutMs: 10_000,
      idleMs: 35_000,
      inFlightToolCalls: [
        { toolCallId: "toolu_long_command", startedAt: new Date(nowMs).toISOString(), timeoutMs: 30_000 },
      ],
      liveProcessPids: [5555, 6666],
    });
    disposeActiveRuntimeObservations(runtime);
  } finally {
    clock.restore();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a settling frame at the deferred deadline renews progress instead of settling", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-stall-renewal-")),
    nowMs = 2_000_000,
    clock = installFakeClock(nowMs);
  const captured: Array<{ occurredAt: string; evidence: DispatchStallEvidence | undefined }> = [],
    scheduled: Array<Promise<void>> = [],
    terminators: string[] = [];
  try {
    const runtime = watchdogFixture({ rootDir, nowMs, liveChildPids: [7777], inFlight: true, captured }),
      context = watchdogContext(runtime, rootDir, scheduled, terminators);
    attachActiveRuntime(context, runtime);

    clock.set(nowMs + 10_000);
    await fireNextTimer(clock, scheduled);
    assert.equal(runtime.stalledAt, null);

    // The tool call's own settling frame arrives after the base deadline; it is progress, not a stall.
    clock.set(nowMs + 20_000);
    runtime.recordProviderProgress?.();
    runtime.inFlightToolCalls.delete("toolu_long_command");
    assert.equal(runtime.lastProgressAtMs, nowMs + 20_000);
    assert.equal(runtime.stalledAt, null);

    clock.set(nowMs + 29_999);
    await fireNextTimer(clock, scheduled);
    assert.equal(runtime.stalledAt, null, "the renewed deadline is still ahead");
    clock.set(nowMs + 30_000);
    await fireNextTimer(clock, scheduled);
    assert.equal(runtime.stalledAt, new Date(nowMs + 30_000).toISOString());
    disposeActiveRuntimeObservations(runtime);
  } finally {
    clock.restore();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("an in-flight tool call with no live child process still stalls at the base deadline", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-stall-negative-")),
    nowMs = 3_000_000,
    clock = installFakeClock(nowMs);
  const captured: Array<{ occurredAt: string; evidence: DispatchStallEvidence | undefined }> = [],
    scheduled: Array<Promise<void>> = [],
    terminators: string[] = [];
  try {
    const runtime = watchdogFixture({ rootDir, nowMs, liveChildPids: [], inFlight: true, captured }),
      context = watchdogContext(runtime, rootDir, scheduled, terminators);
    attachActiveRuntime(context, runtime);

    clock.set(nowMs + 10_000);
    await fireNextTimer(clock, scheduled);
    assert.equal(runtime.stalledAt, new Date(nowMs + 10_000).toISOString());
    assert.deepEqual(terminators, [runtime.runtimeSessionId]);
    assert.deepEqual(captured[0]?.evidence?.liveProcessPids, []);
    assert.equal(captured[0]?.evidence?.inFlightToolCalls.length, 1, "the evidence still names the open call");
    disposeActiveRuntimeObservations(runtime);
  } finally {
    clock.restore();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("provider tool-call frames open and close the in-flight ledger with the declared timeout", async () => {
  const runtime = runtimeFixture({
      kindId: "deepseek-harness",
      stream: { ref: "runtime-stream:test", appendProviderEvent: () => undefined } as never,
    }),
    context = {
      input: { now: () => new Date().toISOString() },
      parseProviderFrame,
      markProtocolError: () => {
        throw new Error("the ACP tool-call frames must parse");
      },
      bindProvider: async () => undefined,
      isStructuredSuccessResult: () => false,
    } as unknown as RuntimeSpawnerContext,
    start = {
      sessionId: "session-tool-call",
      type: "acp.update",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "toolu_c30c1dfe167041409b3ba8ad",
        status: "in_progress",
        rawInput: { command: "sleep 300", timeoutMs: 330_000 },
      },
    },
    settled = {
      sessionId: "session-tool-call",
      type: "acp.update",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_c30c1dfe167041409b3ba8ad",
        status: "completed",
      },
    };

  await consumeProviderLine(context, runtime, JSON.stringify(start), false, false);
  const open = runtime.inFlightToolCalls.get("toolu_c30c1dfe167041409b3ba8ad");
  assert.equal(open?.timeoutMs, 330_000);
  assert.ok((open?.startedAtMs ?? 0) > 0);

  await consumeProviderLine(context, runtime, JSON.stringify(settled), false, false);
  assert.equal(runtime.inFlightToolCalls.size, 0);
});

test("codex item.started and item.completed bracket a command in the in-flight ledger", async () => {
  const runtime = runtimeFixture({
      kindId: "codex",
      stream: { ref: "runtime-stream:test", appendProviderEvent: () => undefined } as never,
    }),
    context = {
      input: { now: () => new Date().toISOString() },
      parseProviderFrame,
      markProtocolError: () => {
        throw new Error("the codex item frames must parse");
      },
      bindProvider: async () => undefined,
      isStructuredSuccessResult: () => false,
    } as unknown as RuntimeSpawnerContext,
    started = { type: "item.started", item: { id: "item_1", type: "command_execution", status: "in_progress" } },
    completed = { type: "item.completed", item: { id: "item_1", type: "command_execution", status: "completed" } };

  await consumeProviderLine(context, runtime, JSON.stringify(started), false, false);
  assert.equal(runtime.inFlightToolCalls.has("item_1"), true);
  await consumeProviderLine(context, runtime, JSON.stringify(completed), false, false);
  assert.equal(runtime.inFlightToolCalls.has("item_1"), false);
});
