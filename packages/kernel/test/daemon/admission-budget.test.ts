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
        }
      }
    }
  }
});
