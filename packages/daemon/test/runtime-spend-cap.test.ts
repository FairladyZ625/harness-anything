// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { attachActiveRuntime, createActiveRuntime } from "../src/runtime-spawn-active.ts";
import { consumeProviderLine } from "../src/runtime-spawn-provider-stream.ts";
import { parseProviderFrame } from "../src/runtime-spawn-provider-frames.ts";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";

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
    cwd: "/tmp",
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
});
