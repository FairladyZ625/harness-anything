// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("CI statistics uses the shared replica read service and explicit cold detail fetch", () => {
  const parsed = parseThinCommand(["ci", "observe", "statistics", "--window", "100", "--fetch-details"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("command failed to parse");
  assert.equal(parsed.command.method, "repo.ci.observatory.read");
  assert.equal(parsed.command.action.window, 100);
  assert.equal(parsed.command.action.fetchDetails, true);
  for (const value of ["0", "101", "1.5", "-1"])
    assert.equal(parseThinCommand(["ci", "observe", "statistics", "--window", value]).ok, false);
});
