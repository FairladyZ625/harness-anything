// harness-test-tier: integration
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { entityDetailTargetOf } from "../src/renderer/navigation/entityRoutes.ts";
import { useEntityNavigation } from "../src/renderer/navigation/useEntityNavigation.ts";
import { workIndexOf } from "../src/renderer/model/work-collections.ts";
import { partitionTasks } from "../src/renderer/graph/territory.ts";
import { NO_WORK } from "../src/renderer/graph/territoryProgress.ts";
import { layoutTerritory, isTerritoryZoneNode } from "../src/renderer/graph/territoryLayout.ts";
import { TerritoryChipNode, TerritoryZoneNode } from "../src/renderer/graph/nodes/TerritoryNode.tsx";
import { GraphDrawer } from "../src/renderer/graph/GraphDrawer.tsx";
import { WorkspaceView } from "../src/renderer/views/WorkspaceView.tsx";
import type { WorkspaceScopeRead } from "../src/api/renderer-dto.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";
import {
  byTestId,
  cleanupMountedDetail,
  installBridge,
  mount as mountDetail,
  prepareDetailEnvironment,
  task as detailTask,
} from "./task-detail.fixtures.ts";

/**
 * 根任务即工作(dec_5F7E74F1,task_7897f56a):任何指向工作根的入口都落工作页,
 * 子任务落任务详情并显示所属工作。判定只有一处(entityDetailTargetOf + daemon 工作索引
 * `repo.works.index` 经 workIndexOf),这里按入口逐个证明它们都走到那一处。
 */

const row = (taskId: string, patch: Partial<TaskRow> = {}): TaskRow =>
  ({
    taskId,
    title: `T ${taskId}`,
    projectId: "p",
    coordinationStatus: "active",
    canonicalStatus: "active",
    taskClass: "standard",
    lastKnownAt: "2026-09-28T00:00:00.000Z",
    ...projectedTaskFields("active"),
    ...patch,
  }) as TaskRow;

// root(派生:顶层且有子任务)→ child → grandchild;root 下还挂一个声明工作 declared → declaredChild;
// solo 是没有子任务的顶层任务,不是工作。工作与归属是 daemon 工作索引给的(规则见 daemon work-read 测试),
// 行上的 workId 是 task-adapter 按同一索引盖上的。
const WORK_INDEX_READ = {
  schema: "daemon.work-index/v1" as const,
  ok: true as const,
  status: "ready" as const,
  works: [
    { taskId: "root", title: "T root", root: "derived" as const, parentTaskId: null, members: ["child", "grandchild"] },
    {
      taskId: "declared",
      title: "T declared",
      root: "declared" as const,
      parentTaskId: "root",
      members: ["declaredChild"],
    },
  ].map(({ members, ...work }) => ({
    ...work,
    status: "active" as const,
    taskCount: members.length,
    counts: { done: 0, executing: members.length, pending: 0, blocked: 0, planned: 0, cancelled: 0 },
    lastActivityAt: "2026-09-28T00:00:00.000Z",
    memberTaskIds: members,
  })),
  watermark: 1,
  sourceRevision: 1,
  warnings: [],
};
const works = workIndexOf(WORK_INDEX_READ);
const TASKS = [
  row("root", { workId: "root", workTitle: "T root" }),
  row("child", { parentTaskId: "root", workId: "root", workTitle: "T root" }),
  row("grandchild", { parentTaskId: "child", workId: "root", workTitle: "T root" }),
  row("declared", { parentTaskId: "root", taskClass: "work", workId: "declared", workTitle: "T declared" }),
  row("declaredChild", { parentTaskId: "declared", workId: "declared", workTitle: "T declared" }),
  row("solo"),
];

const mounted: Root[] = [];
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});
afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  await cleanupMountedDetail();
  document.body.replaceChildren();
});

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div"),
    root = createRoot(container);
  document.body.append(container);
  mounted.push(root);
  await act(async () => root.render(node));
  return container;
}

/** 挂真 hook,返回它的导航出口与两个位置写口的记录。 */
async function mountNavigation() {
  const navigate = vi.fn(),
    updateLocation = vi.fn();
  let api: ReturnType<typeof useEntityNavigation> | null = null;
  function Probe() {
    api = useEntityNavigation({
      navigate,
      updateLocation,
      activeRepoId: "p",
      enabledRepoIds: ["p"],
      openInRepo: () => undefined,
      onRepoUnavailable: () => undefined,
      isWorkRoot: works.isWorkRoot,
    });
    return null;
  }
  await render(createElement(Probe));
  return { navigate, updateLocation, api: () => api! };
}

const WORK_PAGE = {
  view: "workspace",
  scopeRootTaskId: "root",
  focusedEntityRef: null,
  selectedId: null,
  previewId: null,
};

describe("the GUI reads works from the daemon work index", () => {
  it("treats exactly the indexed roots as work roots", () => {
    expect(["root", "declared"].every(works.isWorkRoot)).toBe(true);
    expect(["child", "grandchild", "declaredChild", "solo", "missing"].some(works.isWorkRoot)).toBe(false);
    expect(workIndexOf(undefined).isWorkRoot("root")).toBe(false);
  });

  it("files each task under the work the index names; a root belongs to its own work", () => {
    expect(works.workOf("child")).toEqual({ taskId: "root", title: "T root" });
    expect(works.workOf("grandchild")?.taskId).toBe("root");
    expect(works.workOf("declaredChild")?.taskId).toBe("declared");
    expect(works.workOf("declared")?.taskId).toBe("declared");
    expect(works.workOf("root")?.taskId).toBe("root");
    expect(works.workOf("solo")).toBeNull();
  });
});

describe("the shared route judgement", () => {
  it("sends a work root to the work page, other tasks to task detail, and decisions to their page", () => {
    const route = (ref: string) => entityDetailTargetOf(ref, [], works.isWorkRoot);
    expect(route("task/root")).toEqual({ view: "workspace", scopeRootTaskId: "root", focusedEntityRef: null });
    expect(route("task/declared")).toEqual({
      view: "workspace",
      scopeRootTaskId: "declared",
      focusedEntityRef: null,
    });
    expect(route("task/child")).toEqual({ selectedId: "child", focusedEntityRef: "task/child" });
    expect(route("task/solo")).toEqual({ selectedId: "solo", focusedEntityRef: "task/solo" });
    expect(route("decision/dec_1")).toEqual({ view: "decisionDetail", focusedEntityRef: "decision/dec_1" });
  });
});

describe("every task exit goes through the shared judgement", () => {
  it("routes detail, preview, search/agenda refs and runtime refs of a root to the work page", async () => {
    const nav = await mountNavigation();
    act(() => nav.api().openTaskDetail("root"));
    act(() => nav.api().openTaskPreview("root"));
    act(() => nav.api().navigateToEntity("task/root"));
    act(() => nav.api().selectRuntimeEntity("task/root"));
    expect(nav.navigate.mock.calls).toEqual([[WORK_PAGE], [WORK_PAGE], [WORK_PAGE], [WORK_PAGE]]);
    expect(nav.updateLocation).not.toHaveBeenCalled();
  });

  it("keeps a child on task detail and its preview in the drawer", async () => {
    const nav = await mountNavigation();
    act(() => nav.api().openTaskDetail("child"));
    act(() => nav.api().openTaskPreview("child"));
    expect(nav.navigate).toHaveBeenCalledWith({ selectedId: "child", previewId: null, focusedEntityRef: "task/child" });
    expect(nav.updateLocation).toHaveBeenCalledWith({ selectedId: null, previewId: "child" });
  });

  it("opens the territory work zone title into the work page, keeping chip and fold clicks as they were", async () => {
    const nav = await mountNavigation(),
      onOpen = vi.fn(),
      onFold = vi.fn();
    const nodes = layoutTerritory({
      partition: { zones: partitionTasks(TASKS), landing: [], noWorkCount: 0 },
      expandedZones: new Set(),
      onOpen,
      onFold,
      onOpenWork: nav.api().navigateToEntity,
    }).nodes;
    const zone = nodes.filter(isTerritoryZoneNode).find((node) => node.data.zone.groupId === "root")!;
    const zoneEl = await render(createElement(TerritoryZoneNode, { ...zone, selected: false, dragging: false }));
    const title = zoneEl.querySelector<HTMLButtonElement>('[data-testid="territory-zone-title"]')!;
    expect(title.textContent).toBe("T root");
    act(() => title.click());
    expect(nav.navigate).toHaveBeenCalledWith(WORK_PAGE);
    act(() =>
      zoneEl.querySelector<HTMLButtonElement>('[data-testid="territory-zone-header"] button:last-child')!.click(),
    );
    expect(onFold).toHaveBeenCalledWith("task:root");

    const chip = nodes.find((node) => node.type === "territoryChip" && node.data.chip?.navRef === "task/child")!;
    const chipEl = await render(
      createElement(TerritoryChipNode, { ...(chip as never), selected: false, dragging: false, zIndex: 0 }),
    );
    act(() => chipEl.querySelector<HTMLElement>('[data-testid="territory-chip"]')!.click());
    expect(onOpen).toHaveBeenCalledWith("task/child");
  });

  it("gives a nested declared work its own territory zone that opens its own work page", async () => {
    const nav = await mountNavigation();
    const zones = partitionTasks(TASKS);
    expect(Object.fromEntries(zones.map((zone) => [zone.groupId, zone.chips.map((chip) => chip.navRef)]))).toEqual({
      root: ["task/child", "task/grandchild", "task/root"],
      declared: ["task/declared", "task/declaredChild"],
      [NO_WORK]: ["task/solo"],
    });
    const nodes = layoutTerritory({
      partition: { zones, landing: [], noWorkCount: 1 },
      expandedZones: new Set(),
      onOpen: () => undefined,
      onFold: () => undefined,
      onOpenWork: nav.api().navigateToEntity,
    }).nodes;
    const zone = nodes.filter(isTerritoryZoneNode).find((node) => node.data.zone.groupId === "declared")!;
    const zoneEl = await render(createElement(TerritoryZoneNode, { ...zone, selected: false, dragging: false }));
    const title = zoneEl.querySelector<HTMLButtonElement>('[data-testid="territory-zone-title"]')!;
    expect(title.textContent).toBe("T declared");
    act(() => title.click());
    expect(nav.navigate).toHaveBeenCalledWith({ ...WORK_PAGE, scopeRootTaskId: "declared" });
    // 独立任务块不是工作,标题不可点。
    const standalone = nodes.filter(isTerritoryZoneNode).find((node) => node.data.zone.groupId === NO_WORK)!;
    const standaloneEl = await render(
      createElement(TerritoryZoneNode, { ...standalone, selected: false, dragging: false }),
    );
    expect(standaloneEl.querySelector('[data-testid="territory-zone-title"]')?.tagName).not.toBe("BUTTON");
  });

  it("opens the root node from the graph drawer into the work page", async () => {
    const nav = await mountNavigation();
    const focusNode = { id: "root", entity: "task" as const, label: "T root", x: 0, y: 0 };
    const drawer = await render(
      createElement(GraphDrawer, {
        focusNode,
        nodes: new Map([["root", focusNode]]),
        edges: [],
        upCount: 0,
        downCount: 0,
        onClose: () => undefined,
        onFocus: () => undefined,
        onNavigateEntity: nav.api().navigateToEntity,
      }),
    );
    const open = [...drawer.querySelectorAll("button")].find((button) => button.textContent?.includes("打开"))!;
    act(() => open.click());
    expect(nav.navigate).toHaveBeenCalledWith(WORK_PAGE);
  });
});

describe("the work page absorbs the root task", () => {
  const scope: WorkspaceScopeRead = {
    schema: "daemon.workspace-scope/v1",
    ok: true,
    status: "ready",
    root: {
      taskId: "root",
      title: "T root",
      status: "active",
      taskClass: "standard",
      parentTaskId: null,
      updatedAt: "2026-09-28T00:00:00.000Z",
      pinned: false,
      hasChildren: true,
    },
    ancestors: [],
    goalMaterial: { taskId: "root", path: "task_plan.md" },
    counts: { done: 0, executing: 1, pending: 0, blocked: 0, planned: 0, cancelled: 0 },
    scope: { descendantCount: 1, executableLeafCount: 1, archivedCount: 0 },
    groups: [],
    memberTaskIds: ["child"],
    eventSummaries: [],
    eventWindowComplete: true,
    tasks: [
      {
        taskId: "child",
        title: "T child",
        status: "active",
        taskClass: "standard",
        parentTaskId: "root",
        updatedAt: "2026-09-28T00:00:00.000Z",
        pinned: false,
        hasChildren: false,
      },
    ],
    page: { limit: 100, cursor: null, nextCursor: null },
    incompleteParentRefs: [],
    watermark: 1,
    sourceRevision: 1,
    warnings: [],
  };

  it("offers the root task as its own tab and opens child tasks outside the page", async () => {
    const onOpenTask = vi.fn(),
      renderRootTask = vi.fn(() => createElement("p", { "data-testid": "root-detail-probe" }, "root detail"));
    const page = await render(
      createElement(WorkspaceView, {
        scope,
        projectName: "P",
        onOpenTask,
        renderRootTask,
      }),
    );
    const tab = (label: string) =>
      [...page.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === label)!;
    expect(tab("根任务")).toBeDefined();
    act(() => tab("根任务").click());
    expect(page.querySelector('[data-testid="workspace-root-task"]')?.textContent).toBe("root detail");
    expect(tab("根任务").getAttribute("aria-selected")).toBe("true");
    // 子任务仍走外部打开位(App 按共享判定落任务详情)。
    act(() => tab("任务 1").click());
    act(() =>
      [...page.querySelectorAll<HTMLButtonElement>("[data-task-row] button")]
        .find((b) => b.textContent?.includes("T child"))!
        .click(),
    );
    expect(onOpenTask).toHaveBeenCalledWith("child");
  });

  it("turns the subgroup tree into a filter on the tasks tab", async () => {
    const declaredRow = {
      ...scope.tasks[0]!,
      taskId: "declared",
      title: "T declared",
      taskClass: "work" as const,
      hasChildren: true,
    };
    const page = await render(
      createElement(WorkspaceView, {
        scope: {
          ...scope,
          groups: [declaredRow],
          memberTaskIds: ["child", "declaredChild"],
          tasks: [
            ...scope.tasks,
            {
              ...scope.tasks[0]!,
              taskId: "declaredChild",
              title: "T declaredChild",
              parentTaskId: "declared",
            },
          ],
        },
        projectName: "P",
        onOpenTask: () => undefined,
      }),
    );
    const groupRow = page.querySelector<HTMLButtonElement>('[data-group-filter="declared"] button')!;
    expect(groupRow).not.toBeNull();
    await act(async () => groupRow.click());
    expect(page.querySelector<HTMLButtonElement>("#workspace-tab-tasks")!.getAttribute("aria-selected")).toBe("true");
    expect(page.textContent).toContain("子组：T declared");
  });

  it("has no root section when the caller cannot render the root task", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceView, {
        scope,
        projectName: "P",
        onOpenTask: () => undefined,
      }),
    );
    expect(html).not.toContain("根任务");
  });
});

describe("a child task names its work", () => {
  it("shows 属于工作 X at the top of task detail and opens that work", async () => {
    prepareDetailEnvironment();
    installBridge();
    const onOpenWork = vi.fn();
    await mountDetail({ task: detailTask, work: { taskId: "root", title: "T root" }, onOpenWork });
    const link = byTestId("task-detail-work");
    expect(link.textContent).toBe("属于工作 T root");
    act(() => link.click());
    expect(onOpenWork).toHaveBeenCalledWith("root");
  });

  it("shows no work link for a top-level task", async () => {
    prepareDetailEnvironment();
    installBridge();
    await mountDetail({ task: detailTask, work: null, onOpenWork: () => undefined });
    expect(document.querySelector('[data-testid="task-detail-work"]')).toBeNull();
  });
});
