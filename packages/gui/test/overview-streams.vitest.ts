// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DecisionRow, TaskRow } from "../src/renderer/model/types.ts";
import { DecisionStream } from "../src/renderer/components/overview/DecisionStream.tsx";
import { TaskStream, tasksAheadOfStatus } from "../src/renderer/components/overview/TaskStream.tsx";
import { BoardView } from "../src/renderer/views/BoardView.tsx";
import { SwimlaneBoard } from "../src/renderer/views/SwimlaneBoard.tsx";
import { OverviewView } from "../src/renderer/views/OverviewView.tsx";
import { PinnedStream } from "../src/renderer/components/overview/PinnedStream.tsx";
import { RuntimeHealthCard } from "../src/renderer/components/overview/RuntimeHealthCard.tsx";
import { DecisionPreviewDrawer } from "../src/renderer/components/DecisionPreviewDrawer.tsx";
import { streamTime } from "../src/renderer/components/overview/streamParts.tsx";
import { localDateTime, localTime } from "../src/renderer/model/local-time.ts";
import type { WorkspaceSummaryRead } from "../src/api/renderer-dto.ts";
import { DEFAULT_TASK_FILTERS, matchesTask } from "../src/renderer/model/taskFilters.ts";
import { summarizeWorkspace } from "../../kernel/src/index.ts";

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
    ...patch,
  };
}

const noop = () => {};
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
  // The overview renders the daemon aggregate and the board counts the rows it draws.
  // They are the same number only while the backend classifies exactly what the board's
  // default filter keeps, so the same fixture has to reach both sides and agree.
  it("counts the same rows in the daemon aggregate and in the board columns it draws", () => {
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
    const visible = rows.filter((row) => matchesTask(row, DEFAULT_TASK_FILTERS));
    const overview = renderToStaticMarkup(
      createElement(TaskStream, { tasks: visible, summary, onOpenPreview: noop, onGoBoard: noop }),
    );
    const board = renderToStaticMarkup(
      createElement(BoardView, {
        tasks: visible,
        allTasks: rows,
        filters: DEFAULT_TASK_FILTERS,
        onFiltersChange: noop,
        onSelect: noop,
        relations: [],
        favorites: new Set<string>(),
        onToggleFavorite: noop,
      }),
    );

    for (const status of ["active", "blocked", "cancelled"] as const) {
      const drawn = visible.filter((row) => row.coordinationStatus === status).length;
      expect(summary.byStatus[status]).toBe(drawn);
      expect(board).toContain(`data-testid="board-status-${status}-count">${drawn}</span>`);
    }
    expect(summary.total).toBe(visible.length);
    expect(tabText(overview, "overview-status-active")).toBe("进行中 2");
    expect(tabText(overview, "overview-status-blocked")).toBe("已阻塞 1");
  });

  it("renders the whole board and swimlane up front with no reveal button", () => {
    const rows = Array.from({ length: 45 }, (_, index) =>
      task({
        taskId: `task_${index}`,
        title: `Task ${index}`,
        rootTaskId: `root_${index}`,
        coordinationStatus: "active",
      }),
    );
    const board = renderToStaticMarkup(
      createElement(BoardView, {
        tasks: rows,
        allTasks: rows,
        filters: DEFAULT_TASK_FILTERS,
        onFiltersChange: noop,
        onSelect: noop,
        relations: [],
        favorites: new Set<string>(),
        onToggleFavorite: noop,
      }),
    );
    expect(board.match(/data-testid="board-task-card"/gu)).toHaveLength(45);
    expect(board).not.toContain('data-testid="board-column-more-active"');
    expect(board).not.toContain("再显示");

    const swimlane = renderToStaticMarkup(
      createElement(SwimlaneBoard, {
        tasks: rows,
        groupBy: "root",
        onSelect: noop,
        drill: null,
        relations: [],
        favorites: new Set<string>(),
        onToggleFavorite: noop,
      }),
    );
    expect(swimlane.match(/data-testid="swimlane-row"/gu)).toHaveLength(45);
    expect(swimlane).not.toContain('data-testid="swimlane-more"');
  });

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
        project: {
          id: "proj",
          name: "Harness",
          path: "/repo",
          preset: "software/coding",
          engines: [],
          watermarkAt: "2026-08-01T00:00:00.000Z",
        },
        tasks: rows,
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
        systemHealth: { daemon: null, repo: null, projection: null },
        onSelect: noop,
        onDrill: noop,
        onOpenInbox: noop,
        onOpenDecision: noop,
        onOpenSystem: noop,
      }),
    );

    expect(tabText(page, "overview-status-active")).toBe("进行中 2");
    expect(tabText(page, "overview-status-blocked")).toBe("已阻塞 1");
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
    expect(markup).toContain("xl:flex-1");
    expect(markup).toContain("xl:max-h-none");
  });

  it("converts UTC stream timestamps with the process local timezone", () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = "Asia/Taipei";
      expect(streamTime("2026-08-21T16:04:35.025Z")).toBe("08-22 00:04");
      expect(localDateTime("2026-08-21T16:04:35.025Z")).toBe("2026-08-22 00:04");
      expect(localDateTime("2026-08-21T16:04:35.025Z", true)).toBe("2026-08-22 00:04:35");
      expect(localTime("2026-08-21T16:04:35.025Z", true)).toBe("00:04:35");
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

// O-01(乙)/ 不变量 1:`ha task create` 建出来的任务恒为 planned(kernel create transition),
// 总览任务流默认标签恒为 active,两者不相交(fact F-266F2F09)——于是新任务必须先点标签才看得见。
// 这一组把「零动作可见」钉住:把 TaskStream 的行集改回「只显示当前标签的状态」(删掉流首那组
// 更新的行)会让 "surfaces the freshly created planned task" 立刻红。
describe("overview task stream: freshly created tasks are visible with zero interaction", () => {
  const freshWorkspace = () => [
    task({
      taskId: "task_old_active",
      title: "Older active task",
      coordinationStatus: "active",
      createdAt: "2026-08-20T10:00:00.000Z",
    }),
    task({
      taskId: "task_new_planned",
      title: "Just created task",
      coordinationStatus: "planned",
      createdAt: "2026-08-22T09:30:00.000Z",
    }),
  ];

  it("surfaces the freshly created planned task in the default view without touching a status tab", () => {
    const markup = renderToStaticMarkup(
      createElement(TaskStream, {
        tasks: freshWorkspace(),
        summary: taskSummary({ active: 1, planned: 1 }),
        onOpenPreview: noop,
        onGoBoard: noop,
      }),
    );
    // 不变量 1:零交互的默认渲染里就有它,而且在可视区域顶部(流首,主行集之前),不在折叠区。
    expect(markup).toContain("Just created task");
    expect(markup.indexOf('data-testid="task-stream-ahead"')).toBeLessThan(
      markup.indexOf('data-testid="task-stream-rows"'),
    );
    const ahead = section(markup, "task-stream-ahead-rows");
    expect(ahead).not.toBeNull();
    expect(ahead).toContain("Just created task");
    // 可点开:与主行集同一个 button 行,带 taskId 的 title,不是纯文本。
    expect(ahead).toMatch(/<button[^>]*title="task_new_planned · Just created task"/u);
    expect(markup).toContain("更新的 1 条");
  });

  it("keeps the active default and the active-only main rows (invariant 3: 看在做的任务仍是 0 动作)", () => {
    const markup = renderToStaticMarkup(
      createElement(TaskStream, {
        tasks: freshWorkspace(),
        summary: taskSummary({ active: 1, planned: 1 }),
        onOpenPreview: noop,
        onGoBoard: noop,
      }),
    );
    expect(markup).toMatch(/aria-selected="true" data-testid="overview-status-active"/u);
    expect(markup).toMatch(/aria-selected="false" data-testid="overview-status-planned"/u);
    const rows = section(markup, "task-stream-rows");
    expect(rows).toContain("Older active task");
    expect(rows).not.toContain("Just created task");
  });

  it("shows the new task under its real status word, not disguised as active (invariant 4)", () => {
    const markup = renderToStaticMarkup(
      createElement(TaskStream, {
        tasks: freshWorkspace(),
        summary: taskSummary({ active: 1, planned: 1 }),
        onOpenPreview: noop,
        onGoBoard: noop,
      }),
    );
    expect(section(markup, "task-stream-ahead-rows")).toContain("计划中");
    // census 逐字照抄 daemon,不因为「让它可见」而被改写。
    expect(tabText(markup, "overview-status-active")).toBe("进行中 1");
    expect(tabText(markup, "overview-status-planned")).toBe("计划中 1");
  });

  it("surfaces the first task of a brand-new workspace where the active filter is empty", () => {
    const markup = renderToStaticMarkup(
      createElement(TaskStream, {
        tasks: [
          task({
            taskId: "task_first",
            title: "First ever task",
            coordinationStatus: "planned",
            createdAt: "2026-08-22T09:30:00.000Z",
          }),
        ],
        summary: taskSummary({ planned: 1 }),
        onOpenPreview: noop,
        onGoBoard: noop,
      }),
    );
    expect(section(markup, "task-stream-ahead-rows")).toContain("First ever task");
    // 空态照旧诚实:当前状态确实没有任务。
    expect(markup).toContain("该状态下暂无任务");
  });

  it("never promotes rows whose creation time is unknown (ledger-timeline: 不从 ID 推时间)", () => {
    const markup = renderToStaticMarkup(
      createElement(TaskStream, {
        tasks: [
          task({ taskId: "task_a1", title: "Active one", coordinationStatus: "active", createdAt: null }),
          task({ taskId: "task_b1", title: "Blocked unknown time", coordinationStatus: "blocked", createdAt: null }),
        ],
        summary: taskSummary({ active: 1, blocked: 1 }),
        onOpenPreview: noop,
        onGoBoard: noop,
      }),
    );
    expect(markup).not.toContain('data-testid="task-stream-ahead"');
    expect(markup).not.toContain("Blocked unknown time");
  });

  it("stays silent when the newest task already sits in the selected status", () => {
    const markup = renderToStaticMarkup(
      createElement(TaskStream, {
        tasks: [
          task({
            taskId: "task_new_active",
            title: "Newest active",
            coordinationStatus: "active",
            createdAt: "2026-08-22T09:30:00.000Z",
          }),
          task({
            taskId: "task_old_done",
            title: "Older done",
            coordinationStatus: "done",
            createdAt: "2026-08-19T09:30:00.000Z",
          }),
        ],
        summary: taskSummary({ active: 1, done: 1 }),
        onOpenPreview: noop,
        onGoBoard: noop,
      }),
    );
    expect(markup).not.toContain('data-testid="task-stream-ahead"');
    expect(markup).not.toContain("Older done");
  });

  // 这一段的规模不是常数:当前筛选一行都没有时阈值退化为无阈值,于是全部有已知创建时间的
  // 任务都合格。完整渲染(fact F-EDD4483A 的规模事实不变),标题报真实总数。
  it("renders every ahead band row with no reveal button", () => {
    const rows = Array.from({ length: 45 }, (_, index) =>
      task({
        taskId: `task_ahead_${index}`,
        title: `Ahead ${index}`,
        coordinationStatus: "planned",
        createdAt: `2026-08-22T09:${String(index).padStart(2, "0")}:00.000Z`,
      }),
    );
    const markup = renderToStaticMarkup(
      createElement(TaskStream, {
        tasks: [
          task({
            taskId: "task_old_active",
            title: "Older active task",
            coordinationStatus: "active",
            createdAt: "2026-08-20T10:00:00.000Z",
          }),
          ...rows,
        ],
        summary: taskSummary({ active: 1, planned: 45 }),
        onOpenPreview: noop,
        onGoBoard: noop,
      }),
    );
    const ahead = section(markup, "task-stream-ahead-rows");
    expect(ahead).not.toBeNull();
    expect(ahead!.match(/title="task_ahead_/gu)).toHaveLength(45);
    expect(ahead).not.toContain('data-testid="task-stream-ahead-more"');
    expect(ahead).not.toContain("再显示");
    // 标题报的就是全量总数。
    expect(markup).toContain("更新的 45 条");
  });

  it("renders a small ahead band in full", () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      task({
        taskId: `task_ahead_${index}`,
        title: `Ahead ${index}`,
        coordinationStatus: "planned",
        createdAt: `2026-08-22T09:0${index}:00.000Z`,
      }),
    );
    const markup = renderToStaticMarkup(
      createElement(TaskStream, {
        tasks: [
          task({
            taskId: "task_old_active",
            title: "Older active task",
            coordinationStatus: "active",
            createdAt: "2026-08-20T10:00:00.000Z",
          }),
          ...rows,
        ],
        summary: taskSummary({ active: 1, planned: 5 }),
        onOpenPreview: noop,
        onGoBoard: noop,
      }),
    );
    expect(section(markup, "task-stream-ahead-rows")!.match(/title="task_ahead_/gu)).toHaveLength(5);
    expect(markup).not.toContain('data-testid="task-stream-ahead-more"');
  });

  // 最坏一档:active 筛选为空,阈值退化为无阈值,全部任务合格——也全部渲染。
  it("renders every task when the active filter is empty and every task qualifies", () => {
    const rows = Array.from({ length: 60 }, (_, index) =>
      task({
        taskId: `task_done_${index}`,
        title: `Done ${index}`,
        coordinationStatus: "done",
        createdAt: `2026-08-22T09:${String(index).padStart(2, "0")}:00.000Z`,
      }),
    );
    const markup = renderToStaticMarkup(
      createElement(TaskStream, {
        tasks: rows,
        summary: taskSummary({ done: 60 }),
        onOpenPreview: noop,
        onGoBoard: noop,
      }),
    );
    const ahead = section(markup, "task-stream-ahead-rows");
    expect(ahead!.match(/title="task_done_/gu)).toHaveLength(60);
    expect(markup).toContain("更新的 60 条");
    expect(ahead).not.toContain("再显示");
  });

  it("derives the ahead rows purely from the selected status (unit-level invariant)", () => {
    const rows = freshWorkspace();
    expect(tasksAheadOfStatus(rows, "active").map((row) => row.taskId)).toEqual(["task_new_planned"]);
    // 选中 planned 时那条新任务已在主行集里,不重复出现在流首。
    expect(tasksAheadOfStatus(rows, "planned")).toEqual([]);
  });

  // 组件级证据说明 leaf 会渲染,页面级证据说明总览页真的把这条流接上了。
  it("carries the zero-interaction visibility through the overview page", () => {
    const page = renderToStaticMarkup(
      createElement(OverviewView, {
        project: {
          id: "proj",
          name: "Harness",
          path: "/repo",
          preset: "software/coding",
          engines: [],
          watermarkAt: "2026-08-22T00:00:00.000Z",
        },
        tasks: freshWorkspace(),
        decisions: [],
        workspaceSummary: {
          schema: "daemon.workspace-summary/v1",
          ok: true,
          status: "ready",
          warnings: [],
          watermark: 1,
          sourceRevision: 1,
          tasks: taskSummary({ active: 1, planned: 1 }),
          decisions: decisionSummary({ proposed: 0 }),
        },
        relations: [],
        systemHealth: { daemon: null, repo: null, projection: null },
        onSelect: noop,
        onDrill: noop,
        onOpenInbox: noop,
        onOpenDecision: noop,
        onOpenSystem: noop,
        onNavigateEntity: noop,
      }),
    );
    expect(page).toContain("Just created task");
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
    const body = section(markup, "task-stream-rows");
    expect(body).not.toBeNull();
    expect(body!.match(/title="task_main_/gu)).toHaveLength(45);
    expect(body).not.toContain('data-testid="task-stream-more"');
    expect(body).not.toContain("再显示");
    // 页签计数报的是真实总数,与渲染行数一致。
    expect(tabText(markup, "overview-status-active")).toBe("进行中 45");
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
    expect(section(markup, "task-stream-rows")!.match(/title="task_main_/gu)).toHaveLength(5);
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
    expect(section(markup, "task-stream-rows")!.match(/title="task_act_/gu)).toHaveLength(60);
    expect(markup).not.toContain('data-testid="task-stream-ahead"');
    expect(markup).not.toContain("再显示");
  });
});

describe("overview pinned stream", () => {
  it("lists only ledger-pinned tasks regardless of their coordination status", () => {
    const markup = renderToStaticMarkup(
      createElement(PinnedStream, {
        tasks: [
          task({ taskId: "task_pin_active", title: "Pinned active", pinned: true, coordinationStatus: "active" }),
          task({ taskId: "task_pin_blocked", title: "Pinned blocked", pinned: true, coordinationStatus: "blocked" }),
          task({ taskId: "task_plain", title: "Plain active", coordinationStatus: "active" }),
        ],
        onOpenPreview: noop,
      }),
    );
    expect(markup).toContain("Pinned active");
    expect(markup).toContain("Pinned blocked");
    expect(markup).not.toContain("Plain active");
  });

  it("explains how to pin when nothing is pinned", () => {
    const markup = renderToStaticMarkup(createElement(PinnedStream, { tasks: [task({})], onOpenPreview: noop }));
    expect(markup).toContain("当前没有 pin 的任务");
    expect(markup).toContain("ha task pin");
  });
});

describe("overview runtime health card", () => {
  it("renders the worst lamp, four signal rows and the system exit", () => {
    const markup = renderToStaticMarkup(
      createElement(RuntimeHealthCard, {
        health: {
          daemon: { state: "responsive", observedAgeSec: 5, uptimeMs: 3_600_000 },
          cell: { state: "attached", queueDepth: 0, problem: null },
          projection: { lag: 0, status: "ready" },
          ledgerChange: { at: "2026-08-21T11:00:00.000Z", ageSec: 3_600 },
        },
        onOpenSystem: noop,
      }),
    );
    expect(markup).toContain('data-testid="runtime-health-card"');
    expect(markup).toContain("运行正常");
    expect(markup).toContain("台账服务");
    expect(markup).toContain("投影落后");
    expect(markup).toContain("最新台账变化");
    expect(markup).toContain("系统页");
  });

  it("renders down state without hiding rows", () => {
    const markup = renderToStaticMarkup(
      createElement(RuntimeHealthCard, {
        health: {
          daemon: { state: "unresponsive", observedAgeSec: 900, uptimeMs: null },
          cell: { state: "unavailable", queueDepth: null, problem: "cell crashed" },
          projection: { lag: 12, status: "pending" },
          ledgerChange: { at: null, ageSec: null },
        },
        onOpenSystem: noop,
      }),
    );
    expect(markup).toContain("不可用");
    expect(markup).toContain("无响应");
    expect(markup).toContain("cell crashed");
    expect(markup).toContain("12 revisions");
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
