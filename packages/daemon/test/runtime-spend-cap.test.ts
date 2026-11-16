// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runtimeExecutionBudgetRefusal } from "../src/runtime-spend-cap.ts";
import { settleFallbackAttempt } from "../src/runtime-spawn-fallback.ts";
import {
  attachActiveRuntime,
  createActiveRuntime,
  disposeActiveRuntimeObservations,
} from "../src/runtime-spawn-active.ts";
import { consumeProviderLine } from "../src/runtime-spawn-provider-stream.ts";
import { parseProviderFrame } from "../src/runtime-spawn-provider-frames.ts";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";

// A real dispatch cwd is its own worktree; a recursive watcher over a shared tmp tree holds one
// fs_event handle per entry and keeps the test process alive after its tests finish.
const fixtureWorkspace = mkdtempSync(path.join(tmpdir(), "ha-spend-cap-fixture-"));

function active(tokenLimit: number | null = 100, process: unknown = { pid: 4321 }) {
  return createActiveRuntime({
    runtimeSessionId: "runtime_spend_cap_aaaaaaaaaaaa",
    dispatchId: "dispatch_spend_cap_aaaaaaaa",
    dispatchOpId: "dispatch-op-spend-cap",
    instanceId: "instance-spend-cap",
    kindId: "codex",
    resolvedProviderDirectory: null,
    permissionMode: null,
    agent: null,
    role: null,
    delegatedBy: null,
    squadId: null,
    publicationOwner: "runtime",
    parentRuntimeSessionId: null,
    binding: { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" },
    task: null,
    decisionReviewTarget: null,
    schedule: null,
    cwd: fixtureWorkspace,
    prompt: "spend cap fixture",
    onExitCommand: null,
    model: "gpt-5.6-sol",
    reasoningEffort: null,
    fast: false,
    startedAt: "2026-10-24T00:00:00.000Z",
    stream: { appendProviderEvent: () => undefined } as never,
    tokenLimit,
    process,
  } as never) as ActiveRuntime;
}

function providerContext() {
  return {
    input: { now: () => "2026-10-24T00:00:00.000Z", stream: { publish: () => undefined } },
    parseProviderFrame,
    markProtocolError: () => undefined,
    bindProvider: async () => undefined,
    isStructuredSuccessResult: () => false,
    processes: new Map(),
  } as never;
}

test("reviewer dispatches neither consume implementation attempts/tokens nor face its ceiling", async () => {
  const task = { taskId: "task-budget", executionId: "execution-budget" },
    rows = Array.from({ length: 5 }, (_, index) => ({
      event: { payload: { runtimeSessionId: `implementation-${index}`, role: "implementer" } },
      metrics: { totalTokens: 1 },
    })),
    reviewer = {
      event: { payload: { runtimeSessionId: "reviewer", role: "reviewer" } },
      metrics: { totalTokens: 1000 },
    },
    projection = { readRuntimeDispatchesByTaskExecution: () => [...rows, reviewer] } as never,
    budget = { maxAttempts: 6, maxTokens: 100 };
  assert.equal(runtimeExecutionBudgetRefusal(projection, task, budget), null);
  rows.push({
    event: { payload: { runtimeSessionId: "implementation-5", role: "implementer" } },
    metrics: { totalTokens: 1 },
  });
  assert.equal(runtimeExecutionBudgetRefusal(projection, task, budget)?.code, "execution_budget_exceeded");
  assert.equal(runtimeExecutionBudgetRefusal(projection, { ...task, role: "reviewer" }, budget), null);
  const result = await settleFallbackAttempt(
    {
      input: { now: () => "2026-11-16T00:00:00Z", readSettings: () => ({ runtime: {} }) },
      requiredRuntimeProjection: () => projection,
    } as never,
    {
      task,
      role: "reviewer",
      tokenLimit: 100,
      stream: { appendFallbackState: () => undefined },
      fallbackAttempt: { attemptIndex: 0, candidates: [{ instance: "a" }, { instance: "b" }] },
    } as never,
    {
      classification: "provider_fault",
      reason: "startup 500",
      provider: { instance: "a", model: "fixture", kind: "agy" },
      attemptGroupId: "reviewer-group",
      attemptIndex: 0,
    },
    { outcome: "failed" } as never,
  );
  assert.equal(result?.fallbackState, "scheduled", "reviewer fallback retains its own bounded retry policy");
});

test("usage above the dispatch token limit marks the runtime as capped", async () => {
  const runtime = active(100);
  await consumeProviderLine(
    providerContext(),
    runtime,
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 80, output_tokens: 30 } }),
  );
  assert.equal(runtime.inputTokens + runtime.outputTokens, 110);
  assert.equal(runtime.spendCapExceeded, true);
});

test("usage at the limit does not stop the runtime yet", async () => {
  const runtime = active(100);
  await consumeProviderLine(
    providerContext(),
    runtime,
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 80, output_tokens: 20 } }),
  );
  assert.equal(runtime.inputTokens + runtime.outputTokens, 100);
  assert.equal(runtime.spendCapExceeded, false);
});

test("Execution token ceiling is opt-in and independent of each dispatch's token cap", () => {
  const task = { taskId: "task-budget", executionId: "execution-budget" },
    rows = [60, 40].map((totalTokens, index) => ({
      event: { payload: { runtimeSessionId: `runtime-${index}`, role: "implementer" } },
      metrics: { totalTokens },
    })),
    projection = { readRuntimeDispatchesByTaskExecution: () => rows } as never;
  assert.equal(runtimeExecutionBudgetRefusal(projection, task), null);
  assert.equal(
    runtimeExecutionBudgetRefusal(projection, task, { maxAttempts: 6, maxTokens: 100 })?.code,
    "execution_budget_exceeded",
  );
  assert.equal(runtimeExecutionBudgetRefusal(projection, task, { maxAttempts: 6, maxTokens: 101 }), null);
});

test("the output handler enforces the cap after the consuming chunk", async () => {
  let output: ((chunk: string) => void) | null = null;
  const runtime = active(100, {
      pid: 4321,
      onOutput: (listener: (chunk: string) => void) => {
        output = listener;
      },
      onErrorOutput: () => undefined,
      onExit: () => undefined,
      terminate: () => undefined,
    }),
    enforced: string[] = [],
    scheduled: Array<() => Promise<void>> = [],
    context = {
      ...providerContext(),
      exiting: new Set<string>(),
      input: {
        ...providerContext().input,
        schedule: (effect: () => Promise<void>) => scheduled.push(effect),
      },
      consumeChunk: async (target: ActiveRuntime, chunk: string) => {
        for (const line of chunk.split(/\r?\n/u))
          if (line.trim()) await consumeProviderLine(context as never, target, line);
      },
      enforceSpendCap: async (target: ActiveRuntime) => {
        enforced.push(target.runtimeSessionId);
      },
    } as never;
  context.processes.set(runtime.runtimeSessionId, runtime);
  attachActiveRuntime(context, runtime);
  output?.(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 80, output_tokens: 30 } }) + "\n");
  for (const effect of scheduled) await effect();
  assert.deepEqual(enforced, [runtime.runtimeSessionId]);
  // The attach owns a recursive watcher for the fixture workspace; disposing it is what lets the
  // test process exit instead of leaking one fs_event handle.
  disposeActiveRuntimeObservations(runtime);
});

for (const tokens of [false, true])
  test(`Execution ${tokens ? "token opt-in leaves the per-dispatch cap independent" : "attempts exhaust fallback"}`, async () => {
    const task = { taskId: "task-budget", executionId: "execution-budget" },
      rows = Array.from({ length: tokens ? 2 : 6 }, (_, index) => ({
        event: { payload: { runtimeSessionId: `runtime-${index}` } },
        metrics: { totalTokens: tokens ? 30 : 0 },
      })),
      projection = {
        readRuntimeDispatchesByTaskExecution: (taskId: string, executionId: string) => {
          assert.equal(taskId, task.taskId);
          assert.equal(executionId, task.executionId);
          return rows;
        },
      } as never,
      states: Record<string, unknown>[] = [],
      current = { runtimeSessionId: tokens ? "runtime-1" : "runtime-5", inputTokens: tokens ? 70 : 0, outputTokens: 0 },
      context = {
        input: {
          now: () => "2026-11-16T00:00:00Z",
          readSettings: () => ({ runtime: {} }),
          onAttemptTerminal: async () => undefined,
        },
        requiredRuntimeProjection: () => projection,
      } as never;
    const refusal = runtimeExecutionBudgetRefusal(
      projection,
      task,
      { maxAttempts: 6, maxTokens: tokens ? 100 : null },
      current,
    );
    assert.equal(refusal?.code, "execution_budget_exceeded");
    const result = await settleFallbackAttempt(
      context,
      {
        ...current,
        task,
        tokenLimit: tokens ? 100 : null,
        stream: { appendFallbackState: (state: Record<string, unknown>) => states.push(state) },
        fallbackAttempt: { attemptIndex: 0, candidates: [{ instance: "a" }, { instance: "b" }] },
      } as never,
      {
        classification: "provider_fault",
        reason: "startup 500",
        provider: { instance: "a", model: "fixture", kind: "agy" },
        attemptGroupId: "group",
        attemptIndex: 0,
      },
      { outcome: "failed" } as never,
    );
    if (tokens) {
      assert.equal(result?.fallbackState, "scheduled", "a dispatch cap does not opt into Execution token limiting");
      assert.equal(result?.budgetRefusal, undefined);
      assert.equal(states[0]?.state, "scheduled");
    } else {
      assert.equal(result?.fallbackState, "exhausted");
      assert.equal(result?.budgetRefusal?.code, "execution_budget_exceeded");
      assert.match(String(states[0]?.reason), /execution_budget_exceeded/u);
      assert.equal(
        states.some((state) => state.state === "scheduled"),
        false,
      );
    }
  });
