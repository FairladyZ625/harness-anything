// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import type { DecisionEventDraftV1 } from "../../src/domain/decision-event-types.ts";
import type { TaskEventV1 } from "../../src/domain/task-lifecycle-event.ts";
import type { TaskV2 } from "../../src/domain/task.ts";
import { withTempStore } from "./helpers.ts";

import {
  accepted,
  actor,
  applyDecision,
  claim,
  projectionFixture,
  proposal,
  relation,
  related,
  taskCreated,
} from "./relation-graph-projection.fixtures.ts";

function taskTransitioned(revision: number, task: TaskV2, status: TaskV2["status"]): TaskEventV1 {
  return {
    schema: "task-event/v1",
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    opId: `op-transition-${revision}`,
    taskId: task.taskId,
    type: "task_transitioned",
    actor,
    source: "local",
    occurredAt: "2026-08-13T00:00:00.000Z",
    payload: {
      task: { ...task, status },
      mutation: { command: "transition", reason: "fixture advance", fields: ["status"] },
      documentClaims: [],
    },
  } as TaskEventV1;
}

function superseded(revision: number, decisionId: string): DecisionEventDraftV1 {
  return {
    ...accepted(revision, decisionId),
    type: "decision_superseded",
    payload: { reason: "Replaced by a later ruling." },
  };
}

test("derives freshness follows the source decision, not the target task version", () => {
  withTempStore((rootDir) => {
    const fixture = projectionFixture(rootDir),
      apply = (event: TaskEventV1) => {
        fixture.appendEvent(event);
        fixture.projection.apply(event);
      },
      derivesEdge = relation({
        source: "decision/dec_DERIVES/CH1",
        target: "task/task_derives_target",
        type: "derives",
      }),
      refinesEdge = relation({
        source: "decision/dec_DERIVES/CH1",
        target: "decision/dec_OTHER",
        type: "refines",
      }),
      freshnessOf = (relationId: string) =>
        fixture.projection.readRelationQuery({}).rows.find((row) => row.relationId === relationId)?.freshness;

    // The target task exists before the edge and keeps advancing afterwards.
    const created = taskCreated(1, "task_derives_target");
    apply(created);
    apply(taskTransitioned(2, created.payload.task, "active"));
    applyDecision(fixture, proposal(3, "dec_DERIVES"));
    applyDecision(fixture, proposal(4, "dec_OTHER"));
    // Edge creation pins the target's then-current version (rev 2 for the task).
    applyDecision(fixture, related(5, "dec_DERIVES", derivesEdge));
    applyDecision(fixture, related(6, "dec_DERIVES", refinesEdge));
    applyDecision(fixture, accepted(7, "dec_DERIVES"));
    applyDecision(fixture, accepted(8, "dec_OTHER"));
    // The task advances its own version several more times.
    apply(taskTransitioned(9, { ...created.payload.task, status: "active" }, "blocked"));
    apply(taskTransitioned(10, { ...created.payload.task, status: "blocked" }, "done"));

    // dec_D6970DC1303EF90E8B4855FC80/CH1: task progress does not stale the derives edge.
    assert.equal(freshnessOf(derivesEdge.relation_id), "current");
    // refines stays target-anchored: the target decision's revision moved since the pin.
    assert.equal(freshnessOf(refinesEdge.relation_id), "suspect");

    // The source decision being superseded is what stales a derives edge.
    applyDecision(fixture, superseded(11, "dec_DERIVES"));
    assert.equal(freshnessOf(derivesEdge.relation_id), "suspect");

    // A decision event that bumps the target's revision keeps refines suspect — identical
    // to the pre-change target-anchored behavior.
    applyDecision(fixture, claim(12, "dec_OTHER"));
    assert.equal(freshnessOf(refinesEdge.relation_id), "suspect");
  });
});
