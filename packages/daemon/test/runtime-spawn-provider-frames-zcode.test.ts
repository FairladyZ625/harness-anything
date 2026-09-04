// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseProviderFrame, parseZcodeFrame } from "../src/runtime-spawn-provider-frames.ts";

test("ZCode terminal result maps response and the pending-sample success candidate", () => {
  const frame = {
    type: "result",
    sessionId: "zcode-session",
    response: "OK",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  assert.deepEqual(parseZcodeFrame(frame, frame.sessionId), { finalText: "OK", outcome: "succeeded" });
  assert.deepEqual(parseProviderFrame("zcode" as never, frame), {
    finalText: "OK",
    outcome: "succeeded",
    sessionIdentity: {
      runtime: "zcode",
      sessionId: "zcode-session",
      transcriptReachability: "dispatch_stream_only",
    },
  });
});

test("ZCode terminal error maps failure; live samples will calibrate this candidate rule", () => {
  assert.deepEqual(
    parseZcodeFrame(
      { type: "result", sessionId: "zcode-session", response: "failure", error: "not ready" },
      "zcode-session",
    ),
    { finalText: "failure", outcome: "failed", failureText: "not ready" },
  );
});

test("ZCode frames without sessionId are rejected", () => {
  assert.throws(() => parseZcodeFrame({ type: "ModelStreaming" }, null), /incomplete/u);
});

test("ZCode success candidates require usage until a live sample calibrates the terminal contract", () => {
  assert.throws(
    () => parseZcodeFrame({ type: "result", sessionId: "zcode-session", response: "OK" }, "zcode-session"),
    /incomplete/u,
  );
});
