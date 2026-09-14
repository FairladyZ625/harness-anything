// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseDaemonRpcParams } from "../src/protocol/daemon-protocol.contract.ts";
import { validAgentRuntimeAttemptChain } from "../src/runtime-attempt-contract.ts";
import { runtimeResumeAdmission } from "../src/runtime-resume-admission.ts";

test("GUI resume spawn uses the dispatchId route", () => {
  const params = {
    repo: { repoId: "canonical" },
    payload: { dispatchId: "dispatch_0123456789abcdef01234567", idempotencyKey: "resume-from-gui" },
  };
  assert.equal(parseDaemonRpcParams("repo.agentRuntime.spawn", params).ok, true);
});

test("resume admission distinguishes resumable, missing-session, and already-resumed dispatches", () => {
  const base = {
    dispatchId: "dispatch_0123456789abcdef01234567",
    agentId: "terra",
    resumedDispatches: new Map<string, string>(),
  } as const;
  assert.deepEqual(runtimeResumeAdmission({ ...base, providerSessionId: "provider-session" }), {
    resumable: true,
    dispatchId: base.dispatchId,
    agentId: "terra",
  });
  assert.deepEqual(runtimeResumeAdmission({ ...base, providerSessionId: null }), {
    resumable: false,
    reason: "missing_provider_session",
  });
  assert.deepEqual(
    runtimeResumeAdmission({
      ...base,
      providerSessionId: "provider-session",
      resumedDispatches: new Map([[base.dispatchId, "dispatch_fedcba987654321001234567"]]),
    }),
    { resumable: false, reason: "already_resumed", resumedDispatchId: "dispatch_fedcba987654321001234567" },
  );
});

test("runtime session attempt chains accept the canonical dispatch resume projection", () => {
  const attempt = {
    dispatchId: "dispatch_0123456789abcdef01234567",
    runtimeSessionId: "runtime-session",
    attemptIndex: 0,
    provider: { instance: "builder", model: "gpt-5" },
    classification: "provider_quota",
    reason: "quota exhausted",
    resume: { dispatchId: "dispatch_0123456789abcdef01234567", agentId: "sol" },
    fallbackState: null,
    nextDispatchId: null,
  };
  assert.equal(validAgentRuntimeAttemptChain({ attemptGroupId: attempt.dispatchId, attempts: [attempt] }), true);
  assert.equal(
    validAgentRuntimeAttemptChain({
      attemptGroupId: attempt.dispatchId,
      attempts: [{ ...attempt, undeclared: true }],
    }),
    false,
  );
});
