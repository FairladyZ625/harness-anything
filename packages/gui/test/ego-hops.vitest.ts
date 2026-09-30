// harness-test-tier: fast
// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { bfsShownFromFocus, buildEgoGraph, type EgoAxisFilter } from "../src/renderer/graph/egoCanvas.ts";
import { EGO_DEFAULT_HOPS } from "../src/renderer/graph/useEgoCanvas.ts";
import { EgoHopsControl, EGO_HOPS_MAX, EGO_HOPS_MIN } from "../src/renderer/graph/EgoHopsControl.tsx";
import { EgoNeighborhood } from "../src/renderer/graph/EgoNeighborhood.tsx";
import type { DecisionRow, RelationEdge, TaskRow } from "../src/renderer/model/types.ts";

/**
 * 聚焦跳数预算(task_b4258de1):「父 ↑ N / 子 ↓ M」步进器 + 方向化 BFS。
 * 全部走既有完整图投影(repo.triadic.relationGraph,无 facet)—— 跳数是前端
 * BFS 预算,不产生任何额外 daemon 读。
 */

function task(taskId: string): TaskRow {
  return {
    taskId,
    title: `任务 ${taskId}`,
    projectId: "proj",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    lastKnownAt: "2026-08-30T00:00:00.000Z",
    gates: [],
    docs: [],
  } as TaskRow;
}

function decision(decisionId: string): DecisionRow {
  return {
    decisionId,
    title: `决策 ${decisionId}`,
    state: "active",
    question: "Q?",
    chosen: [],
    rejected: [],
    claims: [],
    proposedAt: "2026-08-30T00:00:00.000Z",
  } as DecisionRow;
}

// 链:d0 → d1 → t1 → t2 → t3。焦点 t1:上游 d0/d1,下游 t2/t3。
// BFS 吃的是归一 node id(task 是裸 id),focusRef 的 task/<id> 形式由画布先归一。
const chainTasks = [task("t1"), task("t2"), task("t3")];
const chainDecisions = [decision("d0"), decision("d1")];
const chainRelations = [
  { from: "decision/d0", to: "decision/d1", kind: "supersedes", provenance: "local-document" },
  { from: "decision/d1", to: "task/t1", kind: "derives", provenance: "local-document" },
  { from: "task/t1", to: "task/t2", kind: "depends-on", provenance: "local-document" },
  { from: "task/t2", to: "task/t3", kind: "blocks", provenance: "local-document" },
] as RelationEdge[];

const axes: EgoAxisFilter = { authority: true, evidence: true, execution: true, assoc: false };

function chainGraph() {
  return buildEgoGraph(chainTasks, chainDecisions, [], chainRelations, []);
}

describe("bfsShownFromFocus 方向化预算", () => {
  it("默认 ±2 与旧的对称 maxHop 同集", () => {
    const shown = bfsShownFromFocus(chainGraph(), "t1", EGO_DEFAULT_HOPS, axes);
    expect([...shown.keys()].sort()).toEqual(["decision/d0", "decision/d1", "t1", "t2", "t3"]);
  });

  it("父/子预算各自独立:up=2 down=0 只铺上游", () => {
    const shown = bfsShownFromFocus(chainGraph(), "t1", { up: 2, down: 0 }, axes);
    expect([...shown.keys()].sort()).toEqual(["decision/d0", "decision/d1", "t1"]);
  });

  it("up=0 down=2 只铺下游", () => {
    const shown = bfsShownFromFocus(chainGraph(), "t1", { up: 0, down: 2 }, axes);
    expect([...shown.keys()].sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("0/0 只剩焦点自身", () => {
    const shown = bfsShownFromFocus(chainGraph(), "t1", { up: 0, down: 0 }, axes);
    expect([...shown.keys()]).toEqual(["t1"]);
  });

  it("预算记录的是沿该侧走出的跳数,不是纯方向可达", () => {
    // t3 在下游第 2 跳(down=1 时不可见);d0 在上游第 2 跳(up=1 时不可见)。
    const one = bfsShownFromFocus(chainGraph(), "t1", { up: 1, down: 1 }, axes);
    expect(one.has("t2")).toBe(true);
    expect(one.has("t3")).toBe(false);
    expect(one.has("decision/d1")).toBe(true);
    expect(one.has("decision/d0")).toBe(false);
  });
});

async function mountControl() {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const root = createRoot(div);
  const onHopsChange = vi.fn();
  await act(async () => {
    root.render(createElement(EgoHopsControl, { hops: { up: 1, down: 1 }, onHopsChange }));
  });
  return { div, root, onHopsChange };
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

describe("EgoHopsControl 步进器", () => {
  it("父/子各一个步进器,初始值透传", async () => {
    const { div, root } = await mountControl();
    expect(div.querySelector("[data-testid='ego-hops-up-value']")?.textContent).toBe("1");
    expect(div.querySelector("[data-testid='ego-hops-down-value']")?.textContent).toBe("1");
    await act(async () => {
      root.unmount();
    });
  });

  it("+/- 各改一侧,互不影响", async () => {
    const { div, root, onHopsChange } = await mountControl();
    await act(async () => {
      (div.querySelector("[data-testid='ego-hops-up-inc']") as HTMLButtonElement).click();
    });
    expect(onHopsChange).toHaveBeenLastCalledWith({ up: 2, down: 1 });
    await act(async () => {
      (div.querySelector("[data-testid='ego-hops-down-dec']") as HTMLButtonElement).click();
    });
    expect(onHopsChange).toHaveBeenLastCalledWith({ up: 1, down: 0 });
    await act(async () => {
      root.unmount();
    });
  });

  it(`范围钳在 ${EGO_HOPS_MIN}–${EGO_HOPS_MAX},越界按钮置灰`, async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const root = createRoot(div);
    const onHopsChange = vi.fn();
    await act(async () => {
      root.render(createElement(EgoHopsControl, { hops: { up: 0, down: 4 }, onHopsChange }));
    });
    expect((div.querySelector("[data-testid='ego-hops-up-dec']") as HTMLButtonElement).disabled).toBe(true);
    expect((div.querySelector("[data-testid='ego-hops-down-inc']") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      (div.querySelector("[data-testid='ego-hops-down-inc']") as HTMLButtonElement).click();
    });
    expect(onHopsChange).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });
});

async function mountNeighborhood(hops: { up: number; down: number }) {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const root = createRoot(div);
  const render = (next: { up: number; down: number }) =>
    act(async () => {
      root.render(
        createElement(EgoNeighborhood, {
          focusRef: "task/t1",
          tasks: chainTasks,
          decisions: chainDecisions,
          facts: [],
          relations: chainRelations,
          factAnchors: [],
          hops: next,
        } as Parameters<typeof EgoNeighborhood>[0]),
      );
    });
  await render(hops);
  return { div, root, render };
}

describe("EgoNeighborhood 接 hops", () => {
  it("1/1 只铺父一跳 + 子一跳;步进到 2/2 就地长出第二跳,不清焦点", async () => {
    const { div, root, render } = await mountNeighborhood({ up: 1, down: 1 });
    // 焦点 chip t1 + 上游 d1 + 下游 t2(§5.2:焦点也是 chip,不再展开成卡片)。
    expect(div.querySelectorAll("[data-testid='ego-chip']").length).toBe(3);
    await render({ up: 2, down: 2 });
    expect(div.querySelectorAll("[data-testid='ego-chip']").length).toBe(5);
    expect(div.querySelectorAll("[data-testid='ego-card']").length).toBe(0);
    await act(async () => {
      root.unmount();
    });
  });

  it("单击子节点只选中开抽屉,不长出下一跳;焦点不变", async () => {
    const { div, root } = await mountNeighborhood({ up: 1, down: 1 });
    const before = div.querySelectorAll("[data-testid='ego-chip']").length;
    const t2 = [...div.querySelectorAll("[data-testid='ego-chip']")].find((c) => c.textContent?.includes("任务 t2"))!;
    await act(async () => {
      t2.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // §5.2:单击 = 选中 + 抽屉;画布节点数与焦点都不变(t3 不会因此出现)。
    expect(div.querySelectorAll("[data-testid='ego-chip']").length).toBe(before);
    expect(div.textContent).not.toContain("任务 t3");
    const drawer = div.querySelector("[data-testid='graph-detail-drawer']")!;
    expect(drawer.textContent).toContain("任务 t2");
    await act(async () => {
      root.unmount();
    });
  });
});
