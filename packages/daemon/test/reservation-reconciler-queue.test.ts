// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createDaemonRuntime } from "../src/runtime/repo-runtime.ts";
import { daemonAttribution } from "./runtime/helpers/daemon-runtime.ts";
import { docWrite, withTempStoreAsync } from "./runtime/helpers/store.ts";

test("reservation reconciliation may await a write on the daemon queue without self-deadlocking", { timeout: 5_000 }, async () => {
  await withTempStoreAsync(async (rootDir) => {
    let reconciliations = 0;
    const runtime = createDaemonRuntime({
      rootDir,
      materializerPollMs: false,
      interactiveMicroBatchMs: 0,
      reservationReconciler: async () => {
        reconciliations += 1;
        await runtime.enqueueInteractiveWrite({
          commandId: "runtime-event-lease-reconcile",
          attribution: daemonAttribution("person_test", "test", "credential-test"),
          ops: [docWrite(
            "op-reservation-reconcile",
            "task-reservation-reconcile",
            "reconciled.md",
            "reconciled\n"
          )]
        });
      }
    });

    await runtime.start();

    assert.equal(reconciliations, 1);
    assert.equal(
      readFileSync(path.join(
        rootDir,
        "harness/tasks/task-reservation-reconcile/reconciled.md"
      ), "utf8"),
      "reconciled\n"
    );
    await runtime.stop();
  });
});
