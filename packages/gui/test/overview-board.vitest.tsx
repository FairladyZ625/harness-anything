// harness-test-tier: fast
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { prefersReducedMotion } from "motion/react";
import { OverviewView } from "../src/renderer/views/OverviewView.tsx";
import {
  decisionRows,
  followUpRows,
  watchedWorks,
  workRows,
  reviewRows,
  reviewCounts,
} from "../src/renderer/views/overview-model.ts";
import { AppMotionConfig } from "../src/renderer/motion-config.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { AgendaSuccess } from "../src/renderer/api-client.ts";
import type { AgentRuntimeOverviewResult } from "@harness-anything/daemon/protocol";
import type { AgendaAwaitsRow, TaskWipRead, WorkIndexRead, WorkspaceSummaryRead } from "../src/api/renderer-dto.ts";
import type { RuntimeHealth } from "../src/renderer/model/runtime-health.ts";

/**
 * 总览(2026-10-04 注意力优先重构)的行为面:首块只列真实待人事项并给真实动作;主区
 * 关注的工作(置顶优先,零置顶回退活跃工作);WIP/评审执行/跟进返工/置顶承诺收成紧凑
 * 下钻入口且列表可达;系统状态弱化、异常(daemon/CI/投影)提升。旧九区瀑布板与
 * overview-layout 已删除,布局断言不再适用;注意力派生的纯函数另测。
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
  // 测试不接 daemon:自持读面走确定性失败(error 态),总览按「无数据」渲染。
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

const HEALTH_DOWN: RuntimeHealth = {
  ...HEALTH,
  daemon: { state: "unresponsive", observedAgeSec: 90, uptimeMs: 1000 },
};

const SUMMARY = {
  schema: "daemon.workspace-summary/v1",
  ok: true,
  status: "ready",
  tasks: {
    lastChangedAt: null,
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
  sourceRef: "task/task_w1",
  title: `提案 ${relationId}`,
  status: "active",
  personId: "person_me",
  askKind: "question",
  question: "接口要不要兼容旧字段?",
  askedAt: AT,
  askedBy: "person_worker",
});

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
      lastActivityAt: "2026-09-28T00:00:00.000Z",
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
      lastActivityAt: "2026-09-20T00:00:00.000Z",
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

const WORKS_EMPTY: WorkIndexRead = { ...WORKS, works: [] };

const TITLES = new Map([
  ["task/task_w1", "代码质量长期检验"],
  ["task/task_m1", "总览首块的成员任务"],
  ["task/task_other", "不属于关注工作的任务"],
]);

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
            onUnpin: noop,
            ...props,
          }),
        ),
      ),
    ),
  );
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

const unmount = () => act(() => root?.unmount());

describe("总览:顶部「需要你处理」紧凑决策带", () => {
  it("只列真实待人事项,并区分出不冒充需要用户的四类", () => {
    const read = agenda({
      answeredForYou: [
        {
          relationId: "follow",
          sourceRef: "task/task_w1",
          title: "已答复的跟进项",
          status: "active",
          personId: "person_worker",
          askKind: "question",
          question: "下一步?",
          answer: "继续",
          answeredAt: AT,
          answeredBy: "答复人甲",
        },
      ],
      awaitingRework: [
        {
          taskId: "task_rew",
          title: "返工中的任务",
          work: { taskId: "task_w1", title: "代码质量长期检验" },
          status: "active",
          pinned: false,
          updatedAt: AT,
          leaseExecutionId: null,
          activeExecutionIds: [],
          blockingAssessment: { state: "clear", blockers: [], warnings: [] },
        },
      ],
      attentionItems: [
        ...agenda().attentionItems,
        {
          ref: "relation/follow",
          title: "已答复的跟进项",
          kind: "answered",
          region: "mine",
          workTaskId: "task_w1",
          attention: { score: 30, reasons: [] },
        },
        {
          ref: "task/task_rew",
          title: "返工中的任务",
          kind: "rework",
          region: "mine",
          workTaskId: "task_w1",
          attention: { score: 70, reasons: [] },
        },
      ],
    });
    const container = mount({ agenda: read });
    const decisions = container.querySelector('[data-testid="overview-decisions-band"]')!;
    expect(textOf(decisions)).toContain("边缘 RBAC 设计裁决");
    expect(textOf(decisions)).toContain("是否冻结旧投影字段");
    // 四类不进决策带:待初审是 owning CEO 的机器双闸,待跟进/返工/阻塞同样不冒充需要用户。
    expect(textOf(decisions)).not.toContain("总览重构的提交");
    expect(textOf(decisions)).not.toContain("已答复的跟进项");
    expect(textOf(decisions)).not.toContain("返工中的任务");
    expect(textOf(decisions)).not.toContain("被阻塞的成员任务");
    unmount();
  });

  it("每条说明问题、受影响工作与推荐(未提供不造假)", () => {
    const container = mount();
    const decisions = container.querySelector('[data-testid="overview-decisions-band"]')!;
    // 问题:awaits 的问句原话。
    expect(textOf(decisions)).toContain("接口要不要兼容旧字段?");
    // 受影响工作:工作索引的标题。
    expect(textOf(decisions)).toContain("代码质量长期检验");
    // 决策行如实写「未归属工作」;两类各带一条「推荐:未提供」。
    expect(textOf(decisions)).toContain("未归属工作");
    expect(textOf(decisions).split("推荐:未提供").length - 1).toBe(2);
    unmount();
  });

  it("动作接真实落点:答复开面板,裁决走实体导航,待初审在跟进入口给收口落点", () => {
    const onNavigateEntity = vi.fn();
    const container = mount({ onNavigateEntity });
    const decisions = container.querySelector('[data-testid="overview-decisions-band"]')!;
    const answer = [...decisions.querySelectorAll("button")].find((button) => textOf(button) === "答复");
    expect(answer).toBeDefined();
    act(() => answer!.click());
    expect(document.body.querySelector('[data-testid="awaits-answer-panel"]')).not.toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.body.querySelector('[data-testid="awaits-answer-panel"]')).toBeNull();
    const adjudicate = [...decisions.querySelectorAll("button")].find((button) => textOf(button) === "去裁决");
    act(() => adjudicate!.click());
    expect(onNavigateEntity).toHaveBeenCalledWith("decision/dec_1");
    // 待初审(execution)住「跟进与返工」:放大层首行即它,详情给「打开收口」的真实落点。
    act(() => (container.querySelector('[data-testid="overview-drill-followups"]') as HTMLButtonElement).click());
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(textOf(dialog)).toContain("总览重构的提交");
    expect(textOf(dialog)).toContain("待初审");
    const closeout = [...dialog.querySelectorAll("button")].find((button) => textOf(button) === "打开收口");
    act(() => closeout!.click());
    expect(onNavigateEntity).toHaveBeenCalledWith("taskreview/task_m1");
    unmount();
  });

  it("默认只铺三条,其余一键展开;展开可收起", () => {
    const extraDecisions = Array.from({ length: 4 }, (_, index) => ({
      decisionId: `dec_more_${index}`,
      title: `追加决策 ${index}`,
      riskTier: "low" as const,
      urgency: "low" as const,
      proposedAt: AT,
    }));
    const read = agenda({
      awaitingDecision: [...agenda().awaitingDecision, ...extraDecisions],
      attentionItems: [
        ...agenda().attentionItems,
        ...extraDecisions.map(({ decisionId }, index) => ({
          ref: `decision/${decisionId}`,
          title: `追加决策 ${index}`,
          kind: "decision",
          region: "mine",
          workTaskId: null,
          attention: { score: 10 * (4 - index), reasons: [] },
        })),
      ],
    });
    const container = mount({ agenda: read });
    const band = container.querySelector('[data-testid="overview-decisions-band"]')!;
    expect(band.querySelectorAll("[data-decision]")).toHaveLength(3);
    expect(band.querySelector('[data-testid="overview-decisions-expand"]')).not.toBeNull();
    expect(textOf(band)).toContain("还有 3 项");
    act(() => (band.querySelector('[data-testid="overview-decisions-expand"]') as HTMLButtonElement).click());
    expect(band.querySelectorAll("[data-decision]")).toHaveLength(6);
    expect(textOf(band)).toContain("追加决策 3");
    act(() => (band.querySelector('[data-testid="overview-decisions-collapse"]') as HTMLButtonElement).click());
    expect(band.querySelectorAll("[data-decision]")).toHaveLength(3);
    unmount();
  });

  it("空态是正向信息:没有等你处理的事项", () => {
    const container = mount({
      agenda: agenda({
        attentionItems: [
          {
            ref: "task/task_blk",
            title: "被阻塞的成员任务",
            kind: "blocked",
            region: "stuck",
            workTaskId: "task_w2",
            attention: { score: 48, reasons: [] },
          },
        ],
        awaitingYou: [],
        awaitingAdjudication: [],
        awaitingDecision: [],
      }),
    });
    const decisions = container.querySelector('[data-testid="overview-decisions-band"]')!;
    expect(textOf(decisions)).toContain("没有等你处理的事项");
    expect(textOf(decisions)).not.toContain("边缘 RBAC");
    unmount();
  });
});

describe("总览:主区「关注的工作」", () => {
  it("置顶的非终态工作优先,来源如实标示;已收尾的置顶工作只计数", () => {
    const container = mount({
      agenda: agenda({
        pinnedEntities: [
          { ref: "task/task_w1", kind: "task", title: "代码质量长期检验", status: "active", pinnedAt: AT },
          { ref: "task/task_w_done", kind: "task", title: "已收尾的工作", status: "done", pinnedAt: AT },
        ],
      }),
    });
    const works = container.querySelector('[data-testid="overview-region-works"]')!;
    expect(textOf(works)).toContain("置顶 1 项");
    expect(textOf(works)).toContain("代码质量长期检验");
    expect(textOf(works)).toContain("1 项置顶工作已收尾");
    // 置顶模式下列活跃的置顶工作,不把全部工作铺开。
    expect(textOf(works)).not.toContain("网关读面加缓存");
    unmount();
  });

  it("零置顶回退活跃工作并给选择入口,不取最旧冒充承诺", () => {
    const onOpenWorks = vi.fn();
    const container = mount({ onOpenWorks });
    const works = container.querySelector('[data-testid="overview-region-works"]')!;
    expect(textOf(works)).toContain("没有置顶的工作");
    expect(textOf(works)).toContain("去工作页选择关注");
    // 活跃工作都在(注意力序:w1 有 mine 项在前),已收尾的不进列表。
    const cards = [...works.querySelectorAll("[data-work-card]")].map((card) => card.getAttribute("data-work-card"));
    expect(cards).toEqual(["task_w1", "task_w2"]);
    expect(textOf(works)).not.toContain("已收尾的工作");
    const pick = [...works.querySelectorAll("button")].find((button) => textOf(button).includes("去工作页选择关注"));
    act(() => pick!.click());
    expect(onOpenWorks).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("工作卡给出阶段/交付/还差/卡点/处理者,完成度只是辅助", async () => {
    vi.stubGlobal("harness", {
      request: (method: string) =>
        method === "getAgentRuntimeOverview"
          ? Promise.resolve({
              ok: true,
              status: "ready",
              installations: [],
              instances: [],
              sessions: [
                {
                  runtimeSessionId: "rs_1",
                  kindId: "codex",
                  liveness: "live",
                  definitionSnapshot: { model: "glm-5.3" },
                  associations: [{ taskId: "task_m1" }],
                  activity: { lastObservedAt: AT },
                },
              ],
              watermark: 7,
              sourceRevision: 7,
            } as unknown as AgentRuntimeOverviewResult)
          : Promise.reject(new Error("no bridge in test")),
    });
    const onOpenTask = vi.fn();
    const container = mount({ onOpenTask });
    await flushUntil(
      () => container.querySelector("[data-work-card='task_w1']")?.textContent?.includes("codex") === true,
    );
    const card = container.querySelector("[data-work-card='task_w1']")!;
    const text = textOf(card);
    // 阶段计数来自工作索引;子任务 done 计数如实称「子任务完成」,不冒充可用交付;
    // 完成度百分比只是行尾辅助。
    expect(text).toContain("子任务完成 2/3");
    expect(text).toContain("未完成 1");
    expect(text).toMatch(/\d+%/);
    // 可用交付与阶段摘要:投影没有就如实说明,不编造。
    expect(textOf(container.querySelector('[data-testid="overview-region-works"]')!)).toContain(
      "可用交付与阶段摘要当前投影未提供",
    );
    // 卡点行点名该工作上的注意力项,可点。
    expect(text).toContain("卡点");
    expect(text).toContain("边缘 RBAC 设计裁决");
    // 处理者来自 runtime overview 的 live 会话(who = kind · model)。
    expect(text).toContain("codex · glm-5.3");
    act(() => (card.querySelector("button") as HTMLButtonElement).click());
    expect(onOpenTask).toHaveBeenCalledWith("task_w1");
    unmount();
    // 还原默认桥:后续用例的 runtime 读面回到确定性失败。
    vi.stubGlobal("harness", { request: () => Promise.reject(new Error("no bridge in test")) });
  });

  it("在飞但无 agent 的工作卡如实标注", () => {
    const container = mount();
    const card = container.querySelector("[data-work-card='task_w1']")!;
    expect(textOf(card)).toContain("在飞任务无 agent 在跑");
    unmount();
  });

  it("近期变化限关注工作:别人的任务不进工作卡", async () => {
    const item = (patch: Record<string, unknown>) => ({
      eventId: `evt-${Math.random().toString(36).slice(2, 8)}`,
      occurredAt: "2026-09-29T10:00:00.000Z",
      workspaceRevision: 1,
      type: "execution_started",
      taskId: "task_m1",
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
              connectionId: "local",
              mode: "local",
              kind: "events",
              direction: "history",
              status: "ready",
              items: [
                item({ type: "execution_started", taskId: "task_m1", occurredAt: "2026-09-29T10:05:00.000Z" }),
                item({ type: "execution_submitted", taskId: "task_m1", occurredAt: "2026-09-29T10:20:00.000Z" }),
                item({ type: "task_completed", taskId: "task_other", occurredAt: "2026-09-29T10:40:00.000Z" }),
              ],
              historyCursor: null,
              liveCursor: null,
              sourceCursor: null,
              done: true,
            })
          : Promise.reject(new Error("no bridge in test")),
    });
    const container = mount();
    await flushUntil(
      () => container.querySelector("[data-work-card='task_w1']")?.textContent?.includes("最近") === true,
    );
    const card = container.querySelector("[data-work-card='task_w1']")!;
    expect(textOf(card)).toContain("最近");
    expect(textOf(card)).toContain("开始");
    expect(textOf(card)).toContain("提交评审");
    // 不属于任何关注工作的任务事件不进总览。
    expect(textOf(card)).not.toContain("不属于关注工作的任务");
    unmount();
    vi.stubGlobal("harness", { request: () => Promise.reject(new Error("no bridge in test")) });
  });

  it("没有任何工作时给「去工作页」入口而不是空壳", () => {
    const onOpenWorks = vi.fn();
    const container = mount({ works: WORKS_EMPTY, onOpenWorks });
    const works = container.querySelector('[data-testid="overview-region-works"]')!;
    expect(textOf(works)).toContain("没有可关注的工作");
    const open = [...works.querySelectorAll("button")].find((button) => textOf(button).includes("去工作页"));
    act(() => open!.click());
    expect(onOpenWorks).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe("总览:执行与下钻", () => {
  type WipEntry = TaskWipRead["counted"][number];

  function wipSnapshot(counted: readonly WipEntry[], limit = 30): TaskWipRead {
    return {
      ok: true,
      limit,
      limitLabel: "settings.tasks.wipLimit",
      counted: [...counted],
      roots: [
        { taskId: "task_root_declared", reason: "declared", directChildCount: 5, threshold: 3 },
        { taskId: "task_root_derived", reason: "derived", directChildCount: 4, threshold: 3 },
      ],
      threshold: 3,
    };
  }

  const defaultCounted = (): WipEntry[] =>
    ["active", "submitted", "in_review", "blocked"].flatMap(
      (status, group) =>
        Array.from({ length: group + 1 }, (_, n) => ({
          taskId: `task_wip${status}${n}`,
          status,
          title: `占位任务 ${status}${n}`,
        })) as WipEntry[],
    );

  /** 只给 repo.tasks.wip 注入 fixture,其余桥方法保持确定性失败;返回还原函数。 */
  function stubBridge(handlers: Record<string, () => unknown>): () => void {
    const previous = (globalThis as { harness?: unknown }).harness;
    vi.stubGlobal("harness", {
      request: (method: string) =>
        method in handlers ? Promise.resolve(handlers[method]!()) : Promise.reject(new Error("no bridge in test")),
    });
    return () => vi.stubGlobal("harness", previous);
  }

  it("WIP 收成紧凑芯片:占用在入口,名单在放大层且全量可达", async () => {
    const snapshot = wipSnapshot(defaultCounted(), 10);
    const restore = stubBridge({ getTaskWip: () => snapshot });
    const container = mount();
    await flushUntil(
      () => container.querySelector('[data-testid="overview-region-drill"]')?.textContent?.includes("10/10") === true,
    );
    const drill = container.querySelector('[data-testid="overview-region-drill"]')!;
    // 工具区只有入口芯片:30 条名单不在总览首屏铺开;满额以警示点标在芯片上。
    expect(textOf(drill)).toContain("进行中的任务(WIP)");
    const wipEntry = drill.querySelector('[data-testid="overview-drill-wip"]')!;
    expect(textOf(wipEntry)).toContain("10/10");
    expect(wipEntry.hasAttribute("data-drill-alert")).toBe(true);
    expect(drill.querySelectorAll("[data-dense-row][data-testid='overview-task-wip-list']")).toHaveLength(0);
    act(() => (wipEntry as HTMLElement).click());
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.querySelectorAll("[data-focus-list] [data-dense-row]")).toHaveLength(10);
    expect(dialog!.querySelector("[data-testid='overview-task-wip-search']")).not.toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    unmount();
    restore();
  });

  it("评审执行入口:计数与分组明细分明,放大层给收口/决策落点", () => {
    const read = agenda({
      underReview: [
        {
          taskId: "task_rev",
          title: "评审中的任务",
          work: null,
          pinned: false,
          executionId: "exec_rev",
          submittedAt: AT,
          blockingAssessment: { state: "clear", blockers: [], warnings: [] },
        },
      ],
      awaitingDecisionReview: [
        { decisionId: "dec_nr", title: "待派审的决策", riskTier: "high", urgency: "low", proposedAt: AT },
      ],
      decisionReviewInProgress: [],
    });
    const onNavigateEntity = vi.fn();
    const container = mount({ agenda: read, onNavigateEntity });
    const drill = container.querySelector('[data-testid="overview-region-drill"]')!;
    const reviewEntry = drill.querySelector('[data-testid="overview-drill-review"]')!;
    expect(textOf(reviewEntry)).toContain("评审执行");
    expect(textOf(reviewEntry)).toContain("2");
    // 分组明细挂在芯片悬停说明上,不占条面。
    expect(reviewEntry.getAttribute("title")).toContain("任务评审中 1");
    expect(reviewEntry.getAttribute("title")).toContain("决策待派审 1");
    act(() => (reviewEntry as HTMLElement).click());
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(textOf(dialog)).toContain("评审中的任务");
    const closeout = [...dialog.querySelectorAll("button")].find((button) => textOf(button) === "打开收口");
    act(() => closeout!.click());
    expect(onNavigateEntity).toHaveBeenCalledWith("taskreview/task_rev");
    unmount();
  });

  it("跟进与返工入口:五类分开计数,放大层不亮红不冒充需要用户", () => {
    const read = agenda({
      answeredForYou: [
        {
          relationId: "follow",
          sourceRef: "task/task_w1",
          title: "已答复的跟进项",
          status: "active",
          personId: "person_worker",
          askKind: "question",
          question: "下一步?",
          answer: "继续",
          answeredAt: AT,
          answeredBy: "答复人甲",
        },
      ],
      attentionItems: [
        ...agenda().attentionItems,
        {
          ref: "relation/follow",
          title: "已答复的跟进项",
          kind: "answered",
          region: "mine",
          workTaskId: "task_w1",
          attention: { score: 30, reasons: [] },
        },
      ],
    });
    const container = mount({ agenda: read });
    const drill = container.querySelector('[data-testid="overview-region-drill"]')!;
    const followEntry = drill.querySelector('[data-testid="overview-drill-followups"]')!;
    expect(textOf(followEntry)).toContain("跟进与返工");
    const breakdown = followEntry.getAttribute("title")!;
    expect(breakdown).toContain("待跟进 1");
    expect(breakdown).toContain("待初审 1");
    expect(breakdown).toContain("阻塞 1");
    expect(breakdown).toContain("停滞 1");
    act(() => (followEntry as HTMLElement).click());
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(textOf(dialog)).toContain("已答复的跟进项");
    expect(textOf(dialog)).toContain("被阻塞的成员任务");
    expect(textOf(dialog)).toContain("总览重构的提交");
    // 首行是分数最高的待初审行;点选已答复行后详情给答复原文与答复人。
    const answeredRow = [...dialog.querySelectorAll("[data-focus-list] [data-dense-row]")].find((row) =>
      textOf(row).includes("已答复的跟进项"),
    );
    act(() => (answeredRow as HTMLElement).click());
    expect(textOf(dialog)).toContain("已答复:继续");
    // 不冒充需要用户:整层没有红档(bad)状态标签。
    expect(dialog!.querySelectorAll('[data-status-tone="bad"]')).toHaveLength(0);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    unmount();
  });

  it("置顶承诺入口:可派在前,行上就地取消置顶接真实 pin 通道", () => {
    const onUnpin = vi.fn();
    const container = mount({
      onUnpin,
      agenda: agenda({
        pinnedEntities: [
          { ref: "task/task_pin_go", kind: "task", title: "可派的置顶承诺", status: "planned", pinnedAt: AT },
          { ref: "task/task_pin_active", kind: "task", title: "在跑的置顶任务", status: "active", pinnedAt: AT },
        ],
        dispatchable: [
          {
            taskId: "task_pin_go",
            title: "可派的置顶承诺",
            work: null,
            status: "planned",
            pinned: true,
            updatedAt: AT,
            leaseExecutionId: null,
            activeExecutionIds: [],
            blockingAssessment: { state: "clear", blockers: [], warnings: [] },
          },
        ],
      }),
    });
    const drill = container.querySelector('[data-testid="overview-region-drill"]')!;
    expect(textOf(drill)).toContain("置顶承诺");
    const pinnedEntry = drill.querySelector('[data-testid="overview-drill-pinned"]')!;
    act(() => (pinnedEntry as HTMLElement).click());
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const rows = [...dialog.querySelectorAll("[data-focus-list] [data-dense-row]")].map((row) => textOf(row));
    expect(rows[0]).toContain("可派的置顶承诺");
    expect(rows[1]).toContain("在跑的置顶任务");
    const unpin = dialog.querySelector<HTMLButtonElement>('[data-testid="overview-unpin-task_pin_active"]')!;
    act(() => unpin.click());
    expect(onUnpin).toHaveBeenCalledWith("task_pin_active");
    unmount();
  });

  it("全部工作/全部任务/会话入口接真实回调", () => {
    const onOpenWorks = vi.fn();
    const onOpenTasks = vi.fn();
    const onOpenSessions = vi.fn();
    const container = mount({ onOpenWorks, onOpenTasks, onOpenSessions });
    const drill = container.querySelector('[data-testid="overview-region-drill"]')!;
    act(() =>
      ([...drill.querySelectorAll("button")].find((b) => textOf(b) === "全部工作") as HTMLButtonElement).click(),
    );
    act(() =>
      ([...drill.querySelectorAll("button")].find((b) => textOf(b) === "全部任务") as HTMLButtonElement).click(),
    );
    act(() =>
      ([...drill.querySelectorAll("button")].find((b) => textOf(b) === "查看会话") as HTMLButtonElement).click(),
    );
    expect(onOpenWorks).toHaveBeenCalledTimes(1);
    expect(onOpenTasks).toHaveBeenCalledTimes(1);
    expect(onOpenSessions).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe("总览:系统状态弱化与异常提升", () => {
  it("正常状态收成一行小字,不再铺状态卡片", async () => {
    // CI 读面给一个绿窗:安静小字只在真实读到「绿」后出现(读不到时是「未知」降级提示)。
    const previous = (globalThis as { harness?: unknown }).harness;
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
                  runId: "run-green",
                  sha: "850840cdffffffffffffffffffffffffffffffff",
                  branch: "main",
                  prNumber: null,
                  job: "integration-shard-6",
                  wallclockMs: 600000,
                  runner: "ubuntu",
                  occurredAt: "2026-09-29T07:18:00.000Z",
                  pass: true,
                  testCount: 10,
                  gateCount: 2,
                },
              ],
              watermark: 7,
              sourceRevision: 7,
            })
          : Promise.reject(new Error("no bridge in test")),
    });
    const container = mount();
    await flushUntil(
      () => container.querySelector('[data-testid="overview-topbar"]')?.textContent?.includes("daemon 正常") === true,
    );
    const topbar = container.querySelector('[data-testid="overview-topbar"]')!;
    expect(textOf(topbar)).toContain("daemon 正常 · main CI 绿");
    expect(textOf(topbar)).toContain("进行中 2");
    expect(topbar.querySelector('[data-testid="overview-ci-alert"]')).toBeNull();
    unmount();
    vi.stubGlobal("harness", previous);
  });

  it("daemon 无响应与投影落后升成显眼状态点;CI 红可点开失败名单", async () => {
    const restore = (globalThis as { harness?: unknown }).harness;
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
              ],
              watermark: 7,
              sourceRevision: 7,
            })
          : Promise.reject(new Error("no bridge in test")),
    });
    const container = mount({
      health: {
        ...HEALTH_DOWN,
        projection: { lag: 3, status: "ready" },
      },
    });
    await flushUntil(() => container.querySelector('[data-testid="overview-ci-alert"]') !== null);
    const topbar = container.querySelector('[data-testid="overview-topbar"]')!;
    expect(textOf(topbar)).toContain("daemon 无响应");
    expect(textOf(topbar)).toContain("投影落后 3");
    expect(textOf(topbar)).toContain("main CI 红 · 1 个 job 失败");
    // 正常小字被异常替代,不再同时出现。
    expect(textOf(topbar)).not.toContain("daemon 正常");
    act(() => (container.querySelector('[data-testid="overview-ci-alert"]') as HTMLButtonElement).click());
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(textOf(dialog)).toContain("integration-shard-6");
    unmount();
    vi.stubGlobal("harness", restore);
  });

  it("全局搜索入口接真实动作(打开 ⌘K 命令面板)", () => {
    const onOpenSearch = vi.fn();
    const container = mount({ onOpenSearch });
    act(() => (container.querySelector('[data-testid="overview-global-search"]') as HTMLButtonElement).click());
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe("总览派生(纯函数)", () => {
  it("decisionRows 只收真实待人两类,followUpRows 收其余五类(含 owning CEO 的待初审)", () => {
    const read = agenda({
      answeredForYou: [
        {
          relationId: "follow",
          sourceRef: "task/task_w1",
          title: "已答复的跟进项",
          status: "active",
          personId: "person_worker",
          askKind: "question",
          question: "下一步?",
          answer: "继续",
          answeredAt: AT,
          answeredBy: "答复人甲",
        },
      ],
      attentionItems: [
        ...agenda().attentionItems,
        {
          ref: "relation/follow",
          title: "已答复的跟进项",
          kind: "answered",
          region: "mine",
          workTaskId: "task_w1",
          attention: { score: 30, reasons: [] },
        },
      ],
    });
    expect(
      decisionRows(read)
        .map(({ kind }) => kind)
        .sort(),
    ).toEqual(["awaiting-you", "decision"]);
    expect(
      followUpRows(read)
        .map(({ kind }) => kind)
        .sort(),
    ).toEqual(["adjudication", "answered", "blocked", "stalled"]);
  });

  it("watchedWorks:置顶优先、终态置顶只计数;零置顶回退全部活跃工作", () => {
    const base = agenda();
    const pinned = watchedWorks(WORKS, {
      ...base,
      pinnedEntities: [
        { ref: "task/task_w1", kind: "task", title: "代码质量长期检验", status: "active", pinnedAt: AT },
      ],
    });
    expect(pinned.watched.map(({ work }) => work.taskId)).toEqual(["task_w1"]);
    expect(pinned.watched.every(({ source }) => source === "pinned")).toBe(true);
    const closed = watchedWorks(WORKS, {
      ...base,
      pinnedEntities: [{ ref: "task/task_w_done", kind: "task", title: "已收尾的工作", status: "done", pinnedAt: AT }],
    });
    expect(closed.pinnedClosed).toBe(1);
    expect(closed.watched.map(({ work }) => work.taskId)).toEqual(["task_w1", "task_w2"]);
    expect(closed.watched.every(({ source }) => source === "active")).toBe(true);
  });

  it("工作行排序:已收尾沉底;注意力优先于最近活动", () => {
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

  it("评审与合并的行分组保持可分辨:待派审不算已在评审也不算待点头", () => {
    const rows = reviewRows(
      agenda({
        awaitingDecisionReview: [
          {
            decisionId: "dec_needs_review",
            title: "Needs an independent review",
            riskTier: "high",
            urgency: "high",
            proposedAt: AT,
          },
        ],
        decisionReviewInProgress: [],
        awaitingDecision: [],
      }),
    );
    const decision = rows.find(({ decisionId }) => decisionId === "dec_needs_review");
    expect(decision?.group).toBe("decisionNeedsReview");
    expect(reviewCounts(rows).decisionNeedsReview).toBe(1);
    expect(reviewCounts(rows).decisionReviewing).toBe(0);
    expect(reviewCounts(rows).decisionPending).toBe(0);
  });
});
describe("总览紧凑协作入口(task_1bafbf09 返工)", () => {
  it("非纯本地仓给真实摘要入口,点击落到协作页;纯本地(null)不渲染入口", () => {
    const opened: string[] = [];
    const center = mount({
      collaboration: { total: 8, executing: 2 },
      onOpenCollaboration: () => opened.push("collaboration"),
    });
    const entry = center.querySelector<HTMLButtonElement>('[data-testid="overview-collaboration-entry"]');
    expect(entry).not.toBeNull();
    expect(entry!.textContent).toContain("8");
    expect(entry!.textContent).toContain("2");
    act(() => entry!.click());
    expect(opened).toEqual(["collaboration"]);
    act(() => root?.unmount());

    const local = mount({ collaboration: null });
    expect(local.querySelector('[data-testid="overview-collaboration-entry"]')).toBeNull();
    act(() => root?.unmount());
  });
});
