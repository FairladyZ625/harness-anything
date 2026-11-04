// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { fleetFrameBusinessOutcome } from "../src/fleet/center-listener.ts";

test("a delivered Fleet business rejection is not a successful outcome", () => {
  assert.deepEqual(fleetFrameBusinessOutcome({ schema: "fleet.task.result/v1", outcome: "op_rejected" }), {
    ok: false,
    code: "op_rejected",
  });
  assert.deepEqual(fleetFrameBusinessOutcome({ schema: "fleet.error/v1", code: "repo_namespace_unknown" }), {
    ok: false,
    code: "repo_namespace_unknown",
  });
  assert.deepEqual(fleetFrameBusinessOutcome({ schema: "fleet.task.result/v1", outcome: "applied" }), {
    ok: true,
    code: null,
  });
});
