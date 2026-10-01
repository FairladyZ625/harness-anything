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
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

setActiveLocale("zh-CN");

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
  it("shows real counts, opens work cards, and searches by work title", () => {
    const host = document.createElement("div"),
      root = createRoot(host),
      opened: string[] = [];
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <WorkView
            tasks={rows}
            repoId="repo"
            ready
            onOpenTask={(id) => opened.push(id)}
            catalog={undefined}
            catalogError={null}
            daemonState="responsive"
            onRefreshLedger={() => {}}
            agenda={undefined}
          />
        </QueryClientProvider>,
      ),
    );
    // 每个工作一张概况卡,默认「全部」:两件安静的工作都在「在推进」组里。
    const workRows = () => [...host.querySelectorAll('[data-testid="work-row"]')];
    expect(workRows().map((row) => row.getAttribute("data-work-id"))).toEqual(["declared_work", "group"]);
    // 独立任务(solo)不在工作页,归任务列表页。
    expect(host.textContent).not.toContain("solo");
    const groupRow = host.querySelector('[data-testid="work-row"][data-work-id="group"]')!;
    expect(groupRow.textContent).toContain("计划 1 · 无 agent 在跑");
    act(() => groupRow.querySelector<HTMLButtonElement>("button")!.click());
    expect(opened).toEqual(["group"]);
    const input = host.querySelector<HTMLInputElement>('input[aria-label="搜索工作"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "declared_work");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(workRows().map((row) => row.getAttribute("data-work-id"))).toEqual(["declared_work"]);
    act(() => root.unmount());
  });
});
