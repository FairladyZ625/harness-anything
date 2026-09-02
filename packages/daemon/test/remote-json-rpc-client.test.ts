// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { classifyRemoteError } from "../src/client/remote-json-rpc-client.ts";

test("remote SSH transport preserves explicit failure classes when stdout closes during handshake", () => {
  const cases = [
    [
      "host key",
      "daemon_closed",
      "No ED25519 host key is known for example and you have requested strict checking.\nHost key verification failed.",
      "ssh_host_key_failed",
    ],
    ["authentication", "daemon_closed", "Permission denied (publickey).", "ssh_auth_failed"],
    [
      "connection",
      "daemon_closed",
      "banner exchange: Connection to UNKNOWN port -1: Connection refused",
      "ssh_connection_failed",
    ],
    ["remote command", "daemon_closed", "bash: line 1: ha: command not found", "remote_daemon_unavailable"],
    ["clean EOF", "daemon_closed", "", "remote_daemon_closed"],
  ] as const;

  for (const [name, errorCode, stderr, expectedCode] of cases) {
    const error = Object.assign(new Error("daemon closed before JSON-RPC response 1"), { code: errorCode });
    const classified = classifyRemoteError(error, stderr);
    assert.equal(classified.code, expectedCode, name);
  }
});

test("remote JSON-RPC timeout remains distinct from SSH transport failure", () => {
  const error = Object.assign(new Error("the daemon did not answer protocol.hello within 250ms"), {
    code: "daemon_response_timeout",
  });
  assert.equal(classifyRemoteError(error, "Connection refused").code, "remote_daemon_timeout");
});
