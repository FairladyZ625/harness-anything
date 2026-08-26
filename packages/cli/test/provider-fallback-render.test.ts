// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { renderDispatchRow } from "../src/cli-render.ts";
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
