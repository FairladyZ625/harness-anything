// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GraphView } from "../src/renderer/views/GraphView.tsx";
import type { TaskRow, DecisionRow, RelationEdge } from "../src/renderer/model/types.ts";

/**
 * 关系图页不因 ego 组件抽取而退化(W4 硬要求)。
 * 聚光灯画布现在由 graph/EgoNeighborhood 承载,本文件锁定页面级行为:
 *   - 领地/聚光灯双模式可进可出,领地 chip → 聚光灯;
 *   - 画布累积态(已展开卡片)在领地↔聚光灯往返后保留(抽组件最大的回归面);
 *   - 焦点历史条仍工作(后退/清除)。
 */

function task(taskId: string, title: string): TaskRow {
  return {
    taskId, title, projectId: "proj",
    coordinationStatus: "active", rawStatus: "active", freshness: "fresh",
    packageDisposition: "active", closeoutReadiness: "not_required",
    engine: "local", source: "local-document", module: "gui",
    lastKnownAt: "2026-08-01T00:00:00.000Z", gates: [], docs: [],
  };
}

function decision(decisionId: string): DecisionRow {
  return {
    decisionId, title: `决策 ${decisionId}`, state: "active", question: "Q?",
    chosen: [], rejected: [], claims: [], proposedAt: "2026-08-01T00:00:00.000Z",
  } as DecisionRow;
}

const fixtures = {
  tasks: [task("t1", "任务一"), task("t2", "任务二"), task("t3", "任务三")],
  decisions: [decision("d1")],
  relations: [
    { from: "decision/d1", to: "task/t1", kind: "derives", provenance: "local-document" },
    { from: "task/t1", to: "task/t2", kind: "depends-on", provenance: "local-document" },
    { from: "task/t1", to: "task/t3", kind: "blocks", provenance: "local-document" },
  ] as RelationEdge[],
};

async function mountGraph(overrides: Partial<Record<string, unknown>> = {}) {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const root = createRoot(div);
  const render = (props: Partial<Record<string, unknown>>) => act(async () => {
    root.render(createElement(GraphView, {
      tasks: fixtures.tasks,
      decisions: fixtures.decisions,
      facts: [],
      relations: fixtures.relations,
      focusRef: "decision/d1",
      viewMode: "spotlight",
      onViewModeChange: () => {},
      ...props,
    } as never));
  });
  await render(overrides);
  return { div, root: root as Root, render };
}

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; });

describe("graph page keeps its behavior after the ego extraction (W4)", () => {
  it("spotlight renders focus card + neighbor chips and reports header counts", async () => {
    const { div, root } = await mountGraph();
    expect(div.querySelectorAll("[data-testid='ego-card']").length).toBe(1);
    expect(div.querySelectorAll("[data-testid='ego-chip']").length).toBe(3);
    expect(div.querySelector("[data-testid='focus-history-bar']")).not.toBeNull();
    expect(div.textContent).toContain("聚光灯 · 4 节点 · 3 边");
    // 同一时刻 DOM 里只有一个 ReactFlow(可访问性/选择器不二义)。
    expect(div.querySelectorAll(".react-flow").length).toBe(1);
    await act(async () => { root.unmount(); });
  });

  it("accumulated expansion survives a territory↔spotlight round trip", async () => {
    const { div, root, render } = await mountGraph();
    // 展开 t1:卡片 1 → 2,邻居累计 3 chip → 2。
    const chip = [...div.querySelectorAll("[data-testid='ego-chip']")].find((c) => c.textContent?.includes("任务一"))!;
    await act(async () => { chip.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(div.querySelectorAll("[data-testid='ego-card']").length).toBe(2);

    // 去领地再回聚光灯:焦点引用不变(EntityWorkspace 切模式不清焦点),
    // 画布保持挂载,累积态不得重置。
    await render({ viewMode: "territory" });
    expect(div.querySelectorAll("[data-testid='territory-chip']").length).toBeGreaterThan(0);
    expect(div.querySelectorAll(".react-flow").length).toBe(1);
    await render({ viewMode: "spotlight" });
    expect(div.querySelectorAll("[data-testid='ego-card']").length).toBe(2);
    expect(div.querySelectorAll("[data-testid='ego-chip']").length).toBe(2);
    expect(div.querySelectorAll(".react-flow").length).toBe(1);
    await act(async () => { root.unmount(); });
  });

  it("territory chip click enters spotlight on that entity", async () => {
    const onViewModeChange = vi.fn();
    const onFocusEntityChange = vi.fn();
    const { div, root } = await mountGraph({ viewMode: "territory", focusRef: null, onViewModeChange, onFocusEntityChange });
    const chip = [...div.querySelectorAll("[data-testid='territory-chip']")].find((c) => c.textContent?.includes("决策 d1"));
    expect(chip).toBeDefined();
    await act(async () => { (chip as HTMLElement).click(); });
    expect(onViewModeChange).toHaveBeenCalledWith("spotlight");
    expect(onFocusEntityChange).toHaveBeenCalledWith("decision/d1");
    await act(async () => { root.unmount(); });
  });

  it("clear focus empties the spotlight canvas", async () => {
    const { div, root, render } = await mountGraph();
    await render({ focusRef: null });
    await act(async () => {});
    expect(div.querySelectorAll("[data-testid='ego-card']").length).toBe(0);
    await act(async () => { root.unmount(); });
  });
});
