// harness-test-tier: integration
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { forkRepoWriteProcess } from "../src/runtime/repo-write-child-process-transport.ts";
import type { RepoWriteRequestTimeoutDiagnostic } from "../src/runtime/repo-write-client-contract.ts";
import { RepoWriteProcessSupervisor } from "../src/runtime/repo-write-process-supervisor.ts";

const fixturePath = fileURLToPath(
  new URL("./support/repo-write-ipc-child.ts", import.meta.url)
);

test("durable deadline observes a slow canonical publication without replacing its writer", async (context) => {
  let forks = 0;
  const timeoutDiagnostics: RepoWriteRequestTimeoutDiagnostic[] = [];
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    // Keep the 40ms observation deadline below the fixture's 60ms terminal,
    // while leaving an order-of-magnitude margin before stall escalation.
    limits: { requestTimeoutMs: 40, proceededStallTimeoutMs: 1_000 },
    spawn: () => {
      forks += 1;
      return forkRepoWriteProcess({
        modulePath: fixturePath,
        args: ["slow-terminal"]
      });
    },
    onRequestTimeout: (diagnostic) => timeoutDiagnostics.push(diagnostic)
  });
  context.after(() => supervisor.stop().catch(() => undefined));

  const receipt = await supervisor.submit({
    commandName: "record-fact",
    actor: { personId: "person-test" },
    context: {},
    payload: {}
  });

  assert.equal(receipt.ok, true);
  assert.equal(receipt.summary, "slow canonical publication");
  assert.ok(timeoutDiagnostics.some((diagnostic) =>
    diagnostic.watchdogStage === "observation"
    && diagnostic.deadlineMs === 40
    && diagnostic.lane === "durable"));
  assert.equal(forks, 1, "PROCEED transfers terminal ownership to the current writer");
  assert.equal(supervisor.status().connected, true);
});
