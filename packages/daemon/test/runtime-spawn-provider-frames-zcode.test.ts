// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseProviderFrame, parseZcodeFrame } from "../src/runtime-spawn-provider-frames.ts";

// Frames below are trimmed from real zcode 0.16.5 headless runs (2026-09-05, `--output-format stream-json`).
const sessionId = "sess_f02d106e-527b-4896-b179-90c6c59627dd";

test("ZCode result frame maps response and usage to a succeeded outcome", () => {
  const frame = {
    type: "result",
    sessionId,
    traceId: "211dcb20-eb31-4991-88eb-85618331d65a",
    turnId: "turn_abf15985-09cb-40eb-817e-1bdc774c999c",
    response: "pong",
    usage: { source: "provider", modelRequestCount: 1, inputTokens: 16995, outputTokens: 3, totalTokens: 16998 },
    eventCount: 11,
    projection: { status: "idle", turnCount: 1, totalTokenCount: 16998, contextUsed: 16998, contextWindow: 1000000 },
  };
  assert.deepEqual(parseZcodeFrame(frame, sessionId), { finalText: "pong", outcome: "succeeded" });
  assert.deepEqual(parseProviderFrame("zcode" as never, frame), {
    finalText: "pong",
    outcome: "succeeded",
    sessionIdentity: { runtime: "zcode", sessionId, transcriptReachability: "dispatch_stream_only" },
  });
});

test("ZCode turn.failed maps the provider error message to a failed outcome (no result frame follows)", () => {
  assert.deepEqual(
    parseZcodeFrame(
      {
        type: "turn.failed",
        sessionId,
        payload: {
          error: {
            type: "unknown_error",
            code: "1214",
            message: "[1214][modelCode：不存在][202609050735186a34d858a4cc4fbf]",
            attribution: { source: "provider", reason: "invalid_request", statusCode: 400, retryable: false },
          },
          turnPhase: "processing_input",
        },
      },
      sessionId,
    ),
    { outcome: "failed", failureText: "[1214][modelCode：不存在][202609050735186a34d858a4cc4fbf]" },
  );
});

test("ZCode model.streaming deltas and tool calls become native signals", () => {
  assert.deepEqual(
    parseZcodeFrame({ type: "model.streaming", sessionId, payload: { kind: "text_delta", delta: "pong" } }, sessionId),
    { signals: [{ type: "activity", activity: "message", content: "pong" }] },
  );
  const toolCall = {
    assistantMessageId: "msg_mtnlb7a6",
    delta: "",
    done: false,
    input: { file_path: "/tmp/hello.txt", content: "hi\n" },
    kind: "tool_call",
    toolCallId: "call_f1e4fa1054134254841c4f20",
    toolName: "Write",
  };
  assert.deepEqual(parseZcodeFrame({ type: "model.streaming", sessionId, payload: toolCall }, sessionId), {
    signals: [{ type: "activity", activity: "tool", content: JSON.stringify(toolCall) }],
    toolCallObserved: true,
    writeItemObserved: true,
  });
  assert.equal(
    parseZcodeFrame({ type: "model.streaming", sessionId, payload: { ...toolCall, toolName: "Read" } }, sessionId)
      .writeItemObserved,
    false,
  );
  assert.deepEqual(parseZcodeFrame({ type: "model.streaming", sessionId, payload: { kind: "start" } }, sessionId), {});
  assert.deepEqual(parseZcodeFrame({ type: "session.updated", sessionId, payload: {} }, sessionId), {});
});

test("ZCode frames without sessionId are rejected", () => {
  assert.throws(() => parseZcodeFrame({ type: "turn.started" }, null), /incomplete/u);
});

test("ZCode result frames without response or usage are incomplete", () => {
  assert.throws(() => parseZcodeFrame({ type: "result", sessionId, response: "OK" }, sessionId), /incomplete/u);
  assert.throws(() => parseZcodeFrame({ type: "result", sessionId, usage: {} }, sessionId), /incomplete/u);
});
