// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { createDaemonRuntime } from "../../src/runtime/repo-runtime.ts";
import { docWrite, withTempStoreAsync } from "../../../kernel/test/store/helpers.ts";
import { daemonAttribution } from "./helpers/daemon-runtime.ts";

const admissionAttribution = daemonAttribution("person_admission", "agent_admission", "credential-admission");

test("JSON-RPC queue retries temporary admission pressure after the reservation is released", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const runtime = createDaemonRuntime({
      rootDir,
      materializerPollMs: false,
      interactiveMicroBatchMs: 100,
      admissionMaxOperations: 1,
      admissionMaxBytes: 1_000_000,
      admissionReservedOperationsPerPlane: 0,
      admissionReservedBytesPerPlane: 0
    });
    await runtime.start();
    const first = runtime.enqueueInteractiveWrite({
      commandId: "cmd-held",
      attribution: admissionAttribution,
      ops: [docWrite("op-held", "task-held", "note.md", "held")]
    });
    await assert.rejects(
      runtime.enqueueInteractiveWrite({
        commandId: "cmd-temporarily-full",
        attribution: admissionAttribution,
        ops: [docWrite("op-temporarily-full", "task-temporarily-full", "note.md", "temporary")]
      }),
      temporaryCapacityError
    );
    await first;
    await runtime.enqueueInteractiveWrite({
      commandId: "cmd-retried",
      attribution: admissionAttribution,
      ops: [docWrite("op-retried", "task-retried", "note.md", "retried")]
    });
    await runtime.stop();
  });
});

test("JSON-RPC queue keeps rejecting an oversized batch as non-retryable", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const runtime = createDaemonRuntime({
      rootDir,
      materializerPollMs: false,
      admissionMaxOperations: 1,
      admissionMaxBytes: 1_000_000,
      admissionReservedOperationsPerPlane: 0,
      admissionReservedBytesPerPlane: 0
    });
    await runtime.start();
    const request = () => runtime.enqueueInteractiveWrite({
      commandId: "cmd-oversized",
      attribution: admissionAttribution,
      ops: [
        docWrite("op-oversized-1", "task-oversized-1", "note.md", "one"),
        docWrite("op-oversized-2", "task-oversized-2", "note.md", "two")
      ]
    });
    await assert.rejects(request(), oversizedPayloadError);
    await assert.rejects(request(), oversizedPayloadError);
    await runtime.stop();
  });
});

function temporaryCapacityError(error: unknown): boolean {
  assert.deepEqual(error, {
    _tag: "WriteRejected",
    code: "admission_overloaded",
    reason: "Shared daemon admission budget is full. Run 'ha daemon status --json', wait for current writes to settle, then retry the exact command.",
    retryable: true
  });
  return true;
}

function oversizedPayloadError(error: unknown): boolean {
  assert.equal(typeof error, "object");
  assert.equal(error !== null && "_tag" in error ? error._tag : undefined, "WriteRejected");
  assert.equal(error !== null && "code" in error ? error.code : undefined, "admission_payload_exceeds_limit");
  assert.equal(error !== null && "retryable" in error ? error.retryable : undefined, false);
  assert.match(error !== null && "reason" in error ? String(error.reason) : "", /operations: requested 2, limit 1/u);
  assert.match(error !== null && "reason" in error ? String(error.reason) : "", /Split the batch or reduce the payload/u);
  return true;
}
