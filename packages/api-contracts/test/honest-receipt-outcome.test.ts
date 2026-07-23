// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  coreFailureRegistry,
  honestReceiptOutcomeSchema,
  isHonestReceiptOutcomeV1,
  type HonestReceiptOutcomeV1
} from "../src/honest-receipt-outcome.ts";

test("core failure registry owns exactly fifteen reason and recovery pairs", () => {
  assert.equal(Object.keys(coreFailureRegistry).length, 15);
  assert.equal(coreFailureRegistry.outcome_unknown.family, "commit");
  for (const [reason, entry] of Object.entries(coreFailureRegistry)) {
    assert.ok(reason.length > 0);
    assert.ok(entry.recovery.action.length > 0);
    assert.ok(entry.recovery.effectSafety.length > 0);
  }
});

test("honest outcome validation enforces evidence, causality, and registered recovery", () => {
  const outcome = validOutcome();
  assert.equal(isHonestReceiptOutcomeV1(outcome), true);

  assert.equal(isHonestReceiptOutcomeV1({
    ...outcome,
    moments: {
      ...outcome.moments,
      visible: { status: "confirmed", evidence: [] }
    }
  }), false, "confirmed without evidence must fail");

  assert.equal(isHonestReceiptOutcomeV1({
    ...outcome,
    moments: {
      ...outcome.moments,
      applied: { status: "unknown", reason: "not_observed" }
    }
  }), false, "visible cannot be confirmed before applied");

  assert.equal(isHonestReceiptOutcomeV1({
    ...outcome,
    failures: [{
      id: "op-1:outcome_unknown",
      reason: "outcome_unknown",
      family: "protocol",
      at: "committed",
      recovery: coreFailureRegistry.protocol_integrity_failed.recovery
    }]
  }), false, "core failures must use the registry family and recovery");
});

function validOutcome(): HonestReceiptOutcomeV1 {
  return {
    schema: honestReceiptOutcomeSchema,
    operation: { namespace: "test", id: "op-1" },
    moments: {
      committed: {
        status: "confirmed",
        evidence: [{
          kind: "write_watermark",
          ref: "watermark/op-1",
          scope: {
            kind: "authority_store",
            id: "op-1",
            freshness: "current"
          }
        }]
      },
      applied: {
        status: "confirmed",
        evidence: [{
          kind: "materialization_witness",
          ref: "merge/op-1",
          scope: {
            kind: "canonical_artifact",
            id: "task/op-1",
            freshness: "current"
          }
        }]
      },
      visible: {
        status: "confirmed",
        evidence: [{
          kind: "projection_read",
          ref: "projection/op-1",
          scope: {
            kind: "projection",
            id: "task-list",
            freshness: "current"
          }
        }]
      },
      acked: { status: "unknown", reason: "not_observed" }
    },
    failures: []
  };
}
