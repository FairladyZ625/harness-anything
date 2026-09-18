// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { deriveRelationId, relationTypes } from "../../src/index.ts";
import {
  relationConsumability,
  relationFreshnessAnchorForType,
  relationIsCurrent,
  relationStrengthForType,
} from "../../src/domain/entity-relation.ts";
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
  assert.equal(relationFreshnessAtCut({ anchor: "target", target, targetObservedVersion: 8 }), "current");
  assert.equal(relationFreshnessAtCut({ anchor: "target", target, targetObservedVersion: 7 }), "suspect");
  assert.equal(relationFreshnessAtCut({ anchor: "target", target, targetObservedVersion: null }), "suspect");
  assert.equal(
    relationFreshnessAtCut({
      anchor: "target",
      target: { ...target, freshness: "unknown", currentVersion: null },
      targetObservedVersion: 8,
    }),
    "suspect",
  );
  assert.equal(
    relationFreshnessAtCut({
      anchor: "target",
      target: { ...target, freshness: "orphaned", currentVersion: null },
      targetObservedVersion: 8,
    }),
    "orphaned",
  );
});

test("derives anchors on the source, depends-on on target presence; every other type keeps the pinned target", () => {
  assert.deepEqual(
    relationTypes.map((type) => [type, relationFreshnessAnchorForType(type)]),
    relationTypes.map((type) => [
      type,
      type === "derives" ? "source" : type === "depends-on" ? "target-presence" : "target",
    ]),
  );
});

test("a target-presence edge stays current while the target exists, orphaned only when it is gone", () => {
  // dec_EB379558A2B33134197859FECF/CH1: "task A depends on task B" holds no matter how
  // far B's own version advances; only losing B turns the edge orphaned.
  const target = { entityRef: "task/task_target", freshness: "current" as const, currentVersion: 42 };
  for (const observed of [8, 41, 42, null])
    assert.equal(
      relationFreshnessAtCut({ anchor: "target-presence", target, targetObservedVersion: observed }),
      "current",
      `observed ${String(observed)}`,
    );
  assert.equal(
    relationFreshnessAtCut({
      anchor: "target-presence",
      target: { ...target, freshness: "orphaned", currentVersion: null },
      targetObservedVersion: 8,
    }),
    "orphaned",
  );
  assert.equal(
    relationFreshnessAtCut({
      anchor: "target-presence",
      target: { ...target, freshness: "unknown", currentVersion: null },
      targetObservedVersion: 8,
    }),
    "suspect",
  );
});

test("a derives edge stays current while its source decision remains in effect", () => {
  // dec_D6970DC1303EF90E8B4855FC80/CH1: the target task may advance its version
  // arbitrarily; the edge only goes stale when the source decision leaves in_effect.
  const target = { entityRef: "task/task_target", freshness: "current" as const, currentVersion: 42 },
    source = {
      entityRef: "decision/dec_source/CH1",
      freshness: "current" as const,
      currentVersion: 9,
      state: "in_effect",
    };
  assert.equal(relationFreshnessAtCut({ anchor: "source", target, targetObservedVersion: 8, source }), "current");
  for (const state of ["superseded", "outcome_retired", "rejected", "deferred", "proposed"])
    assert.equal(
      relationFreshnessAtCut({
        anchor: "source",
        target,
        targetObservedVersion: 8,
        source: { ...source, state },
      }),
      "suspect",
      `source state ${state}`,
    );
  assert.equal(
    relationFreshnessAtCut({
      anchor: "source",
      target,
      targetObservedVersion: 8,
      source: { ...source, freshness: "unknown", currentVersion: null, state: undefined },
    }),
    "suspect",
  );
  assert.equal(
    relationFreshnessAtCut({
      anchor: "source",
      target,
      targetObservedVersion: 8,
      source: { ...source, freshness: "orphaned", currentVersion: null, state: undefined },
    }),
    "orphaned",
  );
  // A source kind with no lifecycle state at the cut counts on presence alone.
  assert.equal(
    relationFreshnessAtCut({
      anchor: "source",
      target,
      targetObservedVersion: 8,
      source: { ...source, state: undefined },
    }),
    "current",
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

test("current edges are active and not refused at the same projection cut", () => {
  assert.equal(relationIsCurrent({ state: "active", strength: "strong", freshness: "current" }), true);
  assert.equal(relationIsCurrent({ state: "retired", strength: "strong", freshness: "current" }), false);
  assert.equal(relationIsCurrent({ state: "active", strength: "strong", freshness: "suspect" }), false);
  assert.equal(relationIsCurrent({ state: "active", strength: "weak", freshness: "suspect" }), true);
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
