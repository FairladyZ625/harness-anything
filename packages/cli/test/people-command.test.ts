// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("People CLI projects registry and delegated-token mutations onto closed Action payloads", () => {
  const added = parseThinCommand([
    "people",
    "add",
    "--person-id",
    "person_alice",
    "--display-name",
    "Alice",
    "--role",
    "dispatcher",
    "--command-class",
    "repo-write",
    "--command-class",
    "repo-read",
  ]);
  assert.equal(added.ok, true);
  if (added.ok)
    assert.deepEqual(added.command.action, {
      kind: "people-add",
      personId: "person_alice",
      displayName: "Alice",
      role: "dispatcher",
      commandClass: ["repo-write", "repo-read"],
    });
  assert.equal(
    parseThinCommand([
      "people",
      "set-role",
      "--person-id",
      "person_alice",
      "--role",
      "owner",
      "--command-class",
      "admin",
    ]).ok,
    true,
  );
  const bound = parseThinCommand([
    "people",
    "bind",
    "--actor",
    "person:person_alice",
    "--role",
    "arbiter",
    "--target",
    "settings/repository",
  ]);
  assert.equal(bound.ok, true);
  if (bound.ok)
    assert.deepEqual(bound.command.action, {
      kind: "people-bind",
      actor: "person:person_alice",
      role: "arbiter",
      target: "settings/repository",
    });
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
  assert.equal(parseThinCommand(["people", "remove", "--person-id", "person_alice"]).ok, true);
});

test("People CLI enforces complete credentials and command class vocabulary", () => {
  assert.equal(
    parseThinCommand([
      "people",
      "add",
      "--person-id",
      "person_alice",
      "--display-name",
      "Alice",
      "--role",
      "owner",
      "--command-class",
      "root",
    ]).ok,
    false,
  );
  assert.equal(
    parseThinCommand([
      "people",
      "add",
      "--person-id",
      "person_alice",
      "--display-name",
      "Alice",
      "--role",
      "owner",
      "--command-class",
      "admin",
      "--credential-kind",
      "email-address",
    ]).ok,
    false,
  );
});

test("People CLI exposes one closed structured packet facet per public command", () => {
  for (const [argv, action] of [
    [["people", "add", "--from-file", "people-add.json"], { kind: "people-add", fromFile: "people-add.json" }],
    [
      ["people", "set-role", "--from-file", "people-role.json"],
      { kind: "people-set-role", fromFile: "people-role.json" },
    ],
    [
      ["people", "bind", "--from-file", "people-binding.json"],
      { kind: "people-bind", fromFile: "people-binding.json" },
    ],
    [
      ["people", "delegate", "--from-file", "people-delegation.json"],
      { kind: "people-delegate", fromFile: "people-delegation.json" },
    ],
    [
      ["people", "revoke-delegation", "--from-file", "people-revocation.json"],
      { kind: "people-revoke-delegation", fromFile: "people-revocation.json" },
    ],
    [
      ["people", "remove", "--from-file", "people-remove.json"],
      { kind: "people-remove", fromFile: "people-remove.json" },
    ],
  ] as const) {
    const parsed = parseThinCommand(argv);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.command.action, action);
  }
  assert.equal(parseThinCommand(["people", "add", "--person-id", "person_alice"]).ok, false);
  assert.equal(
    parseThinCommand(["people", "remove", "--from-file", "people-remove.json", "--person-id", "person_alice"]).ok,
    false,
  );
});
