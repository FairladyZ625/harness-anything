// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { deriveRelationId, relationTypes } from "../../src/index.ts";
import { relationConsumability, relationStrengthForType } from "../../src/domain/entity-relation.ts";
import { relationFreshnessAtCut } from "../../src/domain/entity-freshness.ts";
import {
  compileRelationCreatedEvent,
  validateCurrentRelationEvent,
  validateRelationEvent,
} from "../../src/domain/relation-event.ts";

const actor = { principal: { personId: "person-freshness-contract" }, executor: null } as const;

test("relation type is the sole strength authority", () => {
  assert.deepEqual(
    relationTypes.map((type) => [type, relationStrengthForType(type)]),
    relationTypes.map((type) => [type, type === "relates" ? "weak" : "strong"]),
  );
});

test("relation freshness compares a pinned witness with the target at one cut", () => {
  const target = { entityRef: "task/task_target", freshness: "current" as const, currentVersion: 8 };
  assert.equal(relationFreshnessAtCut({ target, targetObservedVersion: 8 }), "current");
  assert.equal(relationFreshnessAtCut({ target, targetObservedVersion: 7 }), "suspect");
  assert.equal(relationFreshnessAtCut({ target, targetObservedVersion: null }), "suspect");
  assert.equal(
    relationFreshnessAtCut({
      target: { ...target, freshness: "unknown", currentVersion: null },
      targetObservedVersion: 8,
    }),
    "suspect",
  );
  assert.equal(
    relationFreshnessAtCut({
      target: { ...target, freshness: "orphaned", currentVersion: null },
      targetObservedVersion: 8,
    }),
    "orphaned",
  );
});

test("consumability refuses stale strong edges and only warns for stale weak edges", () => {
  for (const freshness of ["current", "suspect", "orphaned"] as const) {
    assert.equal(
      relationConsumability({ strength: "strong", freshness }),
      freshness === "current" ? "consumable" : "refuse",
    );
    assert.equal(
      relationConsumability({ strength: "weak", freshness }),
      freshness === "current" ? "consumable" : "warn",
    );
  }
});

test("current relation payloads omit strength while frozen historical readers ignore it and unknown fields", () => {
  const identity = {
    source: "task/task_source",
    target: "task/task_target",
    type: "relates" as const,
    direction: "directed" as const,
  };
  const event = compileRelationCreatedEvent({
    record: {
      relation_id: deriveRelationId(identity),
      ...identity,
      origin: "declared",
      rationale: "The kernel derives weak strength.",
      state: "active",
      targetObservedVersion: 6,
    },
    actor,
    source: "local",
    opId: "relation-freshness-payload",
    occurredAt: "2026-09-02T00:00:00.000Z",
    workspaceRevision: 9,
  });
  assert.equal(Object.hasOwn(event.payload.relation, "strength"), false);
  const historical = {
    ...event,
    futureEnvelopeField: true,
    payload: {
      ...event.payload,
      futurePayloadField: true,
      relation: {
        ...event.payload.relation,
        strength: "weak",
        futureRelationField: true,
      },
    },
  };
  assert.deepEqual(validateRelationEvent(historical), []);
  assert.notDeepEqual(validateCurrentRelationEvent(historical), []);
});
