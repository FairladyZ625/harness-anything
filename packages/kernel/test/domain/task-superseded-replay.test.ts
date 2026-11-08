// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  emptyTaskLifecycleSnapshot,
  reduceTaskEvent,
  type TaskEventV1,
  type TaskLifecycleSnapshot,
} from "../../src/index.ts";
import { serializeTaskEvent } from "../../src/domain/task-lifecycle.contract.ts";

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
