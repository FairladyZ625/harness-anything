import type { Todo } from "../api/renderer-dto.ts";
import { invoke } from "./api-client-invoke.ts";
import { readGuiActionResult } from "./command-receipt.ts";

export interface TodoRow extends Todo {
  readonly open: boolean;
  readonly revision: number;
  readonly ref: string;
  readonly relations: readonly { readonly ref: string; readonly title: string }[];
}
export interface TodoDetail {
  readonly todo: TodoRow;
  readonly relations: readonly {
    readonly relationId: string;
    readonly targetRef: string;
    readonly relationType: string;
  }[];
}
function result(value: unknown) {
  const receipt = readGuiActionResult(value) as ReturnType<typeof readGuiActionResult> & {
    readonly evidence?: string;
    readonly error?: { readonly code?: string; readonly hint?: string };
  };
  if (
    !receipt.ok ||
    receipt.outcome === "op_rejected" ||
    receipt.outcome === "indeterminate" ||
    receipt.outcome === "pending"
  )
    throw new Error(
      `${receipt.error?.code ?? receipt.outcome}: ${receipt.error?.hint ?? "Todo request did not complete."}`,
    );
  return receipt;
}
export const todosClient = {
  async list(repoId: string, targetRef?: string): Promise<readonly TodoRow[]> {
    const params = { repoId, all: true, ...(targetRef ? { targetRef } : {}) };
    const receipt = result(await invoke("repo.todo.list", params, "listTodos"));
    return (JSON.parse(receipt.evidence ?? "{}") as { todos: TodoRow[] }).todos;
  },
  async show(repoId: string, todoId: string): Promise<TodoDetail> {
    const params = { repoId, todoId };
    return JSON.parse(result(await invoke("repo.todo.show", params, "showTodo")).evidence ?? "{}");
  },
  async add(repoId: string, text: string, relate?: string) {
    const params = { repoId, text, ...(relate ? { relate } : {}) };
    return result(await invoke("repo.todo.add", params, "addTodo"));
  },
  async done(repoId: string, todoId: string) {
    const params = { repoId, todoId };
    return result(await invoke("repo.todo.done", params, "completeTodo"));
  },
  async reopen(repoId: string, todoId: string) {
    const params = { repoId, todoId };
    return result(await invoke("repo.todo.reopen", params, "reopenTodo"));
  },
  async archive(repoId: string, todoId: string) {
    const params = { repoId, todoId };
    return result(await invoke("repo.todo.archive", params, "archiveTodo"));
  },
  async relate(repoId: string, todoId: string, targetRef: string) {
    const params = { repoId, todoId, targetRef };
    return result(await invoke("repo.todo.relate", params, "relateTodo"));
  },
  async promote(repoId: string, todoId: string, work: string) {
    const params = { repoId, todoId, work };
    return result(await invoke("repo.todo.promote", params, "promoteTodo"));
  },
};
