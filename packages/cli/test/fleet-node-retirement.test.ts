// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("node retirement has a semantic CLI entry and defaults to a preview", () => {
  const parsed = parseThinCommand(["access", "node", "unregister", "--node-id", "retired-test-node"], "/repo");
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) return;
  assert.equal(parsed.command.method, "daemon.rbac.manage");
  assert.equal(parsed.command.action.operation, "node-unregister");
  assert.equal(parsed.command.action.nodeId, "retired-test-node");
  assert.notEqual(parsed.command.action.confirm, true);
});

test("confirmed forced node retirement retains the optimistic version and explicit flags", () => {
  const parsed = parseThinCommand(
    [
      "access",
      "node",
      "unregister",
      "--node-id",
      "retired-test-node",
      "--expected-version",
      "3",
      "--confirm",
      "--force",
    ],
    "/repo",
  );
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) return;
  assert.deepEqual(
    [parsed.command.action.confirm, parsed.command.action.force, parsed.command.action.expectedVersion],
    [true, true, "3"],
  );
});
