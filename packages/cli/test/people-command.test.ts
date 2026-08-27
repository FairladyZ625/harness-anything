// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("People CLI projects add, set-role, and remove onto closed Action payloads", () => {
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
