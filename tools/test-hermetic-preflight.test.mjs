// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { assessHermeticConfig, main, parsePreflightArgs } from "./test-hermetic-preflight.mjs";

test("preflight rejects the default daemon with separate user-root and socket failures", () => {
  const result = assessHermeticConfig({
    userRoot: "/home/tester/.harness",
    daemonId: "default",
    userRootSource: "flag",
    home: "/home/tester"
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, [
    "user-root path: /home/tester/.harness is the default daemon root; choose a dedicated directory.",
    "socket namespace: the default user-root with daemon-id default resolves to the user's default daemon endpoint."
  ]);
});

test("preflight reports a missing user root", () => {
  const result = assessHermeticConfig({ userRoot: undefined, daemonId: undefined, userRootSource: undefined, home: "/home/runner" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, [
    "user-root source: pass --user-root explicitly; implicit daemon configuration is not permitted."
  ]);
});

test("preflight accepts an explicit dedicated user root with the default daemon id", () => {
  const result = assessHermeticConfig({
    userRoot: "/tmp/harness-test-isolation/run-42",
    daemonId: undefined,
    userRootSource: "flag",
    home: "/home/runner"
  });
  assert.deepEqual(result, { ok: true, failures: [], effectiveDaemonId: "default" });
});

test("preflight refuses an environment-only user root", () => {
  const config = parsePreflightArgs([], {
    HARNESS_DAEMON_USER_ROOT: "/tmp/harness-test-isolation/run-42",
    HARNESS_DAEMON_ID: "test-isolation-42"
  });
  assert.deepEqual(assessHermeticConfig({ ...config, home: "/home/runner" }).failures, [
    "user-root source: pass --user-root explicitly; an environment-only value is not an auditable isolation boundary."
  ]);
});

test("preflight command accepts explicit values", () => {
  assert.equal(main(["--user-root", "/tmp/harness-test-isolation/run-42"], {}), 0);
});
