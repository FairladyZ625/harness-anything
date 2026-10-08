// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { deriveRelationId } from "../../src/domain/entity-relation.ts";
import { parseEntityRef } from "../../src/domain/entity-ref.ts";
import {
  compileRelationCreatedEvent,
  reduceRelationEntity,
  validateCurrentRelationEvent,
  validateRelationEvent,
  type RelationEventV1,
} from "../../src/domain/relation-event.ts";
import { parseCanonicalEvent, serializeCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";
import { validateCurrentCanonicalEvent } from "../../src/domain/doc-sync-canonical-events.ts";

const oldRef = "software/coding/external-issue@1/ISSUE-0123456789abcdef";
function fixture(source: string, target = "task/task_fixture"): RelationEventV1 {
  const identity = { source, target, type: "relates" as const, direction: "directed" as const };
  return {
    schema: "relation-event/v1",
    eventId: "event-historical-artifact",
    opId: "historical-artifact",
    relationId: deriveRelationId(identity),
    workspaceRevision: 1,
    occurredAt: "2026-09-03T00:00:00.000Z",
    actor: { principal: { personId: "person-fixture" }, executor: null },
    source: "local",
    type: "relation_created",
    payload: {
      relation: {
        ...identity,
        relation_id: deriveRelationId(identity),
        origin: "declared",
        rationale: "An accepted historical artifact relation.",
        state: "active",
        targetObservedVersion: null,
      },
    },
  };
}

test("historical versioned artifact endpoints retain their bytes and identity through canonical read and replay", () => {
  for (const event of [fixture(oldRef), fixture("task/task_fixture", oldRef)]) {
    assert.deepEqual(validateRelationEvent(event), []);
    const bytes = serializeCanonicalEvent(event);
    assert.deepEqual(parseCanonicalEvent(bytes), event);
    assert.equal(serializeCanonicalEvent(parseCanonicalEvent(bytes)), bytes);
    const entity = reduceRelationEntity(null, event);
    assert.equal(entity.id, event.relationId);
    assert.equal(entity.source, event.payload.relation.source);
    assert.equal(entity.target, event.payload.relation.target);
    assert.equal(entity.strength, "weak");
    assert.ok(validateCurrentRelationEvent(event).length > 0);
    assert.ok(validateCurrentCanonicalEvent(event).length > 0);
    assert.throws(
      () =>
        compileRelationCreatedEvent({
          record: event.payload.relation,
          actor: event.actor,
          source: event.source,
          opId: event.opId,
          occurredAt: event.occurredAt,
          workspaceRevision: event.workspaceRevision,
        }),
      /canonical registered Entity refs/u,
    );
  }
  assert.equal(parseEntityRef(oldRef), null);
});

test("historical relation reads still reject malformed, external and inconsistent endpoint identities", () => {
  for (const ref of [
    oldRef.replace("@1", "@0"),
    oldRef.replace("@1", "@01"),
    oldRef.replace("@1", ""),
    `${oldRef}0`,
    `${oldRef}/anchor`,
    `other:${oldRef}`,
    "unknown/not-a-task",
  ])
    assert.ok(validateRelationEvent(fixture(ref)).length > 0, ref);
  const event = fixture(oldRef);
  assert.ok(
    validateRelationEvent({
      ...event,
      payload: {
        relation: { ...event.payload.relation, target: "task/task_different" },
      },
    }).length > 0,
  );
});
