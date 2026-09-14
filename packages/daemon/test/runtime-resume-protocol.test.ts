// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseDaemonRpcParams } from "../src/protocol/daemon-protocol.contract.ts";
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
