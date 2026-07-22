// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDaemonDeploymentCheck } from "../src/commands/daemon/deployment-check.ts";

test("deployment check turns daemon drift into a failing receipt with executable next steps", () => {
  const result = evaluateDaemonDeploymentCheck({
    service: { deployment: { healthy: false, failures: ["artifact-drift", "supervision-unverified"] } }
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, ["artifact-drift", "supervision-unverified"]);
  assert.match(result.nextSteps[0]!, /npm run build/u);
  assert.match(result.nextSteps[1]!, /ha daemon install-templates/u);
});

test("old daemon without deployment fields degrades to an upgrade instruction", () => {
  const result = evaluateDaemonDeploymentCheck({ service: { started: true, pid: 42 } });
  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, ["deployment-identity-capability-unavailable"]);
  assert.match(result.nextSteps[0]!, /ha daemon upgrade/u);
});
