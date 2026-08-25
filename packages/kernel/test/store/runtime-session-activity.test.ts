// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { runtimeSessionInActivityWindow, runtimeSessionIsRunning } from "../../src/domain/agent-runtime.ts";

test("runtime session activity keeps active work and bounds settled history", () => {
  const since = "2026-08-25T12:00:00.000Z";
  assert.equal(
    runtimeSessionInActivityWindow(
      { liveness: "live", outcome: null, lastObservedAt: "2026-08-01T00:00:00.000Z" },
      since,
    ),
    true,
  );
  assert.equal(
    runtimeSessionInActivityWindow(
      { liveness: "exited", outcome: "succeeded", lastObservedAt: "2026-08-26T00:00:00.000Z" },
      since,
    ),
    true,
  );
  assert.equal(
    runtimeSessionInActivityWindow(
      { liveness: "exited", outcome: "failed", lastObservedAt: "2026-08-24T00:00:00.000Z" },
      since,
    ),
    false,
  );
  assert.equal(runtimeSessionIsRunning({ liveness: "live", outcome: null }), true);
  assert.equal(runtimeSessionIsRunning({ liveness: "live", outcome: "cancelled" }), false);
  assert.throws(
    () => runtimeSessionInActivityWindow({ liveness: "exited", outcome: null, lastObservedAt: since }, "invalid"),
    /ISO timestamp/u,
  );
});
