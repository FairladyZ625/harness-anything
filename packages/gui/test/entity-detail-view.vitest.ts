// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DecisionDetailView, FactDetailView } from "../src/renderer/views/EntityDetailView.tsx";
import type { TaskRow, DecisionRow, FactRef, RelationEdge } from "../src/renderer/model/types.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * Fact/Decision 详情页(W4 可寻址路由的渲染面):
 * 详情栏复用 FactInspector / DecisionDetailPanel,邻域复用 graph/EgoNeighborhood;
 * 无单体 read —— 取数来自已加载的 triadic 集合,集合加载中/实体缺失有显式态。
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

function decision(): DecisionRow {
  return {
    decisionId: "dec_1", title: "暴露投影", state: "in_effect", question: "走哪条读径?",
    chosen: [{ id: "CH1", text: "复用集合投影", evidence: [] }],
    rejected: [{ id: "RJ1", text: "直读 Markdown", evidence: [], whyNot: "绕开 canonical 投影" }],
    claims: [], proposedAt: "2026-08-01T00:00:00.000Z",
  } as DecisionRow;
}

const facts: FactRef[] = [{
  anchor: "task_a/F-001", taskId: "task_a", category: "finding",
  text: "GUI 收到了事件派生的三元行。", at: "2026-08-01T00:00:00.000Z",
}];

const relations: RelationEdge[] = [
  { from: "decision/dec_1", to: "task/task_a", kind: "derives", provenance: "local-document" },
  { from: "decision/dec_1/CH1", to: "fact/task_a/F-001", kind: "evidenced-by", provenance: "local-document" },
  { from: "task/task_a", to: "fact/task_a/F-001", kind: "produces", provenance: "local-document" },
];

async function mountView(element: ReturnType<typeof createElement>) {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const root = createRoot(div);
  await act(async () => { root.render(element); });
  return { div, root: root as Root };
}

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; setActiveLocale("zh-CN"); });

describe("DecisionDetailView", () => {
  it("renders the detail panel beside a neighborhood canvas of that decision", async () => {
    const { div, root } = await mountView(createElement(DecisionDetailView, {
      decisionId: "dec_1", decisions: [decision()], tasks: [task("task_a", "任务A")],
      facts, relations, factAnchors: [], loading: false,
    }));
    expect(div.querySelector("[data-testid='decision-detail-panel']")?.textContent).toContain("暴露投影");
    expect(div.querySelector("[data-testid='decision-detail-view'] .react-flow")).not.toBeNull();
    // 邻域含 task 邻居 chip(derives 边)。
    expect(div.querySelector("[data-testid='ego-chip']")).not.toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("shows the loading state while the collection is still loading", async () => {
    const { div, root } = await mountView(createElement(DecisionDetailView, {
      decisionId: "dec_missing", decisions: [], tasks: [], facts: [],
      relations: [], factAnchors: [], loading: true,
    }));
    expect(div.querySelector("[data-testid='entity-detail-pending']")?.textContent).toContain("加载中");
    await act(async () => { root.unmount(); });
  });

  it("shows the not-in-projection state after loading completes without the entity", async () => {
    const { div, root } = await mountView(createElement(DecisionDetailView, {
      decisionId: "dec_missing", decisions: [decision()], tasks: [], facts: [],
      relations: [], factAnchors: [], loading: false,
    }));
    expect(div.querySelector("[data-testid='entity-detail-pending']")?.textContent).toContain("不在当前投影");
    await act(async () => { root.unmount(); });
  });

  it("在决策池查看 fires the pool opener with the decision id", async () => {
    const onOpenPool = vi.fn();
    const { div, root } = await mountView(createElement(DecisionDetailView, {
      decisionId: "dec_1", decisions: [decision()], tasks: [], facts: [],
      relations, factAnchors: [], loading: false, onOpenPool,
    }));
    const poolBtn = [...div.querySelectorAll("button")].find((b) => b.textContent?.includes("在决策池查看"))!;
    await act(async () => { poolBtn.click(); });
    expect(onOpenPool).toHaveBeenCalledWith("dec_1");
    await act(async () => { root.unmount(); });
  });
});

describe("FactDetailView", () => {
  it("renders the fact inspector beside a neighborhood centered on the fact", async () => {
    const { div, root } = await mountView(createElement(FactDetailView, {
      factRef: "fact/task_a/F-001", facts, tasks: [task("task_a", "任务A")],
      decisions: [decision()], relations, factAnchors: [], loading: false,
    }));
    expect(div.querySelector("[data-testid='fact-inspector']")?.textContent).toContain("GUI 收到了事件派生的三元行。");
    expect(div.querySelector("[data-testid='fact-detail-view'] .react-flow")).not.toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("neighbor nodes report jumps through onNavigateEntity (跳去邻居详情页)", async () => {
    const onNavigateEntity = vi.fn();
    const { div, root } = await mountView(createElement(FactDetailView, {
      factRef: "fact/task_a/F-001", facts, tasks: [task("task_a", "任务A")],
      decisions: [decision()], relations, factAnchors: [], loading: false, onNavigateEntity,
    }));
    const chip = [...div.querySelectorAll("[data-testid='ego-chip']")].find((c) => c.textContent?.includes("任务A"))!;
    await act(async () => { chip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(onNavigateEntity).toHaveBeenCalledWith("task/task_a");
    await act(async () => { root.unmount(); });
  });

  it("anchor-only facts (no body in the projection) still show a neighborhood", async () => {
    const { div, root } = await mountView(createElement(FactDetailView, {
      factRef: "fact/task_b/F-002", facts: [], tasks: [task("task_b", "任务B")],
      decisions: [], relations: [], factAnchors: [{ factRef: "fact/task_b/F-002", taskId: "task_b", factId: "F-002" }],
      loading: false,
    }));
    expect(div.querySelector("[data-testid='fact-inspector']")).not.toBeNull();
    // 仅有锚点也有详情页(不因正文缺席而 404)。
    expect(div.querySelector("[data-testid='entity-detail-pending']")).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("W5 后不再有「在分诊中查看」出口(事实分诊页已撤销,详情页即终点)", async () => {
    const { div, root } = await mountView(createElement(FactDetailView, {
      factRef: "fact/task_a/F-001", facts, tasks: [task("task_a", "任务A")],
      decisions: [decision()], relations, factAnchors: [], loading: false,
    }));
    expect(div.querySelector("[data-testid='fact-detail-open-triage']")).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("missing fact while loading shows loading; after load shows not-in-projection", async () => {    const loadingView = await mountView(createElement(FactDetailView, {
      factRef: "fact/task_c/F-404", facts, tasks: [], decisions: [], relations: [],
      factAnchors: [], loading: true,
    }));
    expect(loadingView.div.querySelector("[data-testid='entity-detail-pending']")?.textContent).toContain("加载中");
    await act(async () => { loadingView.root.unmount(); });
    const missingView = await mountView(createElement(FactDetailView, {
      factRef: "fact/task_c/F-404", facts, tasks: [], decisions: [], relations: [],
      factAnchors: [], loading: false,
    }));
    expect(missingView.div.querySelector("[data-testid='entity-detail-pending']")?.textContent).toContain("不在当前投影");
    await act(async () => { missingView.root.unmount(); });
  });
});
