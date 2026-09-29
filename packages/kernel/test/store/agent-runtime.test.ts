// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { runtimeSessionSemanticState } from "../../src/domain/agent-runtime.ts";

test("runtime session semantics preserve the four adjudicated liveness/outcome cases", () => {
  assert.deepEqual(
    [
      runtimeSessionSemanticState({ liveness: "live", outcome: null }),
      runtimeSessionSemanticState({ liveness: "exited", outcome: "succeeded" }),
      runtimeSessionSemanticState({ liveness: "exited", outcome: "failed" }),
      runtimeSessionSemanticState({ liveness: "exited", outcome: "cancelled" }),
      runtimeSessionSemanticState({ liveness: "exited", outcome: "unknown" }),
      runtimeSessionSemanticState({ liveness: "unknown", outcome: null }),
    ],
    ["running", "succeeded", "failed", "cancelled", "ended-indeterminate", "unavailable"],
  );
});
