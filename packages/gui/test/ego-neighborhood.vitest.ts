// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EgoNeighborhood } from "../src/renderer/graph/EgoNeighborhood.tsx";
import type { TaskRow, DecisionRow, RelationEdge } from "../src/renderer/model/types.ts";
import { decisionProjectionFields } from "./decision-projection-fields.ts";

/**
 * 可复用邻域画布(W4 抽取)的行为契约:脱离 GraphView/页面状态独立可用。
 * 这是从关系图抽出的组件复用边界证明 —— 无筛选面板/焦点历史/领地依赖,
 * 只吃 focusRef + 四类集合 + 回调。
 */

function task(taskId: string, title: string): TaskRow {
  return {
    taskId,
    title,
    projectId: "proj",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    lastKnownAt: "2026-08-01T00:00:00.000Z",
    gates: [],
    docs: [],
  };
}

function decision(decisionId: string): DecisionRow {
  return {
    decisionId,
    title: `决策 ${decisionId}`,
    state: "proposed",
    question: "Q?",
    chosen: [],
    rejected: [],
    claims: [],
    proposedAt: "2026-08-01T00:00:00.000Z",
    ...decisionProjectionFields("proposed"),
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
    root.render(
      createElement(EgoNeighborhood, {
        focusRef: "decision/d1",
        tasks: fixtures.tasks,
        decisions: fixtures.decisions,
        facts: [],
        relations: fixtures.relations,
        factAnchors: [],
        ...props,
      } as Parameters<typeof EgoNeighborhood>[0]),
    );
  });
  return { div, root: root as Root };
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

describe("EgoNeighborhood standalone reuse (W4)", () => {
  it("renders every entity as a compact chip; no node renders expanded content", async () => {
    const { div, root } = await mount();
    // 规范 §5.2:节点只做选中态,内容只在抽屉里 —— 焦点与邻居一律 chip。
    expect(div.querySelectorAll("[data-testid='ego-card']").length).toBe(0);
    expect(div.querySelectorAll("[data-testid='ego-chip']").length).toBe(4);
    expect(div.querySelector(".react-flow")).not.toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  it("single click selects the chip and opens exactly one drawer, without expanding the node", async () => {
    const { div, root } = await mount();
    const chip = [...div.querySelectorAll("[data-testid='ego-chip']")].find((c) => c.textContent?.includes("任务一"))!;
    await act(async () => {
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // §5.2:一次点击只让内容出现在一个地方 —— 节点不变成卡片,摘要只在抽屉里。
    expect(div.querySelectorAll("[data-testid='ego-card']").length).toBe(0);
    expect(div.querySelectorAll("[data-testid='ego-chip']").length).toBe(4);
    const drawer = div.querySelectorAll("[data-testid='graph-detail-drawer']");
    expect(drawer.length).toBe(1);
    expect(drawer[0]!.textContent).toContain("任务一");
    await act(async () => {
      root.unmount();
    });
  });

  it("Esc closes the drawer and clears the selection", async () => {
    const { div, root } = await mount();
    const chip = [...div.querySelectorAll("[data-testid='ego-chip']")].find((c) => c.textContent?.includes("任务一"))!;
    await act(async () => {
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(div.querySelector("[data-testid='graph-detail-drawer']")).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(div.querySelector("[data-testid='graph-detail-drawer']")).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  it("double click reports the node navRef through onRefocus (host decides page jump)", async () => {
    const onRefocus = vi.fn();
    const { div, root } = await mount({ onRefocus });
    const chip = [...div.querySelectorAll("[data-testid='ego-chip']")].find((c) => c.textContent?.includes("任务一"))!;
    await act(async () => {
      chip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onRefocus).toHaveBeenCalledWith("task/t1");
    await act(async () => {
      root.unmount();
    });
  });

  it("drawer 打开 button reports the entity ref through onNavigateEntity", async () => {
    const { messageFor } = await import("../src/renderer/i18n/core.ts");
    const openTitle = messageFor("graph.graphDrawer.openSidebarTaskDetailsDecisionDecisionPool");
    const onNavigateEntity = vi.fn();
    const { div, root } = await mount({ onNavigateEntity });
    const chip = [...div.querySelectorAll("[data-testid='ego-chip']")].find((c) => c.textContent?.includes("任务一"))!;
    await act(async () => {
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const drawer = div.querySelector("[data-testid='graph-detail-drawer']")!;
    const openBtn = [...drawer.querySelectorAll("button")].find((b) => b.getAttribute("title") === openTitle)!;
    await act(async () => {
      openBtn.click();
    });
    expect(onNavigateEntity).toHaveBeenCalledWith("task/t1");
    await act(async () => {
      root.unmount();
    });
  });

  it("task chips expose the shared pin writer without making non-task entities writable", async () => {
    const onSetTaskPin = vi.fn();
    const { div, root } = await mount({ onSetTaskPin });
    const taskPin = div.querySelector("[data-testid='ego-pin-toggle-t1']") as HTMLButtonElement;
    expect(taskPin).not.toBeNull();
    expect(div.querySelector("[data-testid='ego-pin-toggle-d1']")).toBeNull();
    await act(async () => {
      taskPin.click();
    });
    expect(onSetTaskPin).toHaveBeenCalledWith(fixtures.tasks[0], true);
    await act(async () => {
      root.unmount();
    });
  });

  it("clearing focusRef resets the accumulated canvas", async () => {
    const { div, root } = await mount();
    const chip = [...div.querySelectorAll("[data-testid='ego-chip']")].find((c) => c.textContent?.includes("任务一"))!;
    await act(async () => {
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(div.querySelector("[data-testid='graph-detail-drawer']")).not.toBeNull();
    await act(async () => {
      root.render(
        createElement(EgoNeighborhood, {
          focusRef: null,
          tasks: fixtures.tasks,
          decisions: fixtures.decisions,
          facts: [],
          relations: fixtures.relations,
          factAnchors: [],
        }),
      );
    });
    expect(div.querySelectorAll("[data-testid='ego-chip']").length).toBe(0);
    expect(div.querySelector("[data-testid='graph-detail-drawer']")).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  it("reports layout stats (nodes/edges/focusLabel) to the host", async () => {
    const onLayoutStats = vi.fn();
    const { root } = await mount({ onLayoutStats });
    const last = onLayoutStats.mock.calls.at(-1)?.[0];
    expect(last.nodes).toBe(4);
    expect(last.edges).toBe(3);
    expect(last.focusLabel).toContain("d1");
    await act(async () => {
      root.unmount();
    });
  });
});

/** 视觉基线 §2.6:画布始终铺满,详情只在选中后以覆盖式共享 Drawer 出现。 */
describe("detail drawer layout contract", () => {
  it("keeps the canvas full-size and opens an overlay drawer only after selection", async () => {
    const { div, root } = await mount();
    expect(div.querySelector("[data-testid='graph-detail-drawer']")).toBeNull();
    expect(div.querySelector(".react-flow")).not.toBeNull();
    const chips = [...div.querySelectorAll<HTMLElement>("[data-testid='ego-chip']")];
    const focusChip = chips.find((c) => c.textContent?.includes("决策 d1"))!;
    await act(async () => focusChip.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const drawer = div.querySelector("[data-testid='graph-detail-drawer']")!;
    expect(drawer.closest("[role='dialog']")?.className).toContain("fixed");
    expect(div.querySelector(".react-flow")).not.toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  it("keeps all relationship rows scrollable when the selected node has many edges", async () => {
    const many: RelationEdge[] = Array.from({ length: 60 }, (_, i) => ({
      from: "decision/d1",
      to: `task/t${i}`,
      kind: "derives",
      provenance: "local-document",
    })) as RelationEdge[];
    const { div, root } = await mount({
      tasks: Array.from({ length: 60 }, (_, i) => task(`t${i}`, `任务 ${i}`)),
      relations: many,
    });
    const chips = [...div.querySelectorAll<HTMLElement>("[data-testid='ego-chip']")];
    const focusChip = chips.find((c) => c.textContent?.includes("决策 d1"))!;
    await act(async () => focusChip.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const drawer = div.querySelector("[data-testid='graph-detail-drawer']")!;
    expect(drawer.closest("[role='dialog']")?.className).toContain("overflow-y-auto");
    expect(drawer.textContent).toContain("60");
    await act(async () => {
      root.unmount();
    });
  });
});

/** §5.2 收口:节点放大路径删除后,原卡片内容必须都在抽屉里(不丢信息)。 */
describe("drawer content parity (node card content moves into the drawer)", () => {
  it("shows rejected claims with whyNot for a selected decision", async () => {
    const decisions = [
      {
        ...decision("d1"),
        rejected: [{ id: "R1", text: "否决论点甲", whyNot: "代价高于收益", evidence: [] }],
      },
    ];
    const { div, root } = await mount({ decisions });
    const chips = [...div.querySelectorAll<HTMLElement>("[data-testid='ego-chip']")];
    const focusChip = chips.find((c) => c.textContent?.includes("决策 d1"))!;
    await act(async () => focusChip.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const drawerText = div.querySelector("[data-testid='graph-detail-drawer']")!.textContent ?? "";
    expect(drawerText).toContain("否决论点甲");
    expect(drawerText).toContain("代价高于收益");
    await act(async () => {
      root.unmount();
    });
  });

  it("shows task risk/urgency and agent taskCount for selected nodes", async () => {
    const riskyTask = { ...fixtures.tasks[0]!, riskTier: "high", urgency: "high" } as (typeof fixtures.tasks)[0];
    const { div, root } = await mount({
      tasks: [riskyTask, ...fixtures.tasks.slice(1)],
      agents: [{ id: "agent/a1", name: "执行体 甲", sub: "worker", taskCount: 13 }],
      relations: [
        ...fixtures.relations,
        { from: "agent/a1", to: "task/t1", kind: "dispatches", provenance: "local-document" },
      ] as RelationEdge[],
    });
    const taskChip = [...div.querySelectorAll<HTMLElement>("[data-testid='ego-chip']")].find((c) =>
      c.textContent?.includes("任务一"),
    )!;
    await act(async () => taskChip.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    let drawerText = div.querySelector("[data-testid='graph-detail-drawer']")!.textContent ?? "";
    expect(drawerText).toContain("high");

    const agentChip = [...div.querySelectorAll<HTMLElement>("[data-testid='ego-chip']")].find(
      (c) => c.getAttribute("data-entity") === "agent",
    )!;
    await act(async () => agentChip.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    drawerText = div.querySelector("[data-testid='graph-detail-drawer']")!.textContent ?? "";
    expect(drawerText).toContain("worker");
    expect(drawerText).toContain("13");
    await act(async () => {
      root.unmount();
    });
  });
});
