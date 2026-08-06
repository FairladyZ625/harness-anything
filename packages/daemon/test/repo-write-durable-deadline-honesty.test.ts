// harness-test-tier: integration
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { forkRepoWriteProcess } from "../src/runtime/repo-write-child-process-transport.ts";
import type { RepoWriteRequestTimeoutDiagnostic } from "../src/runtime/repo-write-client-contract.ts";
import { RepoWriteProcessSupervisor } from "../src/runtime/repo-write-process-supervisor.ts";
import { repoWriteProductionCommandFixture } from "./support/repo-write-production-command-fixture.ts";

const fixturePath = fileURLToPath(
  new URL("./support/repo-write-ipc-child.ts", import.meta.url)
);

test("durable deadline observes a slow canonical publication without replacing its writer", async (context) => {
  const requestTimeoutMs = 40;
  let forks = 0;
  let timeoutDiagnostic: RepoWriteRequestTimeoutDiagnostic | undefined;
  let barrierError: unknown;
  let confirmSlowTerminalReady!: () => void;
  const slowTerminalReady = new Promise<void>((resolve) => {
    confirmSlowTerminalReady = resolve;
  });
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    limits: { requestTimeoutMs },
    spawn: () => {
      forks += 1;
      return forkRepoWriteProcess({
        modulePath: fixturePath,
        args: ["slow-terminal"]
      });
    },
    onRequestTimeout: (diagnostic) => {
      timeoutDiagnostic = diagnostic;
    },
    onDiagnostic: (frame) => {
      if (frame.code !== "FIXTURE_SLOW_TERMINAL_READY") return;
      try {
        // Advance synchronously while handling the ordered barrier. Node may
        // deliver the following terminal in the same IPC poll turn, before an
        // awaiting continuation gets its own microtask checkpoint.
        assert.equal(timeoutDiagnostic, undefined);
        context.mock.timers.tick(requestTimeoutMs);
      } catch (error) {
        // Recovery-diagnostic observers intentionally swallow exceptions, so
        // hand assertion failures back to the test continuation explicitly.
        barrierError = error;
      } finally {
        confirmSlowTerminalReady();
      }
    }
  });
  context.after(() => supervisor.stop().catch(() => undefined));

  await supervisor.start();
  context.mock.timers.enable({ apis: ["setTimeout"] });

  const outcome = supervisor.submit(
    repoWriteProductionCommandFixture("record-fact", "slow publication")
  );
  await slowTerminalReady;
  if (barrierError) throw barrierError;
  assert.equal(timeoutDiagnostic?.watchdogStage, "observation");
  assert.ok(timeoutDiagnostic);
  assert.equal(timeoutDiagnostic.deadlineMs, requestTimeoutMs);
  assert.equal(timeoutDiagnostic.lane, "durable");
  assert.equal(timeoutDiagnostic.lastTelemetry?.phase, "git");

  const receipt = await outcome;

  assert.equal(receipt.ok, true);
  assert.equal(receipt.summary, "slow canonical publication");
  assert.equal(forks, 1, "PROCEED transfers terminal ownership to the current writer");
  assert.equal(supervisor.status().connected, true);
});
