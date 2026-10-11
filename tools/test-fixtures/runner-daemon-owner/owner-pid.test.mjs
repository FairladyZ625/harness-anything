// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";

test("runner daemon-owner fixture finds its own process named as the daemon owner when explicitly enabled", () => {
  if (process.env.HARNESS_RUNNER_DAEMON_OWNER_FIXTURE !== "1") return;
  assert.equal(process.env.HARNESS_DAEMON_OWNER_PID, String(process.pid));
  for (const name of ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID"])
    assert.equal(process.env[name], undefined, `${name} belongs to the invoking worker, not a test actor`);
});
