// harness-test-tier: integration
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceView } from "../src/renderer/views/WorkspaceView.tsx";
import type { WorkTopologyRead, WorkspaceScopeRead } from "../src/api/renderer-dto.ts";
import type { TaskRow, DecisionRow, FactRef, RelationEdge } from "../src/renderer/model/types.ts";
import { decisionProjectionFields } from "./decision-projection-fields.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { clearEgoSession } from "../src/renderer/graph/egoSession.ts";
import { taskQueryKeys } from "../src/renderer/task-data.ts";

/**
 * 工作详情页「关系图」页签消费 daemon 单 cut 拓扑,复用聚光灯的 ego 画布与跨页签焦点。
 */

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

beforeEach(() => {
  // ego 会话是模块级单槽:测试间清空,避免上一个用例的探索态串场。
  clearEgoSession();
});
const task = (taskId: string, parentTaskId?: string): TaskRow => ({
  taskId,
  title: `任务 ${taskId}`,
  parentTaskId,
  projectId: "proj",
  coordinationStatus: "active",
  rawStatus: "active",
  freshness: "fresh",
  packageDisposition: "active",
  closeoutReadiness: "not_required",
  engine: "local",
  source: "local-document",
  lastKnownAt: "2026-09-21",
  gates: [],
  docs: [],
  ...projectedTaskFields("active"),
});
const decision = (decisionId: string): DecisionRow =>
  ({
    decisionId,
    title: `决策 ${decisionId}`,
    state: "proposed",
    question: "Q",
    chosen: [],
    rejected: [],
    claims: [],
    proposedAt: "2026-09-21",
    ...decisionProjectionFields("proposed"),
  }) as DecisionRow;
const fact = (anchor: string): FactRef => ({
  anchor,
  text: `事实 ${anchor}`,
  category: "finding",
  at: "2026-09-21",
  confidence: "high",
});
const edge = (from: string, to: string, kind = "relates"): RelationEdge =>
  ({ from, to, kind, provenance: "local-document" }) as RelationEdge;
const topology: WorkTopologyRead = {
  schema: "daemon.work-topology/v1",
  ok: true,
  status: "ready",
  workRootTaskId: "root",
  members: [
    {
      taskId: "root",
      title: "任务 root",
      canonicalStatus: "active",
      topologyState: "in-flight",
      parentTaskId: null,
      pinned: false,
      boundary: false,
      blockers: [],
      warnings: [],
    },
    {
      taskId: "member",
      title: "任务 member",
      canonicalStatus: "planned",
      topologyState: "blocked",
      parentTaskId: "root",
      pinned: false,
      boundary: false,
      blockers: [
        { relationId: "rel-member-boundary", kind: "depends-on", sourceTaskId: "member", targetTaskId: "boundary" },
      ],
      warnings: [],
    },
  ],
  boundaryTasks: [
    {
      taskId: "boundary",
      title: "任务 boundary",
      canonicalStatus: "planned",
      topologyState: "boundary",
      parentTaskId: null,
      pinned: false,
      boundary: true,
      blockers: [],
      warnings: [],
    },
  ],
  edges: [
    {
      relationId: "rel-member-boundary",
      from: "task/member",
      to: "task/boundary",
      kind: "depends-on",
      direction: "directed",
      state: "active",
      rationale: "must ship first",
    },
  ],
  frontier: ["root"],
  criticalPath: ["member"],
  completeness: "complete",
  warnings: [],
  watermark: 1,
  sourceRevision: 1,
};
function queryClientForTopology() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(taskQueryKeys.topology("repo", "root"), topology);
  return client;
}
const scope: WorkspaceScopeRead = {
  schema: "daemon.workspace-scope/v1",
  ok: true,
  status: "ready",
  root: {
    taskId: "root",
    title: "工作组",
    status: "active",
    taskClass: "work",
    parentTaskId: null,
    updatedAt: "2026-09-21",
    pinned: false,
    hasChildren: true,
  },
  ancestors: [],
  goalMaterial: null,
  groups: [],
  tasks: [],
  memberTaskIds: ["member"],
  eventSummaries: [],
  eventWindowComplete: true,
  counts: { done: 0, executing: 0, pending: 0, blocked: 0, planned: 1, cancelled: 0 },
  scope: { descendantCount: 1, executableLeafCount: 1, archivedCount: 0 },
  page: { limit: 1, cursor: null, nextCursor: "member" },
  incompleteParentRefs: [],
  watermark: 1,
  sourceRevision: 1,
  warnings: [],
};

it("uses daemon topology nodes and edges, navigates entities and preserves focus across tabs", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host),
    navigate = vi.fn();
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClientForTopology()}>
        <WorkspaceView
          scope={scope}
          repoId="repo"
          projectName="Project"
          tasks={[task("root"), task("member", "root"), task("boundary"), task("outside")]}
          decisions={[decision("d1"), decision("unrelated")]}
          facts={[fact("F-BARE"), fact("fact/F-PREFIX"), fact("F-OUTSIDE")]}
          relations={[
            edge("task/member", "task/boundary"),
            edge("task/boundary", "task/outside"),
            edge("decision/d1/C1", "task/root", "derives"),
            edge("task/root", "fact/F-BARE", "produces"),
            edge("task/root", "fact/F-PREFIX", "produces"),
            edge("decision/unrelated", "fact/F-OUTSIDE"),
          ]}
          onOpenTask={() => {}}
          onPreviewTask={() => {}}
          rootTaskOpen={false}
          onOpenRootTask={() => {}}
          onCloseRootTask={() => {}}
          onNavigateEntity={navigate}
        />
      </QueryClientProvider>,
    ),
  );
  const tab = async (id: string) =>
    act(async () => host.querySelector<HTMLButtonElement>(`#workspace-tab-${id}`)!.click());
  const node = (id: string) => host.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
  await tab("graph");
  // 图场景 2026-10-02:焦点(root)是阅读主体,自动成卡;其余成员为 chip。
  expect(host.querySelectorAll('[data-testid="ego-card"]').length).toBe(1);
  expect(host.querySelector('.react-flow__node[data-id="root"] [data-testid="ego-card"]')).not.toBeNull();
  expect([...host.querySelectorAll(".react-flow__node")].map((n) => n.getAttribute("data-id")).sort()).toEqual(
    ["root", "member", "boundary"].sort(),
  );
  // 工作页渲染的是全局关系图同一个画布宿主:同一份 relation-canvas,只把 scope 预设成 work。
  const canvas = host.querySelector('[data-testid="relation-canvas"]')!;
  expect(canvas).not.toBeNull();
  expect(canvas.getAttribute("data-scope")).toBe("work");
  expect(canvas.querySelectorAll(".react-flow").length).toBe(1);
  // 状态层逐格等于 daemon 返回值,不是 GUI 自己数的:前沿 1/2、在飞 1、阻塞 1、关键路径 1。
  const statusLayer = host.querySelector('[data-testid="workspace-graph-topology"]')!;
  expect(statusLayer.textContent).toContain("3 节点 / 2 关系");
  expect(statusLayer.textContent).toContain("前沿 1 / 2");
  expect(statusLayer.textContent).toContain("1 在飞");
  expect(statusLayer.textContent).toContain("1 阻塞");
  expect(statusLayer.textContent).toContain("0 待裁决");
  expect(statusLayer.textContent).toContain("关键路径 1 个任务");
  expect(statusLayer.textContent).toContain("外部边界 1");
  expect(statusLayer.textContent).toContain("revision 1");
  expect(node("member").textContent).toContain("任务 member");
  expect(node("outside")).toBeNull();
  expect(node("decision/d1")).toBeNull();
  expect(node("fact/F-BARE")).toBeNull();
  // 卡片「详情」仍走现有实体导航。
  for (const [id, ref] of [["member", "task/member"]]) {
    await act(async () =>
      node(id)
        .querySelector<HTMLElement>("[data-testid='ego-chip']")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(node(id).querySelector('[data-testid="ego-card"]')?.textContent).toContain("blocked");
    const open = node(id).querySelector<HTMLButtonElement>("[data-testid='ego-card-open']")!;
    expect(open).not.toBeNull();
    await act(async () => open.click());
    expect(navigate).toHaveBeenLastCalledWith(ref);
    await act(async () => node(id).querySelector<HTMLElement>("[data-testid='ego-card-collapse']")!.click());
  }
  navigate.mockClear();
  // 双击 = 以它为中心重排邻域,不跳页;与拓扑响应无关的页面边仍不进入工作图。
  await act(async () => node("boundary").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 })));
  expect(navigate).not.toHaveBeenCalled();
  expect(node("outside")).toBeNull();
  expect(host.textContent).toContain("3 节点");
  await act(async () =>
    node("member")
      .querySelector<HTMLElement>("[data-testid='ego-chip']")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  expect(node("member").querySelector('[data-testid="ego-card"]')?.textContent).toContain("任务 member");
  await tab("tasks");
  expect(host.querySelector(".react-flow")).toBeNull();
  await tab("graph");
  // 页签往返:画布保持挂载,展开的 member 卡与可见集原样保留。
  expect(node("member").querySelector('[data-testid="ego-card"]')?.textContent).toContain("任务 member");
  expect(node("outside")).toBeNull();
  await act(async () => root.unmount());
  host.remove();
});

// 关系图页把 onSetTaskPin 传给同一个画布;工作页不传时卡片/chip 上就静默少一个动作,
// 而这张卡看起来和关系图页的一模一样。
it("hands the canvas its pin toggle, so the workspace canvas offers the same actions", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host),
    setPin = vi.fn();
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClientForTopology()}>
        <WorkspaceView
          scope={scope}
          repoId="repo"
          projectName="Project"
          tasks={[task("root"), task("member", "root")]}
          decisions={[]}
          facts={[]}
          relations={[edge("task/root", "task/member")]}
          onOpenTask={() => {}}
          onPreviewTask={() => {}}
          rootTaskOpen={false}
          onOpenRootTask={() => {}}
          onCloseRootTask={() => {}}
          onNavigateEntity={() => {}}
          onSetTaskPin={setPin}
        />
      </QueryClientProvider>,
    ),
  );
  await act(async () => host.querySelector<HTMLButtonElement>("#workspace-tab-graph")!.click());
  const toggle = host.querySelector<HTMLButtonElement>('[data-testid="ego-pin-toggle-root"]');
  expect(toggle).not.toBeNull();
  expect(toggle!.querySelector("svg")).not.toBeNull();
  await act(async () => toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(setPin).toHaveBeenCalledWith(expect.objectContaining({ taskId: "root" }), true);
  await act(async () => root.unmount());
  host.remove();
});
