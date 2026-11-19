import { actionRpc, shape } from "./daemon-protocol-results.ts";

export const todoActionRoutes = [
  actionRpc(
    "todo.list",
    "repo.todo.list",
    "todo-list",
    shape({ open: "boolean?", done: "boolean?", archived: "boolean?", all: "boolean?", targetRef: "string?" }),
    { read: true },
  ),
  actionRpc("todo.show", "repo.todo.show", "todo-show", shape({ todoId: "string" }), { read: true }),
  actionRpc(
    "todo.add",
    "repo.todo.add",
    "todo-add",
    shape({ text: "string", relate: "string?", idempotencyKey: "string?" }),
  ),
  actionRpc("todo.done", "repo.todo.done", "todo-done", shape({ todoId: "string", expectedVersion: "number?" })),
  actionRpc("todo.reopen", "repo.todo.reopen", "todo-reopen", shape({ todoId: "string", expectedVersion: "number?" })),
  actionRpc(
    "todo.archive",
    "repo.todo.archive",
    "todo-archive",
    shape({ todoId: "string", expectedVersion: "number?" }),
  ),
  actionRpc("todo.relate", "repo.todo.relate", "todo-relate", shape({ todoId: "string", targetRef: "string" })),
  actionRpc("todo.promote", "repo.todo.promote", "todo-promote", shape({ todoId: "string", work: "string" })),
] as const;
