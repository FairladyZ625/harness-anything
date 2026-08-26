// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { runtimeBatchTaskDispatchSettled } from "../src/cli-runtime-batch.ts";

test("runtime batch records a released task only after the dispatch reaches its final terminal attempt", () => {
  assert.equal(
    runtimeBatchTaskDispatchSettled({
      ok: false,
      outcome: "op_rejected",
      code: "daemon_gone",
      runtimeSessionId: "runtime-still-running",
      lastKnownDispatch: { status: "running" },
    }),
    false,
  );
  assert.equal(
    runtimeBatchTaskDispatchSettled({
      ok: true,
      outcome: "failed",
      runtimeSessionId: "runtime-fallback-scheduled",
      session: {
        attemptChain: {
          attempts: [{ runtimeSessionId: "runtime-fallback-scheduled", fallbackState: "scheduled" }],
        },
      },
    }),
    false,
  );
  assert.equal(
    runtimeBatchTaskDispatchSettled({
      ok: true,
      outcome: "succeeded",
      runtimeSessionId: "runtime-terminal",
      session: {
        attemptChain: { attempts: [{ runtimeSessionId: "runtime-terminal", fallbackState: null }] },
      },
    }),
    true,
  );
});
