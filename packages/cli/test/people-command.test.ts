// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { materializePacketStdin } from "../src/index.ts";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("People CLI projects registry and delegated-token mutations onto closed Action payloads", () => {
  for (const retired of ["add", "remove", "set-role", "bind"])
    assert.equal(parseThinCommand(["people", retired, "--person-id", "person_alice"]).ok, false);
  const delegated = parseThinCommand([
    "people",
    "delegate",
    "--token-id",
    "det_alice_runtime_1",
    "--runtime-session-id",
    "runtime_1",
    "--action",
    "execution.start",
    "--action",
    "doc.submit",
    "--expires-at",
    "2026-08-27T03:00:00.000Z",
  ]);
  assert.equal(delegated.ok, true);
  if (delegated.ok)
    assert.deepEqual(delegated.command.action, {
      kind: "people-delegate",
      tokenId: "det_alice_runtime_1",
      runtimeSessionId: "runtime_1",
      action: ["execution.start", "doc.submit"],
      expiresAt: "2026-08-27T03:00:00.000Z",
    });
  const revoked = parseThinCommand(["people", "revoke-delegation", "--token-id", "det_alice_runtime_1"]);
  assert.equal(revoked.ok, true);
  if (revoked.ok)
    assert.deepEqual(revoked.command.action, {
      kind: "people-revoke-delegation",
      tokenId: "det_alice_runtime_1",
    });
  assert.equal(parseThinCommand(["people", "remove", "--person-id", "person_alice"]).ok, false);
});

test("People CLI exposes one closed structured packet facet per public command", () => {
  for (const [argv, action] of [
    [
      ["people", "delegate", "--from-file", "people-delegation.json"],
      { kind: "people-delegate", fromFile: "people-delegation.json" },
    ],
    [
      ["people", "revoke-delegation", "--from-file", "people-revocation.json"],
      { kind: "people-revoke-delegation", fromFile: "people-revocation.json" },
    ],
  ] as const) {
    const parsed = parseThinCommand(argv);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.command.action, action);
  }
  const packet = '{"tokenId":"det_example"}',
    inline = parseThinCommand(["people", "revoke-delegation", "--json-input", packet]),
    stdin = parseThinCommand(["people", "revoke-delegation", "--json-input", "@-"]);
  assert.equal(inline.ok, true);
  assert.equal(stdin.ok, true);
  if (inline.ok) assert.deepEqual(inline.command.action, { kind: "people-revoke-delegation", jsonInput: packet });
  if (stdin.ok)
    assert.deepEqual(materializePacketStdin(stdin.command, () => packet).action, {
      kind: "people-revoke-delegation",
      jsonInput: packet,
    });
  assert.equal(parseThinCommand(["people", "add", "--person-id", "person_alice"]).ok, false);
  assert.equal(
    parseThinCommand(["people", "remove", "--from-file", "people-remove.json", "--person-id", "person_alice"]).ok,
    false,
  );
  assert.equal(
    parseThinCommand(["people", "remove", "--from-file", "people-remove.json", "--json-input", packet]).ok,
    false,
  );
});
