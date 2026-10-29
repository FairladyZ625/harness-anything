// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";

test("todo list renders one readable line with relation title and short id", () => {
  const { text } = renderCliReceipt({
    ok: true,
    command: "todo-list",
    evidence: JSON.stringify({
      todos: [
        {
          id: "todo_1aa011e48834a8b1a74c05ed",
          text: "整理待办清单体验",
          completed: false,
          archived: false,
          relations: [{ ref: "task/task_123", title: "待办清单 UX" }],
        },
        { id: "todo_abcdef0123456789", text: "提交", completed: true, relations: [] },
      ],
    }),
  });
  assert.equal(text, "○  整理待办清单体验  [关联: 待办清单 UX]  todo_1aa0\n✓  提交  todo_abcd");
});

test("todo list prints a compact empty state", () => {
  assert.equal(renderCliReceipt({ ok: true, command: "todo-list", evidence: '{"todos":[]}' }).text, "No todos.");
});
