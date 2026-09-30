// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TaskRow, DecisionRow, RelationEdge } from "../src/renderer/model/types.ts";
import { decisionProjectionFields } from "./decision-projection-fields.ts";

/**
 * 相机归属:聚光灯的缩放级别只由用户改,不由画布上有多少节点决定。
 *
 * 泽宇 2026-09-13 在 Electron 里实测到的问题——单击一个 chip 展开邻居,整张图被
 * fitView 塞进一屏,几百个子任务的工作下缩到看不清,原本在读的那块彻底找不回来。
 * 病根是旧 effect 把 displayNodes.length 放进了依赖:那是内容变化,不是用户动作。
 *
 * 这里钉两条:换焦点(用户动作)平移到焦点且不改 zoom;单击选中(§5.2 后唯一单击
 * 语义,不再改变画布内容)完全不动相机。
 */

const setCenter = vi.fn();
const fitView = vi.fn();
const getZoom = vi.fn(() => 0.37);

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    useReactFlow: () => ({ ...actual.useReactFlow(), setCenter, getZoom, fitView }),
  };
});

const { EgoNeighborhood } = await import("../src/renderer/graph/EgoNeighborhood.tsx");

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
    state: "active",
    question: "Q?",
    chosen: [],
    rejected: [],
    claims: [],
    proposedAt: "2026-08-01T00:00:00.000Z",
    ...decisionProjectionFields("proposed"),
  } as DecisionRow;
}

const fixtures = {
  // t4 在焦点 d1 的第三跳,默认 ±2 跳不铺开;展开 t2 才会把它长出来。
  tasks: [task("t1", "任务一"), task("t2", "任务二"), task("t3", "任务三"), task("t4", "任务四")],
  decisions: [decision("d1")],
  relations: [
    { from: "decision/d1", to: "task/t1", kind: "derives", provenance: "local-document" },
    { from: "task/t1", to: "task/t2", kind: "depends-on", provenance: "local-document" },
    { from: "task/t1", to: "task/t3", kind: "blocks", provenance: "local-document" },
    { from: "task/t2", to: "task/t4", kind: "depends-on", provenance: "local-document" },
  ] as RelationEdge[],
};

function element(focusRef: string) {
  return createElement(EgoNeighborhood, {
    focusRef,
    tasks: fixtures.tasks,
    decisions: fixtures.decisions,
    facts: [],
    relations: fixtures.relations,
    factAnchors: [],
  } as Parameters<typeof EgoNeighborhood>[0]);
}

/** effect 把相机动作排进 requestAnimationFrame,断言前先把这一帧放出去。 */
async function flushFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  });
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  setCenter.mockClear();
  getZoom.mockClear();
  fitView.mockClear();
});

describe("聚光灯相机", () => {
  it("换焦点平移到焦点,并原样带走当前缩放", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const root: Root = createRoot(div);
    await act(async () => {
      root.render(element("decision/d1"));
    });
    await flushFrame();
    setCenter.mockClear();

    await act(async () => {
      root.render(element("task/t2"));
    });
    await flushFrame();

    // 布局器把焦点节点的几何中心恒置于流坐标原点,所以定心到 (0,0) 就是定心到新焦点。
    expect(setCenter).toHaveBeenCalledTimes(1);
    const [x, y, options] = setCenter.mock.calls[0] as [number, number, { zoom: number }];
    expect([x, y]).toEqual([0, 0]);
    // zoom 等于调用前读到的值 —— 相机平移,不缩放。
    expect(options.zoom).toBe(0.37);
    // 换焦点也不许把整张图塞进一屏。
    expect(fitView).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("单击选中开抽屉,画布内容与相机都一动不动", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const root: Root = createRoot(div);
    await act(async () => {
      root.render(element("decision/d1"));
    });
    await flushFrame();
    const nodeCount = () => div.querySelectorAll("[data-testid='ego-chip']").length;
    const before = nodeCount();
    setCenter.mockClear();
    fitView.mockClear();

    const chip = [...div.querySelectorAll("[data-testid='ego-chip']")].find((c) => c.textContent?.includes("任务二"))!;
    await act(async () => {
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushFrame();

    // §5.2:单击只选中(抽屉显示摘要),不改变画布内容 —— 节点数不变,相机不动。
    expect(nodeCount()).toBe(before);
    expect(div.querySelector("[data-testid='graph-detail-drawer']")).not.toBeNull();
    expect(div.querySelectorAll("[data-testid='ego-card']").length).toBe(0);
    expect(setCenter).not.toHaveBeenCalled();
    expect(fitView).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });
});
