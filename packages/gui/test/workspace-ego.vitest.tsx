// harness-test-tier: integration
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, expect, it, vi } from "vitest";
import { WorkspaceView } from "../src/renderer/views/WorkspaceView.tsx";
import type { WorkspaceScopeRead } from "../src/api/renderer-dto.ts";
import type { TaskRow, DecisionRow, FactRef, RelationEdge } from "../src/renderer/model/types.ts";
import { decisionProjectionFields } from "./decision-projection-fields.ts";

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
const task = (taskId: string, parentTaskId?: string): TaskRow => ({
  taskId,
  title: `任务 ${taskId}`,
  parentTaskId,
  projectId: "proj",
  canonicalStatus: "planned",
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
});
const decision = (decisionId: string): DecisionRow =>
  ({
    decisionId,
    title: `决策 ${decisionId}`,
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
const scope: WorkspaceScopeRead = {
  schema: "daemon.workspace-scope/v1",
  ok: true,
  status: "ready",
  root: {
    taskId: "root",
    title: "工作组",
    status: "active",
    taskClass: "milestone",
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
  counts: { done: 0, executing: 0, pending: 0, blocked: 0, planned: 1, cancelled: 0 },
  scope: { descendantCount: 1, executableLeafCount: 1, archivedCount: 0 },
  page: { limit: 1, cursor: null, nextCursor: "member" },
  incompleteParentRefs: [],
  watermark: 1,
  sourceRevision: 1,
  warnings: [],
};

it("reuses the ego canvas with scoped full rows, navigates entities and preserves local refocus across tabs", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host),
    navigate = vi.fn();
  await act(async () =>
    root.render(
      <WorkspaceView
        scope={scope}
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
        onOpenGroup={() => {}}
        onNavigateEntity={navigate}
      />,
    ),
  );
  const tab = async (id: string) =>
    act(async () => host.querySelector<HTMLButtonElement>(`#workspace-tab-${id}`)!.click());
  const node = (id: string) => host.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
  await tab("relations");
  expect(host.querySelector('[data-testid="ego-card"]')).not.toBeNull();
  expect([...host.querySelectorAll(".react-flow__node")].map((n) => n.getAttribute("data-id")).sort()).toEqual(
    ["root", "member", "boundary", "decision/d1", "fact/F-BARE", "fact/F-PREFIX"].sort(),
  );
  expect(host.textContent).toContain("6 节点 / 5 关系");
  expect(node("member").textContent).toContain("任务 member");
  expect(node("decision/d1").textContent).toContain("决策 d1");
  for (const [id, ref] of [
    ["member", "task/member"],
    ["decision/d1", "decision/d1"],
    ["fact/F-BARE", "fact/F-BARE"],
  ]) {
    await act(async () => node(id).dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => node(id).querySelector<HTMLButtonElement>('button[aria-label="详情"]')!.click());
    expect(navigate).toHaveBeenLastCalledWith(ref);
  }
  navigate.mockClear();
  await act(async () => node("boundary").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(node("boundary").querySelector('[data-testid="ego-card"]')).not.toBeNull();
  expect(node("root").querySelector('[data-testid="ego-card"]')).toBeNull();
  expect(navigate).not.toHaveBeenCalled();
  expect(node("outside")).toBeNull();
  await act(async () => node("member").dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await tab("tasks");
  expect(host.querySelector(".react-flow")).toBeNull();
  await tab("relations");
  expect(node("boundary").querySelector('[data-testid="ego-card"]')).not.toBeNull();
  expect(node("member").querySelector('[data-testid="ego-card"]')).not.toBeNull();
  expect(node("outside")).toBeNull();
  await act(async () => root.unmount());
  host.remove();
});
