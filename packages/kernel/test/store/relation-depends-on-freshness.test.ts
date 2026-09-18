// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import type { FactEventDraftV1 } from "../../src/domain/fact-event.ts";
import type { TaskEventV1 } from "../../src/domain/task-lifecycle-event.ts";
import type { TaskV2 } from "../../src/domain/task.ts";
import { blockingOf } from "../../src/domain/task-blocking.ts";
import { withTempStore } from "./helpers.ts";

import {
  accepted,
  actor,
  applyDecision,
  applyFact,
  fact,
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

function reclassified(revision: number): FactEventDraftV1 {
  return {
    ...fact(revision),
    type: "fact_reclassified",
    payload: { ...fact(revision).payload, domainTypes: ["evidence"], reclassificationRationale: "retag" },
  };
}

test("depends-on freshness follows target presence; blocking keeps consuming it across target versions", () => {
  withTempStore((rootDir) => {
    const fixture = projectionFixture(rootDir),
      apply = (event: TaskEventV1) => {
        fixture.appendEvent(event);
        fixture.projection.apply(event);
      },
      dependsOnEdge = relation({
        source: "task/task_waiting",
        target: "task/task_prerequisite",
        type: "depends-on",
      }),
      evidenceEdge = relation({
        source: "decision/dec_DEP/C1",
        target: "fact/F-DEADBEEF",
        type: "evidenced-by",
      }),
      rowOf = (relationId: string) =>
        fixture.projection.readRelationQuery({}).rows.find((row) => row.relationId === relationId)!;

    // Both tasks and the fact exist before the edges are declared.
    apply(taskCreated(1, "task_waiting"));
    const prerequisite = taskCreated(2, "task_prerequisite");
    apply(prerequisite);
    apply(taskTransitioned(3, prerequisite.payload.task, "active"));
    applyDecision(fixture, proposal(4, "dec_DEP"));
    applyFact(fixture, {
      ...fact(5),
      payload: { ...fact(5).payload, registersDomainType: "evidence" },
    });
    // Edge creation pins the target's then-current version (rev 3 for the task).
    applyDecision(fixture, related(6, "dec_DEP", dependsOnEdge));
    applyDecision(fixture, related(7, "dec_DEP", evidenceEdge));
    applyDecision(fixture, accepted(8, "dec_DEP"));
    // The prerequisite task advances its own version several more times.
    apply(taskTransitioned(9, { ...prerequisite.payload.task, status: "active" }, "blocked"));
    apply(taskTransitioned(10, { ...prerequisite.payload.task, status: "blocked" }, "active"));

    // dec_EB379558A2B33134197859FECF/CH1: task progress does not stale the depends-on edge.
    const edgeRow = rowOf(dependsOnEdge.relation_id);
    assert.equal(edgeRow.freshness, "current");
    // The blocking consumer reads the same edge and keeps the source task blocked.
    const assessment = blockingOf(
      [
        { taskId: "task_waiting", status: "active" },
        { taskId: "task_prerequisite", status: "active" },
      ],
      [edgeRow],
    ).find((entry) => entry.taskId === "task_waiting")!;
    assert.equal(assessment.state, "blocked");
    assert.deepEqual(
      assessment.blockers.map((blocker) => blocker.targetTaskId),
      ["task_prerequisite"],
    );

    // Negative control: a target-anchored evidenced-by edge still goes suspect when the
    // fact's version advances — no other relation type moved to the presence anchor.
    applyFact(fixture, reclassified(11));
    assert.equal(rowOf(evidenceEdge.relation_id).freshness, "suspect");
  });
});
