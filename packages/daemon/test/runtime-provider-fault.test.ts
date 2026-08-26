// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";
import { classifyRuntimeExit, observeProviderFault, providerFaultFromFrame } from "../src/runtime-provider-fault.ts";

test("structured provider errors classify rate limits, server faults, quota, model, and auth failures", () => {
  assert.equal(
    providerFaultFromFrame("codex", {
      type: "turn.failed",
      error: { http_status: 429, code: "rate_limit", message: "request throttled" },
    })?.code,
    "rate_limited",
  );
  assert.equal(
    providerFaultFromFrame("claude", {
      type: "result",
      api_error_status: 503,
      error: "upstream unavailable",
      result: "upstream unavailable",
    })?.code,
    "server_error",
  );
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

test("attempt-bound classification falls back only before tools or for recognized provider faults", () => {
  assert.equal(classifyRuntimeExit(active({ toolCallObserved: false }), 1).classification, "provider_fault");
  assert.equal(
    classifyRuntimeExit(active({ toolCallObserved: false, providerOutcome: "failed" }), 0).classification,
    "provider_fault",
  );
  assert.equal(classifyRuntimeExit(active({ toolCallObserved: true }), null).classification, "provider_fault");
  assert.equal(classifyRuntimeExit(active({ toolCallObserved: true }), 1).classification, "gate_red");
  assert.equal(
    classifyRuntimeExit(
      active({
        toolCallObserved: true,
        providerFault: { code: "rate_limited", reason: "structured 429" },
      }),
      1,
    ).classification,
    "provider_fault",
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
  assert.equal(classifyRuntimeExit(active({ providerOutcome: "succeeded" }), 0).classification, "worker_stop");
  assert.equal(
    classifyRuntimeExit(active({ cancelRequested: true, toolCallObserved: false }), 1).classification,
    "worker_stop",
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
    ...overrides,
  } as ActiveRuntime;
}
