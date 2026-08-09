// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { authenticateSshAuthorityWireFrame } from "../src/index.ts";

test("unavailable authority-wire roots render a concrete read-only diagnostic", () => {
  const canonicalRoot = "/srv/team's canonical";
  const result = authenticateSshAuthorityWireFrame(
    {
      type: "harness-daemon.ssh-forced-command/v2",
      streamProtocol: "harness-authority-wire/v1",
      personId: "person_alice",
      canonicalRoot
    },
    { transportKind: "unix-socket", endpoint: "/tmp/authority-wire.sock" },
    () => false
  );

  assert.deepEqual(result, {
    ok: false,
    code: "authority_wire_repo_unavailable",
    message: "The requested canonical root \"/srv/team's canonical\" is unavailable to this authority service. Run `ha --root '/srv/team'\"'\"'s canonical' daemon status --json` on the authority host to inspect its registered state. Do not register a second repo id or start, stop, or restart a daemon based on this error."
  });
});
