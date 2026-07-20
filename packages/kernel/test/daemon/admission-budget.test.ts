// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { createDaemonAdmissionBudget, type DaemonAdmissionPlane } from "../../src/daemon/admission-budget.ts";

test("shared admission budget bounds 32 clients per plane without starving the plane that arrives second", () => {
  for (const firstPlane of ["authority", "json-rpc"] as const) {
    const secondPlane: DaemonAdmissionPlane = firstPlane === "authority" ? "json-rpc" : "authority";
    const budget = createDaemonAdmissionBudget({
      maxOperations: 8,
      maxBytes: 800,
      reservedOperationsPerPlane: 2,
      reservedBytesPerPlane: 200
    });
    const admitted = { authority: [], "json-rpc": [] } as Record<DaemonAdmissionPlane, Array<() => void>>;

    admit32(firstPlane);
    admit32(secondPlane);

    const saturated = budget.snapshot();
    assert.equal(saturated.used.operations, 8);
    assert.equal(saturated.used.bytes, 800);
    assert.equal(admitted[firstPlane].length, 6);
    assert.equal(admitted[secondPlane].length, 2);
    assert.ok(saturated.rejected[firstPlane] > 0);
    assert.ok(saturated.rejected[secondPlane] > 0);

    for (const release of [...admitted.authority, ...admitted["json-rpc"]]) release();
    assert.deepEqual(budget.snapshot().used, {
      operations: 0,
      bytes: 0,
      authorityOperations: 0,
      authorityBytes: 0,
      jsonRpcOperations: 0,
      jsonRpcBytes: 0
    });

    function admit32(plane: DaemonAdmissionPlane): void {
      for (let client = 0; client < 32; client += 1) {
        const result = budget.reserve({ plane, operations: 1, bytes: 100 });
        if (result.ok) admitted[plane].push(result.reservation.release);
        else {
          assert.equal(result.error._tag, "WriteRejected");
          assert.equal(result.error._tag === "WriteRejected" ? result.error.code : undefined, "admission_overloaded");
          assert.equal(result.error._tag === "WriteRejected" ? result.error.retryable : undefined, true);
        }
      }
    }
  }
});

test("admission distinguishes temporary capacity pressure from a payload that can never fit", () => {
  for (const plane of ["authority", "json-rpc"] as const) {
    const budget = createDaemonAdmissionBudget({
      maxOperations: 4,
      maxBytes: 400,
      reservedOperationsPerPlane: 1,
      reservedBytesPerPlane: 100
    });
    const held = budget.reserve({ plane, operations: 3, bytes: 300 });
    assert.equal(held.ok, true);

    const temporarilyFull = budget.reserve({ plane, operations: 1, bytes: 100 });
    assert.deepEqual(temporarilyFull, {
      ok: false,
      error: {
        _tag: "WriteRejected",
        code: "admission_overloaded",
        reason: "Shared daemon admission budget is full. Run 'ha daemon status --json', wait for current writes to settle, then retry the exact command.",
        retryable: true
      }
    });
    if (held.ok) held.reservation.release();
    const retriedAfterRelease = budget.reserve({ plane, operations: 1, bytes: 100 });
    assert.equal(retriedAfterRelease.ok, true);
    if (retriedAfterRelease.ok) retriedAfterRelease.reservation.release();

    const oversized = {
      ok: false,
      error: {
        _tag: "WriteRejected",
        code: "admission_payload_exceeds_limit",
        reason: "Shared daemon admission payload exceeds the per-request limit (operations: requested 4, limit 3; bytes: requested 301, limit 300). Split the batch or reduce the payload, then submit each smaller request.",
        retryable: false
      }
    };
    assert.deepEqual(budget.reserve({ plane, operations: 4, bytes: 301 }), oversized);
    assert.deepEqual(budget.reserve({ plane, operations: 4, bytes: 301 }), oversized);
  }
});
