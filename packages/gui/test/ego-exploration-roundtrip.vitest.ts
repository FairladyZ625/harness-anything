// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactFlowProps } from "@xyflow/react";
import type { EgoFlowNode, EgoFlowEdge } from "../src/renderer/graph/egoCanvas.ts";
import type { FactRef, RelationEdge, TaskRow } from "../src/renderer/model/types.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";
import { clearEgoSession, readEgoSessionFor } from "../src/renderer/graph/egoSession.ts";

let flow: ReactFlowProps<EgoFlowNode, EgoFlowEdge>;
const setCenter = vi.fn();
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    useReactFlow: () => ({ ...actual.useReactFlow(), setCenter }),
    ReactFlow: (props: ReactFlowProps<EgoFlowNode, EgoFlowEdge>) => {
      flow = props;
      return createElement(actual.ReactFlow, props);
    },
  };
});
const { GraphView } = await import("../src/renderer/views/GraphView.tsx");
const { FactDetailView } = await import("../src/renderer/views/EntityDetailView.tsx");

const tasks: TaskRow[] = ["a", "c", "d"].map((taskId) => ({
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
  lastKnownAt: "2026-08-01T00:00:00.000Z",
  gates: [],
  docs: [],
  ...projectedTaskFields("active"),
}));
const facts: FactRef[] = [
  { anchor: "fact/F-B", taskId: "a", category: "finding", text: "邻居 B 的观察", at: "2026-08-01T00:00:00.000Z" },
];
const relations: RelationEdge[] = [
  { from: "task/a", to: "fact/F-B", kind: "produces", provenance: "local-document" },
  { from: "task/a", to: "task/c", kind: "depends-on", provenance: "local-document" },
  { from: "task/d", to: "fact/F-B", kind: "produces", provenance: "local-document" },
];

function Journey() {
  const [detail, setDetail] = useState<string | null>(null);
  const [focusRef, setFocusRef] = useState("task/a");
  const data = { repoId: "repo-a", tasks, facts, decisions: [], relations, factAnchors: [] };
  return detail
    ? createElement(
        "div",
        null,
        createElement("button", { "data-testid": "back", onClick: () => setDetail(null) }, "返回"),
        createElement(FactDetailView, {
          ...data,
          factRef: detail,
          coverageRows: [],
          loading: false,
          onNavigateEntity: setDetail,
        }),
      )
    : createElement(GraphView, {
        ...data,
        focusRef,
        viewMode: "spotlight",
        onViewModeChange: () => {},
        onNavigateEntity: setDetail,
        onFocusEntityChange: (ref) => setFocusRef(ref!),
      });
}

let root: Root;
let div: HTMLDivElement;
const centers = () =>
  new Map(
    flow.nodes!.map((node) => [
      node.id,
      { x: node.position.x + Number(node.width) / 2, y: node.position.y + Number(node.height) / 2 },
    ]),
  );
const nodeElement = (id: string, testId: string) =>
  div.querySelector<HTMLElement>(`.react-flow__node[data-id='${id}'] [data-testid='${testId}']`)!;
const click = (el: HTMLElement) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(async () => {
  clearEgoSession();
  div = document.createElement("div");
  document.body.appendChild(div);
  root = createRoot(div);
  await act(async () => {
    root.render(createElement(StrictMode, null, createElement(Journey)));
  });
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  div.remove();
});

describe("主图探索的所有权与节点中心", () => {
  it("直接打开邻居 Fact 的真实详情邻域再返回,主图焦点/卡片/铺开/视口/中心恢复", async () => {
    await click(nodeElement("fact/F-B", "ego-chip"));
    const before = centers();
    const viewport = { x: 173, y: -91, zoom: 0.61 };
    await act(async () => {
      flow.onMoveEnd!(null, viewport);
    });
    await click(nodeElement("fact/F-B", "ego-card-open"));
    expect(div.querySelector("[data-testid='fact-detail-view']")).toBeTruthy();
    expect(flow.nodes!.find((node) => node.data.focus)?.id).toBe("fact/F-B");
    // 详情预览的缩放以及展开都不能写主图导航会话。
    await act(async () => {
      flow.onMoveEnd!(null, { x: 0, y: 0, zoom: 1 });
    });
    await click(nodeElement("d", "ego-chip"));
    expect(readEgoSessionFor("repo-a", "task/a")?.viewport).toEqual(viewport);
    setCenter.mockClear();
    await click(div.querySelector<HTMLElement>("[data-testid='back']")!);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(flow.nodes!.find((node) => node.data.focus)?.id).toBe("a");
    expect(nodeElement("fact/F-B", "ego-card")).toBeTruthy();
    expect(nodeElement("d", "ego-chip")).toBeTruthy();
    expect(flow.defaultViewport).toEqual(viewport);
    expect(centers()).toEqual(before);
    expect(setCenter).not.toHaveBeenCalled();
    expect(readEgoSessionFor("repo-a", "task/a")?.expanded).toContain("fact/F-B");
  });

  it("展开/收起和长出新邻居保持所有已有节点中心,显式换焦点才重排", async () => {
    const before = centers();
    await click(nodeElement("fact/F-B", "ego-chip"));
    expect(flow.nodes!.some((node) => node.id === "d")).toBe(true);
    for (const [id, center] of before) expect(centers().get(id), id).toEqual(center);
    const expanded = centers();
    for (const id of ["c", "d"]) {
      await click(nodeElement(id, "ego-chip"));
      expect(centers()).toEqual(expanded);
    }
    for (const node of flow.nodes!)
      for (const other of flow.nodes!) {
        if (node.id === other.id) continue;
        expect(
          node.position.x + Number(node.width) <= other.position.x ||
            other.position.x + Number(other.width) <= node.position.x ||
            node.position.y + Number(node.height) <= other.position.y ||
            other.position.y + Number(other.height) <= node.position.y,
        ).toBe(true);
      }
    await click(nodeElement("fact/F-B", "ego-card-collapse"));
    expect(centers()).toEqual(expanded);
    await click(nodeElement("fact/F-B", "ego-chip"));
    await click(nodeElement("fact/F-B", "ego-card-refocus"));
    expect(flow.nodes!.find((node) => node.data.focus)?.id).toBe("fact/F-B");
    expect(centers().get("fact/F-B")).toEqual({ x: 0, y: 0 });
    expect(centers().get("a")).not.toEqual(before.get("a"));
  });
});
