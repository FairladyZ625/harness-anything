// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { attachActiveRuntime, createActiveRuntime } from "../src/runtime-spawn-active.ts";
import { observeResumeProcess } from "../src/runtime-spawn-process.ts";
import {
  consumeDurableOutput,
  consumeProviderChunk,
  consumeProviderLine,
} from "../src/runtime-spawn-provider-stream.ts";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";
import { parseProviderFrame } from "../src/runtime-spawn-provider-frames.ts";

function active(kindId = "codex", process = {} as never) {
  return createActiveRuntime({
    runtimeSessionId: "runtime_aaaaaaaaaaaaaaaaaaaaaaaa",
    dispatchId: "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa",
    dispatchOpId: "dispatch-op-metrics",
    instanceId: "instance-1",
    kindId,
    model: null,
    reasoningEffort: null,
    fast: false,
    cwd: "/tmp",
    prompt: "metrics fixture",
    startedAt: "2026-09-11T00:00:00.000Z",
    binding: {} as never,
    process,
    stream: { appendProviderEvent: () => undefined } as never,
  } as never);
}

function context() {
  return {
    input: { now: () => "2026-09-11T00:00:00.000Z", stream: { publish: () => undefined } },
    parseProviderFrame: () => ({}),
    markProtocolError: () => undefined,
    bindProvider: async () => undefined,
    isStructuredSuccessResult: () => false,
    processes: new Map(),
  } as never;
}

test("resume observation preserves durable provider output provenance", async () => {
  const frame = `${JSON.stringify({ type: "thread.started", thread_id: "codex-resume-session" })}\n`,
    process = {
      onOutput: (listener: (chunk: string, persisted?: boolean) => void) => listener(frame, true),
      onErrorOutput: () => undefined,
      onExit: () => undefined,
      terminate: () => undefined,
    },
    observation = observeResumeProcess(process as never, "codex", "codex-resume-session"),
    runtime = active(),
    consumed: { readonly chunk: string; readonly persisted: boolean }[] = [],
    scheduled: Promise<unknown>[] = [],
    resumeContext = {
      ...context(),
      input: {
        ...context().input,
        schedule: (effect: () => Promise<unknown>) => scheduled.push(effect()),
      },
      consumeChunk: async (_active: unknown, chunk: string, _flush: boolean, persisted: boolean) => {
        consumed.push({ chunk, persisted });
      },
      captureErrorOutput: () => undefined,
      publishExit: async () => undefined,
    } as never;
  resumeContext.processes.set(runtime.runtimeSessionId, runtime);

  await observation.ready;
  attachActiveRuntime(resumeContext, runtime, observation);
  await Promise.all(scheduled);

  assert.deepEqual(consumed, [{ chunk: frame, persisted: true }]);
});

test("runtime callbacks enqueue output before a subsequently observed exit", async () => {
  const listeners: {
      output?: (chunk: string) => void;
      exit?: (code: number | null) => void;
    } = {},
    runtime = active("codex", {
      onOutput: (listener: (chunk: string) => void) => {
        listeners.output = listener;
      },
      onErrorOutput: () => undefined,
      onExit: (listener: (code: number | null) => void) => {
        listeners.exit = listener;
      },
    } as never),
    scheduled: Array<() => Promise<void>> = [],
    observed: string[] = [],
    orderedContext = {
      ...context(),
      input: {
        ...context().input,
        schedule: (effect: () => Promise<void>) => scheduled.push(effect),
      },
      consumeChunk: async (_active: unknown, chunk: string, flush: boolean) => {
        observed.push(flush ? "flush" : `output:${chunk}`);
      },
      captureErrorOutput: () => undefined,
      publishExit: async (_active: unknown, code: number | null) => {
        observed.push(`exit:${String(code)}`);
      },
    } as never;
  orderedContext.processes.set(runtime.runtimeSessionId, runtime);

  attachActiveRuntime(orderedContext, runtime);
  listeners.output?.("last-frame");
  listeners.exit?.(0);

  assert.equal(scheduled.length, 2);
  for (const effect of scheduled) await effect();
  assert.deepEqual(observed, ["output:last-frame", "flush", "exit:0"]);
});

test("Codex stream normalizes usage, ten tool calls, compaction, and preserves raw usage", async () => {
  const runtime = active();
  for (const frame of [
    { type: "thread.started", thread_id: "codex-live-session" },
    ...Array.from({ length: 10 }, (_, index) => ({
      type: "item.completed",
      item: { id: `tool-${index}`, type: "command_execution", command: "printf fixture" },
    })),
    { type: "context_compaction" },
    { type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 30, output_tokens: 45 } },
  ])
    await consumeProviderLine(context(), runtime, JSON.stringify(frame));

  assert.deepEqual(
    {
      inputTokens: runtime.inputTokens,
      cacheReadTokens: runtime.cacheReadTokens,
      outputTokens: runtime.outputTokens,
      totalTokens: runtime.inputTokens + runtime.outputTokens,
      toolCallCount: runtime.toolCallCount,
      compacted: runtime.compacted,
    },
    { inputTokens: 120, cacheReadTokens: 30, outputTokens: 45, totalTokens: 165, toolCallCount: 10, compacted: true },
  );
  assert.ok(runtime.cacheReadTokens <= runtime.inputTokens);
  assert.deepEqual(runtime.rawUsage, { input_tokens: 120, cached_input_tokens: 30, output_tokens: 45 });
});

test("Claude stream normalizes message usage including cache creation and preserves raw usage", async () => {
  const runtime = active();
  for (const frame of [
    {
      type: "message_start",
      message: {
        id: "msg_fixture",
        usage: { input_tokens: 80, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 },
      },
    },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }] } },
    { type: "context_truncated" },
    { type: "message_delta", usage: { output_tokens: 25 } },
  ])
    await consumeProviderLine(context(), runtime, JSON.stringify(frame));

  assert.deepEqual(
    {
      inputTokens: runtime.inputTokens,
      cacheReadTokens: runtime.cacheReadTokens,
      outputTokens: runtime.outputTokens,
      totalTokens: runtime.inputTokens + runtime.outputTokens,
      toolCallCount: runtime.toolCallCount,
      compacted: runtime.compacted,
    },
    { inputTokens: 110, cacheReadTokens: 20, outputTokens: 25, totalTokens: 135, toolCallCount: 1, compacted: true },
  );
  assert.ok(runtime.cacheReadTokens <= runtime.inputTokens);
  assert.deepEqual(runtime.rawUsage, {
    input_tokens: 80,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 10,
    output_tokens: 25,
  });
});

test("identical provider frames without stable identity retain every write and signal", async () => {
  const appended: unknown[] = [],
    signals: unknown[] = [],
    runtime = active(),
    frame = { type: "turn.started" },
    passthroughContext = {
      ...context(),
      input: {
        ...context().input,
        stream: { publish: (_runtimeSessionId: string, signal: unknown) => signals.push(signal) },
      },
      parseProviderFrame,
    } as never;
  runtime.stream = { appendProviderEvent: (value: unknown) => appended.push(value) } as never;

  await consumeProviderLine(passthroughContext, runtime, JSON.stringify(frame));
  await consumeProviderLine(passthroughContext, runtime, JSON.stringify(frame));

  assert.deepEqual(appended, [frame, frame]);
  assert.equal(signals.length, 0);
});

test("Codex empty turn usage is replaced by the matching session turn token count", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-codex-session-metrics-")),
    runtime = active(),
    providerSessionId = "01a091cd-17a9-71d1-9f46-b924018345e4",
    sessions = path.join(
      userRoot,
      "runtime-instances",
      runtime.instanceId,
      "home",
      ".codex",
      "sessions",
      "2026",
      "09",
      "12",
    );
  try {
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      path.join(sessions, `rollout-2026-09-12T02-48-52-${providerSessionId}.jsonl`),
      `${JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 181354, cached_input_tokens: 170624, output_tokens: 2449 },
            last_token_usage: { input_tokens: 62284, cached_input_tokens: 60672, output_tokens: 2046 },
          },
        },
      })}\n`,
    );
    runtime.providerSessionId = providerSessionId;
    runtime.providerUsageEmpty = true;
    await consumeProviderLine(context(), runtime, JSON.stringify({ type: "turn.completed", usage: {} }));
    await consumeProviderChunk(
      { ...context(), input: { ...context().input, runtimeDaemonRoute: { userRoot } } } as never,
      runtime,
      "",
      true,
    );
    assert.deepEqual(
      {
        inputTokens: runtime.inputTokens,
        cacheReadTokens: runtime.cacheReadTokens,
        outputTokens: runtime.outputTokens,
      },
      { inputTokens: 62284, cacheReadTokens: 60672, outputTokens: 2046 },
    );
    assert.deepEqual(runtime.rawUsage, { input_tokens: 62284, cached_input_tokens: 60672, output_tokens: 2046 });
    assert.equal(runtime.usageReported, true);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

// Live sample: dispatch_1b5ff88e064cff106424764a.jsonl (agy, gemini-3.8-flash-high) — the CLI
// reports each tool step as ACTIVE then DONE under one step_index, and usage stays `{}`.
test("AGY counts each tool step_index once and reports no token usage", async () => {
  const runtime = active("agy");
  for (const frame of [
    {
      event: "init",
      conversation_id: "60edfe99-9a15-4467-843d-b9f7acd50f21",
      init: { model: "gemini-3.8-flash-high" },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: "60edfe99-9a15-4467-843d-b9f7acd50f21",
        step_index: 0,
        state: "DONE",
        step_type: "user_input",
      },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: "60edfe99-9a15-4467-843d-b9f7acd50f21",
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        duration_seconds: 0.120258,
        usage: {},
      },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: "60edfe99-9a15-4467-843d-b9f7acd50f21",
        step_index: 2,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "view_file",
        tool_info: { name: "view_file", parameters: { AbsolutePath: "task_plan.md" } },
      },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: "60edfe99-9a15-4467-843d-b9f7acd50f21",
        step_index: 2,
        state: "DONE",
        step_type: "tool",
        tool_name: "view_file",
        duration_seconds: 0.034432,
        tool_info: { name: "view_file", parameters: { AbsolutePath: "task_plan.md" }, output: "78 lines, 5003 bytes" },
      },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: "60edfe99-9a15-4467-843d-b9f7acd50f21",
        step_index: 3,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
      },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: "60edfe99-9a15-4467-843d-b9f7acd50f21",
        step_index: 3,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
      },
    },
    {
      event: "result",
      result: {
        conversation_id: "60edfe99-9a15-4467-843d-b9f7acd50f21",
        status: "SUCCESS",
        response: "Scanning dispatches for non-zero token metrics.",
        num_turns: 1,
        usage: {},
      },
    },
  ])
    await consumeProviderLine(context(), runtime, JSON.stringify(frame));

  assert.equal(runtime.toolCallCount, 2);
  assert.deepEqual(
    {
      inputTokens: runtime.inputTokens,
      cacheReadTokens: runtime.cacheReadTokens,
      outputTokens: runtime.outputTokens,
    },
    { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
  );
  assert.equal(runtime.usageReported, false);
});

// Live sample: dispatch_9521193d29eefa58514b767c.jsonl (zcode) — turn.completed.payload carries
// per-turn toolCallCount that accumulates; its usage holds request counters, never tokens.
test("ZCode accumulates turn.completed tool counts and reports no token usage", async () => {
  const runtime = active("zcode");
  for (const frame of [
    { type: "session.resumed", eventId: "zcode-live-resume", sessionId: "sess_fixture" },
    { type: "model.streaming", payload: { kind: "text_delta", delta: "Scanning dispatches." } },
    {
      type: "turn.completed",
      payload: {
        usage: { source: "provider", modelRequestCount: 27, webFetchRequests: 0, webSearchRequests: 0 },
        toolCallCount: 33,
        historyRoundCount: 27,
        duration: 313948,
        resultType: "success",
      },
    },
    {
      type: "turn.completed",
      payload: {
        usage: { source: "provider", modelRequestCount: 9, webFetchRequests: 0, webSearchRequests: 0 },
        toolCallCount: 12,
        resultType: "success",
      },
    },
    {
      type: "result",
      response: "Implemented the bounded fix.",
      usage: { source: "provider", modelRequestCount: 36 },
    },
  ])
    await consumeProviderLine(context(), runtime, JSON.stringify(frame));

  assert.equal(runtime.toolCallCount, 45);
  assert.equal(runtime.usageReported, false);
  assert.deepEqual(runtime.rawUsage, {
    source: "provider",
    modelRequestCount: 36,
  });
});

test("Codex turn.completed frames never carry a payload tool count", async () => {
  const runtime = active();
  for (const frame of [
    { type: "thread.started", thread_id: "codex-no-payload" },
    { type: "turn.completed", usage: {} },
  ])
    await consumeProviderLine(context(), runtime, JSON.stringify(frame));

  assert.equal(runtime.toolCallCount, 0);
  assert.equal(runtime.usageReported, false);
});

// Live sample: dispatch_26b190cd3a86af6ebff0d15a.jsonl (claude, claude-opus-5) — every
// assistant.message.usage holds only tier metadata, no integer token field.
test("Claude usage without token integers stays unreported", async () => {
  const runtime = active("claude");
  for (const frame of [
    {
      type: "assistant",
      message: {
        id: "msg_011CewUnyD992wJFh3v36MbZ",
        content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: {} }],
        usage: { cache_creation: {}, service_tier: "standard", inference_geo: "not_available" },
      },
    },
    {
      type: "result",
      subtype: "success",
      result: "Done.",
      usage: { server_tool_use: { web_search_requests: 0 }, service_tier: "standard", cache_creation: {} },
    },
  ])
    await consumeProviderLine(context(), runtime, JSON.stringify(frame));

  assert.equal(runtime.toolCallCount, 1);
  assert.equal(runtime.usageReported, false);
});

test("durable drains wait for the first record while the worker runs, then consume it once", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-durable-wait-"));
  try {
    const dispatchId = "dispatch_e1f2a3b4c5d60718293a4b5c";
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: null,
      executionId: null,
      runtimeSessionId: "runtime-durable-wait",
      instanceId: "instance-1",
      startedAt: "2026-09-12T00:00:00.000Z",
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 2_147_483_647 });
    const consumed: string[] = [],
      active = { dispatchId, durableOutputCount: 0 },
      context = {
        input: { rootDir },
        consumeLine: async (_active: unknown, line: string) => {
          consumed.push(line);
        },
      };
    const draining = consumeDurableOutput(context as never, active as never, 2_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(consumed, []);
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "provider_event", event: { seq: 1 } });
    await draining;
    assert.deepEqual(consumed, ['{"seq":1}']);
    active.durableOutputCount = consumed.length;
    await consumeDurableOutput(context as never, active as never);
    assert.deepEqual(consumed, ['{"seq":1}'], "an already-counted record is never consumed twice");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("durable drains do not wait when no process record shows the worker running", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-durable-no-wait-"));
  try {
    const dispatchId = "dispatch_f1a2b3c4d5e60718293a4b5c",
      consumed: string[] = [],
      context = {
        input: { rootDir },
        consumeLine: async (_active: unknown, line: string) => {
          consumed.push(line);
        },
      };
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: null,
      executionId: null,
      runtimeSessionId: "runtime-durable-no-wait",
      instanceId: "instance-1",
      startedAt: "2026-09-12T00:00:00.000Z",
    });
    const startedAt = Date.now();
    await consumeDurableOutput(context as never, { dispatchId, durableOutputCount: 0 } as never, 2_000);
    assert.ok(Date.now() - startedAt < 1_000, "a stream without a running worker must not poll its budget away");
    assert.deepEqual(consumed, []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
