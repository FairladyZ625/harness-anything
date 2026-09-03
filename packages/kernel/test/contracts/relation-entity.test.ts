// harness-test-tier: contract
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  deriveRelationId,
  getEntityKindContract,
  getExecutableEntityAction,
  relationEventWritePlan,
  validateMigrationImportEvent,
  type MigrationImportEventV1,
} from "../../src/index.ts";
import { validateCurrentMigrationImportEvent } from "../../src/domain/migration-import-event.ts";
import { type EntityRelationRecord, type GovernedRelationRegistryWitness } from "../../src/domain/entity-relation.ts";
import {
  compileRelationCreatedEvent,
  compileRelationReconfirmedEvent,
  compileRelationRetiredEvent,
  reduceRelationEntity,
  type RelationEventV1,
  validateCurrentRelationEvent,
} from "../../src/domain/relation-event.ts";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";
import {
  applyRelationProjectionEvent,
  readRelationProjectionRows,
  RELATION_PROJECTION_VERSION,
} from "../../src/projection/relation-entity-projection.ts";
import { markEntityProjectionMissing } from "../../src/projection/rebuildable-task-projection-entities.ts";

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
    strength: "weak",
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
  for (const ingress of ["relation-relate", "relation-unrelate", "relation-reconfirm"]) {
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
      record: eventRecord(relation, 5),
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
  assert.equal(first.strength, "weak");
  assert.equal(first.targetObservedVersion, 5);
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.updatedAt, retired.occurredAt);
  assert.equal(second.revision, 9);
  assert.equal(second.state, "retired");

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
          relation: { ...relation, origin: "imported_snapshot", state: "edge_retired" as never },
          ownerRef: relation.source,
        },
      },
    };
  assert.deepEqual(validateMigrationImportEvent(migrated), [], "the frozen migration remains a readable event");
  assert.notDeepEqual(validateCurrentMigrationImportEvent(migrated), [], "new migration writes reject the old state");
  // History carrying the retired lifecycle word is upcast once by `ha migrate relation-events`;
  // replay no longer translates it.
  assert.throws(() => reduceRelationEntity(null, migrated), /Relation facet is invalid/u);
  const upcast = {
      ...migrated,
      payload: {
        ...migrated.payload,
        entity: {
          ...migrated.payload.entity,
          relation: { ...migrated.payload.entity.relation, state: "retired" as const },
        },
      },
    },
    entity = reduceRelationEntity(null, upcast);
  assert.equal(entity.id, relation.relation_id);
  assert.equal(entity.origin, "imported_snapshot");
  assert.equal(entity.state, "retired");
  assert.equal(entity.revision, 11);
  assert.throws(
    () =>
      reduceRelationEntity(null, {
        ...migrated,
        payload: {
          ...migrated.payload,
          entity: {
            ...migrated.payload.entity,
            relation: { ...migrated.payload.entity.relation, state: "deleted" as never },
          },
        },
      }),
    /Relation facet is invalid/u,
  );

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
        relation: eventRecord(replacementRecord, 11),
        reason: "Endpoint moved to the successor task.",
      },
    };
  assert.deepEqual(validateCurrentRelationEvent(replacement), []);
  const replaced = reduceRelationEntity(null, replacement);
  assert.equal(replaced.id, replacementRecord.relation_id);
  assert.equal(replaced.retirementReason, replacement.payload.reason);
});

test("a governed migration witness admits only its pinned artifact Relation direction", () => {
  const sourceRef = "software/coding/architecture-decision-record@1/ADR-1234567890ABCDEF",
    relation = record(sourceRef, "decision/dec_ADR_0001_TEST"),
    registry: GovernedRelationRegistryWitness = {
      schema: "governed-relation-registry-witness/v1",
      registryRevision: `sha256:${"a".repeat(64)}`,
      artifactEndpoints: [
        {
          kind: "software/coding/architecture-decision-record@1",
          idPattern: "^ADR-[A-F0-9]{16}$",
          refTemplate: "software/coding/architecture-decision-record@1/{id}",
        },
      ],
      direction: {
        type: "relates",
        sourceKind: "software/coding/architecture-decision-record@1",
        targetKind: "decision",
        reads: "the architecture decision record relates to the target decision",
        registration: "ratified",
        strength: "weak",
        governance: {
          decisionClaimRef: "decision/dec_RELATION_GOVERNANCE/CH1",
          decisionContentPin: `sha256:${"b".repeat(64)}`,
        },
      },
    },
    migrated: MigrationImportEventV1 = {
      schema: "migration-import-event/v1",
      eventId: "event-governed-relation-migration",
      workspaceRevision: 17,
      opId: "governed-relation-migration",
      type: "entity_migrated",
      actor,
      source: "migration-import/v1",
      occurredAt: "2026-09-02T00:00:00.000Z",
      payload: {
        migratedFrom: "adr-cutover:test",
        generation: "v0",
        entity: {
          kind: "relation",
          relation: { ...relation, origin: "imported_snapshot" },
          ownerRef: sourceRef,
          registry,
        },
      },
    };
  assert.deepEqual(validateCurrentMigrationImportEvent(migrated), []);
  assert.equal(reduceRelationEntity(null, migrated).source, sourceRef);
  assert.notDeepEqual(
    validateCurrentMigrationImportEvent({
      ...migrated,
      payload: {
        ...migrated.payload,
        entity: {
          ...migrated.payload.entity,
          registry: { ...registry, direction: { ...registry.direction, targetKind: "task" } },
        },
      },
    }),
    [],
  );
});

test("relation_reconfirmed advances only the pinned target witness", () => {
  const relation = record(),
    created = compileRelationCreatedEvent({
      record: eventRecord(relation, 7),
      actor,
      source,
      opId: "relation-reconfirm-genesis",
      occurredAt: "2026-08-31T05:00:00.000Z",
      workspaceRevision: 13,
    }),
    reconfirmed = compileRelationReconfirmedEvent({
      relationId: relation.relation_id,
      priorTargetVersion: 7,
      targetObservedVersion: 12,
      rationale: "Reviewed the target changes.",
      actor,
      source,
      opId: "relation-reconfirm-contract",
      occurredAt: "2026-08-31T06:00:00.000Z",
      workspaceRevision: 14,
    }),
    first = reduceRelationEntity(null, created),
    second = reduceRelationEntity(first, reconfirmed);
  assert.deepEqual(validateCurrentRelationEvent(reconfirmed), []);
  assert.equal(second.targetObservedVersion, 12);
  assert.equal(second.reconfirmationRationale, "Reviewed the target changes.");
  assert.equal(second.strength, "weak");
  assert.throws(
    () => reduceRelationEntity({ ...first, targetObservedVersion: 8 }, reconfirmed),
    /prior target version/u,
  );
});

test("an entity_target_missing projection makes every inbound Relation orphaned at the same cut", () => {
  const db = new DatabaseSync(":memory:");
  createRelationGraphProjectionTables(db);
  db.exec(
    "CREATE TABLE entity_projection (entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, task_id TEXT, " +
      "workspace_revision INTEGER NOT NULL, freshness TEXT NOT NULL, current_version, value_json TEXT NOT NULL, " +
      "PRIMARY KEY(entity_kind, entity_id))",
  );
  db.prepare("INSERT INTO entity_projection VALUES ('runtime-session', 'target', NULL, 4, 'current', 4, '{}')").run();
  const created = ["source-a", "source-b"].map((sourceId, index) => {
    const identity = {
      source: `agent/${sourceId}`,
      target: "runtime-session/target",
      type: "dispatches" as const,
      direction: "directed" as const,
    };
    return compileRelationCreatedEvent({
      record: {
        relation_id: deriveRelationId(identity),
        ...identity,
        origin: "declared",
        state: "active",
        rationale: "The Agent dispatched the target session.",
        targetObservedVersion: 4,
      },
      actor,
      source,
      opId: `relation-target-missing-${String(index)}`,
      occurredAt: "2026-08-31T07:00:00.000Z",
      workspaceRevision: 5 + index,
    });
  });
  created.forEach((event) => applyRelationProjectionEvent(db, event));
  assert.equal(
    readRelationProjectionRows(db).every(({ freshness }) => freshness === "current"),
    true,
  );
  markEntityProjectionMissing(db, "runtime-session", "target", 7);
  const orphaned = readRelationProjectionRows(db);
  assert.equal(orphaned.length, 2);
  assert.equal(
    orphaned.every(({ freshness }) => freshness === "orphaned"),
    true,
  );
  assert.equal(
    orphaned.every(({ currentTargetVersion }) => currentTargetVersion === null),
    true,
  );
  db.close();
});

function eventRecord(relation: EntityRelationRecord, targetObservedVersion: number) {
  const { strength: _strength, ...recordWithoutStrength } = relation;
  return { ...recordWithoutStrength, targetObservedVersion };
}
