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
        {
          relationId: "rel_two",
          sourceRef: "todo/todo_one",
          targetRef: "decision/dec_report",
          relationType: "relates",
        },
      ],
      page: null,
    }),
    read: () => ({ snapshot: { task: { title: "Report delivery" } } }),
    readDecision: (id: string, withBody?: boolean) => {
      assert.equal(id, "dec_report");
      assert.equal(withBody, false, "agenda todo relation titles must not request decision bodies");
      return { decision: { title: "Report policy" } };
    },
    getEntity: () => null,
  } as never);

  assert.deepEqual(todos[0]?.relations, [
    { ref: "task/task_report", title: "Report delivery" },
    { ref: "decision/dec_report", title: "Report policy" },
  ]);
  assert.equal(todos[0]?.open, true);
  assert.equal(todos[0]?.revision, 7);
});
