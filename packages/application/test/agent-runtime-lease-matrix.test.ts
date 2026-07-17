// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { runtimeLeaseObservationMatrix } from "../src/agent-runtime-liveness.ts";

test("task lease and process witness remain orthogonal across their full matrix", () => {
  assert.deepEqual(runtimeLeaseObservationMatrix(), [
    { lease: "active", process: "alive" },
    { lease: "active", process: "exited" },
    { lease: "orphan", process: "alive" },
    { lease: "orphan", process: "exited" }
  ]);
});
