// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";
import {
  classifyRuntimeExit,
  observeProviderFault,
  providerFaultFromFrame,
  providerFaultFromStderr,
} from "../src/runtime-provider-fault.ts";
import { parseCodexFrame } from "../src/runtime-spawn-provider-frames.ts";

test("structured provider errors classify rate limits, server faults, quota, model, and auth failures", () => {
  const rateLimit = providerFaultFromFrame("codex", {
      type: "turn.failed",
      error: { http_status: 429, code: "rate_limit", message: "request throttled" },
    }),
    serverError = providerFaultFromFrame("claude", {
      type: "result",
      api_error_status: 503,
      error: "upstream unavailable",
      result: "upstream unavailable",
    });
  assert.equal(rateLimit?.code, "rate_limited");
  assert.match(rateLimit?.reason ?? "", /HTTP 429.*request throttled/u);
  assert.equal(serverError?.code, "server_error");
  assert.match(serverError?.reason ?? "", /HTTP 503.*upstream unavailable/u);
  assert.equal(
    providerFaultFromFrame("agy", {
      event: "result",
      result: { code: "resource_exhausted", error: "quota exhausted" },
    })?.code,
    "quota_exhausted",
  );
  assert.equal(
    providerFaultFromFrame("codex", {
      type: "turn.failed",
      error: { code: "unknown_model", message: "model_not_found" },
    })?.code,
    "unrecognized_model",
  );
  assert.equal(
    providerFaultFromFrame("codex", {
      type: "turn.failed",
      error: { http_status: 401, message: "unauthorized" },
    })?.code,
    "auth_failed",
  );
});

test("ACP serving capacity errors remain provider faults after tool activity", () => {
  const providerFault = providerFaultFromFrame("devin", {
      type: "acp.error",
      message: "Protocol error (unimplemented): We are currently experiencing capacity issues with this serving model",
    }),
    result = classifyRuntimeExit(active({ kindId: "devin", toolCallObserved: true, providerFault }), 1);

  assert.equal(providerFault?.code, "server_error");
  assert.equal(result.classification, "provider_fault");
});

test("transient busy model service errors remain retryable provider faults", () => {
  const providerFault = providerFaultFromFrame("codex", {
      type: "turn.failed",
      error: { message: "service is busy; please try again later" },
    }),
    result = classifyRuntimeExit(active({ providerFault }), 1);

  assert.equal(providerFault?.code, "server_error");
  assert.equal(result.classification, "provider_fault");
});

test("claude api_error 429 preserves quota classification and reset header", () => {
  const fault = providerFaultFromFrame("claude", {
    type: "result",
    api_error_status: 429,
    error: "insufficient_quota",
    result: "Your credit balance is exhausted",
    headers: { "x-ratelimit-reset": "2026-09-06T01:02:03Z" },
  });
  assert.equal(fault?.faultClass, "quota_exhausted");
  assert.equal(fault?.reason, "HTTP 429: insufficient_quota Your credit balance is exhausted");
  assert.equal(fault?.resetAt, "2026-09-06T01:02:03.000Z");
});

test("codex rate_limit_exceeded preserves reset_at", () => {
  const fault = providerFaultFromFrame("codex", {
    type: "turn.failed",
    error: {
      http_status: 429,
      code: "rate_limit_exceeded",
      message: "Too many requests",
      reset_at: "2026-09-06T02:03:04Z",
    },
  });
  assert.equal(fault?.faultClass, "rate_limited");
  assert.equal(fault?.reason, "HTTP 429: rate_limit_exceeded Too many requests");
  assert.equal(fault?.resetAt, "2026-09-06T02:03:04.000Z");
});

test("agy RESOURCE_EXHAUSTED preserves epoch reset_time", () => {
  const fault = providerFaultFromFrame("agy", {
    event: "result",
    result: {
      status: "ERROR",
      response: "",
      status_code: 429,
      code: "RESOURCE_EXHAUSTED",
      error: "quota exhausted",
      reset_time: 1_788_658_985,
    },
  });
  assert.equal(fault?.faultClass, "quota_exhausted");
  assert.equal(fault?.reason, "HTTP 429: RESOURCE_EXHAUSTED quota exhausted");
  assert.equal(fault?.resetAt, "2026-09-06T01:43:05.000Z");
});

test("zcode turn.failed attribution 429 preserves retry reset", () => {
  const fault = providerFaultFromFrame("zcode", {
    type: "turn.failed",
    payload: {
      error: {
        code: "rate_limit_exceeded",
        message: "rate limit reached",
        attribution: { statusCode: 429, resetAt: "2026-09-06T04:05:06Z" },
      },
    },
  });
  assert.equal(fault?.faultClass, "rate_limited");
  assert.equal(fault?.reason, "HTTP 429: rate_limit_exceeded rate limit reached");
  assert.equal(fault?.resetAt, "2026-09-06T04:05:06.000Z");
});

// decision/dec_FCD38D503B0C0752B83A417246/CH2: unknown failures are task failures.
test("attempt-bound classification falls back only for recognized provider faults", () => {
  assert.deepEqual(pick(classifyRuntimeExit(active({ toolCallObserved: false }), 1)), {
    outcome: "failed",
    classification: "gate_red",
  });
  assert.deepEqual(pick(classifyRuntimeExit(active({ toolCallObserved: false, providerOutcome: "failed" }), 0)), {
    outcome: "failed",
    classification: "gate_red",
  });
  assert.deepEqual(pick(classifyRuntimeExit(active({ toolCallObserved: false, providerOutcome: "failed" }), null)), {
    outcome: "failed",
    classification: "provider_fault",
  });
  assert.deepEqual(pick(classifyRuntimeExit(active({ toolCallObserved: true }), null)), {
    outcome: "unknown",
    classification: "provider_fault",
  });
  assert.deepEqual(pick(classifyRuntimeExit(active({ toolCallObserved: true }), 1)), {
    outcome: "failed",
    classification: "gate_red",
  });
  assert.equal(
    classifyRuntimeExit(
      active({
        toolCallObserved: true,
        providerFault: { code: "rate_limited", reason: "structured 429" },
      }),
      1,
    ).outcome,
    "failed",
  );
  assert.equal(
    classifyRuntimeExit(
      active({
        providerOutcome: "succeeded",
        providerFault: { code: "rate_limited", reason: "transient structured 429 before retry success" },
      }),
      0,
    ).classification,
    "worker_stop",
  );
  const cleanExit = classifyRuntimeExit(active({ providerOutcome: "succeeded" }), 0);
  assert.deepEqual(pick(cleanExit), { outcome: "unknown", classification: "worker_stop" });
  assert.deepEqual(
    pick(
      classifyRuntimeExit(
        active({ providerOutcome: "succeeded", toolCallObserved: true, providerUsageEmpty: true }),
        0,
      ),
    ),
    {
      outcome: "unknown",
      classification: "worker_stop",
    },
  );
  const stopped = classifyRuntimeExit(active({ providerOutcome: "succeeded", finalText: "checkpoint reached" }), 0);
  assert.deepEqual(pick(stopped), { outcome: "stopped", classification: "worker_stop" });
  assert.deepEqual(pick(classifyRuntimeExit(active({ cancelRequested: true, toolCallObserved: false }), 1)), {
    outcome: "cancelled",
    classification: "worker_stop",
  });
  assert.deepEqual(
    pick(classifyRuntimeExit(active({ lossReason: "runtime process disappeared", toolCallObserved: true }), null)),
    { outcome: "unknown", classification: "worker_stop" },
  );
  const recovered = active({ providerFault: { code: "rate_limited", reason: "transient 429" } });
  observeProviderFault(recovered, { toolCallObserved: true });
  assert.equal(recovered.providerFault, null);
  assert.equal(classifyRuntimeExit(recovered, 1).classification, "gate_red");
});

test("agy print timeout makes an exit-zero partial turn a provider fault", () => {
  const stderr = "[agy] print timeout after 5m0s with turn in progress; returning partial output\n",
    runtime = active({
      kindId: "agy",
      providerOutcome: "succeeded",
      toolCallObserved: true,
      errorBuffer: stderr,
    }),
    fault = providerFaultFromStderr("agy", stderr),
    result = classifyRuntimeExit(runtime, 0);
  assert.equal(fault?.code, "pre_tool_exit");
  assert.equal(fault?.reason, stderr.trim());
  assert.equal(result.outcome, "failed");
  assert.equal(result.classification, "provider_fault");
  assert.equal(result.reason, stderr.trim());
});

test("blank successful Codex turns classify as provider faults", () => {
  const runtime = active({ providerOutcome: null });
  for (const frame of [
    { type: "thread.started", thread_id: "provider-session" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: " " } },
    { type: "turn.completed", usage: {} },
  ]) {
    const parsed = parseCodexFrame(frame, "provider-session");
    if (parsed.finalText !== undefined) runtime.finalText = parsed.finalText;
    if (parsed.outcome) runtime.providerOutcome = parsed.outcome;
    observeProviderFault(runtime, parsed);
  }
  const result = classifyRuntimeExit(runtime, 0);
  assert.equal(result.outcome, "failed");
  assert.equal(result.classification, "provider_fault");
  assert.equal(result.reason, "Provider completed a turn but produced no output.");
});

test("non-blank successful Codex turns remain worker stops", () => {
  const runtime = active({ providerOutcome: null });
  for (const frame of [
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "done" } },
    { type: "turn.completed", usage: {} },
  ]) {
    const parsed = parseCodexFrame(frame, "provider-session");
    if (parsed.finalText !== undefined) runtime.finalText = parsed.finalText;
    if (parsed.outcome) runtime.providerOutcome = parsed.outcome;
    observeProviderFault(runtime, parsed);
  }
  assert.equal(classifyRuntimeExit(runtime, 0).classification, "worker_stop");
});

test("missing process evidence remains unknown regardless of the loss description or final output", () => {
  for (const lossReason of [
    "runtime process was never recorded before daemon restart",
    "runtime process disappeared",
  ]) {
    const result = classifyRuntimeExit(active({ lossReason, finalText: "checkpoint reached" }), null);
    assert.equal(result.outcome, "unknown");
    assert.equal(result.classification, "worker_stop");
    assert.deepEqual(pick(classifyRuntimeExit(active({ lossReason }), 1)), {
      outcome: "failed",
      classification: "worker_stop",
    });
  }
});

test("a signaled provider exit with code zero is never classified as success", () => {
  const result = classifyRuntimeExit(
    active({
      providerOutcome: "succeeded",
      finalText: "truncated before completion",
      lossReason: "provider process terminated by SIGTERM",
    }),
    0,
  );
  assert.deepEqual(pick(result), { outcome: "stopped", classification: "worker_stop" });
});

test("observed provider fault takes precedence over a later runtime loss", () => {
  const result = classifyRuntimeExit(
    active({
      lossReason: "runtime process disappeared",
      providerFault: {
        code: "quota_exhausted",
        faultClass: "quota_exhausted",
        reason: "HTTP 429: insufficient_quota credit balance exhausted",
        resetAt: "2026-09-06T05:06:07.000Z",
      },
    }),
    null,
  );

  assert.equal(result.outcome, "failed");
  assert.equal(result.classification, "provider_quota");
  assert.equal(result.faultClass, "quota_exhausted");
  assert.equal(result.resetAt, "2026-09-06T05:06:07.000Z");
  assert.equal(result.reason, "HTTP 429: insufficient_quota credit balance exhausted");
});

function active(overrides: Partial<ActiveRuntime>): ActiveRuntime {
  return {
    dispatchId: "dispatch_0123456789abcdef01234567",
    instanceId: "provider-a",
    model: "model-a",
    kindId: "codex",
    fallbackAttempt: null,
    cancelRequested: false,
    providerFault: null,
    errorOverflowed: false,
    errorBuffer: "",
    toolCallObserved: false,
    nonEmptyAgentOutputObserved: false,
    providerUsageEmpty: false,
    providerOutcome: null,
    failureText: null,
    permissionMode: "read-only",
    protocolError: false,
    planIncomplete: false,
    planObserved: false,
    writeItemObserved: false,
    lossReason: null,
    ...overrides,
  } as ActiveRuntime;
}

function pick(value: ReturnType<typeof classifyRuntimeExit>) {
  return { outcome: value.outcome, classification: value.classification };
}

// decision/dec_FCD38D503B0C0752B83A417246/CH2: preserve provider-positive and task-negative cases.
test("task input, model and request-policy errors do not become provider failures", () => {
  const inputFailure = classifyRuntimeExit(active({ errorBuffer: "Task input file missing: mission.md" }), 1);
  assert.equal(inputFailure.classification, "gate_red");
  assert.equal(inputFailure.reason, "Task input file missing: mission.md");
  assert.equal(classifyRuntimeExit(active({ errorOverflowed: true }), 1).classification, "gate_red");
  for (const fault of [
    providerFaultFromFrame("codex", {
      type: "turn.failed",
      error: { code: "unknown_model", message: "model_not_found" },
    }),
    providerFaultFromStderr("claude", "[claude-code:unrecognized_model] invalid model"),
  ]) {
    assert.ok(fault);
    assert.equal(classifyRuntimeExit(active({ providerFault: fault }), 1).classification, "gate_red");
  }
  for (const message of ["forbidden", "content policy rejected the request", "request not permitted"]) {
    assert.equal(providerFaultFromFrame("codex", { type: "turn.failed", error: { http_status: 403, message } }), null);
  }
  assert.equal(providerFaultFromStderr("claude", "[claude-code:forbidden] content policy rejected"), null);
  assert.equal(
    providerFaultFromFrame("codex", { type: "turn.failed", error: { http_status: 403, message: "invalid API key" } })
      ?.code,
    "auth_failed",
  );
  assert.equal(
    providerFaultFromFrame("codex", { type: "turn.failed", error: { http_status: 401, message: "access denied" } })
      ?.code,
    "auth_failed",
  );
});

test("Retry-After seconds and dates decode once at observation time; absolute resets stay absolute", (t) => {
  const now = Date.parse("2026-10-11T04:00:00Z");
  t.mock.method(Date, "now", () => now);
  const fromError = (error: Record<string, unknown>) =>
    providerFaultFromFrame("codex", {
      type: "turn.failed",
      error: { http_status: 429, message: "Too many requests", ...error },
    })?.resetAt;
  for (const seconds of [120, "120", " 120 ", 0, "0", "1.5"]) {
    const expected = new Date(now + Number(seconds) * 1000).toISOString();
    assert.equal(fromError({ headers: { "retry-after": seconds } }), expected);
    assert.equal(fromError({ response_headers: { "retry-after": seconds } }), expected);
    assert.equal(fromError({ retry_after: seconds }), expected);
  }
  assert.equal(fromError({ headers: { "retry-after": "Sun, 11 Oct 2026 04:02:00 GMT" } }), "2026-10-11T04:02:00.000Z");
  for (const invalid of [-1, "-1", "garbage", "", "  ", null, false]) {
    assert.equal(fromError({ headers: { "retry-after": invalid } }), undefined);
  }
  for (const reset of [1791691320, "1791691320", 1791691320000, "1791691320000"]) {
    assert.equal(
      fromError({ headers: { "x-ratelimit-reset": reset, "retry-after": "120" } }),
      "2026-10-11T04:02:00.000Z",
    );
  }
  assert.equal(
    fromError({ reset_at: "2026-10-11T05:00:00Z", headers: { "retry-after": "120" } }),
    "2026-10-11T05:00:00.000Z",
  );
});
