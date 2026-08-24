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

/**
 * 详情抽屉的布局契约(2026-08-24 回归):GraphDrawer 是**画布右侧的定宽栏**,
 * 不是底部横条。抽屉 aside 自带 `w-[26rem] shrink-0 border-l`,只有当它与画布
 * 同处一个**行轴**容器时才成立;宿主一旦写成 flex-col,shrink-0 就改为拒绝纵向
 * 收缩 —— 抽屉变成占满整条带宽的底部横条,自身只填 26rem,带内其余部分是纯空区,
 * 同时把画布高度吃掉(实测 1440×900 下画布 828→401;内容一多直接吃到 0)。
 *
 * happy-dom 没有布局引擎量不出像素,所以这里守的是**产生该像素结果的三个结构条件**:
 * 行轴 + 定宽不收缩 + 溢出可滚。像素级前后对比见任务包 artifacts 的 Electron 实测。
 */
describe("detail drawer layout contract", () => {
  function drawerAndHost(div: HTMLElement) {
    const drawer = div.querySelector("[data-testid='graph-detail-drawer']") as HTMLElement;
    return { drawer, host: drawer?.parentElement as HTMLElement };
  }

  it("docks the drawer on a row axis beside the canvas, never as a bottom band", async () => {
    const { div, root } = await mount();
    const { drawer, host } = drawerAndHost(div);
    expect(drawer).not.toBeNull();
    // 画布与抽屉是同一个容器的兄弟 —— 该容器决定二者的排布轴。
    expect(host.querySelector(".react-flow")).not.toBeNull();
    expect(host.classList.contains("flex")).toBe(true);
    expect(host.classList.contains("flex-col")).toBe(false);
    // 定宽 + 不收缩:在行轴上这是「右侧栏」,在列轴上这正是撑出空区的那一条。
    expect(drawer.classList.contains("shrink-0")).toBe(true);
    expect(drawer.className).toMatch(/\bw-\[26rem\]/u);
    await act(async () => { root.unmount(); });
  });

  it("keeps the same docked shape when the node has far more edges than fit", async () => {
    const many: RelationEdge[] = Array.from({ length: 60 }, (_, i) => ({
      from: "decision/d1", to: `task/t${i}`, kind: "derives", provenance: "local-document",
    })) as RelationEdge[];
    const { div, root } = await mount({
      tasks: Array.from({ length: 60 }, (_, i) => task(`t${i}`, `任务 ${i}`)),
      relations: many,
    });
    const { drawer, host } = drawerAndHost(div);
    // 内容量不改变布局形态:仍是行轴右侧栏,不因内容多而改吃画布。
    expect(host.classList.contains("flex-col")).toBe(false);
    expect(drawer.classList.contains("shrink-0")).toBe(true);
    // 溢出走滚动而不是撑高/截断:60 条出边全部进 DOM,一条不少。
    expect(drawer.classList.contains("overflow-y-auto")).toBe(true);
    expect(drawer.textContent).toContain("60");
    await act(async () => { root.unmount(); });
  });
});
