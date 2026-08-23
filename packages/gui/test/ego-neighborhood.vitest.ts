// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EgoNeighborhood } from "../src/renderer/graph/EgoNeighborhood.tsx";
import type { TaskRow, DecisionRow, RelationEdge } from "../src/renderer/model/types.ts";

/**
 * 可复用邻域画布(W4 抽取)的行为契约:脱离 GraphView/页面状态独立可用。
 * 这是从关系图抽出的组件复用边界证明 —— 无筛选面板/焦点历史/领地依赖,
 * 只吃 focusRef + 四类集合 + 回调。
 */

function task(taskId: string, title: string, module = "gui"): TaskRow {
  return {
    taskId, title, projectId: "proj",
    coordinationStatus: "active", rawStatus: "active", freshness: "fresh",
    packageDisposition: "active", closeoutReadiness: "not_required",
    engine: "local", source: "local-document", module,
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

async function mount(props: Partial<Parameters<typeof EgoNeighborhood>[0]> = {}) {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const root = createRoot(div);
  await act(async () => {
    root.render(createElement(EgoNeighborhood, {
      focusRef: "decision/d1",
      tasks: fixtures.tasks,
      decisions: fixtures.decisions,
      facts: [],
      relations: fixtures.relations,
      factAnchors: [],
      ...props,
    } as Parameters<typeof EgoNeighborhood>[0]));
  });
  return { div, root: root as Root };
}

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; });

describe("EgoNeighborhood standalone reuse (W4)", () => {
  it("renders the focus card and neighbor chips from collections alone", async () => {
    const { div, root } = await mount();
    // d1 焦点卡 + ±2 跳邻居(t1/t2/t3)chip,不依赖任何页面级状态。
    expect(div.querySelectorAll("[data-testid='ego-card']").length).toBe(1);
    expect(div.querySelectorAll("[data-testid='ego-chip']").length).toBe(3);
    expect(div.querySelector(".react-flow")).not.toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("single click expands a chip and grows the next ring without dropping nodes", async () => {
    const { div, root } = await mount();
    const chip = [...div.querySelectorAll("[data-testid='ego-chip']")].find((c) => c.textContent?.includes("任务一"))!;
    await act(async () => { chip.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    // t1 → 卡片;焦点卡保留;邻居累计不撤。
    expect(div.querySelectorAll("[data-testid='ego-card']").length).toBe(2);
    expect(div.querySelectorAll("[data-testid='ego-chip']").length).toBe(2);
    await act(async () => { root.unmount(); });
  });

  it("double click reports the node navRef through onRefocus (host decides page jump)", async () => {
    const onRefocus = vi.fn();
    const { div, root } = await mount({ onRefocus });
    const chip = [...div.querySelectorAll("[data-testid='ego-chip']")].find((c) => c.textContent?.includes("任务一"))!;
    await act(async () => { chip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(onRefocus).toHaveBeenCalledWith("task/t1");
    await act(async () => { root.unmount(); });
  });

  it("card 详情 button reports the entity ref through onNavigateEntity", async () => {
    const onNavigateEntity = vi.fn();
    const { div, root } = await mount({ onNavigateEntity });
    const chip = [...div.querySelectorAll("[data-testid='ego-chip']")].find((c) => c.textContent?.includes("任务一"))!;
    await act(async () => { chip.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const t1Card = [...div.querySelectorAll("[data-testid='ego-card']")].find((c) => c.textContent?.includes("任务一"))!;
    const detailBtn = [...t1Card.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "详情")!;
    await act(async () => { detailBtn.click(); });
    expect(onNavigateEntity).toHaveBeenCalledWith("task/t1");
    await act(async () => { root.unmount(); });
  });

  it("clearing focusRef resets the accumulated canvas", async () => {
    const { div, root } = await mount();
    const chip = [...div.querySelectorAll("[data-testid='ego-chip']")].find((c) => c.textContent?.includes("任务一"))!;
    await act(async () => { chip.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(div.querySelectorAll("[data-testid='ego-card']").length).toBe(2);
    await act(async () => {
      root.render(createElement(EgoNeighborhood, {
        focusRef: null,
        tasks: fixtures.tasks, decisions: fixtures.decisions, facts: [],
        relations: fixtures.relations, factAnchors: [],
      }));
    });
    expect(div.querySelectorAll("[data-testid='ego-card']").length).toBe(0);
    expect(div.querySelectorAll("[data-testid='ego-chip']").length).toBe(0);
    await act(async () => { root.unmount(); });
  });

  it("reports layout stats (nodes/edges/focusLabel) to the host", async () => {
    const onLayoutStats = vi.fn();
    const { root } = await mount({ onLayoutStats });
    const last = onLayoutStats.mock.calls.at(-1)?.[0];
    expect(last.nodes).toBe(4);
    expect(last.edges).toBe(3);
    expect(last.focusLabel).toContain("d1");
    await act(async () => { root.unmount(); });
  });
});
