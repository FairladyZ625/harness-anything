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
