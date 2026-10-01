// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";

test("runner daemon-owner fixture finds its own process named as the daemon owner when explicitly enabled", () => {
  if (process.env.HARNESS_RUNNER_DAEMON_OWNER_FIXTURE !== "1") return;
  assert.equal(process.env.HARNESS_DAEMON_OWNER_PID, String(process.pid));
});
