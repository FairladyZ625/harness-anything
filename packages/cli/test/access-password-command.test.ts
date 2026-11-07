// harness-test-tier: fast
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("access password commands accept only a file path or redirected stdin reference", () => {
  const fromFile = parseThinCommand(
      ["access", "password", "change", "--password-file", "secrets/new-password.txt"],
      "/workspace",
    ),
    fromStdin = parseThinCommand(["access", "password", "change", "--password-stdin"], "/workspace"),
    reset = parseThinCommand(
      ["access", "password", "reset", "--person-id", "person-target", "--password-file", "reset.txt"],
      "/workspace",
    );

  assert.equal(fromFile.ok, true, JSON.stringify(fromFile));
  if (fromFile.ok)
    assert.deepEqual(fromFile.command.action, {
      kind: "access-password-change",
      operation: "password-change",
      passwordFile: path.resolve("/workspace", "secrets/new-password.txt"),
    });
  assert.equal(fromStdin.ok, true, JSON.stringify(fromStdin));
  if (fromStdin.ok)
    assert.deepEqual(fromStdin.command.action, {
      kind: "access-password-change",
      operation: "password-change",
      passwordStdin: true,
    });
  assert.equal(reset.ok, true, JSON.stringify(reset));
  if (reset.ok)
    assert.deepEqual(reset.command.action, {
      kind: "access-password-reset",
      operation: "password-reset",
      personId: "person-target",
      passwordFile: path.resolve("/workspace", "reset.txt"),
    });
  for (const parsed of [fromFile, fromStdin, reset])
    if (parsed.ok) assert.equal(Object.hasOwn(parsed.command.action, "password"), false);
});

test("access password commands require exactly one protected input and reject inline passwords", () => {
  for (const argv of [
    ["access", "password", "change"],
    ["access", "password", "change", "--password-file", "one", "--password-stdin"],
    ["access", "password", "reset", "--password-file", "one"],
    ["access", "password", "change", "--password", "must-not-appear-in-argv"],
  ]) {
    const parsed = parseThinCommand(argv, "/workspace");
    assert.equal(parsed.ok, false, argv.join(" "));
  }
});
