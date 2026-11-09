// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  claimGateRun,
  compileGateRunChange,
  emptyTaskLifecycleSnapshot,
  reduceTaskEvent,
  supersededTaskState,
  type TaskEventV1,
  type TaskLifecycleSnapshot,
} from "../../src/index.ts";
import { serializeTaskEvent } from "../../src/domain/task-lifecycle.contract.ts";
import { implementer, lifecycleFixture } from "../store/task-lifecycle-fixture.ts";

type SupersededEvent = Extract<TaskEventV1, { readonly type: "task_superseded" }>;

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/canonical-events/task-event-v1/accepted-task-superseded-d7291fb4ed55.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as SupersededEvent;

function beforeSupersede(event: SupersededEvent): TaskLifecycleSnapshot {
  const task = event.payload.task;
  return {
    ...emptyTaskLifecycleSnapshot(),
    revision: event.workspaceRevision - 1,
    task: { ...task, status: "active", packageDisposition: "active", supersededBy: null },
  };
}

test("replay never accepts a superseded task as archived+active: legacy payloads land cancelled", () => {
  const replayed = reduceTaskEvent(beforeSupersede(fixture), fixture);
  assert.equal(replayed.task?.status, "cancelled");
  assert.equal(replayed.task?.packageDisposition, "archived");
  assert.equal(replayed.task?.supersededBy, fixture.payload.task.supersededBy);
  assert.notEqual(
    `${replayed.task?.packageDisposition}/${replayed.task?.status}`,
    "archived/active",
    "the archived+active pair must not survive replay",
  );
});

test("current admission rejects the archived+active pair while historical replay stays readable", () => {
  assert.throws(
    () => serializeTaskEvent(fixture),
    /terminal cancelled status, not archived\+active/u,
    "a new supersede event must not record archived+active",
  );
  assert.equal(reduceTaskEvent(beforeSupersede(fixture), fixture).task?.status, "cancelled");
});

test("a gate run recorded after a supersede still replays and leaves the task terminal", () => {
  const gate = {
      gateId: "artifact-check",
      appliesTo: "submission" as const,
      witness: {
        kind: "manual" as const,
        predicateType: "human/v1",
        resultSchema: { type: "object" },
        adapterId: "manual-attest",
        adapterOptions: {},
      },
    },
    fixture = lifecycleFixture({ gates: [gate], complete: false }),
    submitted = fixture.snapshot,
    execution = submitted.executions[0]!,
    requirement = execution.submission!.completionContract.gates[0]!,
    sourceActor = {
      principal: implementer.principal,
      executor: { kind: "agent" as const, id: "completion-source:manual-attest" },
    },
    run = claimGateRun({
      execution,
      repoId: "workspace-1",
      requirement,
      runId: "run-artifact-check",
      claimFence: submitted.revision + 10,
      actor: sourceActor,
      occurredAt: "2026-08-11T00:10:00.000Z",
      expiresAt: "2026-08-11T01:10:00.000Z",
    }),
    historicalSuperseded = {
      ...submitted,
      task: { ...submitted.task!, packageDisposition: "archived" as const, supersededBy: "task-replacement" },
    },
    gateWrite = compileGateRunChange({
      snapshot: historicalSuperseded,
      executionId: execution.executionId,
      run,
      operation: "claim",
      actor: sourceActor,
      source: "local",
      opId: "op-gate-after-supersede",
      eventId: "event-gate-after-supersede",
      workspaceRevision: submitted.revision + 10,
      occurredAt: "2026-08-11T00:10:00.000Z",
      packagePath: null,
      currentDocuments: [],
    }),
    supersedeEvent = {
      ...gateWrite.event,
      type: "task_superseded",
      eventId: "event-supersede-before-gate",
      opId: "op-supersede-before-gate",
      workspaceRevision: submitted.revision + 9,
      occurredAt: "2026-08-11T00:09:00.000Z",
      payload: {
        task: supersededTaskState(submitted.task!, "task-replacement"),
        mutation: {
          command: "supersede",
          reason: "Replacement carries the future work",
          fields: ["status", "supersededBy"],
        },
        documentClaims: [],
      },
    } as unknown as TaskEventV1,
    afterSupersede = reduceTaskEvent(submitted, supersedeEvent),
    replayed = reduceTaskEvent(afterSupersede, gateWrite.event);
  assert.equal(afterSupersede.task?.status, "cancelled");
  assert.equal(replayed.task?.status, "cancelled");
  assert.equal(replayed.task?.supersededBy, "task-replacement");
  assert.equal(replayed.executions[0]?.gateRuns.length, 1);
});

test("a later historical transition cannot reopen a superseded package", () => {
  const afterSupersede = reduceTaskEvent(beforeSupersede(fixture), fixture),
    later = {
      ...fixture,
      type: "task_transitioned",
      eventId: "event-later-transition",
      opId: "op-later-transition",
      workspaceRevision: afterSupersede.revision + 1,
      occurredAt: "2026-09-01T11:00:00.000Z",
      payload: {
        task: { ...afterSupersede.task!, status: "planned" as const },
        mutation: { command: "transition", reason: "Legacy reopen before the terminal rule", fields: ["status"] },
        documentClaims: [],
      },
    } as unknown as TaskEventV1,
    replayed = reduceTaskEvent(afterSupersede, later);
  assert.equal(replayed.task?.status, "cancelled");
  assert.equal(replayed.task?.packageDisposition, "archived");
  assert.equal(replayed.task?.supersededBy, afterSupersede.task?.supersededBy);
});

test("a lease release recorded after a supersede replays against the historical task", () => {
  const fixture = lifecycleFixture(),
    preSupersede = fixture.events.slice(0, 2).reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot()),
    historical = {
      ...preSupersede.task!,
      packageDisposition: "archived" as const,
      supersededBy: "task-replacement",
    },
    supersedeEvent = {
      ...fixture.events[1]!,
      type: "task_superseded",
      eventId: "event-supersede-lease",
      opId: "op-supersede-lease",
      workspaceRevision: preSupersede.revision + 1,
      occurredAt: "2026-08-11T00:20:00.000Z",
      payload: {
        task: supersededTaskState(preSupersede.task!, "task-replacement"),
        mutation: {
          command: "supersede",
          reason: "Replacement carries the future work",
          fields: ["status", "supersededBy"],
        },
        documentClaims: [],
      },
    } as unknown as TaskEventV1,
    afterSupersede = reduceTaskEvent(preSupersede, supersedeEvent),
    leaseRelease = {
      ...fixture.events[1]!,
      type: "lease_released",
      eventId: "event-release-after-supersede",
      opId: "op-release-after-supersede",
      workspaceRevision: afterSupersede.revision + 1,
      occurredAt: "2026-08-11T00:21:00.000Z",
      payload: {
        task: historical,
        execution: preSupersede.executions[0]!,
        releasedLease: preSupersede.lease!,
        mutation: { command: "release", reason: "Lease retired with the package", fields: ["release"] },
        documentClaims: [],
      },
    } as unknown as TaskEventV1,
    replayed = reduceTaskEvent(afterSupersede, leaseRelease);
  assert.equal(replayed.task?.status, "cancelled");
  assert.equal(replayed.task?.supersededBy, "task-replacement");
  assert.equal(replayed.lease, null);
});

test("a supersede event that carries only the terminal status still derives its archived disposition", () => {
  const event = {
      ...fixture,
      payload: {
        ...fixture.payload,
        task: { ...fixture.payload.task, status: "cancelled" as const, packageDisposition: "active" as const },
      },
    },
    replayed = reduceTaskEvent(beforeSupersede(event), event);
  assert.equal(replayed.task?.status, "cancelled");
  assert.equal(replayed.task?.packageDisposition, "archived");
  assert.equal(replayed.task?.supersededBy, event.payload.task.supersededBy);
});
