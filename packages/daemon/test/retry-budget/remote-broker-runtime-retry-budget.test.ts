// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { AuthorityTransportDisconnectedError } from "../../src/index.ts";
import {
  makeRuntime,
  notifyRuntime,
  ReadDownClient,
  record,
  snapshotFixture,
  waitFor,
  withRoots
} from "../remote-broker-runtime-failure-support.ts";

test("remote broker remains recoverable and repeatedly visible after retry budget exhaustion", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const client = new ReadDownClient(snapshotFixture(0, "epoch-broker-visible"));
    const phases: string[] = [];
    const runtime = makeRuntime(client, viewRoot, stateRoot, {
      retryBudget: { maxRetries: 1, reminderEveryFailures: 1 },
      onRetryBudgetSignal: (signal) => {
        if (signal.event.operation === "remote-broker-synchronization") phases.push(signal.phase);
      }
    });
    await runtime.start();
    const refresh = runtime.session.refresh.bind(runtime.session);
    let refreshFailures = 3;
    runtime.session.refresh = async () => {
      if (refreshFailures > 0) {
        refreshFailures -= 1;
        throw new AuthorityTransportDisconnectedError("scripted broker retry disconnect");
      }
      await refresh();
    };
    runtime.broker.onNotification = async () => {
      throw new AuthorityTransportDisconnectedError("start broker retry loop");
    };

    notifyRuntime(runtime, record(1, "commit-1", null));
    await waitFor(() => phases.at(-1) === "recovered");

    assert.deepEqual(phases, ["exhausted", "still-retrying", "recovered"]);
    assert.deepEqual(runtime.health(), { status: "RUNNING" });
    await runtime.stop();
  });
});
