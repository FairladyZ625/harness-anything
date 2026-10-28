// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { waitForFixturePublication, openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { readFileSync } from "node:fs";
import { actor, evidence, initRepo } from "./task-surface.fixtures.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";

const binding = withPolicyGroup({ actor, source: "local" as const }, "contributor");
test("repository todos: concurrent completion, archive and recovery", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-todo-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId: workspaceId("todos"), rootDir: canonicalRoot(rootDir), ownerId: "todo-test" });
    const added = await cell.run({ kind: "todo-add", text: "记得检查并发完成" }, binding);
    assert.equal(added.outcome, "applied", JSON.stringify(added));
    const { todo } = evidence(added) as { todo: { id: string; text: string; completed: boolean; archived: boolean } };
    assert.equal(todo.text, "记得检查并发完成");
    const list = async (flags = {}) =>
      evidence(await cell!.run({ kind: "todo-list", ...flags }, binding)) as { todos: (typeof todo)[] };
    assert.equal((await list()).todos.length, 1);
    const completed = await Promise.all(
      Array.from({ length: 5 }, () => cell!.run({ kind: "todo-done", todoId: todo.id }, binding)),
    );
    assert.equal(completed.filter((r) => r.outcome === "applied").length, 1);
    assert.equal(completed.filter((r) => r.outcome === "no_changes").length, 4);
    assert.equal((await list()).todos.length, 0);
    assert.equal((await list({ done: true })).todos.length, 1);
    assert.equal((await cell.run({ kind: "todo-archive", todoId: todo.id }, binding)).outcome, "applied");
    assert.equal((await list({ archived: true })).todos[0]!.completed, true);
    assert.equal((await cell.run({ kind: "todo-reopen", todoId: todo.id }, binding)).outcome, "applied");
    assert.equal((await list()).todos.length, 1);
    const empty = await cell.run({ kind: "todo-add", text: "   " }, binding);
    assert.equal(empty.outcome, "op_rejected", JSON.stringify(empty));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("todos relate both ways, promote atomically once, publish and survive reopen", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-todo-relations-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  const input = {
    repoId: workspaceId("todo-relations"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "todo-relations-test",
  };
  try {
    initRepo(rootDir);
    cell = await openRepoCell(input);
    const work = await cell.run(
      { kind: "task-create", taskId: "task_todo_work", title: "Todo work", taskClass: "work" },
      binding,
    );
    assert.equal(work.outcome, "applied", JSON.stringify(work));
    const add = await cell.run(
      { kind: "todo-add", text: "Inspect the archive", relate: "task/task_todo_work", idempotencyKey: "todo-linked" },
      binding,
    );
    assert.equal(add.outcome, "applied", JSON.stringify(add));
    const todoId = (evidence(add) as { todo: { id: string } }).todo.id;
    const show = () => cell!.run({ kind: "todo-show", todoId }, binding);
    const details = evidence(await show()) as { relations: { targetRef: string }[]; todo: { revision: number } };
    assert.equal(details.relations[0]?.targetRef, "task/task_todo_work");
    const attached = evidence(await cell.run({ kind: "todo-list", targetRef: "task/task_todo_work" }, binding)) as {
      todos: { id: string }[];
    };
    assert.equal(attached.todos[0]?.id, todoId);
    const invalid = await cell.run(
      { kind: "todo-add", text: "Invalid reference", relate: "task/task_missing" },
      binding,
    );
    assert.equal(invalid.outcome, "op_rejected", JSON.stringify(invalid));
    assert.equal(
      (evidence(await cell.run({ kind: "todo-list", all: true }, binding)) as { todos: unknown[] }).todos.length,
      1,
    );
    const conflict = await cell.run({ kind: "todo-done", todoId, expectedVersion: details.todo.revision - 1 }, binding);
    assert.equal(conflict.outcome, "op_rejected", JSON.stringify(conflict));
    const promoted = await cell.run({ kind: "todo-promote", todoId, work: "task_todo_work" }, binding);
    assert.equal(promoted.outcome, "applied", JSON.stringify(promoted));
    const taskRef = (evidence(promoted) as { taskRef: string }).taskRef;
    const again = await cell.run({ kind: "todo-promote", todoId, work: "task_todo_work" }, binding);
    assert.equal(again.outcome, "no_changes", JSON.stringify(again));
    assert.equal((evidence(again) as { taskRef: string }).taskRef, taskRef);
    await waitForFixturePublication(cell, promoted.opId, binding);
    const document = JSON.parse(readFileSync(path.join(rootDir, "harness", "todos", `${todoId}.json`), "utf8"));
    assert.equal(document.completed, true);
    assert.equal(document.promotedTaskId, taskRef.split("/")[1]);
    const agenda = await cell.read("repo.agenda.read", {});
    assert.equal(agenda.todos.length, 0);
    await cell.close();
    cell = await openRepoCell(input);
    assert.equal(
      (evidence(await show()) as { todo: { promotedTaskId: string } }).todo.promotedTaskId,
      taskRef.split("/")[1],
    );
    await cell.run({ kind: "todo-reopen", todoId }, binding);
    const reopenedAgenda = await cell.read("repo.agenda.read", {});
    assert.equal(reopenedAgenda.todos[0]?.id, todoId);
    assert.equal(
      reopenedAgenda.attentionItems.some((item) => JSON.stringify(item).includes(todoId)),
      false,
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
