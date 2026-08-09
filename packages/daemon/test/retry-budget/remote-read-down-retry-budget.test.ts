// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import {
  RemoteReadDownSession,
  type PersistentSshAuthorityClient
} from "../../src/index.ts";
import {
  ReadDownClient,
  snapshotFixture,
  withRoots,
  workspaceId
} from "../remote-broker-runtime-failure-support.ts";

test("remote read-down keeps an exhausted recovery episode visibly escalated until it recovers", async () => {
  await withRoots(async ({ stateRoot }) => {
    const client = new ReadDownClient(snapshotFixture(0, "epoch-visible"));
    client.connectFailuresRemaining = 3;
    const phases: string[] = [];
    const session = new RemoteReadDownSession({
      client: client as unknown as PersistentSshAuthorityClient,
      workspaceId,
      stateRoot,
      backoff: { initialMs: 0, maximumMs: 0, multiplier: 1 },
      retryBudget: { maxRetries: 1, reminderEveryFailures: 1 },
      onRetryBudgetSignal: (signal) => phases.push(signal.phase)
    });

    await session.latest();

    assert.deepEqual(phases, ["exhausted", "still-retrying", "recovered"]);
    assert.deepEqual(session.health(), { status: "READY" });
    await session.close();
  });
});
