// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { cliDispatchError, humanError, renderDispatchRow } from "../src/cli-render.ts";
import { renderRuntimeStatus } from "../src/cli-runtime-auth.ts";

test("task dispatch and runtime status renders expose provider attempt chains", () => {
  assert.match(
    renderDispatchRow({
      dispatchId: "dispatch-one",
      status: "failed",
      runtimeSessionId: "runtime-one",
      attemptIndex: 0,
      provider: { instance: "provider-a", model: "model-a" },
      classification: "provider_fault",
      fallbackState: "dispatched",
      reason: "429",
    }),
    /attempt:0\tprovider:provider-a\tmodel:model-a\tclassification:provider_fault\tfallback:dispatched/u,
  );
  assert.match(
    renderRuntimeStatus({
      session: {
        runtimeSessionId: "runtime-one",
        instanceId: "provider-a",
        providerSessionId: "thread-a",
        liveness: "exited",
        activity: { outcome: "failed", resultRef: "artifact:result" },
        attemptChain: {
          attemptGroupId: "attempt-one",
          attempts: [
            {
              attemptIndex: 0,
              provider: { instance: "provider-a", model: "model-a" },
              classification: "provider_fault",
              fallbackState: "dispatched",
              reason: "429",
            },
          ],
        },
      },
    }),
    /ATTEMPT\tPROVIDER\tMODEL\tCLASSIFICATION\tFALLBACK\tREASON\n0\tprovider-a\tmodel-a\tprovider_fault\tdispatched\t429/u,
  );
});

test("CLI dispatch and nested receipt errors are handled by closed tagged branches", () => {
  assert.deepEqual(
    cliDispatchError({ error: new Error("start failed"), directCode: "daemon_start_failed", timeoutCode: null }),
    { code: "daemon_start_failed", hint: "start failed" },
  );
  assert.deepEqual(cliDispatchError({ error: "deadline", directCode: null, timeoutCode: "daemon_response_timeout" }), {
    code: "daemon_response_timeout",
    hint: "Local daemon request failed. Cause: deadline",
  });
  assert.deepEqual(humanError({ code: "top", nextAction: "repair" }), { code: "top", hint: "repair" });
  assert.deepEqual(
    humanError({
      code: "squad_leader_failed",
      leader: { error: { code: "lease_conflict", hint: "release the holder" } },
    }),
    {
      code: "squad_leader_failed",
      hint: "Leader dispatch rejected: code=lease_conflict hint=release the holder",
    },
  );
});
