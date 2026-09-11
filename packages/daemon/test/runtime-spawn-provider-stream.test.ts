// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createActiveRuntime } from "../src/runtime-spawn-active.ts";
import { consumeProviderChunk, consumeProviderLine } from "../src/runtime-spawn-provider-stream.ts";

function active() {
  return createActiveRuntime({
    runtimeSessionId: "runtime_aaaaaaaaaaaaaaaaaaaaaaaa",
    dispatchId: "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa",
    dispatchOpId: "dispatch-op-metrics",
    instanceId: "instance-1",
    kindId: "codex",
    model: null,
    reasoningEffort: null,
    fast: false,
    cwd: "/tmp",
    prompt: "metrics fixture",
    startedAt: "2026-09-11T00:00:00.000Z",
    binding: {} as never,
    process: {} as never,
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
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
