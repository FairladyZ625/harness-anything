// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { WorkView } from "../src/renderer/views/WorkView.tsx";
import { collectWork } from "../src/renderer/model/work-collections.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { NAV_GROUPS } from "../src/renderer/navigation/navConfig.tsx";

// workId 是 daemon 工作索引(`repo.works.index`)盖在行上的所属工作;renderer 不自己判定。
const task = (taskId: string, parentTaskId?: string, workId?: string, taskClass = "standard") =>
  ({
    taskId,
    title: taskId,
    parentTaskId,
    taskClass,
    workId,
    lastKnownAt: "2026-09-21",
    canonicalStatus: "planned",
  }) as TaskRow;
const rows = [
  task("group", undefined, "group"),
  task("nested", "group", "group"),
  task("leaf", "nested", "group"),
  task("solo"),
  task("declared_work", undefined, "declared_work", "work"),
];

describe("work aggregation", () => {
  it("lists only the daemon's work roots and puts top-level tasks in no work in independent work", () => {
    const result = collectWork(rows);
    // 中层组 nested 有子任务但不是工作根,不单列成工作卡片。
    expect(result.groups.map(({ task }) => task.taskId)).toEqual(["declared_work", "group"]);
    expect(result.isolated.map((row) => row.taskId)).toEqual(["solo"]);
    const ids = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id));
    expect(ids).toEqual(expect.arrayContaining(["overview", "work", "board", "graph", "cadence", "decisionPool"]));
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
            onOpenTask={(id) => opened.push(id)}
            catalog={undefined}
            catalogError={null}
            daemonState="responsive"
            onRefreshLedger={() => {}}
          />
        </QueryClientProvider>,
      ),
    );
    expect(host.querySelector("progress")?.value).toBe(0);
    expect(host.querySelector("progress")?.max).toBe(1);
    act(() => [...host.querySelectorAll("button")].find((button) => button.textContent?.startsWith("group"))!.click());
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="isolated-work"] button')!.click());
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="isolated-work"] button:nth-of-type(2)')!.click());
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
