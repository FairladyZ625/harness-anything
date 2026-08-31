// harness-test-tier: contract
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  compileRelationCreatedEvent,
  compileRelationRetiredEvent,
  deriveRelationId,
  getEntityKindContract,
  getExecutableEntityAction,
  reduceRelationEntity,
  relationEventWritePlan,
  validateCurrentRelationEvent,
  type EntityRelationRecord,
  type MigrationImportEventV1,
  type RelationEventV1,
} from "../../src/index.ts";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";
import {
  applyRelationProjectionEvent,
  readRelationProjectionRows,
  RELATION_PROJECTION_VERSION,
} from "../../src/projection/relation-entity-projection.ts";

const actor = {
  principal: { personId: "person-relation-contract" },
  executor: { kind: "agent", id: "agent-relation-contract" },
} as const;
const source = "local" as const;

function record(
  sourceRef = "relation/rel_1111111111111111",
  targetRef = "decision/dec_RELATION_TARGET",
): EntityRelationRecord {
  const identity = { source: sourceRef, target: targetRef, type: "relates" as const, direction: "directed" as const };
  return {
    relation_id: deriveRelationId(identity),
    ...identity,
    strength: "strong",
    origin: "declared",
    rationale: "First-class Relation endpoint contract.",
    state: "active",
  };
}

test("Relation kind and actions expose the BaseEntity and G1 concurrency contracts", () => {
  const contract = getEntityKindContract("relation")!;
  assert.equal(contract.id.refTemplate, "relation/{id}");
  assert.deepEqual(contract.residency, { history: "ledger", graph: "projection" });
  assert.equal(contract.relationEndpoint.eligible, true);
  for (const ingress of ["relation-relate", "relation-unrelate"]) {
    const action = getExecutableEntityAction(ingress)!;
    assert.equal(action.target.kind, "relation");
    assert.equal(action.input.schema, "entity-action-input/v1");
    assert.deepEqual(action.concurrency.expectedVersion, {
      authority: "relation-aggregate-revision",
      required: true,
    });
    assert.deepEqual(action.concurrency.artifactOwnership, {
      owner: "initiating-execution",
      refTemplate: "execution/{executionId}",
    });
  }
  assert.equal(getExecutableEntityAction("task-relate"), undefined);
  assert.equal(getExecutableEntityAction("decision-relate"), undefined);
});

test("native Relation history reduces and projects one versioned aggregate row", () => {
  const relation = record(),
    created = compileRelationCreatedEvent({
      record: relation,
      actor,
      source,
      opId: "relation-create-contract",
      occurredAt: "2026-08-31T01:00:00.000Z",
      workspaceRevision: 7,
    }),
    retired = compileRelationRetiredEvent({
      relationId: relation.relation_id,
      reason: "No longer load-bearing.",
      actor,
      source,
      opId: "relation-retire-contract",
      occurredAt: "2026-08-31T02:00:00.000Z",
      workspaceRevision: 9,
    });
  assert.deepEqual(validateCurrentRelationEvent(created), []);
  assert.deepEqual(validateCurrentRelationEvent(retired), []);
  assert.equal(
    relationEventWritePlan(created).targets.some(({ kind }) => kind === "projection_invalidation"),
    true,
  );

  const first = reduceRelationEntity(null, created),
    second = reduceRelationEntity(first, retired);
  assert.equal(first.kind, "relation");
  assert.equal(first.ref, `relation/${relation.relation_id}`);
  assert.equal(first.revision, 7);
  assert.equal(first.createdAt, created.occurredAt);
  assert.equal(first.provenance.actor.executor?.id, "agent-relation-contract");
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.updatedAt, retired.occurredAt);
  assert.equal(second.revision, 9);
  assert.equal(second.state, "edge_retired");

  const db = new DatabaseSync(":memory:");
  createRelationGraphProjectionTables(db);
  applyRelationProjectionEvent(db, created);
  applyRelationProjectionEvent(db, retired);
  const rows = readRelationProjectionRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.schema, RELATION_PROJECTION_VERSION);
  assert.deepEqual(rows[0]?.entity, second);
  db.close();
});

test("entity_migrated is valid Relation genesis and replacement is an explicit family member", () => {
  const relation = record("relation/rel_3333333333333333", "fact/F-ABCDEFGH"),
    migrated: MigrationImportEventV1 = {
      schema: "migration-import-event/v1",
      eventId: "event-migration-relation-contract",
      workspaceRevision: 11,
      opId: "migration-relation-contract",
      type: "entity_migrated",
      actor,
      source: "migration-import/v1",
      occurredAt: "2026-08-31T03:00:00.000Z",
      payload: {
        migratedFrom: "legacy-relation-contract",
        generation: "v0",
        entity: {
          kind: "relation",
          relation: { ...relation, origin: "imported_snapshot" },
          ownerRef: relation.source,
        },
      },
    };
  const entity = reduceRelationEntity(null, migrated);
  assert.equal(entity.id, relation.relation_id);
  assert.equal(entity.origin, "imported_snapshot");
  assert.equal(entity.revision, 11);

  const replacementRecord = record("relation/rel_2222222222222222", "task/task_REPLACEMENT"),
    replacement: RelationEventV1 = {
      schema: "relation-event/v1",
      eventId: "event-relation-replaced-contract",
      workspaceRevision: 12,
      opId: "relation-replaced-contract",
      relationId: replacementRecord.relation_id,
      type: "relation_replaced",
      actor,
      source,
      occurredAt: "2026-08-31T04:00:00.000Z",
      payload: {
        previousRelationId: relation.relation_id,
        relation: replacementRecord,
        reason: "Endpoint moved to the successor task.",
      },
    };
  assert.deepEqual(validateCurrentRelationEvent(replacement), []);
  const replaced = reduceRelationEntity(null, replacement);
  assert.equal(replaced.id, replacementRecord.relation_id);
  assert.equal(replaced.retirementReason, replacement.payload.reason);
});
