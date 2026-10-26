// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The daemon user root an unconfigured fixture reaches: every resolver falls back to
// `<home>/.harness`. HARNESS_RUNNER_OPERATOR_HOME stands in for the operator's home and is created
// empty by the test that invokes this fixture, so anything appearing under it came from this child.
test("runner home-isolation fixture resolves the daemon user root inside a private home", () => {
  if (process.env.HARNESS_RUNNER_HOME_ISOLATION_FIXTURE !== "1") return;
  const operatorHome = process.env.HARNESS_RUNNER_OPERATOR_HOME,
    fallback = path.join(os.homedir(), ".harness");
  assert.equal(
    process.env.HARNESS_DAEMON_USER_ROOT,
    undefined,
    "the worker's daemon route must not reach a test child",
  );
  assert.notEqual(os.homedir(), operatorHome, "a test child must not run in the operator's home");
  assert.equal(
    fallback.startsWith(process.env.HARNESS_TEST_TEMP_ROOT),
    true,
    `${fallback} is outside the run's temporary root`,
  );
  assert.equal(existsSync(path.join(operatorHome, ".harness")), false, "nothing may create the operator's user root");
});
