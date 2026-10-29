// OverviewView 挂载夹具:overview-board 与左列在飞/产物测试共用的环境 stub、读面
// fixture 与渲染等待件。不进 vitest include(非 *.vitest.ts),测试文件各自 beforeAll
// 调 setupOverviewBoardEnvironment() 完成全局 stub。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import { prefersReducedMotion } from "motion/react";
import { OverviewView } from "../src/renderer/views/OverviewView.tsx";
import { AppMotionConfig } from "../src/renderer/motion-config.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { AgendaSuccess } from "../src/renderer/api-client.ts";
import type { AgendaAwaitsRow, WorkIndexRead, WorkspaceSummaryRead } from "../src/api/renderer-dto.ts";
import type { RuntimeHealth } from "../src/renderer/model/runtime-health.ts";

export const AT = "2026-09-29T01:00:00.000Z";

/** 全局环境 stub:happy-dom 没有 matchMedia/ResizeObserver;测试不接 daemon,自持读面
 *  走确定性失败(error 态),总览按「无数据」渲染。 */
export function setupOverviewBoardEnvironment(): void {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
  // 不开假定时器:react-query 的取数调度依赖真定时器,冻结会永远 pending。
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as typeof matchMedia,
  );
  prefersReducedMotion.current = true;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element): void {
        this.callback(
          [
            {
              target,
              contentRect: { width: 1200, height: 700, x: 0, y: 0, top: 0, left: 0, bottom: 700, right: 1200 },
            } as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal("harness", {
    request: () => Promise.reject(new Error("no bridge in test")),
  });
}

export const HEALTH: RuntimeHealth = {
  daemon: { state: "responsive", observedAgeSec: 1, uptimeMs: 1000 },
  cell: { state: "attached", queueDepth: 0, problem: null },
  projection: { lag: 0, loading: false, status: "ready", isolatedRows: 0, hydrating: false },
  transient: { lagSince: null, unknownSince: null, lagAgeSec: null, unknownAgeSec: null },
  mount: null,
  ledgerChange: { at: AT, ageSec: 60 },
};

export const HEALTH_DOWN: RuntimeHealth = {
  ...HEALTH,
  daemon: { state: "unresponsive", observedAgeSec: 90, uptimeMs: 1000 },
};

export const SUMMARY = {
  schema: "daemon.workspace-summary/v1",
  ok: true,
  status: "ready",
  tasks: {
    lastChangedAt: null,
    total: 9,
    byStatus: { planned: 3, active: 2, submitted: 1, in_review: 1, blocked: 1, done: 1, cancelled: 0 },
  },
  // 「决策待裁」域的普查数(与侧栏待办签发角标同一读面):总览右下块的差额指回靠它。
  decisions: { total: 2, inboxCount: 2, byState: {}, groups: [] },
  watermark: 7,
  sourceRevision: 7,
  warnings: [],
} as unknown as WorkspaceSummaryRead;

const awaitsRow = (relationId: string): AgendaAwaitsRow => ({
  relationId,
  relationRevision: 1,
  sourceRef: "task/task_w1",
  title: `提案 ${relationId}`,
  status: "active",
  personId: "person_me",
  askKind: "question",
  question: "接口要不要兼容旧字段?",
  askedAt: AT,
  askedBy: "person_worker",
});

/** 工作的活动时间相对挂载时刻生成:总览「关注的工作」默认只列最近 3 天(设置项)有
 * 活动的工作,静态历史日期会被窗口诚实地滤掉。w1 两小时前、w2 两天前(都在默认窗口
 * 内),已收尾工作任意旧。 */
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

export const WORKS: WorkIndexRead = {
  schema: "daemon.work-index/v1",
  ok: true,
  status: "ready",
  works: [
    {
      taskId: "task_w1",
      title: "代码质量长期检验",
      status: "active",
      root: "declared",
      parentTaskId: null,
      taskCount: 3,
      counts: { done: 2, executing: 1, pending: 0, blocked: 0, planned: 0, cancelled: 0 },
      lastActivityAt: hoursAgo(2),
      memberTaskIds: ["task_m1"],
    },
    {
      taskId: "task_w2",
      title: "网关读面加缓存",
      status: "active",
      root: "derived",
      parentTaskId: null,
      taskCount: 3,
      counts: { done: 0, executing: 0, pending: 0, blocked: 1, planned: 2, cancelled: 0 },
      lastActivityAt: hoursAgo(48),
      memberTaskIds: [],
    },
    {
      taskId: "task_w_done",
      title: "已收尾的工作",
      status: "done",
      root: "declared",
      parentTaskId: null,
      taskCount: 1,
      counts: { done: 1, executing: 0, pending: 0, blocked: 0, planned: 0, cancelled: 0 },
      lastActivityAt: "2026-09-30T00:00:00.000Z",
      memberTaskIds: [],
    },
  ],
  watermark: 7,
  sourceRevision: 7,
  warnings: [],
};

export const WORKS_EMPTY: WorkIndexRead = { ...WORKS, works: [] };

export const TITLES = new Map([
  ["task/task_w1", "代码质量长期检验"],
  ["task/task_m1", "总览首块的成员任务"],
  ["task/task_other", "不属于关注工作的任务"],
]);

export const agenda = (patch: Partial<AgendaSuccess> = {}): AgendaSuccess =>
  ({
    ok: true,
    status: "ready",
    pinnedEntities: [],
    pinnedEntityOverflow: 0,
    attentionItems: [
      {
        ref: "relation/rel_1",
        title: "边缘 RBAC 设计裁决",
        kind: "awaiting-you",
        region: "mine",
        workTaskId: "task_w1",
        attention: {
          score: 132,
          reasons: [
            { label: "等你答复", contribution: 100 },
            { label: "已置顶", contribution: 20 },
          ],
        },
      },
      {
        ref: "execution/exec_1",
        title: "总览重构的提交",
        kind: "adjudication",
        region: "mine",
        workTaskId: "task_w1",
        attention: { score: 90, reasons: [{ label: "待裁决", contribution: 60 }] },
      },
      {
        ref: "decision/dec_1",
        title: "是否冻结旧投影字段",
        kind: "decision",
        region: "mine",
        workTaskId: null,
        attention: { score: 70, reasons: [{ label: "决策待点头", contribution: 50 }] },
      },
      {
        ref: "task/task_blk",
        title: "被阻塞的成员任务",
        kind: "blocked",
        region: "stuck",
        workTaskId: "task_w2",
        attention: { score: 48, reasons: [{ label: "阻塞", contribution: 45 }] },
      },
      {
        ref: "task/task_stuck",
        title: "PLT-Observability-Eval",
        kind: "stalled",
        region: "stuck",
        workTaskId: null,
        attention: { score: 40, reasons: [{ label: "进行中停滞", contribution: 40 }] },
      },
    ],
    regionWeights: { mine: 15.4, stuck: 4, run: 3, review: 3, queue: 0, recent: 4, works: 8 },
    awaitingYou: [awaitsRow("rel_1")],
    answeredForYou: [],
    inFlight: [],
    stalled: [
      {
        taskId: "task_stuck",
        title: "PLT-Observability-Eval",
        status: "active",
        pinned: false,
        updatedAt: "2026-09-10T00:00:00.000Z",
        leaseExecutionId: null,
        activeExecutionIds: [],
        blockingAssessment: { state: "clear", blockers: [], warnings: [] },
      },
    ],
    awaitingRework: [],
    awaitingAdjudication: [
      {
        taskId: "task_m1",
        title: "总览重构的提交",
        work: { taskId: "task_w1", title: "代码质量长期检验" },
        pinned: false,
        executionId: "exec_1",
        submittedAt: AT,
        blockingAssessment: { state: "clear", blockers: [], warnings: [] },
      },
    ],
    underReview: [],
    decisionReviewInProgress: [],
    awaitingDecisionReview: [],
    awaitingDecision: [
      { decisionId: "dec_1", title: "是否冻结旧投影字段", riskTier: "high", urgency: "high", proposedAt: AT },
    ],
    waitingOnOthers: [
      {
        taskId: "task_blk",
        title: "被阻塞的成员任务",
        work: { taskId: "task_w2", title: "网关读面加缓存" },
        status: "blocked",
        pinned: false,
        updatedAt: AT,
        leaseExecutionId: null,
        activeExecutionIds: [],
        blockingAssessment: { state: "clear", blockers: [], warnings: [] },
      },
    ],
    dispatchable: [],
    summary: "",
    page: { sourceLimit: 100, cursor: null, nextCursor: null },
    watermark: 7,
    sourceRevision: 7,
    ...patch,
  }) as AgendaSuccess;

let root: Root | null = null;

/** 每个用例一个干净 client:上一例的 error 态不能泄进下一例的读面。 */
export function mountOverview(props: Partial<Parameters<typeof OverviewView>[0]> = {}): HTMLElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AppMotionConfig, null, createElement(OverviewHistoryHarness, props)),
      ),
    ),
  );
  return container;
}

/**
 * 与 App.tsx 同一接线的导航 harness:真实 useViewHistory(总览四块重构后不再持有页内
 * 层字段,这里只保留挂载手柄供后续用例扩展)。
 */
function OverviewHistoryHarness(props: Partial<Parameters<typeof OverviewView>[0]> = {}) {
  const noop = () => undefined;
  return createElement(OverviewView, {
    repoId: "probe-repo",
    connectionId: "local",
    agenda: agenda(),
    works: WORKS,
    titles: TITLES,
    workspaceSummary: SUMMARY,
    health: HEALTH,
    onNavigateEntity: noop,
    onOpenTask: noop,
    onOpenSearch: noop,
    onOpenSessions: noop,
    onOpenWorks: noop,
    onOpenTasks: noop,
    onOpenSignoffs: noop,
    onOpenPool: noop,
    tasks: [],
    onUnpin: noop,
    onUnpinEntity: noop,
    ...props,
  });
}

export const textOf = (element: Element | null | undefined): string => element?.textContent ?? "";

/** 自持读面(queryFn 走微任务链)落定的等待:谓词成立即停。每轮仍在 act 内清微任务
 * (不开假定时器:react-query 调度依赖真定时器);轮询与超时交给 vitest 的 vi.waitFor
 * 按真实时间计,慢机器上渲染晚于 200 轮微任务也能等到。超时即抛带条件描述的错误,
 * 不再静默返回把「行还没渲染」推迟成后续断言的误导性报红。默认超时取 2s:必须留在
 * vitest 每用例 5s 默认超时之内,超时时报的才是这里的条件描述而不是 runner 超时。 */
export async function flushUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  await vi.waitFor(
    async () => {
      for (let round = 0; round < 200 && !predicate(); round += 1) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      if (!predicate()) {
        throw new Error(`flushUntil:条件未在 ${timeoutMs}ms 内成立: ${predicate.toString()}`);
      }
    },
    { timeout: timeoutMs, interval: 10 },
  );
}

export const unmountOverview = (): void => {
  act(() => root?.unmount());
};
