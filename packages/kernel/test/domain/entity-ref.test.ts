import assert from "node:assert/strict";
import test from "node:test";
import { findEntityRefs, parseEntityRef } from "../../src/domain/entity-ref.ts";

test("EntityRef parser accepts local and prefixed task references", () => {
  assert.deepEqual(parseEntityRef("task/task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q"), {
    raw: "task/task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q",
    kind: "task",
    id: "task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q",
    externalHarness: false
  });
  assert.deepEqual(parseEntityRef("team-a:task/task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q"), {
    raw: "team-a:task/task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q",
    kind: "task",
    id: "task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q",
    harnessAlias: "team-a",
    externalHarness: true
  });
  assert.equal(parseEntityRef("issue/123"), null);
});

test("EntityRef scanner preserves external harness prefixes without resolving them", () => {
  const refs = findEntityRefs("depends on task/local-task and other-harness:task/remote-task");

  assert.deepEqual(refs.map((ref) => [ref.raw, ref.externalHarness]), [
    ["task/local-task", false],
    ["other-harness:task/remote-task", true]
  ]);
});
