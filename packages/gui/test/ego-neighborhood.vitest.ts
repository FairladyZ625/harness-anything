// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EgoNeighborhood } from "../src/renderer/graph/EgoNeighborhood.tsx";
import { clearEgoSession } from "../src/renderer/graph/egoSession.ts";
import type { TaskRow, DecisionRow, RelationEdge } from "../src/renderer/model/types.ts";
import { decisionProjectionFields } from "./decision-projection-fields.ts";

/**
 * 可复用邻域画布(W4 抽取)的行为契约:脱离 GraphView/页面状态独立可用。
 * 图场景 2026-10-02 恢复节点原位展开(task_baca8e2b3e32c288fbd14b71f0,业主批准):
 * 单击 = 原位展开摘要卡片 + 长出下一环邻居(不自动开抽屉);双击 = 设为中心;
 * Esc = 收正文(探索范围保留);卡片「设为焦点/详情」是显式动作;详情页返回经
 * egoSession 接续焦点/铺开/展开。节点正文只在卡片上,抽屉只承载边。
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

function chipOf(div: HTMLElement, text: string) {
  return [...div.querySelectorAll<HTMLElement>("[data-testid='ego-chip']")].find((c) => c.textContent?.includes(text))!;
}

function cardOf(div: HTMLElement, text: string) {
  return [...div.querySelectorAll<HTMLElement>("[data-testid='ego-card']")].find((c) => c.textContent?.includes(text))!;
}

const unmount = async (root: Root) => {
  await act(async () => {
    root.unmount();
  });
};

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  clearEgoSession();
});

describe("EgoNeighborhood standalone reuse (W4)", () => {
  it("focus mounts as the reading card; neighbors stay compact chips", async () => {
    const { div, root } = await mount();
    // 焦点是阅读主体,自动成卡;其余(含未铺开徽章)保持紧凑 chip。
    expect(div.querySelectorAll("[data-testid='ego-card']").length).toBe(1);
    expect(cardOf(div, "决策 d1")).not.toBeNull();
    expect(div.querySelectorAll("[data-testid='ego-chip']").length).toBe(3);
    expect(div.querySelector(".react-flow")).not.toBeNull();
    await unmount(root);
  });

  it("single click expands the chip in place and grows its next ring; no drawer opens", async () => {
    const { div, root } = await mount();
    const beforeChips = div.querySelectorAll("[data-testid='ego-chip']").length;
    await act(async () => {
      chipOf(div, "任务一").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // 原位成卡 + 长出下一环(t2/t3 已在,但 hop 语义不重复计数;用计数与卡片同时断言)。
    expect(cardOf(div, "任务一")).not.toBeNull();
    expect(div.querySelectorAll("[data-testid='ego-chip']").length).toBe(beforeChips - 1);
    // 节点正文不进抽屉:单击后抽屉不得出现(同一正文只在一处)。
    expect(div.querySelector("[data-testid='graph-detail-drawer']")).toBeNull();
    await unmount(root);
  });

  it("expanding a peripheral node grows nodes beyond the hops budget (t4 case)", async () => {
    // d1 → t1 → t2 → t4:down=2 预算铺到 t2/t3;t4 在第三跳不铺。展开 t2 必须把 t4
    // 长出来 —— 展开是显式动作,不受预算限制。
    const tasks = [...fixtures.tasks, task("t4", "任务四")];
    const relations = [
      ...fixtures.relations,
      { from: "task/t2", to: "task/t4", kind: "depends-on", provenance: "local-document" },
    ] as RelationEdge[];
    const { div, root } = await mount({ tasks, relations, hops: { up: 1, down: 2 } });
    expect(div.textContent).not.toContain("任务四");
    await act(async () => {
      chipOf(div, "任务二").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(div.textContent).toContain("任务四");
    await unmount(root);
  });

  it("clicking an expanded card collapses it; grown neighbors stay", async () => {
    const { div, root } = await mount({ hops: { up: 1, down: 1 } });
    await act(async () => {
      chipOf(div, "任务一").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(cardOf(div, "任务一")).not.toBeNull();
    const chipsWithGrowth = div.querySelectorAll("[data-testid='ego-chip']").length;
    await act(async () => {
      cardOf(div, "任务一").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // 收起只是阅读层收回:t2/t3 仍在画布上。
    expect(div.querySelectorAll("[data-testid='ego-card']").length).toBe(1);
    expect(chipOf(div, "任务一")).not.toBeNull();
    expect(div.querySelectorAll("[data-testid='ego-chip']").length).toBe(chipsWithGrowth + 1);
    await unmount(root);
  });

  it("Esc collapses all cards without shrinking the explored scope", async () => {
    const { div, root } = await mount({ hops: { up: 1, down: 1 } });
    await act(async () => {
      chipOf(div, "任务一").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const chipsBefore = div.querySelectorAll("[data-testid='ego-chip']").length;
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(div.querySelectorAll("[data-testid='ego-card']").length).toBe(0);
    // 探索范围(已长出的邻居)不被 Esc 撤回:焦点与 t1 都回到 chip,t2/t3 仍在。
    expect(div.querySelectorAll("[data-testid='ego-chip']").length).toBe(chipsBefore + 2);
    await unmount(root);
  });

  it("double click reports the node navRef through onRefocus (host decides page jump)", async () => {
    const onRefocus = vi.fn();
    const { div, root } = await mount({ onRefocus });
    await act(async () => {
      chipOf(div, "任务一").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onRefocus).toHaveBeenCalledWith("task/t1");
    await unmount(root);
  });

  it("card buttons act explicitly without triggering node click/dblclick", async () => {
    const onRefocus = vi.fn();
    const onNavigateEntity = vi.fn();
    const { div, root } = await mount({ onRefocus, onNavigateEntity });
    await act(async () => {
      chipOf(div, "任务一").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const card = cardOf(div, "任务一")!;
    // 「设为焦点」:一次点击只报一次 onRefocus,不触发收起/展开切换。
    await act(async () => {
      card.querySelector("[data-testid='ego-card-refocus']")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRefocus).toHaveBeenCalledTimes(1);
    expect(onRefocus).toHaveBeenCalledWith("task/t1");
    expect(cardOf(div, "任务一")).not.toBeNull();
    // 「详情」:报 onNavigateEntity;按钮上的双击不触发父节点的双击重聚焦。
    await act(async () => {
      card.querySelector("[data-testid='ego-card-open']")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onRefocus).toHaveBeenCalledTimes(1);
    await act(async () => {
      card.querySelector("[data-testid='ego-card-open']")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onNavigateEntity).toHaveBeenCalledWith("task/t1");
    // 「收起」:卡片收回,不触发 onRefocus/onNavigateEntity。
    await act(async () => {
      card
        .querySelector("[data-testid='ego-card-collapse']")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(chipOf(div, "任务一")).not.toBeNull();
    expect(onRefocus).toHaveBeenCalledTimes(1);
    expect(onNavigateEntity).toHaveBeenCalledTimes(1);
    await unmount(root);
  });

  it("task cards expose the shared pin writer without making non-task entities writable", async () => {
    const onSetTaskPin = vi.fn();
    const { div, root } = await mount({ onSetTaskPin });
    const taskPin = div.querySelector("[data-testid='ego-pin-toggle-t1']") as HTMLButtonElement;
    expect(taskPin).not.toBeNull();
    expect(div.querySelector("[data-testid='ego-pin-toggle-d1']")).toBeNull();
    await act(async () => {
      taskPin.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSetTaskPin).toHaveBeenCalledWith(fixtures.tasks[0], true);
    await unmount(root);
  });

  it("edge drawer renders edge info only (nodes carry their own bodies)", async () => {
    // happy-dom 不渲染 ReactFlow 的 SVG 边,边抽屉按组件面直接锁:抽屉只承载边
    // (种类/端点/provenance/两端跳转),不再有节点正文分支。
    const { GraphDrawer } = await import("../src/renderer/graph/GraphDrawer.tsx");
    const onClose = vi.fn();
    const onFocus = vi.fn();
    const onNavigateEntity = vi.fn();
    const div = document.createElement("div");
    document.body.appendChild(div);
    const root = createRoot(div);
    await act(async () => {
      root.render(
        createElement(GraphDrawer, {
          focusEdge: fixtures.relations[0]!,
          onClose,
          onFocus,
          onNavigateEntity,
        }),
      );
    });
    const drawer = div.querySelector("[data-testid='graph-detail-drawer']")!;
    expect(drawer.textContent).toContain("derives");
    expect(drawer.textContent).toContain("decision/d1");
    expect(drawer.textContent).toContain("task/t1");
    const { messageFor } = await import("../src/renderer/i18n/core.ts");
    const jumpLabel = messageFor("graph.graphDrawer.jumpSourceNode");
    const jump = [...drawer.querySelectorAll("button")].find((b) => b.textContent?.includes(jumpLabel))!;
    await act(async () => {
      jump.click();
    });
    expect(onFocus).toHaveBeenCalledWith("decision/d1");
    await act(async () => {
      root.unmount();
    });
  });

  it("clearing focusRef resets the accumulated canvas", async () => {
    const { div, root } = await mount();
    await act(async () => {
      chipOf(div, "任务一").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(cardOf(div, "任务一")).not.toBeNull();
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
    await unmount(root);
  });

  it("remount with the same focus continues the exploration session (detail-page return)", async () => {
    // 详情页往返的接续契约:卸载(去详情页)再挂载(返回),焦点/铺开/展开原样恢复。
    const first = await mount({ hops: { up: 1, down: 1 } });
    await act(async () => {
      chipOf(first.div, "任务一").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const cardsBefore = first.div.querySelectorAll("[data-testid='ego-card']").length;
    const chipsBefore = first.div.querySelectorAll("[data-testid='ego-chip']").length;
    await unmount(first.root);

    const second = await mount({ hops: { up: 1, down: 1 } });
    expect(second.div.querySelectorAll("[data-testid='ego-card']").length).toBe(cardsBefore);
    expect(second.div.querySelectorAll("[data-testid='ego-chip']").length).toBe(chipsBefore);
    expect(cardOf(second.div, "任务一")).not.toBeNull();
    await unmount(second.root);
  });

  it("remount with a different focus starts fresh (no stale restore)", async () => {
    const first = await mount({ hops: { up: 1, down: 1 } });
    await act(async () => {
      chipOf(first.div, "任务一").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await unmount(first.root);

    const second = await mount({ focusRef: "task/t2", hops: { up: 1, down: 1 } });
    // 焦点不同 = 新探索:不恢复旧焦点的铺开,t2 自己成为焦点卡。
    expect(second.div.querySelectorAll("[data-testid='ego-card']").length).toBe(1);
    expect(cardOf(second.div, "任务二")).not.toBeNull();
    await unmount(second.root);
  });

  it("reports layout stats (nodes/edges/focusLabel) to the host", async () => {
    const onLayoutStats = vi.fn();
    const { root } = await mount({ onLayoutStats });
    const last = onLayoutStats.mock.calls.at(-1)?.[0];
    expect(last.nodes).toBe(4);
    expect(last.edges).toBe(3);
    expect(last.focusLabel).toContain("d1");
    await unmount(root);
  });
});

/** 图场景 2026-10-02:节点原位展开后,原抽屉的节点正文全部在卡片上(内容对等,不丢信息)。 */
describe("card content parity (node summaries live on the expanded card)", () => {
  it("shows rejected claims with whyNot for an expanded decision", async () => {
    const decisions = [
      {
        ...decision("d1"),
        rejected: [{ id: "R1", text: "否决论点甲", whyNot: "代价高于收益", evidence: [] }],
      },
    ];
    const { div, root } = await mount({ decisions });
    // 焦点即该 decision:卡片直接承载正文,不需要先单击。
    const cardText = cardOf(div, "决策 d1")!.textContent ?? "";
    expect(cardText).toContain("否决论点甲");
    expect(cardText).toContain("代价高于收益");
    await unmount(root);
  });

  it("shows task risk/urgency and agent taskCount on expanded cards", async () => {
    const riskyTask = { ...fixtures.tasks[0]!, riskTier: "high", urgency: "high" } as (typeof fixtures.tasks)[0];
    const { div, root } = await mount({
      tasks: [riskyTask, ...fixtures.tasks.slice(1)],
      agents: [{ id: "agent/a1", name: "执行体 甲", sub: "worker", taskCount: 13 }],
      relations: [
        ...fixtures.relations,
        { from: "agent/a1", to: "task/t1", kind: "dispatches", provenance: "local-document" },
      ] as RelationEdge[],
    });
    await act(async () => {
      chipOf(div, "任务一").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const taskCard = cardOf(div, "任务一")!;
    expect(taskCard.textContent).toContain("high");

    await act(async () => {
      chipOf(div, "执行体 甲").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const agentCard = cardOf(div, "执行体 甲")!;
    expect(agentCard.textContent).toContain("worker");
    expect(agentCard.textContent).toContain("13");
    await unmount(root);
  });
});
