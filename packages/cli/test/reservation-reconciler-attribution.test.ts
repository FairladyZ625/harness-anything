// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { reservationReconciliationAttribution } from "../src/composition/reservation-reconciler.ts";

test("reservation reconciliation copies lease holder axes and marks its recovery evidence", () => {
  const attribution = reservationReconciliationAttribution("exe_original", {
    principal: { personId: "person_alice", displayName: "Alice" },
    executor: { kind: "agent", id: "codex-original" },
    responsibleHuman: "person:person_alice"
  });

  assert.deepEqual(attribution, {
    actor: {
      principal: { kind: "person", personId: "person_alice" },
      executor: { kind: "agent", id: "codex-original" }
    },
    principalSource: { kind: "migration", evidenceRef: "recovery-of:exe_original" },
    executorSource: "client-asserted"
  });
});

test("reservation reconciliation fails closed when the lease has no trustworthy principal", () => {
  assert.throws(
    () => reservationReconciliationAttribution("exe_orphan", {
      principal: { personId: "" },
      executor: { kind: "agent", id: "daemon" },
      responsibleHuman: "person:"
    }),
    /orphan execution reservation has no trustworthy principal/u
  );
});
