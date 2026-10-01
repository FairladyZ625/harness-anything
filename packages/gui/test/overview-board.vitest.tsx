// harness-test-tier: fast
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { prefersReducedMotion } from "motion/react";
import { OverviewView } from "../src/renderer/views/OverviewView.tsx";
import { workRows } from "../src/renderer/views/overview-model.ts";
import { AppMotionConfig } from "../src/renderer/motion-config.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { AgendaSuccess } from "../src/renderer/api-client.ts";
import type { AgendaAwaitsRow, WorkIndexRead, WorkspaceSummaryRead } from "../src/api/renderer-dto.ts";
import type { RuntimeHealth } from "../src/renderer/model/runtime-health.ts";

/**
 * 总览(S3 区域板,dec_B3D40712 CH1)的行为面:区域由 S1 权重落位、等我处理/阻塞与停滞
 * 的行取 attentionItems、CI 绿不出区域红时压左上、点区域原位放大并给真实动作、Esc 收回、
 * 顶栏只放系统状态与全局搜索。布局算法本身在 overview-layout.vitest.ts 单测。
 */

const AT = "2026-09-29T01:00:00.000Z";

beforeAll(() => {
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
  // 板尺寸观察者:挂上即报一次 1200×700,区域随后落位。
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
  // 测试不接 daemon:三条自持读面走确定性失败(error 态),总览按「无数据」渲染。
  vi.stubGlobal("harness", {
    request: () => Promise.reject(new Error("no bridge in test")),
  });
});

const HEALTH: RuntimeHealth = {
  daemon: { state: "responsive", observedAgeSec: 1, uptimeMs: 1000 },
  cell: { state: "mounted", queueDepth: 0, problem: null },
  projection: { lag: 0, status: "ready" },
  ledgerChange: { at: AT, ageSec: 60 },
};

const SUMMARY = {
  schema: "daemon.workspace-summary/v1",
  ok: true,
  status: "ready",
  tasks: {
    total: 9,
    byStatus: { planned: 3, active: 2, submitted: 1, in_review: 1, blocked: 1, done: 1, cancelled: 0 },
  },
  decisions: { total: 2, byState: {} },
  watermark: 7,
  sourceRevision: 7,
  warnings: [],
} as unknown as WorkspaceSummaryRead;

const awaitsRow = (relationId: string): AgendaAwaitsRow => ({
  relationId,
  relationRevision: 1,
  sourceRef: "task/task_9",
  title: `提案 ${relationId}`,
  status: "active",
  personId: "person_me",
  askKind: "question",
  question: "接口要不要兼容旧字段?",
  askedAt: AT,
  askedBy: "person_worker",
});

const agenda = (patch: Partial<AgendaSuccess> = {}): AgendaSuccess =>
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
        ref: "task/task_stuck",
        title: "PLT-Observability-Eval",
        kind: "stalled",
        region: "stuck",
        workTaskId: null,
        attention: { score: 48, reasons: [{ label: "进行中停滞", contribution: 40 }] },
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
    awaitingAdjudication: [],
    underReview: [],
    decisionReviewInProgress: [],
    awaitingDecisionReview: [],
    awaitingDecision: [],
    waitingOnOthers: [],
    dispatchable: [],
    summary: "",
    page: { sourceLimit: 100, cursor: null, nextCursor: null },
    watermark: 7,
    sourceRevision: 7,
    ...patch,
  }) as AgendaSuccess;

const WORKS: WorkIndexRead = {
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
      lastActivityAt: AT,
      memberTaskIds: [],
    },
  ],
  watermark: 7,
  sourceRevision: 7,
  warnings: [],
};

const WORKS_EMPTY: WorkIndexRead = { ...WORKS, works: [] };

const TITLES = new Map([
  ["task/task_w1", "代码质量长期检验"],
  ["task/task_r1", "网关读面加缓存"],
  ["task/task_r2", "修复 401 重定向循环"],
]);

let root: Root | null = null;
let host: HTMLElement | null = null;

/** 每个用例一个干净 client:上一例的 error 态不能泄进下一例的读面。 */
function mount(props: Partial<Parameters<typeof OverviewView>[0]> = {}): HTMLElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const noop = () => undefined;
  act(() =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          AppMotionConfig,
          null,
          createElement(OverviewView, {
            repoId: "probe-repo",
            agenda: agenda(),
            works: WORKS,
            titles: TITLES,
            workspaceSummary: SUMMARY,
            health: HEALTH,
            onNavigateEntity: noop,
            onOpenTask: noop,
            onOpenSearch: noop,
            onOpenSessions: noop,
            onUnpin: noop,
            ...props,
          }),
        ),
      ),
    ),
  );
  host = container;
  return container;
}

const textOf = (element: Element | null | undefined) => element?.textContent ?? "";

/** 自持读面(queryFn 走微任务链)落定的确定性等待:谓词成立即停,上限轮数内不成立即原样返回,
 * 由调用方的断言报红。不用假定时器(react-query 调度依赖真定时器)。 */
async function flushUntil(predicate: () => boolean, rounds = 200): Promise<void> {
  for (let round = 0; round < rounds && !predicate(); round += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("总览区域板(S3)", () => {
  it("顶栏只放系统状态与全局搜索:状态点 + ⌘K 搜索入口,无仓库名大标题", () => {
    const container = mount();
    const topbar = container.querySelector('[data-testid="overview-topbar"]')!;
    expect(textOf(topbar)).toContain("daemon 正常");
    expect(textOf(topbar)).toContain("main CI 绿");
    expect(textOf(topbar)).toContain("agent 在跑");
    expect(textOf(topbar)).toContain("进行中 2");
    const search = topbar.querySelector('[data-testid="overview-global-search"]')! as HTMLButtonElement;
    expect(textOf(search)).toContain("⌘K");
    expect(host?.querySelector("h1")).toBeNull();
    act(() => root?.unmount());
  });

  it("全局搜索入口接真实动作(打开 ⌘K 命令面板)", () => {
    const onOpenSearch = vi.fn();
    const container = mount({ onOpenSearch });
    act(() => (container.querySelector('[data-testid="overview-global-search"]') as HTMLButtonElement).click());
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
    act(() => root?.unmount());
  });

  it("等我处理/阻塞与停滞的行取 attentionItems,原因与分数进放大层", () => {
    const container = mount();
    const mine = container.querySelector('[data-testid="overview-region-mine"]')!;
    expect(textOf(mine)).toContain("边缘 RBAC 设计裁决");
    expect(textOf(mine)).toContain("1 件急");
    // 原因行(所属工作)与等待时长来自源行/工作索引
    expect(textOf(mine)).toContain("代码质量长期检验");
    const stuck = container.querySelector('[data-testid="overview-region-stuck"]')!;
    expect(textOf(stuck)).toContain("PLT-Observability-Eval");
    expect(textOf(stuck)).toContain("停滞 1");
    act(() => root?.unmount());
  });

  it("点区域原位放大:左列表右详情,Esc 或点背景收回", () => {
    const container = mount();
    act(() => (container.querySelector('[data-testid="overview-region-mine"] section') as HTMLElement).click());
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(textOf(dialog)).toContain("边缘 RBAC 设计裁决");
    expect(textOf(dialog)).toContain("为什么排在这里");
    expect(textOf(dialog)).toContain("注意力分");
    expect(textOf(dialog)).toContain("132");
    expect(container.querySelector("[data-focus-list]")?.className).toContain("flex-col");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    act(() => root?.unmount());
  });

  it("放大层的答复按钮接真实动作:关闭放大层并打开 awaits 答复面板", () => {
    const container = mount();
    act(() => (container.querySelector('[data-testid="overview-region-mine"] section') as HTMLElement).click());
    const answer = [...container.querySelectorAll("button")].find((button) => textOf(button) === "答复");
    expect(answer).toBeDefined();
    act(() => answer!.click());
    // 答复面板自己也带 role=dialog,聚焦层以其列表特征断言收回。
    expect(container.querySelector("[data-focus-list]")).toBeNull();
    expect(container.querySelector('[data-testid="awaits-answer-panel"]')).not.toBeNull();
    act(() => root?.unmount());
  });

  it("等我处理为空:区域显示「清空」且不再列行(空了就收)", () => {
    const container = mount({
      agenda: agenda({
        attentionItems: [],
        regionWeights: { mine: 1.5, stuck: 3, run: 3, review: 3, queue: 0, recent: 4, works: 8 },
        awaitingYou: [],
      }),
    });
    const mine = container.querySelector('[data-testid="overview-region-mine"]')!;
    expect(textOf(mine)).toContain("清空");
    expect(textOf(mine)).not.toContain("边缘 RBAC");
    act(() => root?.unmount());
  });

  it("置顶待派为空时区域不落位(权重 0 → 不渲染)", () => {
    const container = mount();
    expect(container.querySelector('[data-testid="overview-region-queue"]')).toBeNull();
    expect(container.querySelector('[data-testid="overview-region-ci"]')).toBeNull();
    act(() => root?.unmount());
  });

  it("工作区域的行按注意力排,mine 计数与进度来自工作索引", () => {
    const container = mount();
    const works = container.querySelector('[data-testid="overview-region-works"]')!;
    expect(textOf(works)).toContain("代码质量长期检验");
    expect(textOf(works)).toContain("1 个有事等你");
    act(() => root?.unmount());
  });

  it("空了就消失:行数为 0 的区域即使 daemon 给了最小权重也不落位(返工 1 第 3 点)", () => {
    // daemon 的 attentionRegionWeights 对空区域也给最小权重(mine 1.5、stuck 3、run 3、
    // review 3、works 8…)——透传会让「工作 0」「阻塞与停滞 0」占成大框;视图层必须归 0。
    const container = mount({
      agenda: agenda({
        attentionItems: [agenda().attentionItems[0]!], // 只留 mine 行,stuck 行清空
        stalled: [],
        regionWeights: { mine: 15.4, stuck: 3, run: 3, review: 3, queue: 0, recent: 4, works: 8 },
      }),
      works: WORKS_EMPTY,
    });
    expect(container.querySelector('[data-testid="overview-region-stuck"]')).toBeNull();
    expect(container.querySelector('[data-testid="overview-region-run"]')).toBeNull();
    expect(container.querySelector('[data-testid="overview-region-review"]')).toBeNull();
    expect(container.querySelector('[data-testid="overview-region-recent"]')).toBeNull();
    expect(container.querySelector('[data-testid="overview-region-works"]')).toBeNull();
    // 有内容的区域不受影响:mine 还有一行,照常落位。
    const mine = container.querySelector('[data-testid="overview-region-mine"]')!;
    expect(textOf(mine)).toContain("边缘 RBAC 设计裁决");
    act(() => root?.unmount());
  });

  it("空行区域不可放大成空壳:点 slim 的等我处理不打开放大层(返工 1 第 4 点)", () => {
    const container = mount({
      agenda: agenda({
        attentionItems: [],
        awaitingYou: [],
        regionWeights: { mine: 1.5, stuck: 3, run: 3, review: 3, queue: 0, recent: 4, works: 8 },
      }),
      works: WORKS_EMPTY,
    });
    // mine 空集收成一行「清空」(原型 v4 slim 样张,「一切正常」的唯一保留形态)。
    const mine = container.querySelector('[data-testid="overview-region-mine"]')!;
    expect(textOf(mine)).toContain("清空");
    act(() => (mine.querySelector("section") as HTMLElement).click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    act(() => root?.unmount());
  });

  it("最近变化与工作页同一派生:按任务收束成一行,原始事件类型名不进总览(返工 1 第 2 点)", async () => {
    const item = (patch: Record<string, unknown>) => ({
      eventId: `evt-${Math.random().toString(36).slice(2, 8)}`,
      occurredAt: "2026-09-29T10:00:00.000Z",
      workspaceRevision: 1,
      type: "execution_started",
      taskId: "task_r1",
      payload: {},
      ...patch,
    });
    vi.stubGlobal("harness", {
      request: (method: string) =>
        method === "tailObservability"
          ? Promise.resolve({
              schema: "daemon.observe-tail/v3",
              ok: true,
              repoId: "probe-repo",
              mode: "local",
              kind: "events",
              direction: "history",
              status: "ready",
              items: [
                // runtime_* / documents_written 这类内部事件不产步骤,不进总览。
                item({ type: "runtime_session_started", taskId: "task_r1" }),
                item({ type: "documents_written", taskId: "task_r1", payload: { documentClaims: [] } }),
                item({ type: "execution_started", occurredAt: "2026-09-29T10:05:00.000Z" }),
                item({ type: "execution_submitted", occurredAt: "2026-09-29T10:20:00.000Z" }),
                item({
                  type: "review_recorded",
                  occurredAt: "2026-09-29T10:30:00.000Z",
                  payload: { review: { verdict: "approved" } },
                }),
                item({ type: "task_completed", taskId: "task_r2", occurredAt: "2026-09-29T10:40:00.000Z" }),
              ],
              historyCursor: null,
              liveCursor: null,
              sourceCursor: null,
              done: true,
            })
          : Promise.reject(new Error("no bridge in test")),
    });
    const container = mount({ works: WORKS_EMPTY });
    await flushUntil(() => container.querySelector('[data-testid="overview-region-recent"]') !== null);
    const recent = container.querySelector('[data-testid="overview-region-recent"]')!;
    // 按任务收束成一行:任务标题 + 箭头串起的步骤(与工作页 DayDigest 同一派生)。
    expect(textOf(recent)).toContain("网关读面加缓存");
    expect(textOf(recent)).toContain("提交");
    expect(textOf(recent)).toContain("评审通过");
    expect(textOf(recent)).toContain("修复 401 重定向循环");
    expect(textOf(recent)).toContain("完成");
    // 原始事件类型名(标准 §8 反例)一个都不出现。
    for (const raw of ["runtime_session_started", "documents_written", "execution_submitted", "review_recorded"]) {
      expect(textOf(recent)).not.toContain(raw);
    }
    act(() => root?.unmount());
  });

  it("main CI 红:CI 区域出现并压在最前(左上),顶栏点名红", async () => {
    vi.stubGlobal("harness", {
      request: (method: string) =>
        method === "getCiObservatory"
          ? Promise.resolve({
              schema: "daemon.ci-observatory/v1",
              ok: true,
              status: "ready",
              window: 30,
              flakes: [],
              shardDurations: [],
              gateTrends: [],
              l0MedianMs: null,
              runs: [
                {
                  runId: "run-1",
                  sha: "850840cdffffffffffffffffffffffffffffffff",
                  branch: "main",
                  prNumber: null,
                  job: "integration-shard-6",
                  wallclockMs: 600000,
                  runner: "ubuntu",
                  occurredAt: "2026-09-29T07:18:00.000Z",
                  pass: false,
                  testCount: 10,
                  gateCount: 2,
                },
                // 同一 job 在 PR 上跑过 → 它挡合入,main 上失败才算 main 红。
                {
                  runId: "run-pr",
                  sha: "aaaaaaaaffffffffffffffffffffffffffffffff",
                  branch: "task_x",
                  prNumber: 3000,
                  job: "integration-shard-6",
                  wallclockMs: 600000,
                  runner: "ubuntu",
                  occurredAt: "2026-09-29T06:00:00.000Z",
                  pass: true,
                  testCount: 10,
                  gateCount: 2,
                },
                // 只在 main 上跑的夜间 job(Windows 矩阵,永不 required)失败,不算 main 红,也不进区域。
                ...[1, 2, 3].map((index) => ({
                  runId: `run-win-${index}`,
                  sha: "e82729a4ffffffffffffffffffffffffffffffff",
                  branch: "main",
                  prNumber: null,
                  job: "windows-integration-shard (6)",
                  wallclockMs: 600000,
                  runner: "windows",
                  occurredAt: `2026-09-29T08:0${index}:00.000Z`,
                  pass: false,
                  testCount: 10,
                  gateCount: 2,
                })),
              ],
              watermark: 7,
              sourceRevision: 7,
            })
          : Promise.reject(new Error("no bridge in test")),
    });
    const container = mount();
    // CI 读面异步落定后区域才落位:等到 CI 区域出现再断言落位顺序。
    await flushUntil(() => container.querySelector('[data-testid="overview-region-ci"]') !== null);
    const board = container.querySelector('[data-testid="overview-board"]')!;
    expect((board.querySelector("[data-region]") as HTMLElement).dataset.region).toBe("ci");
    const ci = container.querySelector('[data-testid="overview-region-ci"]')!;
    expect(textOf(ci)).toContain("阻断合入");
    expect(textOf(ci)).toContain("integration-shard-6");
    expect(textOf(ci)).not.toContain("windows-integration-shard");
    expect(textOf(container.querySelector('[data-testid="overview-topbar"]'))).toContain("main CI 红");
    act(() => root?.unmount());
  });

  it("工作区域:已完成/已取消的工作沉底,不按最近活动插进活跃工作之间", () => {
    const base = WORKS.works[0]!;
    const rows = workRows(
      {
        ...WORKS,
        works: [
          { ...base, taskId: "task_done", status: "done", lastActivityAt: "2026-09-30T09:00:00.000Z" },
          { ...base, taskId: "task_cancel", status: "cancelled", lastActivityAt: "2026-09-30T08:00:00.000Z" },
          { ...base, taskId: "task_live", status: "active", lastActivityAt: "2026-09-20T00:00:00.000Z" },
        ],
      },
      undefined,
    );
    expect(rows.map((row) => row.taskId)).toEqual(["task_live", "task_done", "task_cancel"]);
  });
});
