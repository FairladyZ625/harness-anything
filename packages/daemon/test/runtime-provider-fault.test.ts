// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";
import { classifyRuntimeExit, observeProviderFault, providerFaultFromFrame } from "../src/runtime-provider-fault.ts";

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

test("claude api_error 429 preserves quota classification and reset header", () => {
  const fault = providerFaultFromFrame("claude", {
    type: "result",
    api_error_status: 429,
    error: "insufficient_quota",
    result: "Your credit balance is exhausted",
    headers: { "x-ratelimit-reset": "2026-09-06T01:02:03Z" },
  });
  assert.equal(fault?.faultClass, "quota_exhausted");
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
  assert.equal(fault?.resetAt, "2026-09-06T04:05:06.000Z");
});

test("attempt-bound classification falls back only before tools or for recognized provider faults", () => {
  assert.deepEqual(pick(classifyRuntimeExit(active({ toolCallObserved: false }), 1)), {
    outcome: "failed",
    classification: "provider_fault",
  });
  assert.deepEqual(pick(classifyRuntimeExit(active({ toolCallObserved: false, providerOutcome: "failed" }), 0)), {
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
  const succeeded = classifyRuntimeExit(active({ providerOutcome: "succeeded" }), 0);
  assert.deepEqual(pick(succeeded), { outcome: "succeeded", classification: "worker_stop" });
  assert.match(succeeded.reason, /successfully/u);
  const descendantsAlive = classifyRuntimeExit(active({ descendantsAlive: true } as Partial<ActiveRuntime>), 0);
  assert.deepEqual(pick(descendantsAlive), { outcome: "unknown", classification: "worker_stop" });
  assert.match(descendantsAlive.reason, /descendant processes are still running/u);
  const worktreeDirty = classifyRuntimeExit(active({ worktreeDirty: true } as Partial<ActiveRuntime>), 0);
  assert.deepEqual(pick(worktreeDirty), { outcome: "unknown", classification: "worker_stop" });
  assert.match(worktreeDirty.reason, /uncommitted changes/u);
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
