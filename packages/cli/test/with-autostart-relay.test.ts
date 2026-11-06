// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { withAutostart } from "../src/daemon/with-autostart.ts";

const relaySocket = "/tmp/harness-anything-1/r-0123456789abcdef01234567.sock";

function options(): Parameters<typeof withAutostart>[3] {
  return {
    autostart: true,
    // No HARNESS_ACTOR: the caller can remove it, so the relay boundary cannot depend on it.
    env: { HARNESS_DAEMON_RELAY: "1" },
    invokingRoot: process.cwd(),
    userRoot: "/nonexistent-daemon-user-root",
    daemonId: "default",
    commandCategory: "operation",
  };
}

test("a relayed runtime never starts a daemon when its fixed relay is unreachable", async () => {
  const calls: string[] = [],
    failure = Object.assign(new Error(`connect ENOENT ${relaySocket}`), { code: "ENOENT" });
  await assert.rejects(
    () =>
      withAutostart(
        async () => {
          calls.push("request");
          throw failure;
        },
        () => {
          calls.push("launch");
          throw new Error("launch must not run in relay mode");
        },
        relaySocket,
        options(),
      ),
    (error: unknown) => {
      assert.equal(error, failure, "the transport failure must surface unchanged");
      return true;
    },
  );
  assert.deepEqual(calls, ["request"], "relay mode must not attempt a daemon launch");
});

test("a relayed runtime surfaces a stopping daemon instead of waiting or starting one", async () => {
  const calls: string[] = [],
    stopping = { ok: false, code: "daemon_stopping" };
  const result = await withAutostart(
    async () => {
      calls.push("request");
      return stopping;
    },
    () => {
      calls.push("launch");
      throw new Error("launch must not run in relay mode");
    },
    relaySocket,
    options(),
  );
  assert.equal(result, stopping);
  assert.deepEqual(calls, ["request"], "relay mode must not wait for a replacement daemon");
});
