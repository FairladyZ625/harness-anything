// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { readTodos } from "../src/todo-read.ts";

test("todo list read model resolves related entity titles for CLI and GUI consumers", () => {
  const todos = readTodos({
    listEntities: () => [
      {
        id: "todo_one",
        workspaceRevision: 7,
        value: { id: "todo_one", text: "Write report", completed: false, archived: false },
      },
    ],
    readRelationQuery: () => ({
      rows: [
        { relationId: "rel_one", sourceRef: "todo/todo_one", targetRef: "task/task_report", relationType: "relates" },
      ],
      page: null,
    }),
    read: () => ({ snapshot: { task: { title: "Report delivery" } } }),
    readDecision: () => ({ decision: null }),
    getEntity: () => null,
  } as never);

  assert.deepEqual(todos[0]?.relations, [{ ref: "task/task_report", title: "Report delivery" }]);
  assert.equal(todos[0]?.open, true);
  assert.equal(todos[0]?.revision, 7);
});
