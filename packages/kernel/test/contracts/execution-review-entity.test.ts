// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { compileEntityUpsert } from "../../src/domain/entity-event.ts";
import {
  interpretEmbeddedEntityProjections,
  type EntityProjectionContract,
} from "../../src/domain/entity-kind-projection.ts";
import { explainEntityKind, getEntityKindContract } from "../../src/domain/entity-kind-registry.ts";
import { isAllowedRelationKindTriple } from "../../src/domain/entity-relation.ts";
import { parseEntityRef } from "../../src/domain/entity-ref.ts";

const actor = { principal: { personId: "person-1" }, executor: { kind: "agent" as const, id: "agent-1" } };

test("execution and review are dependency-free EntityKindContracts with lifecycle relations", () => {
  const execution = {
      schema: "execution/v1",
      executionId: "exe_01KXZ6PY19GBXMBRHBXQT3Q0DH",
      taskId: "task_01j00000000000000000000000",
      nodeId: "implementation",
      iteration: 0,
      state: "active",
      actor,
      claimedAt: "2026-08-25T00:00:00.000Z",
      submittedAt: null,
      closedAt: null,
      submission: null,
    },
    review = {
      schema: "review/v1",
      reviewId: "rev_88E36DD4172ECC8AC1C0FF318A",
      taskId: execution.taskId,
      executionId: execution.executionId,
      verdict: "approved",
      actor,
      capabilityRef: "execution-review@v1",
      reason: "checked",
      evidenceChecked: ["test"],
      commitSha: "a".repeat(40),
      iteration: 0,
      contentDigest: `sha256:${"b".repeat(64)}`,
      reviewedAt: execution.claimedAt,
    },
    runtimeSession = {
      schema: "runtime-session/v1",
      runtimeSessionId: "runtime_session1",
      taskBindings: [],
      liveness: "live",
      outcome: null,
      semanticState: "running",
    },
    agent = {
      schema: "agent-declaration/v1",
      id: "agent-valid",
      name: "Valid Agent",
      instructions: "Work precisely.",
      runtime_type: "codex",
    },
    squad = {
      schema: "squad-declaration/v1",
      id: "squad-valid",
      name: "Valid Squad",
      leader: agent.id,
      workers: [agent.id],
      leaderTurnBudget: 8,
      roster: "# Valid Squad",
    },
    base = {
      eventId: "event-1",
      opId: "op-1",
      workspaceRevision: 1,
      actor: { principal: { personId: "person-1" }, executor: null },
      source: "local" as const,
      occurredAt: execution.claimedAt,
    };

  assert.equal(getEntityKindContract("execution")?.id.field, "executionId");
  assert.equal(getEntityKindContract("review")?.id.field, "reviewId");
  assert.deepEqual(getEntityKindContract("execution")?.authoring, {
    kind: "task-lifecycle",
    contractRef: "task-event/v1",
  });
  assert.deepEqual(getEntityKindContract("review")?.authoring, {
    kind: "task-lifecycle",
    contractRef: "task-event/v1",
  });
  assert.deepEqual(getEntityKindContract("runtime-session")?.authoring, {
    kind: "agent-runtime-event",
    contractRef: "agent-runtime-event/v1",
  });
  assert.deepEqual(getEntityKindContract("execution")?.canonicalProjection, {
    embeddedEvents: [
      {
        schema: "task-event/v1",
        types: [
          "execution_started",
          "lease_renewed",
          "execution_submitted",
          "execution_executor_declared",
          "review_recorded",
          "review_consent_recorded",
          "code_doc_reconciled",
          "code_doc_repointed",
          "completion_gate_verified",
          "task_completed",
          "lease_released",
        ],
        payloadField: "execution",
      },
    ],
    row: { idField: "executionId", ownerField: "taskId" },
  });
  assert.deepEqual(getEntityKindContract("review")?.canonicalProjection, {
    embeddedEvents: [
      {
        schema: "task-event/v1",
        types: ["review_recorded", "review_consent_recorded"],
        payloadField: "review",
      },
    ],
    row: { idField: "reviewId", ownerField: "taskId" },
  });
  assert.deepEqual(explainEntityKind("execution").relations, {
    directions: ["directed"],
    edges: [
      {
        type: "executes",
        sourceKind: "execution",
        targetKind: "task",
        projection: {
          source: { field: "executionId", refTemplate: "execution/{id}" },
          target: { field: "taskId", refTemplate: "task/{id}" },
          direction: "directed",
          strength: "strong",
          origin: "generated",
          rationale: "Execution belongs to its task lifecycle.",
        },
      },
    ],
  });
  assert.deepEqual(explainEntityKind("review").relations, {
    directions: ["directed"],
    edges: [
      {
        type: "reviews",
        sourceKind: "review",
        targetKind: "execution",
        projection: {
          source: { field: "reviewId", refTemplate: "review/{id}" },
          target: { field: "executionId", refTemplate: "execution/{id}" },
          direction: "directed",
          strength: "strong",
          origin: "generated",
          rationale: "Review records judgment for its execution.",
        },
      },
    ],
  });
  assert.throws(
    () => compileEntityUpsert({ ...base, entityKind: "execution", entity: execution }),
    /execution.*no generic entity-store surface/u,
  );
  assert.throws(
    () => compileEntityUpsert({ ...base, entityKind: "review", entity: review }),
    /review.*no generic entity-store surface/u,
  );
  assert.throws(
    () => compileEntityUpsert({ ...base, entityKind: "runtime-session", entity: runtimeSession }),
    /runtime-session.*no generic entity-store surface/u,
  );
  assert.doesNotThrow(() => compileEntityUpsert({ ...base, entityKind: "agent", entity: agent }));
  assert.doesNotThrow(() => compileEntityUpsert({ ...base, entityKind: "squad", entity: squad }));
  assert.throws(
    () => compileEntityUpsert({ ...base, entityKind: "agent", entity: { ...agent, id: "" } }),
    /lowercase entity slug|invalid|pattern|non-empty/u,
  );
  assert.throws(
    () => compileEntityUpsert({ ...base, entityKind: "agent", entity: { ...agent, id: "agent/bad" } }),
    /lowercase entity slug|invalid|pattern/u,
  );
  assert.throws(
    () => compileEntityUpsert({ ...base, entityKind: "squad", entity: { ...squad, id: "" } }),
    /lowercase entity slug|invalid|pattern|non-empty/u,
  );
  assert.throws(
    () => compileEntityUpsert({ ...base, entityKind: "squad", entity: { ...squad, id: "squad.bad" } }),
    /lowercase entity slug|invalid|pattern/u,
  );

  assert.equal(isAllowedRelationKindTriple("execution", "executes", "task"), true);
  assert.equal(isAllowedRelationKindTriple("review", "reviews", "execution"), true);
  assert.equal(isAllowedRelationKindTriple("task", "executes", "execution"), false);
  assert.deepEqual(parseEntityRef(`execution/${execution.executionId}`)?.kind, "execution");
  assert.deepEqual(parseEntityRef(`review/${review.reviewId}`)?.kind, "review");
  assert.equal(parseEntityRef(`execution/${execution.taskId}/${execution.executionId}`), null);
  assert.equal(parseEntityRef(`review/${execution.executionId}/${review.reviewId}`), null);
});

test("a synthetic third contract drives the same embedded projection interpreter", () => {
  const contract = {
    kind: "artifact",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "Artifact/v1",
      type: "object",
      properties: {
        artifactId: { type: "string", minLength: 1 },
        taskId: { type: "string", minLength: 1 },
      },
      required: ["artifactId", "taskId"],
      additionalProperties: false,
    },
    id: { field: "artifactId", pattern: "^artifact-", refTemplate: "artifact/{id}" },
    canonicalProjection: {
      embeddedEvents: [{ schema: "fixture-event/v1", types: ["artifact_written"], payloadField: "artifact" }],
      row: { idField: "artifactId", ownerField: "taskId" },
    },
    relations: {
      directions: ["directed"],
      edges: [
        {
          type: "produces",
          sourceKind: "artifact",
          targetKind: "task",
          projection: {
            source: { field: "artifactId", refTemplate: "artifact/{id}" },
            target: { field: "taskId", refTemplate: "task/{id}" },
            direction: "directed",
            strength: "strong",
            origin: "generated",
            rationale: "Fixture artifact belongs to its task.",
          },
        },
      ],
    },
  } as const satisfies EntityProjectionContract;
  const [projection] = interpretEmbeddedEntityProjections(contract, {
    schema: "fixture-event/v1",
    type: "artifact_written",
    opId: "op-artifact",
    workspaceRevision: 17,
    payload: { artifact: { artifactId: "artifact-1", taskId: "task-1" } },
  });
  assert.deepEqual(
    {
      kind: projection?.kind,
      id: projection?.id,
      ownerId: projection?.ownerId,
      sourceRef: projection?.relations[0]?.sourceRef,
      targetRef: projection?.relations[0]?.targetRef,
      relationType: projection?.relations[0]?.relationType,
    },
    {
      kind: "artifact",
      id: "artifact-1",
      ownerId: "task-1",
      sourceRef: "artifact/artifact-1",
      targetRef: "task/task-1",
      relationType: "produces",
    },
  );
  assert.equal(containsFunction(contract.canonicalProjection), false);
  assert.equal(getEntityKindContract("runtime-session")?.canonicalProjection, null);
  assert.equal(getEntityKindContract("runtime-session")?.relations.edges[0]?.projection, undefined);
});

function containsFunction(value: unknown): boolean {
  if (typeof value === "function") return true;
  if (Array.isArray(value)) return value.some(containsFunction);
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some(containsFunction);
}
