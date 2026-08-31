// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveRelationId,
  runtimeTaskExecutionRelation,
  type AgentRuntimeEventV1,
  type MigrationImportEventV1,
} from "../../kernel/src/index.ts";
import { planEmbeddedRelationRestatements } from "../src/embedded-relation-restatement.ts";

const actor = { principal: { personId: "person_zeyu" }, executor: null } as const;
const identity = {
  source: "runtime-session/runtime_fixture",
  target: "task/task_fixture",
  type: "executes" as const,
  direction: "directed" as const,
};
const relationId = deriveRelationId(identity);
const migrationEvent: MigrationImportEventV1 = {
  schema: "migration-import-event/v1",
  eventId: "event-migration-relation",
  workspaceRevision: 1,
  opId: "migration-runtime-relation",
  type: "entity_migrated",
  actor,
  source: "migration-import/v1",
  occurredAt: "2026-08-31T00:00:00.000Z",
  payload: {
    migratedFrom: relationId,
    generation: "v0",
    entity: {
      kind: "relation",
      ownerRef: identity.source,
      relation: {
        relation_id: relationId,
        ...identity,
        strength: "strong",
        origin: "imported_snapshot",
        state: "active",
        rationale: "Authenticated runtime handoff.",
      },
    },
  },
};
const taskBindingEvent: AgentRuntimeEventV1 = {
  schema: "agent-runtime-event/v1",
  eventId: "event-runtime-task-binding",
  workspaceRevision: 2,
  opId: "migration-runtime-task-binding",
  type: "runtime_session_task_bound",
  actor,
  source: "migration-import/v1",
  occurredAt: "2026-08-30T15:51:46.589Z",
  payload: {
    runtimeSessionId: "runtime_fixture",
    taskId: "task_fixture",
    executionId: "exe_fixture",
    providerSessionId: "provider_fixture",
    transcriptRef: "file:.harness/runtime/fixture.jsonl",
  },
};

test("embedded relation restatement aligns runtime execution identity and is idempotent", () => {
  const derived = runtimeTaskExecutionRelation("runtime_fixture", "task_fixture");
  assert.notDeepEqual(migrationEvent.payload.entity.relation, derived);

  const plan = planEmbeddedRelationRestatements([migrationEvent]);
  assert.equal(plan.differences.length, 1);
  assert.deepEqual(plan.differences[0]?.changedFields, ["origin", "rationale"]);
  assert.equal(plan.differences[0]?.migrationOpId, migrationEvent.opId);
  assert.equal(plan.differences[0]?.derivedOpId, "contract:runtime-session-task-binding");
  assert.equal(plan.differences[0]?.derivedRevision, null);
  assert.equal(plan.differences[0]?.derivedSource, "runtime-session-task-binding-contract");
  const rewritten = plan.rewrites.get(migrationEvent.opId);
  assert.ok(rewritten);
  assert.equal(rewritten.eventId, migrationEvent.eventId);
  assert.equal(rewritten.workspaceRevision, migrationEvent.workspaceRevision);
  assert.equal(rewritten.payload.migratedFrom, migrationEvent.payload.migratedFrom);
  assert.equal(rewritten.payload.entity.kind, "relation");
  if (rewritten.payload.entity.kind === "relation") {
    assert.equal(rewritten.payload.entity.relation.origin, "generated");
    assert.equal(rewritten.payload.entity.relation.rationale, "Runtime session is bound to the task execution.");
  }

  assert.deepEqual(rewritten.payload.entity.relation, derived);

  const repeat = planEmbeddedRelationRestatements([rewritten, taskBindingEvent]);
  assert.equal(repeat.differences.length, 0);
  assert.equal(repeat.rewrites.size, 0);
});
