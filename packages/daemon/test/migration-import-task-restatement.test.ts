// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { REPLAY_TASK_GRAPH } from "../../kernel/src/index.ts";
import { restateLegacyTaskEvents } from "../src/migration-import-task-restatement.ts";

const actor = { principal: { personId: "person_zeyu" }, executor: null } as const;

test("Task/v1 restatement preserves pinned and explicitly writes false when the field is absent", () => {
  const restated = restateLegacyTaskEvents([
    input(1, "task_missing_pin", legacyTask("task_missing_pin")),
    input(2, "task_pinned", { ...legacyTask("task_pinned"), pinned: true }),
  ]);
  assert.deepEqual(restated.get("task_missing_pin"), {
    taskId: "task_missing_pin",
    pinned: false,
    pinnedWasPresent: false,
    sourceRevision: 1,
    sourcePath: "harness/events/1.json",
  });
  assert.equal(restated.get("task_pinned")?.pinned, true);
  assert.equal(restated.get("task_pinned")?.pinnedWasPresent, true);
});

test("Task/v1 restatement rejects a row missing any non-migrated required field", () => {
  const { title: _title, ...missingTitle } = legacyTask("task_missing_title");
  assert.throws(
    () => restateLegacyTaskEvents([input(1, "task_missing_title", missingTitle)]),
    /Task\/v1 cannot be restated as Task\/v2: Task\/v2 fields are incomplete/u,
  );
});

test("Task/v1 restatement rejects duplicate task identity creation", () => {
  assert.throws(
    () =>
      restateLegacyTaskEvents([
        input(1, "task_duplicate", legacyTask("task_duplicate")),
        input(2, "task_duplicate", legacyTask("task_duplicate")),
      ]),
    /identity occurs more than once/u,
  );
});

test("Task/v1 restatement rejects reverse source revisions", () => {
  assert.throws(
    () =>
      restateLegacyTaskEvents([
        input(2, "task_two", legacyTask("task_two")),
        input(1, "task_one", legacyTask("task_one")),
      ]),
    /revisions must increase/u,
  );
});

function input(
  workspaceRevision: number,
  taskId: string,
  task: Readonly<Record<string, unknown>>,
  type = "task_created",
) {
  return {
    sourcePath: `harness/events/${workspaceRevision}.json`,
    value: {
      schema: "task-event/v1",
      eventId: `event-${workspaceRevision}`,
      workspaceRevision,
      opId: `op-${workspaceRevision}`,
      type,
      taskId,
      actor,
      source: "migration-import/v1",
      occurredAt: `2026-01-01T00:00:0${workspaceRevision}.000Z`,
      payload: { task },
    },
  };
}

function legacyTask(taskId: string) {
  return {
    schema: "task/v1",
    taskId,
    title: taskId,
    taskClass: "standard",
    status: "planned",
    graph: REPLAY_TASK_GRAPH,
    currentNode: "implementation",
    iteration: 0,
    createdBy: actor,
    completionGateIds: [],
    presetSnapshotDigest: null,
  } as const;
}
