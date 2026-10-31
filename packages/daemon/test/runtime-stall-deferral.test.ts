// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDispatchStream, type DispatchStallEvidence } from "../src/dispatch-stream.ts";
import { attachActiveRuntime, disposeActiveRuntimeObservations } from "../src/runtime-spawn-active.ts";
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

test("live descendants defer the stall regardless of provider frame activity", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-stall-deferral-")),
    nowMs = 1_000_000,
    clock = installFakeClock(nowMs);
  const captured: Array<{ occurredAt: string; evidence: DispatchStallEvidence | undefined }> = [],
    scheduled: Array<Promise<void>> = [],
    terminators: string[] = [];
  try {
    const runtime = watchdogFixture({ rootDir, nowMs, liveChildPids: [5555, 6666], captured }),
      context = watchdogContext(runtime, rootDir, scheduled, terminators);
    attachActiveRuntime(context, runtime);
    assert.equal(clock.timers.length, 1);

    clock.set(nowMs + 10_000);
    await fireNextTimer(clock, scheduled);
    assert.equal(runtime.stalledAt, null, "a running tool with live children is not a stall");
    assert.deepEqual(terminators, []);
    assert.equal(clock.timers.length, 1, "the watchdog re-arms instead of cancelling");

    // The watchdog keeps observing the live subtree instead of inventing a provider timeout.
    clock.set(nowMs + 20_000);
    await fireNextTimer(clock, scheduled);
    assert.equal(runtime.stalledAt, null, "a command still running in the child process is not a stall");
    assert.deepEqual(terminators, []);
    disposeActiveRuntimeObservations(runtime);
  } finally {
    clock.restore();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a provider frame is not required to keep an active child command alive", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-stall-renewal-")),
    nowMs = 2_000_000,
    clock = installFakeClock(nowMs);
  const captured: Array<{ occurredAt: string; evidence: DispatchStallEvidence | undefined }> = [],
    scheduled: Array<Promise<void>> = [],
    terminators: string[] = [];
  try {
    const runtime = watchdogFixture({ rootDir, nowMs, liveChildPids: [7777], captured }),
      context = watchdogContext(runtime, rootDir, scheduled, terminators);
    attachActiveRuntime(context, runtime);

    clock.set(nowMs + 10_000);
    await fireNextTimer(clock, scheduled);
    assert.equal(runtime.stalledAt, null);

    clock.set(nowMs + 20_000);
    await fireNextTimer(clock, scheduled);
    assert.equal(runtime.stalledAt, null);
    assert.equal(terminators.length, 0);
    disposeActiveRuntimeObservations(runtime);
  } finally {
    clock.restore();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("no live child process still triggers the stall at the base deadline", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-stall-negative-")),
    nowMs = 3_000_000,
    clock = installFakeClock(nowMs);
  const captured: Array<{ occurredAt: string; evidence: DispatchStallEvidence | undefined }> = [],
    scheduled: Array<Promise<void>> = [],
    terminators: string[] = [];
  try {
    const runtime = watchdogFixture({ rootDir, nowMs, liveChildPids: [], captured }),
      context = watchdogContext(runtime, rootDir, scheduled, terminators);
    attachActiveRuntime(context, runtime);

    clock.set(nowMs + 10_000);
    await fireNextTimer(clock, scheduled);
    assert.equal(runtime.stalledAt, new Date(nowMs + 10_000).toISOString());
    assert.deepEqual(terminators, [runtime.runtimeSessionId]);
    assert.deepEqual(captured[0]?.evidence?.liveProcessPids, []);
    disposeActiveRuntimeObservations(runtime);
  } finally {
    clock.restore();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
