// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CadenceView } from "../src/renderer/views/CadenceView.tsx";
import { harnessClient, type AgendaSuccess } from "../src/renderer/api-client.ts";
import { agentRuntimeClient } from "../src/renderer/agent-runtime-client.ts";
import type { ObserveTailRead } from "../src/api/renderer-dto.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { AgentRuntimeSessionGroupDto, AgentRuntimeSessionGroupsResult } from "@harness-anything/daemon/protocol";

/**
 * 研发态势视图的装配判据(happy-dom):
 *  - observe.tail events 页(history 方向,单页 done)进入 HUD/音轨/摩擦/产出;
 *  - 音轨外行节拍指标(历时徽章、首轮直通/返工);
 *  - 外壳是区域板(标准 §2.1):堵点、产出、摩擦、任务节奏四块都是 Region,任务节奏在最右一列,
 *    窗口化列表的滚动元素仍是音轨自己的那个 div;
 *  - 音轨点击原地展开:阶段耗时漏斗(瓶颈占比) + 微型事件链(fact statement 原地可读),
 *    「进入详情」外链与实体跳转走 onNavigateEntity(task/<id>、decision/<id>);
 *  - `unavailable`(远端 edge 无事件流)显式横幅,不冒充空驾驶舱;
 *  - 议程缺位时堵点卡片如实显示读取中,不冒充「无堵点」;
 *  - 执行概况页签:一条 sessionGroups 有界读面(groupBy=task,无成员级 status 筛选)分
 *    正在执行/最近异常执行/最近运行结果三区;done 任务的失败行带「任务已完成」声明;
 *    runningCount>0 但最新一轮已结束不指名执行人;pending/error 不冒充空态;截断与
 *    显示条数如实标注;窗口切换重读且 since 口径一致。
 */

const REPO_ID = "cadence-probe",
  NOW = "2026-09-20T12:00:00.000Z";

function cadenceTask(overrides: Partial<TaskRow> & { readonly taskId: string }): TaskRow {
  return {
    title: overrides.taskId,
    projectId: REPO_ID,
    coordinationStatus: "active",
    rawStatus: "active/implementation",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "kernel/task-lifecycle/v1",
    origin: "native",
    source: "local-document",
    lastKnownAt: NOW,
    gates: [],
    board: projectedTaskFields("active").board,
    visibility: projectedTaskFields("active").visibility,
    capabilities: projectedTaskFields("active").capabilities,
    risk: projectedTaskFields("active").risk,
    phase: projectedTaskFields("active").phase,
    docs: [],
    ...overrides,
  } as TaskRow;
}

function eventItem(input: {
  readonly id: string;
  readonly type: string;
  readonly revision: number;
  readonly taskId?: string;
  readonly factId?: string;
  readonly at?: string;
  readonly payload?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    schema: "task-event/v1",
    eventId: input.id,
    workspaceRevision: input.revision,
    opId: "op-cadence-view",
    type: input.type,
    actor: { principal: { personId: "probe" }, executor: { kind: "agent", id: "runtime-session:runtime_probe" } },
    source: { channel: "cli" },
    occurredAt: input.at ?? NOW,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.factId ? { factId: input.factId } : {}),
    ...(input.payload ? { payload: input.payload } : {}),
  };
}

function historyPage(items: readonly Record<string, unknown>[]): ObserveTailRead {
  const top = items.length === 0 ? 0 : Math.max(...items.map((item) => Number(item.workspaceRevision)));
  return {
    schema: "daemon.observe-tail/v3",
    ok: true,
    repoId: REPO_ID,
    mode: "local",
    kind: "events",
    direction: "history",
    status: "ready",
    items: items as never,
    historyCursor: null,
    liveCursor: { kind: "events", revision: top },
    sourceCursor: { kind: "events", revision: top },
    done: true,
  };
}

const AGENDA: AgendaSuccess = {
  ok: true,
  status: "ready",
  pinnedEntities: [],
  pinnedEntityOverflow: 0,
  inFlight: [],
  awaitingRework: [],
  awaitingAdjudication: [
    {
      taskId: "task_live",
      title: "在飞任务",
      pinned: false,
      executionId: "exec_1",
      submittedAt: NOW,
      blockingAssessment: { state: "clear", contributors: [], warnings: [] },
    },
  ],
  underReview: [],
  awaitingYou: [],
  answeredForYou: [],
  decisionReviewInProgress: [],
  awaitingDecisionReview: [],
  awaitingDecision: [
    {
      decisionId: "dec_probe",
      title: "探针决策:切换读取形态",
      riskTier: "medium",
      urgency: "high",
      proposedAt: NOW,
    },
  ],
  waitingOnOthers: [],
  dispatchable: [],
  summary: "",
  page: { sourceLimit: 100, cursor: null, nextCursor: null },
  watermark: 12,
  sourceRevision: 3,
};

setActiveLocale("zh-CN");

const mounted: { root: Root; container: HTMLElement }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());

interface Mounted {
  readonly container: HTMLElement;
  readonly navigate: ReturnType<typeof vi.fn>;
}

/** 执行概况页签的一条 sessionGroups 有界读面(groupBy=task,无成员级 status 筛选)。 */
function groupsResult(
  groups: readonly AgentRuntimeSessionGroupDto[],
  totals: { groups: number; sessions: number },
  truncated = false,
): AgentRuntimeSessionGroupsResult {
  return { ok: true, status: "ready", groups, totals, truncated, watermark: 12, sourceRevision: 3 };
}

function fleetGroup(
  overrides: Partial<AgentRuntimeSessionGroupDto> & { readonly key: string },
): AgentRuntimeSessionGroupDto {
  const kind = overrides.kind ?? (overrides.taskId !== undefined ? "task" : "unattributed");
  return {
    key: overrides.key,
    kind,
    label: overrides.label ?? overrides.key,
    ...(overrides.taskId !== undefined ? { taskId: overrides.taskId } : {}),
    latestStatus: "succeeded",
    latestActivityAt: NOW,
    runningCount: 0,
    sessionCount: 1,
    roundCount: 1,
    latestRound: null,
    ...overrides,
  };
}

async function flushEffects() {
  for (let index = 0; index < 3; index++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountCadence(options: {
  readonly page: ObserveTailRead;
  readonly agenda?: AgendaSuccess;
  readonly fleet?: AgentRuntimeSessionGroupsResult;
  readonly fleetError?: Error;
  readonly tasks?: readonly TaskRow[];
}): Promise<Mounted> {
  const navigate = vi.fn();
  vi.spyOn(harnessClient, "tailObservability").mockImplementation(async () => options.page);
  vi.spyOn(agentRuntimeClient, "sessionGroups").mockImplementation(async () => {
    if (options.fleetError !== undefined) throw options.fleetError;
    return options.fleet ?? groupsResult([], { groups: 0, sessions: 0 });
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container),
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(CadenceView, {
          repoId: REPO_ID,
          projectName: "cadence-probe",
          tasks: options.tasks ?? [
            cadenceTask({ taskId: "task_live", title: "在飞任务" }),
            cadenceTask({ taskId: "task_done", title: "已收口任务", coordinationStatus: "done" }),
          ],
          agenda: options.agenda,
          decisions: [
            {
              decisionId: "dec_probe",
              title: "探针决策",
              state: "proposed",
              riskTier: "medium",
              urgency: "high",
              proposedAt: NOW,
            },
            {
              decisionId: "dec_standing",
              title: "常设决策",
              state: "in_effect",
              riskTier: "low",
              urgency: "low",
              proposedAt: NOW,
            },
          ],
          onNavigateEntity: navigate,
          onOpenPool: () => undefined,
        }),
      ),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { container, navigate };
}

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  vi.restoreAllMocks();
});

/** 切到执行概况页签并等 sessionGroups 读面结算。 */
async function openFleetTab(container: HTMLElement): Promise<void> {
  const fleetTab = [...container.querySelectorAll('[role="tab"]')].find((row) =>
    row.textContent?.includes("执行概况"),
  )!;
  await act(async () => fleetTab.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await flushEffects();
}

/** 行主点击面:带行尾动作时 DenseRow 的主面是内层无 testid 的 button,不带动作时是行本身。 */
function mainRowButton(scope: HTMLElement): HTMLElement {
  const button = [...scope.querySelectorAll('[data-testid="cadence-fleet-row"] button')].find(
    (candidate) => candidate.getAttribute("data-testid") === null,
  );
  expect(button).toBeInstanceOf(HTMLElement);
  return button as HTMLElement;
}

function textOf(container: HTMLElement, testId: string): string {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

describe("CadenceView", () => {
  it("renders the execution overview from one sessionGroups read with honest task claims", async () => {
    const { container, navigate } = await mountCadence({
      page: historyPage([]),
      fleet: groupsResult(
        [
          fleetGroup({
            key: "task_live",
            label: "在飞任务",
            taskId: "task_live",
            latestStatus: "running",
            runningCount: 1,
            latestRound: {
              runtimeSessionId: "runtime_running",
              dispatchId: null,
              agentName: "GLM-5.3 · 通用实现 Worker",
              instanceId: "zcode-glm-5-3",
              status: "running",
              classification: null,
              reason: null,
              startedAt: NOW,
            },
          }),
          fleetGroup({
            key: "task_done",
            label: "已收口但末轮失败",
            taskId: "task_done",
            latestStatus: "failed",
            latestRound: {
              runtimeSessionId: "runtime_failed",
              dispatchId: null,
              agentName: "Closeout · 独立评审 Reviewer",
              instanceId: "zcode-glm-5-3-flash",
              status: "failed",
              classification: null,
              reason: null,
              startedAt: "2026-09-20T10:00:00.000Z",
            },
          }),
          fleetGroup({
            key: "task_probe",
            label: "探针成功任务",
            taskId: "task_probe",
            latestStatus: "succeeded",
            latestActivityAt: "2026-09-20T09:00:00.000Z",
          }),
        ],
        { groups: 3, sessions: 7 },
      ),
    });
    await openFleetTab(container);
    // 一条读面:groupBy=task、无成员级 status 筛选、有界 limit;since=当前-24h(默认窗)。
    const read = agentRuntimeClient.sessionGroups as unknown as { mock: { calls: unknown[][] } };
    expect(read.mock.calls.length).toBeGreaterThan(0);
    for (const call of read.mock.calls) {
      expect(call[1]).toMatchObject({
        groupBy: "task",
        since: "2026-09-19T12:00:00.000Z",
        limit: 1000,
      });
      expect(call[1]).not.toHaveProperty("status");
    }
    // 三区各就各位:正在执行带真实执行人,异常行带「任务已完成」声明(不叫人处理)。
    expect(textOf(container, "cadence-fleet-executing")).toContain("在飞任务");
    expect(textOf(container, "cadence-fleet-executing")).toContain("GLM-5.3 · 通用实现 Worker");
    expect(textOf(container, "cadence-fleet-executing")).toContain("第 1 轮");
    expect(textOf(container, "cadence-fleet-anomaly")).toContain("已收口但末轮失败");
    expect(textOf(container, "cadence-fleet-anomaly")).toContain("任务已完成");
    expect(textOf(container, "cadence-fleet-anomaly")).toContain("已失败");
    expect(textOf(container, "cadence-fleet-results")).toContain("探针成功任务");
    expect(textOf(container, "cadence-fleet-results")).toContain("已成功");
    // 口径行:窗口 + 总数 + 已加载组数;不把已加载部分冒充全量。
    expect(textOf(container, "cadence-fleet-scope")).toContain("窗口 24小时");
    expect(textOf(container, "cadence-fleet-scope")).toContain("共 3 组 7 个会话");
    expect(textOf(container, "cadence-fleet-scope")).toContain("已加载 3 组");
    // 行点击落点:主点击(DenseRow 按钮面)进该任务会话组,行尾动作进任务详情(验收面)。
    const anomalyRegion = container.querySelector('[data-testid="cadence-fleet-anomaly"]')!;
    const anomalyRow = mainRowButton(anomalyRegion);
    await act(async () => anomalyRow.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(navigate).toHaveBeenCalledWith("tasksessions/task_done");
    const taskButton = [
      ...container.querySelectorAll('[data-testid="cadence-fleet-anomaly"] [data-testid="cadence-fleet-row-task"]'),
    ][0]!;
    await act(async () => taskButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(navigate).toHaveBeenCalledWith("task/task_done");
  });

  it("renders the HUD, rhythm track, friction and yield from one observe.tail history page", async () => {
    const { container } = await mountCadence({
      page: historyPage([
        eventItem({ id: "e1", type: "task_created", revision: 1, taskId: "task_live", at: "2026-09-20T01:00:00.000Z" }),
        eventItem({
          id: "e2",
          type: "execution_started",
          revision: 2,
          taskId: "task_live",
          at: "2026-09-20T02:00:00.000Z",
        }),
        eventItem({ id: "e3", type: "fact_recorded", revision: 3, taskId: "task_live", factId: "F-probe000", at: NOW }),
        eventItem({
          id: "e4",
          type: "completion_gate_verified",
          revision: 4,
          taskId: "task_live",
          payload: { witness: { gateId: "ci", result: "fail" } },
        }),
        eventItem({
          id: "e5",
          type: "review_recorded",
          revision: 5,
          taskId: "task_live",
          payload: { review: { verdict: "changes_requested" } },
        }),
        eventItem({ id: "e6", type: "task_created", revision: 6, taskId: "task_done", at: "2026-09-20T03:00:00.000Z" }),
        eventItem({
          id: "e7",
          type: "task_completed",
          revision: 7,
          taskId: "task_done",
          at: "2026-09-20T04:00:00.000Z",
        }),
      ]),
      agenda: AGENDA,
    });
    expect(textOf(container, "cadence-stream")).toContain("7");
    expect(textOf(container, "cadence-stream")).toContain("本地");
    expect(textOf(container, "cadence-stream")).toContain("已覆盖全部保留事件");
    // HUD:两行投影里在飞 1;今日收口 1;待人工 = 待裁 decision 1 + 待派审 execution 1。
    const hud = container.querySelector('[data-testid="cadence-hud"]');
    expect(hud?.textContent).toContain("在飞任务");
    expect(hud?.textContent).toContain("决策 1 · 执行裁决 1");
    // 音轨:两行任务都渲染(虚拟窗口 640px/64px 行高足够装下),摩擦徽标计数可见。
    const rows = [...container.querySelectorAll('[data-testid="cadence-rhythm-row"]')];
    expect(rows.length).toBe(2);
    expect(rows.some((row) => row.textContent?.includes("在飞任务"))).toBe(true);
    expect(rows.some((row) => row.textContent?.includes("摩擦 2"))).toBe(true);
    expect(rows.some((row) => row.textContent?.includes("立项"))).toBe(true);
    expect(rows.some((row) => row.textContent?.includes("门禁"))).toBe(true);
    // 外行节拍指标:历时时长徽章(在飞任务计到聚合时钟——墙钟,只断形如「历时 7h51m」;
    // 已收口任务计到收口事件,确定值 1h)与流转顺畅度(2 次返工 vs 首轮直通)。
    const liveRow = rows.find((row) => row.textContent?.includes("在飞任务")),
      doneRow = rows.find((row) => row.textContent?.includes("已收口任务"));
    expect(liveRow?.textContent).toMatch(/历时 \d+[hm]/);
    expect(doneRow?.textContent).toContain("历时 1h");
    expect(liveRow?.textContent).toContain("2 次返工/打回");
    expect(doneRow?.textContent).toContain("首轮直通");
    const frictionTasks = container.querySelector('[data-testid="cadence-friction-tasks"]');
    expect(frictionTasks).not.toBeNull();
    const yieldBody = container.querySelector('[data-testid="cadence-yield-body"]');
    expect(yieldBody).not.toBeNull();
    // 摩擦雷达:门禁失败 1 · 评审打回 1;产出:今日 Fact 1。
    expect(textOf(container, "cadence-friction")).toContain("门禁失败 1");
    expect(textOf(container, "cadence-yield-facts")).toContain("1");
    // 堵点:待裁决策与待裁决执行两组都在,整组铺开不截断。
    const blockers = container.querySelector('[data-testid="cadence-blockers-groups"]');
    expect(blockers?.textContent).toContain("探针决策:切换读取形态");
    expect(blockers?.textContent).toContain("待裁决执行 1");
  });

  it("frames all four blocks as Regions on the shared board, task rhythm in the rightmost column", async () => {
    const { container } = await mountCadence({
      page: historyPage([
        eventItem({ id: "e1", type: "task_created", revision: 1, taskId: "task_live", at: "2026-09-20T01:00:00.000Z" }),
        eventItem({
          id: "e2",
          type: "completion_gate_verified",
          revision: 2,
          taskId: "task_live",
          payload: { witness: { gateId: "ci", result: "fail" } },
        }),
      ]),
      agenda: AGENDA,
    });
    const panel = container.querySelector("#cadence-panel")!,
      board = panel.querySelector('[data-testid="cadence-board"]')!,
      block = (name: string) => panel.querySelector(`[data-testid="cadence-${name}"]`)!;
    // 任务节奏是这一页的主列表:两列时与主区各占一半,不用默认的 3:2。
    expect(board.className).toContain("@[900px]:grid-cols-2");
    // 四块都是 Region 区域框(标题在框里);页签里没有框外的标题,也没有自写的圆角外框。
    for (const name of ["blockers", "yield", "friction", "rhythm"]) {
      expect(block(name).querySelector(":scope > section[data-entry-region] h2"), name).not.toBeNull();
    }
    expect(panel.querySelectorAll("section[data-entry-region]").length).toBe(4);
    expect([...panel.querySelectorAll("h2")].every((h2) => h2.closest("section[data-entry-region]") !== null)).toBe(
      true,
    );
    expect(panel.querySelector("section.rounded-lg h2")).toBeNull();
    // 列位置:主区按堵点、产出、摩擦排,任务节奏是板的最后一格(右列)。
    expect([...board.querySelectorAll("[data-region]")].map((region) => region.getAttribute("data-region"))).toEqual([
      "blockers",
      "yield",
      "friction",
      "rhythm",
    ]);
    expect(board.lastElementChild).toBe(block("rhythm"));
    // 列切换只靠容器查询:页签面板自己是容器量尺且窄时由它滚动,板上没有视口断点。
    expect(panel.className).toContain("@container");
    expect(panel.className).toContain("overflow-y-auto");
    expect(board.outerHTML).not.toMatch(/\b(?:sm|md|lg|xl):grid-cols/u);
    // 窗口化认的滚动元素是音轨自己的 div:它是行列表的父元素,占满 Region 行体(行体自己不滚)。
    const scroller = block("rhythm").querySelector('[data-testid="cadence-rhythm-rows"]')!.parentElement!,
      regionBody = block("rhythm").querySelector(":scope > section > div:nth-child(2) > div")!;
    expect(scroller.className).toContain("overflow-y-auto");
    expect(scroller.className).toContain("flex-1");
    expect(scroller.parentElement!.className).toContain("h-full");
    expect(scroller.parentElement!.parentElement).toBe(regionBody);
    // 产出的条目是 DenseRow(板据此量「至少露出三条」);摩擦的行是自写的,有内容时用 fill 保底。
    expect(block("yield").querySelectorAll("[data-dense-row]").length).toBeGreaterThanOrEqual(3);
    expect(block("friction").className).toContain("flex-[1_1_100%]");
    // 区域级去向在页脚:去总池的按钮不在标题行。
    const pool = [...block("blockers").querySelectorAll("button")].find((button) =>
      button.textContent?.includes("去待办签发总池"),
    )!;
    expect(pool.closest("section")!.lastElementChild!.contains(pool)).toBe(true);
  });

  it("does not stretch the friction region when it has nothing to show", async () => {
    const { container } = await mountCadence({ page: historyPage([]), agenda: AGENDA, tasks: [] });
    const friction = container.querySelector('[data-testid="cadence-friction"]')!;
    expect(friction.querySelector('[data-testid="cadence-friction-empty"]')).not.toBeNull();
    expect(friction.className).not.toContain("flex-[1_1_100%]");
  });

  it("renders every blocker item — no silent slice(0,5) cap (v2 §1.8)", async () => {
    const seven = Array.from({ length: 7 }, (_, index) => ({
      taskId: `task_wait_${index}`,
      title: `待裁决 ${index}`,
      pinned: false,
      executionId: `exec_${index}`,
      submittedAt: NOW,
      blockingAssessment: { state: "clear", contributors: [], warnings: [] },
    }));
    const { container } = await mountCadence({
      page: historyPage([]),
      agenda: { ...AGENDA, awaitingAdjudication: seven },
    });
    const blockers = container.querySelector('[data-testid="cadence-blockers-groups"]');
    for (const item of seven) {
      expect(blockers?.textContent).toContain(item.title);
    }
  });

  it("switches the history range for the whole pane and re-reads with a consistent since", async () => {
    const { container } = await mountCadence({
      page: historyPage([]),
      fleet: groupsResult(
        [
          fleetGroup({
            key: "task_live",
            label: "在飞任务",
            taskId: "task_live",
            latestStatus: "running",
            runningCount: 1,
          }),
        ],
        { groups: 1, sessions: 1 },
      ),
    });
    await openFleetTab(container);
    // 窗口切换是共享 SegCtl 分段控件(§2.3),只管历史两区。
    const sevenDays = [...container.querySelectorAll('[data-testid="cadence-fleet"] [role="group"] button')].find(
      (button) => button.textContent === "7天",
    )!;
    await act(async () => sevenDays.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushEffects();
    const read = agentRuntimeClient.sessionGroups as unknown as { mock: { calls: unknown[][] } };
    const lastCall = read.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(lastCall).toMatchObject({ groupBy: "task", since: "2026-09-13T12:00:00.000Z", limit: 1000 });
    expect(textOf(container, "cadence-fleet-scope")).toContain("窗口 7天");
  });

  it("keeps running groups visible and unnamed when the latest round already ended", async () => {
    const { container } = await mountCadence({
      page: historyPage([]),
      fleet: groupsResult(
        [
          // runningCount>0 但最新一轮已结束:不指名执行人,只说几个会话在跑。
          fleetGroup({
            key: "task_mixed",
            label: "混合任务",
            taskId: "task_mixed",
            latestStatus: "failed",
            runningCount: 2,
            latestRound: {
              runtimeSessionId: "runtime_old",
              dispatchId: null,
              agentName: "已结束的执行人",
              instanceId: "zcode-glm-5-3",
              status: "failed",
              classification: null,
              reason: null,
              startedAt: "2026-09-20T10:00:00.000Z",
            },
          }),
        ],
        { groups: 1, sessions: 2 },
      ),
    });
    await openFleetTab(container);
    expect(textOf(container, "cadence-fleet-executing")).toContain("混合任务");
    expect(textOf(container, "cadence-fleet-executing")).toContain("2 个会话执行中");
    expect(textOf(container, "cadence-fleet-executing")).not.toContain("已结束的执行人");
    // 未归属桶(非 task 组)仍可导航:直达最新会话详情,不冒充 task 引用。
    const unattributed = await mountCadence({
      page: historyPage([]),
      fleet: groupsResult(
        [
          fleetGroup({
            key: "unattributed:no-task",
            label: "No task binding",
            latestStatus: "failed",
            latestRound: {
              runtimeSessionId: "runtime_direct",
              dispatchId: null,
              agentName: null,
              instanceId: "direct",
              status: "failed",
              classification: null,
              reason: null,
              startedAt: NOW,
            },
          }),
        ],
        { groups: 1, sessions: 1 },
      ),
    });
    await openFleetTab(unattributed.container);
    // 未归属桶按缺失原因分名(与会话页同一份词表),不是原始英文桶名。
    expect(textOf(unattributed.container, "cadence-fleet-anomaly")).toContain("未绑定任务");
    const directRow = mainRowButton(unattributed.container.querySelector('[data-testid="cadence-fleet-anomaly"]')!);
    await act(async () => directRow.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(unattributed.navigate).toHaveBeenCalledWith("session/runtime_direct");
  });

  it("states empty and error honestly: loaded range wording, no fake empties while pending", async () => {
    const empty = await mountCadence({
      page: historyPage([]),
      fleet: groupsResult([], { groups: 0, sessions: 0 }, true),
    });
    await openFleetTab(empty.container);
    expect(textOf(empty.container, "cadence-fleet-executing")).toContain("当前没有在跑的执行");
    // 截断/空态按「已加载范围内」措辞,不冒充全局无故障。
    expect(textOf(empty.container, "cadence-fleet-anomaly")).toContain("当前已加载范围内");
    expect(textOf(empty.container, "cadence-fleet-results")).toContain("当前已加载范围内");
    expect(textOf(empty.container, "cadence-fleet-scope")).toContain("列表已截断");

    const pending = await mountCadence({
      page: historyPage([]),
      fleet: { ...groupsResult([], { groups: 0, sessions: 0 }), status: "pending" },
    });
    await openFleetTab(pending.container);
    expect(textOf(pending.container, "cadence-fleet-pending")).toContain("读取中");
    expect(pending.container.querySelector('[data-testid="cadence-fleet-anomaly"]')).toBeNull();

    const failed = await mountCadence({ page: historyPage([]), fleetError: new Error("socket closed") });
    await openFleetTab(failed.container);
    expect(textOf(failed.container, "cadence-fleet-error")).toContain("socket closed");
    expect(failed.container.querySelector('[data-testid="cadence-fleet-results"]')).toBeNull();
  });

  it("caps rendered result rows at the overview bound and says so in the region footer", async () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      fleetGroup({ key: `task_${index}`, label: `结果任务 ${index}`, taskId: `task_${index}` }),
    );
    const { container } = await mountCadence({
      page: historyPage([]),
      fleet: groupsResult(many, { groups: 60, sessions: 60 }),
    });
    await openFleetTab(container);
    expect(
      container.querySelectorAll('[data-testid="cadence-fleet-results"] [data-testid="cadence-fleet-row"]').length,
    ).toBe(50);
    // 截断说明在区域页脚(Region footer),与行体同级。
    const resultsRegion = container.querySelector('[data-testid="cadence-fleet-results"]')!.closest("section")!;
    expect(resultsRegion.textContent).toContain("显示前 50 条");
    expect(textOf(container, "cadence-fleet-scope")).toContain("已加载 60 组");
  });

  it("expands a rhythm row in place with the funnel and micro chain; the detail link navigates", async () => {
    const { container, navigate } = await mountCadence({
      page: historyPage([
        eventItem({ id: "e1", type: "task_created", revision: 1, taskId: "task_live", at: "2026-09-20T01:00:00.000Z" }),
        eventItem({
          id: "e2",
          type: "execution_started",
          revision: 2,
          taskId: "task_live",
          at: "2026-09-20T02:00:00.000Z",
        }),
        eventItem({
          id: "e3",
          type: "fact_recorded",
          revision: 3,
          taskId: "task_live",
          factId: "F-probe000",
          at: NOW,
          payload: { statement: "探针事实:聚合窗口按 5 秒追尾一次" },
        }),
        eventItem({
          id: "e4",
          type: "completion_gate_verified",
          revision: 4,
          taskId: "task_live",
          payload: { witness: { gateId: "ci", result: "fail" } },
        }),
        eventItem({
          id: "e5",
          type: "review_recorded",
          revision: 5,
          taskId: "task_live",
          payload: { review: { verdict: "changes_requested" } },
        }),
      ]),
      agenda: AGENDA,
    });
    const titleButton = [...container.querySelectorAll('[data-testid="cadence-rhythm-toggle"]')].find((button) =>
      button.textContent?.includes("在飞任务"),
    )!;
    expect(titleButton.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="cadence-rhythm-detail"]')).toBeNull();
    await act(async () => {
      titleButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // 点击行 = 原地展开深度分析,不路由跳走。
    expect(navigate).not.toHaveBeenCalled();
    expect(titleButton.getAttribute("aria-expanded")).toBe("true");
    const detail = container.querySelector('[data-testid="cadence-rhythm-detail"]');
    expect(detail).not.toBeNull();
    // 阶段耗时漏斗:toWip 1h / toFact 10h / toGate 0 / toComplete 未覆盖,瓶颈占比 91%。
    expect(detail?.textContent).toContain("立项 → 编码");
    expect(detail?.textContent).toContain("瓶颈区间「编码 → 首条 Fact」耗时占比 91%");
    expect(detail?.textContent).toContain("未覆盖");
    expect(container.querySelector('[data-testid="cadence-funnel-turnaround"]')?.textContent).toContain(
      "窗口内未见完整周期",
    );
    // 微型事件链:fact statement 原地可读,fact id 是可激活链接(G10)。
    expect(container.querySelector('[data-testid="cadence-micro"]')?.textContent).toContain(
      "探针事实:聚合窗口按 5 秒追尾一次",
    );
    const factLink = [...detail!.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("F-probe000"),
    );
    expect(factLink).toBeDefined();
    // 展开头部的「进入详情」外链才路由跳转。
    const detailLink = [...detail!.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("进入详情"),
    );
    expect(detailLink).toBeDefined();
    await act(async () => {
      detailLink!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigate).toHaveBeenCalledWith("task/task_live");
    // 再点一次收起,深度面板卸载。
    await act(async () => {
      titleButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="cadence-rhythm-detail"]')).toBeNull();
    // 堵点卡片的实体跳转不受音轨交互改造影响。
    const decisionRow = [...container.querySelectorAll('[data-testid="cadence-blockers"] button')].find((button) =>
      button.textContent?.includes("探针决策:切换读取形态"),
    )!;
    await act(async () => {
      decisionRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigate).toHaveBeenCalledWith("decision/dec_probe");
  });

  it("surfaces observe.tail unavailability explicitly instead of an empty cockpit", async () => {
    const { container } = await mountCadence({
      page: {
        ...historyPage([]),
        status: "unavailable",
        unavailable: { reason: "edge-mirror-has-no-events", centerRevision: 41 },
        items: [],
        liveCursor: null,
        sourceCursor: null,
        done: false,
      },
    });
    expect(textOf(container, "cadence-unavailable")).toContain("事件流不可用");
    expect(textOf(container, "cadence-blockers-pending")).toContain("议程读取中");
  });
});
