// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";
import { isProviderFailureClassification } from "../src/runtime-fallback-contract.ts";
import {
  classifyRuntimeExit,
  observeProviderFault,
  providerFaultFromFrame,
  providerFaultFromStderr,
} from "../src/runtime-provider-fault.ts";
import { parseCodexFrame, parseProviderFrame } from "../src/runtime-spawn-provider-frames.ts";

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

test("request_unavailable is retryable only before tool activity; other startup errors stay task failures", () => {
  const fault = providerFaultFromFrame("codex", {
      type: "turn.failed",
      error: { code: "request_unavailable" },
    }),
    structuredDiagnostic = JSON.stringify({ error: { code: "request_unavailable" } });

  assert.equal(fault?.code, "request_unavailable");
  assert.equal(classifyRuntimeExit(active({ providerFault: fault }), 1).classification, "provider_fault");
  assert.equal(
    classifyRuntimeExit(active({ providerFault: fault, toolCallObserved: true }), 1).classification,
    "gate_red",
    "the startup-only error must not retry after tool activity",
  );
  assert.equal(
    providerFaultFromStderr("codex", structuredDiagnostic)?.code,
    "request_unavailable",
    "the structured error in a drained diagnostic must enter the same retry path",
  );
  assert.equal(
    classifyRuntimeExit(
      active({
        providerOutcome: "failed",
        failureText: "invalid_request: malformed prompt",
        providerFault: providerFaultFromFrame("codex", {
          type: "turn.failed",
          error: { code: "invalid_request", message: "malformed prompt" },
        }),
      }),
      1,
    ).classification,
    "gate_red",
    "non-transient request validation errors do not retry",
  );
});

// Measured on instance devin-main (2026-09-18~19): the ACP provider reported
// `Connection error, send a message to continue retrying` after the upstream connection dropped.
// A turn that never reached a tool call is a transport failure, not a task verdict
// (dec_FCD38D503B0C0752B83A417246 CH2); once a tool has run, the attempt may have changed the
// workspace and must not be replayed on the next provider.
test("connection loss retries before tool activity and stays a task failure after it", () => {
  const diagnostic = "Connection error, send a message to continue retrying",
    frameFault = providerFaultFromFrame("devin", { type: "acp.error", message: diagnostic }),
    stderrFault = providerFaultFromStderr("devin", diagnostic),
    beforeTool = classifyRuntimeExit(
      active({
        kindId: "devin",
        providerOutcome: "failed",
        failureText: diagnostic,
        providerFault: frameFault,
      }),
      1,
    ),
    afterTool = classifyRuntimeExit(
      active({
        kindId: "devin",
        providerOutcome: "failed",
        failureText: diagnostic,
        providerFault: frameFault,
        toolCallObserved: true,
      }),
      1,
    );

  assert.equal(frameFault?.code, "provider_disconnected");
  assert.equal(stderrFault?.code, "provider_disconnected");
  assert.equal(frameFault?.reason, diagnostic);
  assert.equal(beforeTool.outcome, "failed");
  assert.equal(beforeTool.classification, "provider_fault");
  assert.equal(afterTool.outcome, "failed");
  assert.equal(afterTool.classification, "gate_red");
  assert.equal(afterTool.reason, diagnostic);
});

test("the connection-failure family covers transport wording but not task refusals", () => {
  for (const diagnostic of [
    "Connection error, send a message to continue retrying",
    "connection reset by peer",
    "read ECONNRESET",
    "socket hang up",
    "Failed to connect to upstream",
    "network is unreachable",
    "transport error",
  ])
    assert.equal(providerFaultFromStderr("devin", diagnostic)?.code, "provider_disconnected", diagnostic);
  for (const refusal of [
    "Connection metadata is missing from the workspace",
    "Connection established; the request returned no content",
    "DeepSeek Messages request failed (404)",
  ])
    assert.equal(providerFaultFromStderr("devin", refusal), null, refusal);
});

// A connection diagnostic can also contain the capacity, broken-stream, or HTTP wording that older
// rules match first. The no-replay rule must follow the connection cause, not whichever regex ran
// first: post-tool the attempt may have left work behind, so it stays gate_red. Pure capacity and
// pure stream diagnostics keep their existing provider_fault semantics.
test("connection failures overlapping capacity, stream, or HTTP rules keep the post-tool no-replay guard", () => {
  const overlaps = [
    ["capacity", "Connection error, please try again later"],
    ["stream", "stream disconnected: connection reset by peer"],
  ];
  for (const [family, diagnostic] of overlaps) {
    const fault = providerFaultFromFrame("devin", { type: "acp.error", message: diagnostic }),
      beforeTool = classifyRuntimeExit(
        active({ kindId: "devin", providerOutcome: "failed", failureText: diagnostic, providerFault: fault }),
        1,
      ),
      afterTool = classifyRuntimeExit(
        active({
          kindId: "devin",
          providerOutcome: "failed",
          failureText: diagnostic,
          providerFault: fault,
          toolCallObserved: true,
        }),
        1,
      );
    assert.equal(fault?.code, "provider_disconnected", family);
    assert.equal(beforeTool.classification, "provider_fault", family);
    assert.equal(afterTool.classification, "gate_red", family);
  }

  const httpOverlap = providerFaultFromFrame("codex", {
      type: "turn.failed",
      error: { http_status: 500, message: "connection reset by peer" },
    }),
    httpBeforeTool = classifyRuntimeExit(
      active({ providerOutcome: "failed", providerFault: httpOverlap, errorBuffer: "connection reset by peer" }),
      1,
    ),
    httpAfterTool = classifyRuntimeExit(
      active({
        providerOutcome: "failed",
        providerFault: httpOverlap,
        toolCallObserved: true,
        errorBuffer: "connection reset by peer",
      }),
      1,
    );
  assert.equal(httpOverlap?.code, "provider_disconnected");
  assert.equal(httpBeforeTool.classification, "provider_fault");
  assert.equal(httpAfterTool.classification, "gate_red");

  for (const diagnostic of ["service is busy; please try again later", "stream disconnected before completion"]) {
    const fault = providerFaultFromFrame("codex", { type: "turn.failed", error: { message: diagnostic } }),
      afterTool = classifyRuntimeExit(
        active({ providerOutcome: "failed", failureText: diagnostic, providerFault: fault, toolCallObserved: true }),
        1,
      );
    assert.equal(fault?.code, "server_error", diagnostic);
    assert.equal(afterTool.classification, "provider_fault", diagnostic);
  }
});

// A connection diagnostic can also arrive beside a 429 or quota/rate-limit wording. Those classes
// are checked before the connection family elsewhere, and `provider_quota` is fallback-eligible, so
// letting them win would replay an attempt that may already have called a tool. The connection
// cause therefore outranks them; pure quota/rate-limit diagnostics keep their existing class.
test("connection failures overlapping quota or rate-limit keep the post-tool no-replay guard", () => {
  const overlaps: [string, Record<string, unknown>][] = [
    ["429", { http_status: 429, message: "Connection error, send a message to continue retrying" }],
    ["rate-limit text", { message: "Connection error, send a message to continue retrying: too many requests" }],
    ["quota text", { message: "Connection error, send a message to continue retrying: quota exceeded" }],
  ];
  for (const [family, error] of overlaps) {
    const fault = providerFaultFromFrame("codex", { type: "turn.failed", error }),
      beforeTool = classifyRuntimeExit(active({ providerOutcome: "failed", providerFault: fault }), 1),
      afterTool = classifyRuntimeExit(
        active({ providerOutcome: "failed", providerFault: fault, toolCallObserved: true }),
        1,
      );
    assert.equal(fault?.code, "provider_disconnected", family);
    assert.equal(beforeTool.classification, "provider_fault", family);
    assert.equal(isProviderFailureClassification(beforeTool.classification), true, family);
    assert.equal(afterTool.classification, "gate_red", family);
    assert.equal(isProviderFailureClassification(afterTool.classification), false, family);
  }

  const pureFaults: [string, Record<string, unknown>, string][] = [
    ["pure 429", { http_status: 429, message: "request throttled" }, "rate_limited"],
    ["pure quota", { message: "quota exceeded" }, "quota_exhausted"],
  ];
  for (const [family, error, code] of pureFaults) {
    const fault = providerFaultFromFrame("codex", { type: "turn.failed", error }),
      beforeTool = classifyRuntimeExit(active({ providerOutcome: "failed", providerFault: fault }), 1),
      afterTool = classifyRuntimeExit(
        active({ providerOutcome: "failed", providerFault: fault, toolCallObserved: true }),
        1,
      );
    assert.equal(fault?.code, code, family);
    assert.equal(beforeTool.classification, "provider_quota", family);
    assert.equal(afterTool.classification, "provider_quota", family);
  }
});

test("Codex tool item.started closes the startup retry window before item completion", () => {
  const unavailable = {
      type: "turn.failed",
      error: { code: "request_unavailable" },
    },
    commandStarted = parseProviderFrame("codex", { type: "item.started", item: { type: "command_execution" } }),
    activeAfterCommandStart = active();

  observeProviderFault(activeAfterCommandStart, commandStarted);
  observeProviderFault(activeAfterCommandStart, parseProviderFrame("codex", unavailable));
  assert.equal(activeAfterCommandStart.toolCallObserved, true);
  assert.equal(
    classifyRuntimeExit(activeAfterCommandStart, 1).classification,
    "gate_red",
    "a started tool can have side effects before completion, so request_unavailable must not retry it",
  );

  const reasoningStarted = parseProviderFrame("codex", { type: "item.started", item: { type: "reasoning" } }),
    activeAfterReasoningStart = active();
  observeProviderFault(activeAfterReasoningStart, reasoningStarted);
  observeProviderFault(activeAfterReasoningStart, parseProviderFrame("codex", unavailable));
  assert.equal(activeAfterReasoningStart.toolCallObserved, false);
  assert.equal(
    classifyRuntimeExit(activeAfterReasoningStart, 1).classification,
    "provider_fault",
    "non-tool item.started frames must leave the startup retry window open",
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

test("a bare ACP Internal error is a provider fault while a detailed refusal stays a task failure", () => {
  const providerFault = providerFaultFromFrame("deepseek-harness", { type: "acp.error", message: "Internal error" }),
    genericAcpFault = providerFaultFromFrame("devin", { type: "acp.error", message: "Internal error" }),
    result = classifyRuntimeExit(
      active({
        kindId: "deepseek-harness",
        providerOutcome: "failed",
        failureText: "Internal error",
        providerFault,
      }),
      0,
    ),
    detailedRefusal = providerFaultFromFrame("deepseek-harness", {
      type: "acp.error",
      message: "Internal error: turn failed: DeepSeek Messages expected a JSON object",
    });

  assert.equal(providerFault?.code, "server_error");
  assert.equal(genericAcpFault?.code, "server_error");
  assert.equal(result.outcome, "failed");
  assert.equal(result.classification, "provider_fault");
  assert.equal(detailedRefusal, null);
});

test("text-only provider transport failures classify for fallback without promoting malformed requests", () => {
  const deepseekDiagnostics = [
      "Internal error: turn failed: Upstream service temporarily unavailable",
      "Internal error: turn failed: Too many pending requests, please retry later",
      "Internal error: turn failed: DeepSeek Messages SSE event type mismatch",
      "Internal error: turn failed: DeepSeek Messages stream ended before message_stop",
    ],
    codexDiagnostics = [
      "stream disconnected before completion: Our servers are currently overloaded. Please try again later.",
      '{"message":"Incomplete response returned, reason: unknown"}',
    ];

  for (const diagnostic of codexDiagnostics) {
    const providerFault = providerFaultFromStderr("codex", diagnostic),
      result = classifyRuntimeExit(
        active({
          kindId: "codex",
          providerOutcome: "failed",
          failureText: diagnostic,
          ...(providerFault ? { providerFault } : {}),
        }),
        1,
      );
    assert.equal(providerFault?.code, "server_error", diagnostic);
    assert.equal(result.classification, "provider_fault", diagnostic);
  }
  for (const diagnostic of deepseekDiagnostics) {
    const providerFault = providerFaultFromFrame("deepseek-harness", { type: "acp.error", message: diagnostic }),
      result = classifyRuntimeExit(
        active({ kindId: "deepseek-harness", providerOutcome: "failed", failureText: diagnostic, providerFault }),
        1,
      );
    assert.equal(providerFault?.code, "server_error", diagnostic);
    assert.equal(result.classification, "provider_fault", diagnostic);
  }

  const codexItemFault = providerFaultFromFrame("codex", {
    type: "item.completed",
    item: { type: "error", message: "Incomplete response returned, reason: unknown" },
  });
  assert.equal(codexItemFault?.code, "server_error");
  assert.equal(
    providerFaultFromFrame("codex", {
      type: "turn.failed",
      error: { message: '{"message":"Incomplete response returned, reason: unknown"}' },
    })?.code,
    "server_error",
  );

  const zcodeQuota = providerFaultFromFrame("zcode", {
      type: "turn.failed",
      payload: {
        error: {
          code: "1308",
          message: "[1308][已达到 5 小时的使用上限。您的限额将在稍后重置。]",
          attribution: { statusCode: 429 },
        },
      },
    }),
    thinkingRequestError =
      "The `content[].thinking` in the thinking mode must be passed back to the API. (request_id: sample)",
    thinkingFault = providerFaultFromStderr("deepseek-harness", thinkingRequestError);

  assert.equal(zcodeQuota?.faultClass, "quota_exhausted");
  assert.equal(
    classifyRuntimeExit(active({ kindId: "zcode", providerOutcome: "failed", providerFault: zcodeQuota }), 1)
      .classification,
    "provider_quota",
  );
  assert.equal(thinkingFault, null);
  assert.equal(
    classifyRuntimeExit(
      active({ kindId: "deepseek-harness", providerOutcome: "failed", failureText: thinkingRequestError }),
      1,
    ).classification,
    "gate_red",
  );
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
    "completed_without_final_text",
  );
  const cleanExit = classifyRuntimeExit(active({ providerOutcome: "succeeded" }), 0);
  assert.deepEqual(pick(cleanExit), { outcome: "unknown", classification: "completed_without_final_text" });
  assert.deepEqual(
    pick(
      classifyRuntimeExit(
        active({ providerOutcome: "succeeded", toolCallObserved: true, providerUsageEmpty: true }),
        0,
      ),
    ),
    {
      outcome: "unknown",
      classification: "completed_without_final_text",
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

test("blank successful Codex turns preserve work as completed without final text", () => {
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
  assert.equal(result.outcome, "unknown");
  assert.equal(result.classification, "completed_without_final_text");
  assert.match(result.reason, /^Provider completed without final text \(/u);
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
    providerReconnectCount: 0,
    lastProviderReconnect: null,
    successfulToolCallAfterReconnect: false,
    finalAgentMessageAfterReconnect: false,
    errorOverflowed: false,
    errorBuffer: "",
    toolCallObserved: false,
    localCommandSucceeded: false,
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

// The DeepSeek Harness Messages adapter reports a broken SSE stream as `MALFORMED_RESPONSE` or
// `STREAM_CLOSED` over ACP; none of those turns produced an answer to judge, so all of them are the
// provider's fault and must switch providers rather than fail the dispatch. The diagnostics below are
// the adapter's own catalogue as measured from the installed 0.2.1-rc.2 bundle. A well-formed body it
// still refused stays a task failure: those are not transport faults.
test("every Messages stream-integrity diagnostic retries while well-formed refusals stay task failures", () => {
  const retryable = [
    "DeepSeek Messages SSE event type mismatch",
    "DeepSeek Messages SSE contains invalid JSON",
    "DeepSeek Messages stream: tool input is invalid JSON",
    "DeepSeek Messages stream: unsupported delta text_delta for tool-call",
    "DeepSeek Messages stream: delta/stop without an open block",
    "DeepSeek Messages stream: message_stop without settled blocks and stop reason",
    "DeepSeek Messages stream idle timeout",
    "DeepSeek Messages transport failed",
    "DeepSeek Messages stream ended before message_stop",
  ];
  const taskFailures = [
    "DeepSeek Messages expected a JSON object",
    "DeepSeek Messages expected a string field",
    "DeepSeek Messages returned no content",
    "DeepSeek Messages returned no response body",
    "DeepSeek Messages request aborted",
    "DeepSeek Messages request failed (404)",
  ];
  for (const diagnostic of retryable) {
    const text = `Internal error: turn failed: ${diagnostic}`,
      providerFault = providerFaultFromStderr("deepseek-harness", text),
      result = classifyRuntimeExit(
        active({ kindId: "deepseek-harness", providerOutcome: "failed", failureText: text, providerFault }),
        1,
      );
    assert.equal(providerFault?.code, "server_error", diagnostic);
    assert.equal(result.classification, "provider_fault", diagnostic);
  }
  for (const diagnostic of taskFailures) {
    const text = `Internal error: turn failed: ${diagnostic}`,
      result = classifyRuntimeExit(
        active({
          kindId: "deepseek-harness",
          providerOutcome: "failed",
          failureText: text,
          providerFault: providerFaultFromStderr("deepseek-harness", text),
        }),
        1,
      );
    assert.equal(result.classification, "gate_red", diagnostic);
  }
});
