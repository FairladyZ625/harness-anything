// harness-test-tier: fast
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PanelWorkbenchView } from "../src/renderer/views/PanelWorkbenchView.tsx";
import type { WorkbenchPanelProps } from "../src/renderer/panel-workspace/workbench-panels.tsx";
import type { TaskRow } from "../src/renderer/model/types.ts";
import type { AgendaSuccess } from "../src/renderer/api-client.ts";
import { deriveRuntimeHealth } from "../src/renderer/model/runtime-health.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { type PanelWorkspaceStorage } from "../src/renderer/panel-workspace/panel-workspace-layout.ts";

/**
 * 剩余功能面板(task_d87e6982658ceccc5f26c80f30)的行为面:面板不是空壳——
 * 议程面板消费 App 常驻议程读面并保留筛选/抽屉交互;任务详情面板有本地任务选择,
 * 详情功能体真实渲染;看板面板的筛选是面板本地态,卡片点击开面板本地预览抽屉
 * (抽屉壳 portal 到 body,逃出浮窗裁切)。自带读面的面板(预设/系统/…)在
 * happy-dom 无传输层,按真实错误路径落面板内错误显示,不在本文件重复断言。
 */
const noop = () => undefined;
const mounted: { root: Root; container: HTMLElement }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement;
    },
  });
});

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

function mapStorage(): PanelWorkspaceStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

const taskActionsFixture = {
  feedback: new Map(),
  startTask: noop,
  appendProgress: noop,
  submitTask: noop,
  completeTask: noop,
  adjudicateTask: noop,
  consentReview: noop,
  setTaskPin: noop,
  attestGate: noop,
};
const decisionActionsFixture = {
  feedback: new Map(),
  propose: noop,
  judge: noop,
  checkReceipt: noop,
};

const taskRow = (taskId: string, title: string, coordinationStatus: TaskRow["coordinationStatus"]): TaskRow =>
  ({
    taskId,
    title,
    projectId: "repo-wb",
    coordinationStatus,
    rawStatus: `${coordinationStatus}/x`,
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "incomplete",
    engine: "kernel/task-lifecycle/v1",
    origin: "native",
    source: "local-document",
    iteration: 0,
    lastKnownAt: "2026-10-01T10:00:00.000Z",
    createdAt: "2026-09-01T10:00:00.000Z",
    pinned: taskId === "task-pinned",
    gates: [],
    executions: [],
    docs: [],
    visibility: { archived: false, noise: false },
    capabilities: [],
    board: { columnId: coordinationStatus === "active" ? "active" : "planned", rank: 0 },
    phase: { index: 0, reason: null, steps: ["planned", "active", "in_review", "done"] },
  }) as TaskRow;

const agendaFixture = {
  ok: true,
  status: "ready",
  pinnedEntities: [],
  pinnedEntityOverflow: 0,
  awaitingYou: [
    {
      relationId: "rel-await",
      relationRevision: 1,
      sourceRef: "task/task-active",
      title: "任务 A 等你答复",
      status: "active",
      personId: "person-z",
      askKind: "question",
      question: "这个切片的验收口径是什么?",
      askedAt: "2026-10-01T08:00:00.000Z",
      askedBy: "agent-x",
    },
  ],
  answeredForYou: [
    {
      relationId: "rel-answered",
      sourceRef: "task/task-done",
      title: "任务 B 已答复",
      status: "active",
      personId: "person-z",
      askKind: "acceptance",
      question: "可以验收吗?",
      answer: "按口径二验收。",
      answeredAt: "2026-09-30T08:00:00.000Z",
      answeredBy: "person-y",
    },
  ],
  attentionItems: [],
  regionWeights: {},
  inFlight: [],
  stalled: [],
  awaitingRework: [],
  awaitingAdjudication: [],
  underReview: [],
  decisionReviewInProgress: [],
  awaitingDecisionReview: [],
  awaitingDecision: [],
  waitingOnOthers: [],
  dispatchable: [],
  summary: {},
  page: { sourceLimit: 100, cursor: null, nextCursor: null },
  watermark: 1,
  sourceRevision: 1,
} as unknown as AgendaSuccess;

function baseProps(overrides: Partial<WorkbenchPanelProps> = {}): WorkbenchPanelProps {
  return {
    repoId: "repo-wb",
    tasks: [taskRow("task-active", "任务 A", "active"), taskRow("task-pinned", "置顶任务", "planned")],
    relations: [],
    decisions: [],
    facts: [],
    onNavigateEntity: noop,
    onOpenPalette: noop,
    agenda: undefined,
    agendaError: null,
    works: undefined,
    titles: new Map<string, string>(),
    workspaceSummary: null,
    workspaceSummaryError: null,
    health: deriveRuntimeHealth({
      daemon: null,
      repo: null,
      projection: null,
      lastSnapshotAt: null,
      now: "2026-10-03T00:00:00.000Z",
    }),
    onOpenTask: noop,
    onOpenSessions: noop,
    onUnpinTask: noop,
    projectName: "repo-wb",
    ready: true,
    catalog: undefined,
    catalogError: null,
    onRefreshLedger: noop,
    favorites: new Set<string>(),
    onToggleFavorite: noop,
    wipSnapshot: undefined,
    taskActions: taskActionsFixture,
    decisionActions: decisionActionsFixture,
    onNavigateDecision: noop,
    onOpenPool: noop,
    activeRepoId: "repo-wb",
    repos: [],
    daemonGeneration: null,
    repoRoot: null,
    onOpenObserve: noop,
    onOpenProject: noop,
    navigate: noop,
    onOpenDocument: noop,
    onOpenTerminal: noop,
    onOpenWork: noop,
    onOpenView: noop,
    ...overrides,
  };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountWorkbench(props: WorkbenchPanelProps, openPanels: string[]) {
  const storage = mapStorage();
  storage.setItem(
    "harness:gui:panel-workspace:local/repo-wb",
    JSON.stringify({ schema: "panel-workspace/v1", panels: openPanels, layout: {} }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(PanelWorkbenchView, { ...props, workspaceKey: "local/repo-wb", storage }),
      ),
    );
  });
  await settle();
  return container;
}

function changeSelect(testId: string, value: string): void {
  const select = document.body.querySelector<HTMLSelectElement>(`[data-testid="${testId}"]`);
  if (select === null) throw new Error(`missing ${testId}`);
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("remaining workbench panels (task_d87e6982658ceccc5f26c80f30)", () => {
  it("agenda panel renders the resident agenda rows and keeps filter interaction local", async () => {
    const container = await mountWorkbench(baseProps({ agenda: agendaFixture }), ["agenda"]);
    const panel = container.querySelector('[data-testid="workbench-agenda-panel"]');
    expect(panel).not.toBeNull();
    // 默认「需要关注」:只显示待答复行;两行都来自 App 传入的同一条议程读面。
    expect(container.querySelector('[data-testid="agenda-row-rel-await"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="agenda-row-rel-answered"]')).toBeNull();
    // 筛选是面板本地态:切到「全部」两行都在(芯片文案自带计数,按前缀找)。
    const allChip = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="agenda-filter-chips"] button'),
    ].find((button) => button.textContent?.startsWith("全部") === true);
    expect(allChip).not.toBeNull();
    act(() => {
      allChip!.click();
    });
    await settle();
    expect(container.querySelector('[data-testid="agenda-row-rel-await"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="agenda-row-rel-answered"]')).not.toBeNull();
  });

  it("agenda panel opens the row detail drawer outside the floating panel (portal)", async () => {
    const container = await mountWorkbench(baseProps({ agenda: agendaFixture }), ["agenda"]);
    // DenseRow 的可点面是内部 button(外包层只承载 testid)。
    const rowButton = container.querySelector<HTMLButtonElement>('[data-testid="agenda-row-rel-await"] button');
    expect(rowButton).not.toBeNull();
    act(() => {
      rowButton!.click();
    });
    await settle();
    // Drawer 壳 portal 到 body:不在浮窗容器内,逃出 overflow 裁切。
    const drawer = document.body.querySelector('aside[role="dialog"]');
    expect(drawer).not.toBeNull();
    expect(drawer!.textContent).toContain("任务 A 等你答复");
    expect(container.contains(drawer)).toBe(false);
  });

  it("task detail panel selects a task locally and renders the real detail body", async () => {
    const container = await mountWorkbench(baseProps(), ["taskDetail"]);
    // 默认选择:置顶优先(与文档面板同一判据)。
    expect(container.querySelector('[data-testid="task-detail-view"]')).not.toBeNull();
    expect(container.textContent).toContain("置顶任务");
    // 本地切换任务:详情体跟着换,不写全局路由。
    changeSelect("workbench-task-detail-task", "task-active");
    await settle();
    expect(container.textContent).toContain("任务 A");
    // 清空选择回到引导空态,详情体卸载。
    changeSelect("workbench-task-detail-task", "");
    await settle();
    expect(container.querySelector('[data-testid="task-detail-view"]')).toBeNull();
    expect(container.querySelector('[data-testid="panel-pick-hint"]')).not.toBeNull();
  });

  it("board panel keeps filters local and opens the panel-local preview drawer on card click", async () => {
    const container = await mountWorkbench(baseProps(), ["board"]);
    expect(container.querySelector('[data-testid="workbench-board-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="board-filter-bar"]')).not.toBeNull();
    const card = container.querySelector<HTMLElement>('[data-testid="board-task-card"]');
    expect(card).not.toBeNull();
    act(() => {
      card!.click();
    });
    await settle();
    // 面板本地预览抽屉(与页面同一 TaskPreviewDrawer,壳已 portal)。
    const drawer = document.body.querySelector('aside[role="dialog"]');
    expect(drawer).not.toBeNull();
    expect(container.contains(drawer)).toBe(false);
  });
});
