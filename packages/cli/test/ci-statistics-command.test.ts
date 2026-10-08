// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { daemonProtocolCommands } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("CI statistics uses the shared replica read service and explicit cold detail fetch", () => {
  const parsed = parseThinCommand(["ci", "observe", "statistics", "--window", "100", "--fetch-details"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("command failed to parse");
  assert.equal(parsed.command.method, "repo.ci.observatory.read");
  const declaration = daemonProtocolCommands.find((command) => command.id === "ci-observe-statistics");
  assert.ok(declaration);
  assert.equal(declaration.commandClass, "repo-read");
  assert.equal(declaration.admission["remote-edge"], "edge-replica");
  assert.equal("repoCellExecution" in declaration, false);
  assert.equal(parsed.command.action.window, 100);
  assert.equal(parsed.command.action.fetchDetails, true);
  for (const value of ["0", "101", "1.5", "-1"])
    assert.equal(parseThinCommand(["ci", "observe", "statistics", "--window", value]).ok, false);
});
