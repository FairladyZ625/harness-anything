// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { PersistentSshAuthorityClient } from "../../src/index.ts";
import { createProductionCompoundReceiptComposition } from "../../src/lifecycle/compound-receipt-composition.ts";
import {
  ReadDownClient,
  snapshotFixture,
  withRoots,
  workspaceId
} from "../remote-broker-runtime-failure-support.ts";

test("production remote composition refuses an unwatched retry-budget callback", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const client = new ReadDownClient(snapshotFixture(0, "epoch-production-log"));

    assert.throws(() => createProductionCompoundReceiptComposition({
      workspaceId,
      viewId: "view-production-log",
      canonicalRoot: viewRoot,
      stateDirectory: stateRoot,
      remoteReadDown: {
        client: client as unknown as PersistentSshAuthorityClient,
        onRetryBudgetSignal: () => undefined
      }
    }), /remote read-down requires daemon error-log visibility/u);
  });
});
