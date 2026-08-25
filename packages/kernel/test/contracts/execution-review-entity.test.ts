// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { compileEntityUpsert } from "../../src/domain/entity-event.ts";
import { explainEntityKind, getEntityKindContract } from "../../src/domain/entity-kind-registry.ts";
import { isAllowedRelationKindTriple } from "../../src/domain/entity-relation.ts";
import { parseEntityRef } from "../../src/domain/entity-ref.ts";

const actor = { principal: { personId: "person-1" }, executor: { kind: "agent" as const, id: "agent-1" } };

test("execution and review are dependency-free EntityKindContracts with lifecycle relations", () => {
  const execution = {
      schema: "execution/v1",
      executionId: "exe_01j00000000000000000000000",
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
      reviewId: "rev_01j00000000000000000000000",
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
  assert.deepEqual(explainEntityKind("execution").relations, {
    directions: ["directed"],
    edges: [{ type: "executes", sourceKind: "execution", targetKind: "task" }],
  });
  assert.deepEqual(explainEntityKind("review").relations, {
    directions: ["directed"],
    edges: [{ type: "reviews", sourceKind: "review", targetKind: "execution" }],
  });
  assert.doesNotThrow(() => compileEntityUpsert({ ...base, entityKind: "execution", entity: execution }));
  assert.doesNotThrow(() => compileEntityUpsert({ ...base, entityKind: "review", entity: review }));
  assert.throws(
    () => compileEntityUpsert({ ...base, entityKind: "execution", entity: { ...execution, executionId: "" } }),
    /invalid|pattern|non-empty/u,
  );

  assert.equal(isAllowedRelationKindTriple("execution", "executes", "task"), true);
  assert.equal(isAllowedRelationKindTriple("review", "reviews", "execution"), true);
  assert.equal(isAllowedRelationKindTriple("task", "executes", "execution"), false);
  assert.deepEqual(parseEntityRef(`execution/${execution.taskId}/${execution.executionId}`)?.kind, "execution");
  assert.deepEqual(parseEntityRef(`review/${execution.executionId}/${review.reviewId}`)?.kind, "review");
});
