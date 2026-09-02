// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";

test("stale-build state remains structured in JSON and visible in human receipts", () => {
  const receipt = {
    ok: true,
    command: "task-create",
    outcome: "applied",
    summary: "task created",
    daemonBuild: {
      code: "daemon_build_stale",
      loadedBuildId: "build-a",
      diskBuildId: "build-b",
      liveRuntimeSessions: 3,
      pendingWrites: 1,
      attachingRepositories: 0,
      message:
        "Daemon loaded old build build-a; disk has build-b. It is serving 3 live runtime session(s) and will exit after drain.",
    },
  };
  const json = JSON.parse(JSON.stringify(receipt)) as typeof receipt;
  assert.deepEqual(json.daemonBuild, receipt.daemonBuild);
  const human = renderCliReceipt(receipt);
  assert.equal(human.stream, "stdout");
  assert.match(human.text, /task created.*warning:.*old build build-a.*3 live runtime session/su);
});
