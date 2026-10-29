// harness-test-tier: fast
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { TodosView } from "../src/renderer/views/TodosView.tsx";
import { todosClient, type TodoRow } from "../src/renderer/todos-client.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

const openTodo: TodoRow = {
  id: "todo_open12345678901234567890",
  text: "交付测试报告",
  completed: false,
  archived: false,
  open: true,
  revision: 1,
  ref: "todo/todo_open12345678901234567890",
  relations: [{ ref: "task/task_report", title: "报告生成" }],
};
const completedTodo: TodoRow = {
  ...openTodo,
  id: "todo_done12345678901234567890",
  completed: true,
  open: false,
  relations: [],
};
const archivedTodo: TodoRow = {
  ...openTodo,
  id: "todo_arch12345678901234567890",
  archived: true,
  open: false,
  relations: [],
};
let rows: TodoRow[] = [openTodo, completedTodo, archivedTodo];
const mounted: { root: Root; client: QueryClient }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});
afterEach(async () => {
  await act(async () => {
    for (const { root, client } of mounted.splice(0)) {
      root.unmount();
      client.clear();
    }
  });
  rows = [openTodo, completedTodo, archivedTodo];
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
notifyManager.setScheduler(queueMicrotask);

function mount() {
  const host = document.createElement("div"),
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, client });
  vi.spyOn(todosClient, "list").mockImplementation(async () => rows);
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TodosView, { repoId: "repo", onNavigateEntity: vi.fn() }),
      ),
    ),
  );
  return client;
}

async function settle(client: QueryClient) {
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  await act(async () => undefined);
}

describe("TodosView", () => {
  it("completes a row, shows undo, then reopens it from the toast", async () => {
    const client = mount();
    vi.spyOn(todosClient, "done").mockImplementation(async () => {
      rows = rows.map((row) => (row.id === openTodo.id ? { ...row, completed: true, open: false } : row));
    });
    const reopen = vi.spyOn(todosClient, "reopen").mockImplementation(async () => {
      rows = rows.map((row) => (row.id === openTodo.id ? { ...row, completed: false, open: true } : row));
    });
    await settle(client);
    await act(async () =>
      document
        .querySelector(`[data-testid="todo-toggle-${openTodo.id}"]`)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await settle(client);
    expect(todosClient.done).toHaveBeenCalledWith("repo", openTodo.id);
    expect(document.querySelector(`[data-testid="todo-${openTodo.id}"]`)).toBeNull();
    expect(document.querySelector("[data-testid='todo-undo-toast']")?.textContent).toContain("撤销");
    await act(async () =>
      document
        .querySelector("[data-testid='todo-undo-toast'] button")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await settle(client);
    expect(reopen).toHaveBeenCalledWith("repo", openTodo.id);
    expect(document.querySelector(`[data-testid="todo-${openTodo.id}"]`)).not.toBeNull();
  });

  it("keeps one text-first row with always-reachable actions and keyboard access", async () => {
    const client = mount();
    await settle(client);
    const row = document.querySelector(`[data-testid="todo-${openTodo.id}"]`)!;
    expect(row.textContent).toContain("交付测试报告");
    expect(row.textContent).toContain("报告生成");
    expect(row.textContent).not.toContain("todo_open123");
    const actions = row.querySelector(`[data-testid="todo-details-${openTodo.id}"]`)!;
    expect(actions.getAttribute("aria-label")).toBe("详情与关联");
    expect(actions.getAttribute("data-tip")).toBe("详情与关联");
    expect(actions.tabIndex).toBe(0);
    expect(actions.parentElement?.className).not.toContain("opacity-0");
    actions.focus();
    expect(document.activeElement).toBe(actions);
    expect(actions.parentElement?.className).toContain("group-hover:text-text-muted");
    expect(actions.parentElement?.className).toContain("group-focus-within:text-text-muted");
  });

  it("switches completed and archived views and focuses the add input in the empty state", async () => {
    const client = mount();
    await settle(client);
    await act(async () =>
      document
        .querySelector("[data-testid='todos-view-completed']")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(document.querySelector(`[data-testid="todo-${completedTodo.id}"]`)).not.toBeNull();
    expect(document.querySelector(`[data-testid="todo-${openTodo.id}"]`)).toBeNull();
    await act(async () =>
      document
        .querySelector("[data-testid='todos-view-archived']")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(document.querySelector(`[data-testid="todo-${archivedTodo.id}"]`)).not.toBeNull();
    rows = [];
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["todos", "repo"] });
      document
        .querySelector("[data-testid='todos-view-open']")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(client);
    expect(document.activeElement).toBe(document.querySelector("[data-testid='todo-text']"));
    expect(document.body.textContent).toContain("没有未完成待办");
  });
});
