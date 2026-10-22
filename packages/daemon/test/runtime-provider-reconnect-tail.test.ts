// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createActiveRuntime } from "../src/runtime-spawn-active.ts";
import { classifyRuntimeExit, observeProviderFault } from "../src/runtime-provider-fault.ts";
import { parseProviderFrame } from "../src/runtime-spawn-provider-frames.ts";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";

// Event skeletons of six real Codex dispatches (2026-10-21/22), reduced to the frames that carry
// evidence: reconnects, tool outcomes, agent messages, turn boundaries. Text is gone; only the
// provider's own reconnect counter and the shape of the tail are kept, so this fixture proves the
// classification and nothing about the words the model wrote.
type SkeletonFrame =
  | { readonly kind: "thread.started" }
  | { readonly kind: "turn.started" }
  | { readonly kind: "turn.completed" }
  | { readonly kind: "reconnect"; readonly message: string }
  | { readonly kind: "agent_message" }
  | { readonly kind: "tool"; readonly ok: number; readonly failed: number };

const okTool = (count: number): SkeletonFrame[] =>
  Array.from({ length: count }, () => ({ kind: "tool" as const, ok: 1, failed: 0 }));
const failedTool = (count: number): SkeletonFrame[] =>
  Array.from({ length: count }, () => ({ kind: "tool" as const, ok: 0, failed: 1 }));
const reconnect = (message: string): SkeletonFrame => ({ kind: "reconnect", message });
const busy = reconnect(
  "Reconnecting... 1/5 (stream disconnected before completion: The service is busy. Please retry later.)",
);
const overloaded = (attempt: number): SkeletonFrame =>
  reconnect(
    `Reconnecting... ${String(attempt)}/5 (stream disconnected before completion: Our servers are currently overloaded. Please try again later.)`,
  );

const samples: Record<
  string,
  {
    readonly frames: readonly SkeletonFrame[];
    readonly before: "worker_stop";
    readonly after: "provider_fault" | "worker_stop";
    readonly note: string;
  }
> = {
  // Four positives: the provider exhausted or drained its reconnect budget, then the attempt
  // closed after 0-1 tool calls. The last message claims the workspace is unreachable; the
  // classification never reads that text.
  "670215fc": {
    frames: [
      { kind: "thread.started" },
      { kind: "turn.started" },
      { kind: "agent_message" },
      ...okTool(40),
      busy,
      { kind: "agent_message" },
      ...okTool(1),
      busy,
      overloaded(2),
      overloaded(3),
      overloaded(4),
      overloaded(5),
      { kind: "agent_message" },
      { kind: "turn.completed" },
    ],
    before: "worker_stop",
    after: "provider_fault",
    note: "5/5 reconnect budget drained, then a final message",
  },
  f9e35de8: {
    frames: [
      { kind: "thread.started" },
      { kind: "turn.started" },
      ...okTool(12),
      busy,
      { kind: "agent_message" },
      ...okTool(8),
      ...failedTool(1),
      { kind: "agent_message" },
      ...okTool(6),
      overloaded(2),
      overloaded(3),
      ...okTool(1),
      busy,
      { kind: "agent_message" },
      { kind: "turn.completed" },
    ],
    before: "worker_stop",
    after: "provider_fault",
    note: "11 reconnects across the attempt; none recovered before the tail",
  },
  "4298b3f7": {
    frames: [
      { kind: "thread.started" },
      { kind: "turn.started" },
      ...okTool(9),
      busy,
      { kind: "agent_message" },
      ...okTool(2),
      busy,
      { kind: "agent_message" },
      { kind: "turn.completed" },
    ],
    before: "worker_stop",
    after: "provider_fault",
    note: "file_change-shaped successes then an unrecovered reconnect",
  },
  "8546206f": {
    frames: [
      { kind: "thread.started" },
      { kind: "turn.started" },
      ...okTool(11),
      { kind: "agent_message" },
      ...okTool(5),
      busy,
      { kind: "agent_message" },
      { kind: "turn.completed" },
    ],
    before: "worker_stop",
    after: "provider_fault",
    note: "single reconnect immediately before the final message",
  },
  // Negative: the attempt recovered after its last reconnect and ran 285 tool calls, so its
  // stop is the worker's own and must keep the original classification.
  c6f6af02: {
    frames: [
      { kind: "thread.started" },
      { kind: "turn.started" },
      ...okTool(20),
      busy,
      ...okTool(30),
      reconnect("Reconnecting... 1/5 (stream disconnected before completion: Upstream HTTP/2 stream failed)"),
      ...okTool(40),
      reconnect("Reconnecting... 1/5 (stream disconnected before completion: Upstream HTTP/2 stream failed)"),
      ...okTool(285),
      { kind: "agent_message" },
      { kind: "turn.completed" },
    ],
    before: "worker_stop",
    after: "worker_stop",
    note: "285 successful tools after the last reconnect",
  },
  // Negative: no reconnect at all, zero tools, one message. Nothing marks the tail as upstream.
  a884b00a: {
    frames: [
      { kind: "thread.started" },
      { kind: "turn.started" },
      { kind: "agent_message" },
      { kind: "turn.completed" },
    ],
    before: "worker_stop",
    after: "worker_stop",
    note: "no reconnect, zero tool calls",
  },
};

test("six real Codex samples reclassify only the drained-reconnect tails", () => {
  for (const [id, sample] of Object.entries(samples)) {
    const runtime = replay(sample.frames),
      before = classifyRuntimeExit(withoutReconnectEvidence(runtime), 0),
      after = classifyRuntimeExit(runtime, 0);
    assert.equal(before.classification, sample.before, `${id}: pre-change classification (${sample.note})`);
    assert.equal(after.classification, sample.after, `${id}: post-change classification (${sample.note})`);
    if (sample.after === "provider_fault") {
      assert.match(after.reason, /reconnected/u, id);
      assert.match(after.reason, /without a successful tool call/u, id);
      assert.equal(runtime.providerFault, null, `${id}: the reconnect tail invents no provider fault frame`);
    } else {
      assert.equal(runtime.providerFault, null, `${id}: no provider fault may be invented for a negative sample`);
      assert.equal(after.reason, before.reason, `${id}: a negative sample keeps its byte-identical reason`);
    }
  }
});

/** The same attempt without the new witness: what classification returned before this change. */
function withoutReconnectEvidence(runtime: ActiveRuntime): ActiveRuntime {
  return {
    ...runtime,
    providerReconnectCount: 0,
    lastProviderReconnect: null,
    successfulToolCallAfterReconnect: false,
    finalAgentMessageAfterReconnect: false,
  };
}

test("the reclassifying reason names the reconnect count and the last provider diagnostic", () => {
  const runtime = replay(samples["670215fc"]!.frames),
    result = classifyRuntimeExit(runtime, 0);
  assert.match(result.reason, /reconnected 6 time\(s\)/u);
  assert.match(result.reason, /5\/5/u);
  assert.match(result.reason, /Our servers are currently overloaded\. Please try again later\./u);
  assert.equal(result.outcome, "stopped", "a drained reconnect keeps the stopped outcome, only the class moves");
});

test("a successful tool call after the last reconnect keeps the worker stop", () => {
  const frames: SkeletonFrame[] = [
      { kind: "thread.started" },
      busy,
      ...okTool(1),
      { kind: "agent_message" },
      { kind: "turn.completed" },
    ],
    result = classifyRuntimeExit(replay(frames), 0);
  assert.equal(result.classification, "worker_stop");
});

test("a failed tool call after the last reconnect does not prove recovery", () => {
  const frames: SkeletonFrame[] = [
      { kind: "thread.started" },
      busy,
      ...failedTool(1),
      { kind: "agent_message" },
      { kind: "turn.completed" },
    ],
    result = classifyRuntimeExit(replay(frames), 0);
  assert.equal(result.classification, "provider_fault");
});

test("a reconnect after which the attempt never answers is not a drained tail", () => {
  const frames: SkeletonFrame[] = [{ kind: "thread.started" }, busy, { kind: "turn.completed" }],
    result = classifyRuntimeExit(replay(frames), 0);
  assert.equal(result.classification, "worker_stop");
});

test("reconnect frames stay provider events, never provider faults", () => {
  const frame = parseProviderFrame("codex", {
    type: "error",
    message: "Reconnecting... 2/5 (stream disconnected before completion: Our servers are currently overloaded.)",
  });
  assert.deepEqual(frame.providerReconnect, {
    attempt: 2,
    limit: 5,
    diagnostic: "Reconnecting... 2/5 (stream disconnected before completion: Our servers are currently overloaded.)",
  });
  assert.equal(frame.providerFault, undefined, "a reconnect is transport progress, not a terminal fault");
  assert.equal(
    parseProviderFrame("codex", { type: "error", message: "stream disconnected before completion" }).providerReconnect,
    undefined,
    "only the provider's own Reconnecting frame carries the budget",
  );
  assert.equal(
    parseProviderFrame("claude", { type: "error", message: "Reconnecting... 1/5 (x)" }).providerReconnect,
    undefined,
    "the budget frame is Codex's protocol",
  );
});

/** Feeds the skeleton through the same parse and observation entry points the daemon uses. */
function replay(frames: readonly SkeletonFrame[]): ActiveRuntime {
  const runtime = createActiveRuntime({
    runtimeSessionId: "runtime_reconnect0000000000000000",
    dispatchId: "dispatch_reconnect00000000000000",
    dispatchOpId: "dispatch-op-reconnect",
    instanceId: "codex-a",
    kindId: "codex",
    resolvedProviderDirectory: null,
    model: "gpt-5",
    reasoningEffort: null,
    fast: false,
    cwd: "/tmp",
    prompt: "reconnect fixture",
    startedAt: "2026-10-22T00:00:00.000Z",
    binding: {} as never,
    process: {} as never,
    stream: { appendProviderEvent: () => undefined } as never,
  });
  for (const frame of frames) for (const value of valuesOf(frame)) observe(runtime, value);
  return runtime;
}

function observe(runtime: ActiveRuntime, value: Record<string, unknown>): void {
  const parsed = parseProviderFrame("codex", value);
  if (parsed.finalText !== undefined) runtime.finalText = parsed.finalText;
  if (parsed.failureText !== undefined) runtime.failureText = parsed.failureText;
  if (parsed.outcome) runtime.providerOutcome = parsed.outcome;
  observeProviderFault(runtime, parsed);
}

function valuesOf(frame: SkeletonFrame): readonly Record<string, unknown>[] {
  if (frame.kind === "reconnect") {
    // The parser must see the real wire frame: a reconnect arrives as a plain error event.
    return [{ type: "error", message: frame.message }];
  }
  if (frame.kind === "tool") {
    return [
      ...Array.from({ length: frame.ok }, () => ({
        type: "item.completed",
        item: { id: "tool", type: "command_execution", status: "completed", exit_code: 0 },
      })),
      ...Array.from({ length: frame.failed }, () => ({
        type: "item.completed",
        item: { id: "tool", type: "command_execution", status: "failed", exit_code: 1 },
      })),
    ];
  }
  if (frame.kind === "agent_message")
    return [{ type: "item.completed", item: { id: "message", type: "agent_message", text: "sample tail" } }];
  if (frame.kind === "turn.completed") return [{ type: "turn.completed", usage: { input_tokens: 1 } }];
  if (frame.kind === "thread.started") return [{ type: "thread.started", thread_id: "reconnect-session" }];
  return [{ type: "turn.started" }];
}
