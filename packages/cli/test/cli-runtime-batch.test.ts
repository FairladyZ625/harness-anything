// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { rejectedWith } from "../src/cli-runtime-batch.ts";

test("runtime batch recognizes a released execution lease from either rejection shape", () => {
  assert.equal(
    rejectedWith(
      { ok: false, outcome: "op_rejected", code: "runtime_task_lease_required" },
      "runtime_task_lease_required",
    ),
    true,
  );
  assert.equal(
    rejectedWith(
      { ok: false, outcome: "op_rejected", error: { code: "runtime_task_lease_required", hint: "run ha task start" } },
      "runtime_task_lease_required",
    ),
    true,
  );
  assert.equal(
    rejectedWith({ ok: false, outcome: "op_rejected", code: "squad_member_not_found" }, "runtime_task_lease_required"),
    false,
  );
  // A settled dispatch never triggers reacquisition, however its outcome reads.
  assert.equal(
    rejectedWith({ ok: true, outcome: "failed", code: "runtime_task_lease_required" }, "runtime_task_lease_required"),
    false,
  );
});
