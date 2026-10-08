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

test("human CLI renders the same DTO diagnostics, missing set and full detail without an all-green inference", async () => {
  const { renderCliReceipt } = await import("../src/cli/receipt-render-registry.ts");
  const { default: fixture } = await import("../../gui/test-support/ci-observation-dto.json", {
    with: { type: "json" },
  });
  const hot = renderCliReceipt(fixture.hot).text;
  assert.match(hot, /Expected result to equal 42/u);
  assert.match(hot, /fixture.test.ts:27:5/u);
  assert.match(hot, /timeout.test.ts.*810000/u);
  assert.match(hot, /claim_fence_expired/u);
  assert.match(hot, /HTTP 401/u);
  assert.match(hot, /statistics=pending/u);
  assert.match(hot, /event-presentation-202-1/u);
  assert.doesNotMatch(hot, /Full assertion stack|all green|p95=0/u);
  const cold = renderCliReceipt(fixture.cold).text;
  assert.match(cold, /Full assertion stack/u);
  assert.match(cold, /attempt 1 -> 2/u);
  assert.match(cold, /sourceRevision=42/u);
});
