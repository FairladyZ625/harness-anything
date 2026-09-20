// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DecisionRow, TaskRow } from "../src/renderer/model/types.ts";
import { decisionProjectionFields } from "./decision-projection-fields.ts";
import { DecisionStream } from "../src/renderer/components/overview/DecisionStream.tsx";
import { TaskStream } from "../src/renderer/components/overview/TaskStream.tsx";
import { BoardView } from "../src/renderer/views/BoardView.tsx";
import { OverviewView } from "../src/renderer/views/OverviewView.tsx";
import { PinnedStream, pinnedAgendaItems } from "../src/renderer/components/overview/PinnedStream.tsx";
import { DecisionPreviewDrawer } from "../src/renderer/components/DecisionPreviewDrawer.tsx";
import { streamTime } from "../src/renderer/components/overview/streamParts.tsx";
import { formatTime } from "../src/renderer/model/time.ts";
import type { WorkspaceSummaryRead } from "../src/api/renderer-dto.ts";
import { DEFAULT_TASK_FILTERS } from "../src/renderer/model/taskFilters.ts";
import { summarizeWorkspace } from "@harness-anything/kernel";
import { deriveRuntimeHealth } from "../src/renderer/model/runtime-health.ts";
import type { AgendaSuccess } from "../src/renderer/api-client.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";
import type { TaskWipRead } from "../src/api/renderer-dto.ts";
import { TaskRootBadge, TaskWipSummary } from "../src/renderer/components/TaskWipSummary.tsx";

function task(patch: Partial<TaskRow>): TaskRow {
  return {
    taskId: "task_a",
    title: "Task A",
    projectId: "proj",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    module: "kernel",
    createdAt: null,
    lastKnownAt: "2026-08-01T00:00:00.000Z",
    gates: [],
    docs: [],
    ...projectedTaskFields(patch.coordinationStatus ?? "active", {
      archived: (patch.packageDisposition ?? "active") !== "active",
    }),
    ...patch,
  };
}

function decision(patch: Partial<DecisionRow>): DecisionRow {
  return {
    decisionId: "dec_x",
    title: "D",
    state: "proposed",
    question: "Q",
    chosen: [],
    rejected: [],
    claims: [],
    judgmentConsents: [],
    body: null,
    ...decisionProjectionFields(patch.state ?? "proposed"),
    ...patch,
  };
}

const noop = () => {};
const wipSnapshot: TaskWipRead = {
  limit: 30,
  limitLabel: "settings.tasks.wipLimit",
  counted: Array.from({ length: 24 }, (_, index) => ({
    taskId: `task_leaf_${index}`,
    status: "active" as const,
    title: `Leaf ${index}`,
  })),
  roots: Array.from({ length: 10 }, (_, index) => ({
    taskId: `task_root_${index}`,
    reason: index < 8 ? ("declared" as const) : ("derived" as const),
    directChildCount: index < 8 ? 0 : 4,
    threshold: 3,
  })),
  threshold: 3,
};
const NOW = "2026-08-31T12:00:00.000Z";
const blocking = { state: "clear" as const, blockers: [], warnings: [] };
const agenda = (patch: Partial<AgendaSuccess> = {}): AgendaSuccess => ({
  ok: true,
  status: "ready",
  inFlight: [],
  pinnedEntities: [],
  pinnedEntityOverflow: 0,
  awaitingRework: [],
  awaitingAdjudication: [],
  underReview: [],
  awaitingDecision: [],
  waitingOnOthers: [],
  dispatchable: [],
  summary: "",
  page: { sourceLimit: 100, cursor: null, nextCursor: null },
  watermark: 12,
  sourceRevision: 12,
  ...patch,
});

describe("task WIP presentation", () => {
  it("renders daemon occupancy, root count, and limit source", () => {
    const markup = renderToStaticMarkup(createElement(TaskWipSummary, { snapshot: wipSnapshot }));
    expect(markup).toContain("WIP 24/30");
    expect(markup).toContain("root 10");
    expect(markup).toContain("上限来源: settings.tasks.wipLimit");
    expect(markup).toContain("task_root_8 (4 children)");
  });

  it("marks a derived root row with its direct child count", () => {
    const row = task({
      taskId: "task_root_8",
      rootAssessment: { reason: "derived", directChildCount: 4, threshold: 3 },
    });
    const markup = renderToStaticMarkup(createElement(TaskRootBadge, { task: row }));
    expect(markup).toContain('data-testid="task-root-badge-task_root_8"');
    expect(markup).toContain("derived 4 children");
  });
});
// Read one status tab's rendered text exactly. A loose `testid … label … count` regex
// matches any later digit in the document, so it stays green when the count is wrong.
const tabText = (markup: string, testId: string): string | null => {
  const found = markup.match(new RegExp(`data-testid="${testId}"[^>]*>([\\s\\S]*?)</button>`, "u"));
  return found === null
    ? null
    : found[1]!
        .replace(/<!--[\s\S]*?-->/gu, "")
        .replace(/\s+/gu, " ")
        .trim();
};
const taskSummary = (patch: Partial<WorkspaceSummaryRead["tasks"]["byStatus"]> = {}): WorkspaceSummaryRead["tasks"] => {
  const byStatus = { planned: 0, active: 0, blocked: 0, in_review: 0, done: 0, cancelled: 0, unknown: 0, ...patch };
  return { total: Object.values(byStatus).reduce((sum, count) => sum + count, 0), byStatus };
};
// 只保留 button/span 的区块可以用非贪婪到第一个 </div> 截断:流里的行本身不含 div
// (批量按钮也是 button),所以这一段正好是「该容器实际渲染的行」。
const section = (markup: string, testId: string): string | null => {
  const found = markup.match(new RegExp(`data-testid="${testId}"[^>]*>([\\s\\S]*?)</div>`, "u"));
  return found === null ? null : found[1]!;
};
const decisionSummary = (
  patch: Partial<WorkspaceSummaryRead["decisions"]["byState"]> = {},
): WorkspaceSummaryRead["decisions"] => {
  const byState = { proposed: 0, in_effect: 0, rejected: 0, deferred: 0, superseded: 0, outcome_retired: 0, ...patch };
  const ids = (state: string, count: number) => Array.from({ length: count }, (_, index) => `${state}_${index}`);
  const retiredIds = [...ids("superseded", byState.superseded), ...ids("outcome_retired", byState.outcome_retired)];
  return {
    total: Object.values(byState).reduce((sum, count) => sum + count, 0),
    inboxCount: byState.proposed,
    byState,
    groups: [
      { id: "proposed", states: ["proposed"], count: byState.proposed, decisionIds: ids("proposed", byState.proposed) },
      {
        id: "in_effect",
        states: ["in_effect"],
        count: byState.in_effect,
        decisionIds: ids("in_effect", byState.in_effect),
      },
      { id: "rejected", states: ["rejected"], count: byState.rejected, decisionIds: ids("rejected", byState.rejected) },
      { id: "deferred", states: ["deferred"], count: byState.deferred, decisionIds: ids("deferred", byState.deferred) },
      { id: "retired", states: ["superseded", "outcome_retired"], count: retiredIds.length, decisionIds: retiredIds },
    ],
  };
};

describe("overview decision stream", () => {
  it("renders only proposed decisions by default with state tabs carrying per-state counts", () => {
    const markup = renderToStaticMarkup(
      createElement(DecisionStream, {
        decisions: [
          decision({
            decisionId: "dec_prop",
            title: "Proposed one",
            state: "proposed",
            riskTier: "high",
            urgency: "high",
            proposedAt: "2026-08-21T01:00:00.000Z",
          }),
          decision({ decisionId: "dec_effect", title: "Effect one", state: "in_effect" }),
        ],
        summary: decisionSummary({ proposed: 7, in_effect: 9 }),
        stateLabel: (state) => state,
        onOpenPreview: noop,
        onOpenInbox: noop,
      }),
    );
    expect(markup).toContain("Proposed one");
    expect(markup).not.toContain("Effect one");
    expect(markup).toContain('data-testid="overview-decision-state-proposed"');
    expect(markup).toMatch(/proposed\s*7/);
    expect(markup).toMatch(/in_effect\s*9/);
    // 行式紧凑:每行一个 button,不再是大卡片。
    expect(markup).toContain('data-testid="decision-stream-rows"');
  });

  it("shows the empty state instead of a blank grid when the selected state has no rows", () => {
    const markup = renderToStaticMarkup(
      createElement(DecisionStream, {
        decisions: [decision({ decisionId: "dec_effect", state: "in_effect" })],
        summary: decisionSummary({ in_effect: 1 }),
        stateLabel: (state) => state,
        onOpenPreview: noop,
        onOpenInbox: noop,
      }),
    );
    expect(markup).toContain("该状态下暂无决策");
  });
});

// 主行集 = 选中状态的全部决策,规模随台账被动累积(本仓实测最大一档 in_effect 608 行)。
// 完整渲染:全量行进 DOM,离屏行靠 content-visibility 跳过布局与绘制(2026-08-25 泽宇裁决,
// 性能顾虑用按需渲染解决,不转嫁给用户点击);页签计数仍报真实总数(daemon census)。
describe("overview decision stream: main row set renders in full", () => {
  it("renders every decision row with no reveal button", () => {
    const rows = Array.from({ length: 45 }, (_, index) =>
      decision({
        decisionId: `dec_main_${index}`,
        title: `Decision ${index}`,
        state: "proposed",
        riskTier: "medium",
        urgency: "medium",
        proposedAt: `2026-08-22T09:${String(index).padStart(2, "0")}:00.000Z`,
      }),
    );
    const markup = renderToStaticMarkup(
      createElement(DecisionStream, {
        decisions: rows,
        summary: decisionSummary({ proposed: 45 }),
        stateLabel: (state) => state,
        onOpenPreview: noop,
        onOpenInbox: noop,
      }),
    );
    const body = section(markup, "decision-stream-rows");
    expect(body).not.toBeNull();
    expect(body!.match(/title="dec_main_/gu)).toHaveLength(45);
    expect(body).not.toContain('data-testid="decision-stream-more"');
    expect(body).not.toContain("再显示");
    // 页签计数报的是真实总数,与渲染行数一致。
    expect(tabText(markup, "overview-decision-state-proposed")).toBe("proposed 45");
  });

  // 小结果集同样完整渲染。
  it("renders a small decision row set in full", () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      decision({
        decisionId: `dec_main_${index}`,
        title: `Decision ${index}`,
        state: "proposed",
        proposedAt: `2026-08-22T09:0${index}:00.000Z`,
      }),
    );
    const markup = renderToStaticMarkup(
      createElement(DecisionStream, {
        decisions: rows,
        summary: decisionSummary({ proposed: 5 }),
        stateLabel: (state) => state,
        onOpenPreview: noop,
        onOpenInbox: noop,
      }),
    );
    expect(section(markup, "decision-stream-rows")!.match(/title="dec_main_/gu)).toHaveLength(5);
    expect(markup).not.toContain('data-testid="decision-stream-more"');
  });
});

describe("overview task stream", () => {
  // The overview renders the daemon aggregate and the board counts the rows it draws
  // into column buckets (task_8928cf1e): lifecycle columns follow the census's
  // active-package scope, archived rows flow into the first-class archived column,
  // and the overview's archived tab counts them from the row set (the census has no
  // archived cell). Cancelled rows stay cold-collapsed by default (W8 noise), so the
  // same fixture has to reach all three surfaces and agree.
  it("buckets board rows by column while the census counts active-package lifecycle rows", () => {
    const rows = [
      task({ taskId: "task_a1", title: "Active one", coordinationStatus: "active" }),
      task({ taskId: "task_a2", title: "Active two", coordinationStatus: "active" }),
      task({ taskId: "task_b1", title: "Blocked one", coordinationStatus: "blocked" }),
      task({ taskId: "task_c1", title: "Cancelled one", coordinationStatus: "cancelled" }),
      task({
        taskId: "task_d1",
        title: "Archived active",
        coordinationStatus: "active",
        packageDisposition: "archived",
      }),
    ];
    const summary = summarizeWorkspace(
      rows.map(({ coordinationStatus, packageDisposition }) => ({ coordinationStatus, packageDisposition })),
      [],
    ).tasks;
    const overview = renderToStaticMarkup(
      createElement(TaskStream, { tasks: rows, summary, onOpenPreview: noop, onGoBoard: noop }),
    );
    const board = renderToStaticMarkup(
      createElement(BoardView, {
        tasks: rows,
        allTasks: rows,
        filters: DEFAULT_TASK_FILTERS,
        onFiltersChange: noop,
        onSelect: noop,
        favorites: new Set<string>(),
        onToggleFavorite: noop,
      }),
    );

    for (const status of ["active", "blocked"] as const) {
      const drawn = rows.filter((row) => !row.visibility.archived && row.coordinationStatus === status).length;
      expect(summary.byStatus[status]).toBe(drawn);
      expect(board).toContain(`data-testid="board-status-${status}-count">${drawn}</span>`);
    }
    // census 按设计不含 cancelled(0);看板 cancelled 列桶画出该行,但 W8 冷折叠
    // 默认只显形计数(cancelled 是 noise,永不是 seed)。
    expect(summary.byStatus.cancelled).toBe(0);
    expect(board).toContain('data-testid="board-status-cancelled-count">0</span>');
    // 归档行进一等 archived 列(非终态归档行默认可见)。
    expect(board).toContain('data-testid="board-status-archived-count">1</span>');
    expect(summary.total).toBe(3);
    expect(tabText(overview, "overview-status-active")).toBe("活跃 2");
    expect(tabText(overview, "overview-status-blocked")).toBe("已阻塞 1");
    // archived 页签的计数从行集本地数出:daemon census 没有这一格。
    expect(tabText(overview, "overview-status-archived")).toBe("已归档 1");
  });

  // 「无 reveal 按钮 + 窗口有界」的看板/泳道断言在 test/taskFilters.vitest.ts 的
  // windowing(W10)用例里:列内/泳道行 windowing 后卡片只在挂载后的视口窗口出现,
  // SSR markup 里没有卡片,断言必须走真实 DOM(happy-dom);本文件其余测试保持
  // node 环境 SSR。

  // The test above renders TaskStream directly, so it proves the leaf agrees with the
  // census but says nothing about the page that feeds it. Render the overview page so
  // breaking the census on its way to the leaf has somewhere to go red.
  it("carries the daemon census through the overview page into the task stream", () => {
    const rows = [
      task({ taskId: "task_a1", title: "Active one", coordinationStatus: "active" }),
      task({ taskId: "task_a2", title: "Active two", coordinationStatus: "active" }),
      task({ taskId: "task_b1", title: "Blocked one", coordinationStatus: "blocked" }),
    ];
    const page = renderToStaticMarkup(
      createElement(OverviewView, {
        repoId: "proj",
        project: {
          id: "proj",
          name: "Harness",
          path: "/repo",
          preset: "software/coding",
          engines: [],
          watermarkAt: "2026-08-01T00:00:00.000Z",
        },
        tasks: rows,
        agenda: agenda(),
        decisions: [],
        workspaceSummary: {
          schema: "daemon.workspace-summary/v1",
          ok: true,
          status: "ready",
          warnings: [],
          watermark: 1,
          sourceRevision: 1,
          tasks: taskSummary({ active: 2, blocked: 1 }),
          decisions: decisionSummary({ proposed: 1 }),
        },
        relations: [],
        health: deriveRuntimeHealth({ daemon: null, repo: null, projection: null, lastSnapshotAt: null, now: NOW }),
        daemonReadFailed: false,
        onSelect: noop,
        onDrill: noop,
        onOpenInbox: noop,
        onOpenDecision: noop,
        onSetPin: noop,
      }),
    );

    expect(tabText(page, "overview-status-active")).toBe("活跃 2");
    expect(tabText(page, "overview-status-blocked")).toBe("已阻塞 1");
    expect(page).toContain("xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]");
    expect(page).toContain("xl:row-span-2");
    expect(page).toContain("overflow-y-auto");
    expect(page).toContain("overview-pin-toggle-task_a1");
    // 2026-08-31 收纳:运行时健康不再占总览主区一行,腾出的高度归决策流/任务流
    // (第三行模板删除,只剩两行)。
    expect(page).toContain("xl:grid-rows-[minmax(0,1fr)_minmax(0,1fr)]");
    expect(page).not.toContain("runtime-health-card");
  });

  it("filters to the selected status in place with census counts on every tab (sidebar parity)", () => {
    const tasks = [
      task({ taskId: "task_a1", title: "Active one", coordinationStatus: "active" }),
      task({ taskId: "task_b1", title: "Blocked one", coordinationStatus: "blocked" }),
      task({ taskId: "task_b2", title: "Blocked two", coordinationStatus: "blocked" }),
    ];
    const markup = renderToStaticMarkup(
      createElement(TaskStream, {
        tasks,
        summary: taskSummary({ active: 4, blocked: 7 }),
        onOpenPreview: noop,
        onGoBoard: noop,
      }),
    );
    expect(markup).toContain("Active one");
    expect(markup).not.toContain("Blocked one");
    for (const status of ["planned", "active", "blocked", "in_review", "done", "cancelled"]) {
      expect(markup).toContain(`data-testid="overview-status-${status}"`);
    }
    expect(markup).toMatch(/已阻塞\s*7/);
  });

  it("renders newest tasks first inside the internally scrolling body", () => {
    const markup = renderToStaticMarkup(
      createElement(TaskStream, {
        tasks: [
          task({
            taskId: "task_z_hash",
            title: "Older task",
            coordinationStatus: "active",
            createdAt: "2026-08-16T10:00:00.000Z",
          }),
          task({
            taskId: "task_a_hash",
            title: "Newer task",
            coordinationStatus: "active",
            createdAt: "2026-08-18T09:30:00.000Z",
          }),
        ],
        summary: taskSummary({ active: 2 }),
        onOpenPreview: noop,
        onGoBoard: noop,
      }),
    );
    expect(markup.indexOf("Newer task")).toBeLessThan(markup.indexOf("Older task"));
    expect(markup).toContain('data-testid="task-stream-rows"');
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("min-h-0 flex-1");
    expect(markup).toContain("xl:max-h-none");
  });

  it("converts UTC stream timestamps with an explicit display timezone", () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = "Asia/Taipei";
      expect(streamTime("2026-08-21T16:04:35.025Z")).toBe("08-22 00:04");
      expect(formatTime("2026-08-21T16:04:35.025Z", { tz: "Asia/Taipei", style: "date-time" })).toBe(
        "2026-08-22 00:04",
      );
      expect(formatTime("2026-08-21T16:04:35.025Z", { tz: "Asia/Taipei", style: "date-time-seconds" })).toBe(
        "2026-08-22 00:04:35",
      );
      expect(formatTime("2026-08-21T16:04:35.025Z", { tz: "Asia/Taipei", style: "time-seconds" })).toBe("00:04:35");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("shows the per-status empty state", () => {
    const markup = renderToStaticMarkup(
      createElement(TaskStream, {
        tasks: [task({ taskId: "task_p", coordinationStatus: "planned" })],
        summary: taskSummary({ planned: 1 }),
        onOpenPreview: noop,
        onGoBoard: noop,
      }),
    );
    expect(markup).toContain("该状态下暂无任务");
  });
});

describe("overview task stream: archived tab alignment (task_8928cf1e)", () => {
  it("keeps lifecycle tabs active-package only while the archived tab counts every archived row", () => {
    const mixed = [
      task({
        taskId: "task_active_live",
        title: "Live active task",
        coordinationStatus: "active",
        packageDisposition: "active",
        createdAt: "2026-08-20T10:00:00.000Z",
      }),
      task({
        taskId: "task_active_archived",
        title: "Archived active task",
        coordinationStatus: "active",
        packageDisposition: "archived",
        createdAt: "2026-08-21T10:00:00.000Z",
      }),
      task({
        taskId: "task_planned_archived",
        title: "Archived planned task",
        coordinationStatus: "planned",
        packageDisposition: "archived",
        createdAt: "2026-08-22T10:00:00.000Z",
      }),
    ];

    const markup = renderToStaticMarkup(
      createElement(TaskStream, {
        tasks: mixed,
        summary: taskSummary({ active: 1 }),
        onOpenPreview: noop,
        onGoBoard: noop,
      }),
    );
    // 生命周期页签仍是活跃包口径(census 同源)。
    expect(markup).toContain("Live active task");
    expect(markup).not.toContain("Archived active task");
    expect(markup).not.toContain("Archived planned task");
    // archived 页签的计数不再丢弃归档行,从行集本地数出(census 无此格)。
    expect(tabText(markup, "overview-status-archived")).toBe("已归档 2");
  });

  it("carries selected status tasks through the overview page", () => {
    const page = renderToStaticMarkup(
      createElement(OverviewView, {
        repoId: "proj",
        project: {
          id: "proj",
          name: "Harness",
          path: "/repo",
          preset: "software/coding",
          engines: [],
          watermarkAt: "2026-08-22T00:00:00.000Z",
        },
        tasks: [
          task({
            taskId: "task_active_1",
            title: "Active task in overview",
            coordinationStatus: "active",
            createdAt: "2026-08-20T10:00:00.000Z",
          }),
        ],
        decisions: [],
        workspaceSummary: {
          schema: "daemon.workspace-summary/v1",
          ok: true,
          status: "ready",
          warnings: [],
          watermark: 1,
          sourceRevision: 1,
          tasks: taskSummary({ active: 1 }),
          decisions: decisionSummary({ proposed: 0 }),
        },
        relations: [],
        health: deriveRuntimeHealth({ daemon: null, repo: null, projection: null, lastSnapshotAt: null, now: NOW }),
        daemonReadFailed: false,
        onSelect: noop,
        onDrill: noop,
        onOpenInbox: noop,
        onOpenDecision: noop,
        onNavigateEntity: noop,
      }),
    );
    expect(page).toContain("Active task in overview");
    expect(page).toMatch(/aria-selected="true" data-testid="overview-status-active"/u);
  });
});

// 主行集 = 选中状态的全部任务,规模随台账被动累积(本仓 1656 任务时选 done 实测 1165 行)。
// 完整渲染:全量行进 DOM,离屏行靠 content-visibility 跳过布局与绘制(2026-08-25 泽宇裁决,
// 性能顾虑用按需渲染解决,不转嫁给用户点击);页签计数仍报真实总数(daemon census,逐字照抄)。
describe("overview task stream: main row set renders in full", () => {
  it("renders every main row with no reveal button", () => {
    const rows = Array.from({ length: 45 }, (_, index) =>
      task({
        taskId: `task_main_${index}`,
        title: `Main ${index}`,
        coordinationStatus: "active",
        createdAt: `2026-08-22T09:${String(index).padStart(2, "0")}:00.000Z`,
      }),
    );
    const markup = renderToStaticMarkup(
      createElement(TaskStream, {
        tasks: rows,
        summary: taskSummary({ active: 45 }),
        onOpenPreview: noop,
        onGoBoard: noop,
      }),
    );
    expect(markup.match(/title="task_main_/gu)).toHaveLength(45);
    expect(markup).not.toContain('data-testid="task-stream-more"');
    expect(markup).not.toContain("再显示");
    // 页签计数报的是真实总数,与渲染行数一致。
    expect(tabText(markup, "overview-status-active")).toBe("活跃 45");
  });

  it("renders a small main row set in full", () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      task({
        taskId: `task_main_${index}`,
        title: `Main ${index}`,
        coordinationStatus: "active",
        createdAt: `2026-08-22T09:0${index}:00.000Z`,
      }),
    );
    const markup = renderToStaticMarkup(
      createElement(TaskStream, {
        tasks: rows,
        summary: taskSummary({ active: 5 }),
        onOpenPreview: noop,
        onGoBoard: noop,
      }),
    );
    expect(markup.match(/title="task_main_/gu)).toHaveLength(5);
    expect(markup).not.toContain('data-testid="task-stream-more"');
  });

  // 全部任务同状态时「更新的」带为空,主行集独自承载全部行——两段不互相兜底。
  it("renders the whole ledger when the default active tab holds it", () => {
    const rows = Array.from({ length: 60 }, (_, index) =>
      task({
        taskId: `task_act_${index}`,
        title: `Active ${index}`,
        coordinationStatus: "active",
        createdAt: `2026-08-22T09:${String(index).padStart(2, "0")}:00.000Z`,
      }),
    );
    const markup = renderToStaticMarkup(
      createElement(TaskStream, {
        tasks: rows,
        summary: taskSummary({ active: 60 }),
        onOpenPreview: noop,
        onGoBoard: noop,
      }),
    );
    expect(markup.match(/title="task_act_/gu)).toHaveLength(60);
    expect(markup).not.toContain("再显示");
  });
});

describe("overview pinned stream", () => {
  it("uses pinned rows from the agenda projection, deduplicating task groups and submitted executions", () => {
    const active = {
      taskId: "task_pin_active",
      title: "Pinned active",
      status: "active" as const,
      pinned: true,
      updatedAt: "2026-08-30T01:00:00.000Z",
      leaseExecutionId: "execution-active",
      activeExecutionIds: ["execution-active"],
      blockingAssessment: blocking,
    };
    const projection = agenda({
      inFlight: [active],
      // 同一 active task 也可能因 blocking 出现在 waitingOnOthers;只显示一次。
      waitingOnOthers: [active],
      dispatchable: [
        {
          taskId: "task_plain",
          title: "Plain planned",
          status: "planned",
          pinned: false,
          updatedAt: "2026-08-30T02:00:00.000Z",
          leaseExecutionId: null,
          activeExecutionIds: [],
          blockingAssessment: blocking,
        },
      ],
      pinnedEntities: [
        {
          ref: "decision/dec_PINNED",
          kind: "decision",
          title: "Pinned decision",
          status: "proposed",
          pinnedAt: "2026-08-30T04:00:00.000Z",
        },
      ],
      pinnedEntityOverflow: 0,
      awaitingAdjudication: [
        {
          taskId: "task_pin_review",
          title: "Pinned review",
          pinned: true,
          executionId: "execution-review",
          submittedAt: "2026-08-30T03:00:00.000Z",
          blockingAssessment: blocking,
        },
      ],
    });

    expect(pinnedAgendaItems(projection).map(({ ref }) => ref)).toEqual([
      "decision/dec_PINNED",
      "task/task_pin_review",
      "task/task_pin_active",
    ]);
    const markup = renderToStaticMarkup(
      createElement(PinnedStream, {
        agenda: projection,
        onOpenPreview: noop,
        onNavigateEntity: noop,
        onSetPin: noop,
      }),
    );
    expect(markup).toContain("Pinned active");
    expect(markup).toContain("Pinned review");
    expect(markup).toContain("Pinned decision");
    expect(markup).not.toContain("Plain planned");
    expect(markup).toContain("repo.agenda.read");
    expect(markup.match(/title="task\/task_pin_active/gu)).toHaveLength(1);
    expect(markup).toContain("overview-pin-toggle-task_pin_active");
    // kind 徽标与各自的状态词:decision 行显示「决策」徽标与 proposed 的决策文案,
    // 不套任务生命周期词表。
    expect(markup).toContain('data-testid="pinned-kind-decision"');
    expect(markup).toContain("决策");
    expect(markup).toContain("待决策批准");
  });

  it("explains how to pin when nothing is pinned", () => {
    const markup = renderToStaticMarkup(createElement(PinnedStream, { agenda: agenda(), onOpenPreview: noop }));
    expect(markup).toContain("当前没有置顶项");
    expect(markup).toContain("ha pin");
  });

  it("shows projection loading instead of the task-list-derived false empty state", () => {
    const markup = renderToStaticMarkup(createElement(PinnedStream, { agenda: undefined, onOpenPreview: noop }));
    expect(markup).toContain("ha agenda");
    expect(markup).not.toContain("当前没有置顶项");
  });

  it("surfaces the daemon collapsed pin count instead of dropping it", () => {
    const markup = renderToStaticMarkup(
      createElement(PinnedStream, {
        agenda: agenda({
          pinnedEntities: [
            {
              ref: "decision/dec_folded",
              kind: "decision",
              title: "Folded window",
              status: "in_effect",
              pinnedAt: "2026-08-30T04:00:00.000Z",
            },
          ],
          pinnedEntityOverflow: 3,
        }),
        onOpenPreview: noop,
        onNavigateEntity: noop,
      }),
    );
    expect(markup).toContain('data-testid="pinned-entity-overflow"');
    expect(markup).toContain("3");
  });
});

describe("decision preview drawer (click opens a drawer, not a page jump)", () => {
  const sample = decision({
    decisionId: "dec_sample",
    title: "Sample decision",
    question: "Which projection feeds the overview?",
    riskTier: "high",
    urgency: "medium",
    chosen: [{ id: "c1", text: "Keep the triadic projection", rationale: "single source" }],
    rejected: [{ id: "r1", text: "Ad-hoc GUI aggregate", whyNot: "numbers would fight" }],
    claims: [{ id: "k1", text: "census stays single-sourced", loadBearing: true, fulfillment: null }],
    proposedBy: { kind: "agent", id: "z" },
  });

  it("renders nothing without a decision", () => {
    expect(
      renderToStaticMarkup(
        createElement(DecisionPreviewDrawer, {
          decision: null,
          tasks: [],
          relations: [],
          onClose: noop,
          onOpenDetail: noop,
        }),
      ),
    ).toBe("");
  });

  it("carries the judgment-minimum fields plus an explicit open-details exit", () => {
    const markup = renderToStaticMarkup(
      createElement(DecisionPreviewDrawer, {
        decision: sample,
        tasks: [],
        relations: [],
        onClose: noop,
        onOpenDetail: noop,
      }),
    );
    expect(markup).toContain("Which projection feeds the overview?");
    expect(markup).toContain("Keep the triadic projection");
    expect(markup).toContain("Ad-hoc GUI aggregate");
    expect(markup).toContain("census stays single-sourced");
    expect(markup).toContain("打开完整详情");
    // 与 TaskPreviewDrawer 同语汇:fixed 覆盖层 + Esc 可关。
    expect(markup).toContain("fixed inset-0");
  });
});
