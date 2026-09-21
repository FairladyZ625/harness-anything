// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { WorkView, workCollections } from "../src/renderer/views/WorkView.tsx";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { NAV_GROUPS } from "../src/renderer/navigation/navConfig.tsx";

vi.mock("../src/renderer/workspace-scope-data.ts", () => ({
  useWorkspaceScopeQuery: () => ({
    data: {
      pages: [
        {
          status: "ready",
          counts: { done: 3, cancelled: 1, pending: 1, blocked: 0, executing: 0 },
          scope: { executableLeafCount: 5 },
        },
      ],
    },
  }),
  combineWorkspaceScopePages: (pages: unknown[]) => pages[0],
}));
const task = (taskId: string, parentTaskId?: string, taskClass = "standard") =>
  ({
    taskId,
    title: taskId,
    parentTaskId,
    taskClass,
    lastKnownAt: "2026-09-21",
    canonicalStatus: "planned",
  }) as TaskRow;
const rows = [
  task("group"),
  task("nested", "group"),
  task("leaf", "nested"),
  task("solo"),
  task("milestone", undefined, "milestone"),
];

describe("work aggregation", () => {
  it("retains nested groups and puts only ungrouped top-level tasks in independent work", () => {
    const result = workCollections(rows);
    expect(result.groups.map((row) => row.taskId)).toEqual(["group", "nested", "milestone"]);
    expect(result.isolated.map((row) => row.taskId)).toEqual(["solo"]);
    const ids = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id));
    expect(ids).toEqual(
      expect.arrayContaining(["overview", "overviewNext", "work", "board", "graph", "cadence", "decisionPool"]),
    );
  });
  it("shows real counts, opens groups and isolated tasks, and searches both sections", () => {
    const host = document.createElement("div"),
      root = createRoot(host),
      opened: string[] = [];
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <WorkView
            tasks={rows}
            repoId="repo"
            projectName="Project"
            ready
            onOpenGroup={(id) => opened.push(id)}
            onOpenTask={(id) => opened.push(id)}
          />
        </QueryClientProvider>,
      ),
    );
    expect(host.querySelector("progress")?.value).toBe(3);
    expect(host.querySelector("progress")?.max).toBe(5);
    act(() => [...host.querySelectorAll("button")].find((button) => button.textContent?.startsWith("group"))!.click());
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="isolated-work"] button')!.click());
    expect(opened).toEqual(["group", "solo"]);
    const input = host.querySelector("input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "solo");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelectorAll("progress")).toHaveLength(0);
    expect(host.textContent).toContain("solo");
    act(() => root.unmount());
  });
});

it("loads actual goal material only after the user opens it", async () => {
  vi.useFakeTimers();
  const { WorkspaceGoal } = await import("../src/renderer/components/WorkspaceGoal.tsx");
  const { harnessClient } = await import("../src/renderer/api-client.ts");
  const read = vi.spyOn(harnessClient, "getTaskDocument").mockResolvedValue({
    status: "ready",
    body: "# Verification\nA real delivery condition",
    worktreeBody: null,
    uncommitted: false,
  } as never);
  const host = document.createElement("div"),
    root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <WorkspaceGoal
          scope={{ goalMaterial: { taskId: "group", path: "task_plan.md" } } as never}
          repoId="repo"
          onOpenTask={() => {}}
        />
      </QueryClientProvider>,
    ),
  );
  expect(read).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(read).toHaveBeenCalledWith({ repoId: "repo", taskId: "group", path: "task_plan.md" });
  // The read promise settles the fetch; React Query still schedules its observer notification.
  // Drain that scheduler deterministically instead of waiting for wall-clock time.
  await act(async () => {
    await read.mock.results[0]!.value;
    await vi.runAllTimersAsync();
  });
  expect(host.textContent).toContain("A real delivery condition");
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  act(() => root.unmount());
  client.clear();
  read.mockRestore();
  vi.useRealTimers();
});
