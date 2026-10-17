// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgendaSuccess } from "../src/renderer/api-client.ts";
import { harnessClient } from "../src/renderer/api-client.ts";
import { agentRuntimeClient } from "../src/renderer/agent-runtime-client.ts";
import type {
  AgendaAnsweredRow,
  AgendaAwaitsRow,
  AgendaDecisionRow,
  AgendaExecutionRow,
  AgendaTaskRow,
  ObserveTailRead,
} from "../src/api/renderer-dto.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { AgendaView } from "../src/renderer/views/AgendaView.tsx";
import { runningRowsOf, TodayView } from "../src/renderer/views/today/TodayView.tsx";
import { deliveredRows } from "../src/renderer/views/today/today-data.ts";
import type { TaskSnapshotProjectionRow } from "../src/api/renderer-dto.ts";
import type { AgentRuntimeSessionGroupsResult } from "@harness-anything/daemon/protocol";

/**
 * 「重构 › 今天」(dec_C612E69B7C7E3480A5F9D2CAD3 CH1)的装配判据(happy-dom):
 *  - 三块区域(等你处理/正在跑/刚交付)各一个数;等你处理的行集与计数和议程页
 *    「需要关注」同源同数——两页共用 model/agenda-rows.ts 的行派生,数字不一致即缺陷;
 *  - awaits 行的首要动作是就地答复(AwaitsAnswerPanel),其余行「去处理」开单层抽屉,
 *    抽屉里给「打开完整详情」;
 *  - 正在跑:会话组 runningCount>0 的任务一行,卡住(blocked/lost)标红;
 *  - 刚交付:任务投影 done/completedAt 一行,点行直接进任务详情;
 *  - 空态写人话,读失败显式报错,不冒充。
 */
const REPO_ID = "today-probe",
  AT = "2026-10-17T01:00:00.000Z";

const decisionRow = (decisionId: string): AgendaDecisionRow => ({
  decisionId,
  title: `决策 ${decisionId}`,
  riskTier: "high",
  urgency: "medium",
  proposedAt: AT,
});
const awaitsRow = (relationId: string, sourceRef: string): AgendaAwaitsRow => ({
  relationId,
  relationRevision: 1,
  sourceRef,
  title: `提案 ${sourceRef}`,
  status: "proposed",
  personId: "person_me",
  askKind: "consent",
  question: "等待同意收口。",
  askedAt: AT,
  askedBy: "person_me",
});
const answeredRow = (relationId: string, sourceRef: string): AgendaAnsweredRow => ({
  relationId,
  sourceRef,
  title: `已答复 ${sourceRef}`,
  status: "active",
  personId: "person_owner",
  askKind: "question",
  question: "接口要不要兼容旧字段?",
  answer: "不兼容，直接删",
  answeredAt: AT,
  answeredBy: "person_owner",
});
const blocking = { state: "clear" } as AgendaTaskRow["blockingAssessment"];
const taskRow = (taskId: string): AgendaTaskRow => ({
  taskId,
  title: `任务 ${taskId}`,
  work: null,
  status: "active",
  pinned: false,
  updatedAt: AT,
  leaseExecutionId: null,
  activeExecutionIds: [],
  blockingAssessment: blocking,
  workspace: null,
});
const executionRow = (taskId: string): AgendaExecutionRow => ({
  taskId,
  title: `送审 ${taskId}`,
  work: null,
  pinned: false,
  executionId: `exec_${taskId}`,
  submittedAt: AT,
  blockingAssessment: blocking,
});

const agenda = (patch: Partial<AgendaSuccess> = {}): AgendaSuccess => ({
  ok: true,
  status: "ready",
  pinnedEntities: [],
  pinnedEntityOverflow: 0,
  attentionItems: [],
  inFlight: [],
  regionWeights: { ci: 0, mine: 0, stuck: 0, run: 0, review: 0, queue: 0, recent: 0, works: 0 },
  awaitingRework: [],
  awaitingAdjudication: [],
  underReview: [],
  awaitingYou: [],
  answeredForYou: [],
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
});

/** 议程读面里需要关注的行全集:两条 awaits(decision 源折成一条 dispose)+ 返工 + 待初审 + 待评审 + 待裁决。 */
const seeded = agenda({
  awaitingYou: [awaitsRow("rel_dec", "decision/dec_dispose"), awaitsRow("rel_task", "task/task_x")],
  awaitingRework: [taskRow("task_rework")],
  awaitingAdjudication: [executionRow("task_adj")],
  awaitingDecisionReview: [decisionRow("dec_review")],
  awaitingDecision: [decisionRow("dec_judge")],
  answeredForYou: [answeredRow("rel_done", "task/task_x")],
});

const sessionGroups = (groups: AgentRuntimeSessionGroupsResult["groups"]): AgentRuntimeSessionGroupsResult => ({
  ok: true,
  status: "ready",
  groups,
  sessionAgents: [],
  totals: { groups: groups.length, sessions: 3 },
  truncated: false,
  watermark: 9,
  sourceRevision: 9,
});

const groupOf = (patch: Partial<AgentRuntimeSessionGroupsResult["groups"][number]> = {}) => ({
  key: "task/task_a",
  kind: "task",
  label: "重构区骨架与今天页",
  taskId: "task_a",
  latestStatus: "running",
  latestActivityAt: AT,
  runningCount: 1,
  sessionCount: 2,
  roundCount: 2,
  latestRound: {
    runtimeSessionId: "runtime_1",
    dispatchId: null,
    agentName: "GLM 实现 worker",
    instanceId: "instance_1",
    status: "running",
    startedAt: AT,
  },
  ...patch,
});

const eventsPage = (items: readonly unknown[]): ObserveTailRead =>
  ({ status: "ready", items, done: true, cursor: "events:9", sourceCursor: "events:9" }) as unknown as ObserveTailRead;

const completedEvent = (taskId: string, at: string) => ({
  eventId: `evt_${taskId}`,
  type: "task_completed",
  occurredAt: at,
  taskId,
  payload: { title: `完成 ${taskId}` },
});

const mounted: { root: Root; container: HTMLElement }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

beforeEach(() => {
  vi.spyOn(agentRuntimeClient, "sessionGroups").mockImplementation(async () =>
    sessionGroups([
      groupOf(),
      groupOf({
        key: "task/task_stuck",
        label: "卡住的任务",
        taskId: "task_stuck",
        latestStatus: "blocked",
        runningCount: 2,
        latestRound: {
          runtimeSessionId: "runtime_2",
          dispatchId: null,
          agentName: "评审 worker",
          instanceId: "instance_2",
          status: "blocked",
          startedAt: AT,
          reason: "等待上游凭据",
        },
      }),
    ]),
  );
  vi.spyOn(harnessClient, "tailObservability").mockImplementation(async () =>
    eventsPage([
      completedEvent("task_done_1", "2026-10-17T08:00:00.000Z"),
      completedEvent("task_done_2", "2026-10-17T06:30:00.000Z"),
      { eventId: "evt_noise", type: "task_progress_appended", occurredAt: AT, taskId: "task_x", payload: {} },
    ]),
  );
});

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
});

async function flushEffects() {
  for (let index = 0; index < 3; index++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

interface Mounted {
  readonly container: HTMLElement;
  readonly navigate: ReturnType<typeof vi.fn>;
}

async function mountToday(
  element: ReturnType<typeof createElement>,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
): Promise<Mounted> {
  const navigate = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, element));
  });
  await flushEffects();
  return { container, navigate };
}

const todayElement = (patch: Partial<Parameters<typeof TodayView>[0]> = {}) =>
  createElement(TodayView, {
    repoId: REPO_ID,
    agenda: seeded,
    agendaError: null,
    titles: new Map([
      ["task_done_1", "刚交付的任务一"],
      ["task_done_2", "刚交付的任务二"],
    ]),
    tasks: [
      { taskId: "task_done_1", snapshot: { task: { status: "done", title: "刚交付的任务一" } } },
      {
        taskId: "task_done_2",
        snapshot: {
          task: { status: "done", title: "刚交付的任务二" },
          executions: [
            {
              iteration: 1,
              submission: {
                completionClaim: "交付了任务二的真实摘要",
                deliverables: [],
                outputs: [],
              },
            },
          ],
        },
      },
    ].map((row, index) => ({
      ...row,
      completedAt: index === 0 ? "2026-10-17T08:00:00.000Z" : "2026-10-17T06:30:00.000Z",
    })) as unknown as TaskSnapshotProjectionRow[],
    onNavigateEntity: () => undefined,
    onOpenTask: () => undefined,
    onOpenAgenda: () => undefined,
    onOpenSessions: () => undefined,
    ...patch,
  });

const byTestId = (host: HTMLElement, testId: string) => host.querySelector(`[data-testid="${testId}"]`);
const click = (host: HTMLElement, testId: string) => {
  const target = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!target) throw new Error(`missing ${testId}`);
  act(() => target.click());
};

describe("今天:三块区域与数字", () => {
  it("从任务投影找最近完成,不受大量非完成事件影响", () => {
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      taskId: `task_noise_${index}`,
      completedAt: null,
      snapshot: { task: { status: "active", title: `噪声 ${index}` } },
    }));
    rows.push({
      taskId: "task_recent_done",
      completedAt: "2026-10-17T08:00:00.000Z",
      snapshot: { task: { status: "done", title: "最近完成" } },
    });
    const delivered = deliveredRows(
      rows as unknown as TaskSnapshotProjectionRow[],
      Date.parse("2026-10-17T09:00:00.000Z"),
    );
    expect(delivered.map(({ taskId }) => taskId)).toEqual(["task_recent_done"]);
  });

  it("三块各一个数;等你处理的计数与议程页「需要关注」同数(两页同源)", async () => {
    const { container } = await mountToday(todayElement());
    // 等你处理:1 条 decision 源 awaits 折成 dispose + 1 条 task 源 awaits + 返工 + 待初审 + 待评审 + 待裁决 = 6。
    expect([...container.querySelectorAll('[data-testid^="today-waiting-row-"]')]).toHaveLength(6);
    // 正在跑:两个任务组,3 个在跑会话(runningCount 1 + 2)。
    expect([...container.querySelectorAll('[data-testid^="today-running-row-"]')]).toHaveLength(2);
    // 刚交付:两条 task_completed,噪声事件(progress)不成行。
    expect([...container.querySelectorAll('[data-testid^="today-delivered-row-"]')]).toHaveLength(2);

    const agendaHost = document.createElement("div");
    document.body.append(agendaHost);
    const agendaRoot = createRoot(agendaHost);
    mounted.push({ root: agendaRoot, container: agendaHost });
    await act(async () => {
      agendaRoot.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(AgendaView, {
            repoId: REPO_ID,
            agenda: seeded,
            agendaError: null,
            onNavigateEntity: () => undefined,
          }),
        ),
      );
    });
    // 议程页默认筛选「需要关注」:行数与今天「等你处理」一致(任务书:两页数字不一致即缺陷)。
    const agendaRows = [...agendaHost.querySelectorAll('[data-testid^="agenda-row-"]')];
    expect(agendaRows).toHaveLength(6);
    expect(container.querySelectorAll('[data-testid^="today-waiting-row-"]').length).toBe(agendaRows.length);
    expect(byTestId(agendaHost, "agenda-count")!.textContent).toContain("6");
  });

  it("刚交付行按时间新→旧,行文本是人话标题,不出现裸 ID", async () => {
    const { container } = await mountToday(todayElement());
    const rows = [...container.querySelectorAll('[data-testid^="today-delivered-row-"]')];
    expect(rows[0]!.textContent).toContain("刚交付的任务一");
    expect(rows[1]!.textContent).toContain("刚交付的任务二");
    expect(rows[0]!.textContent).not.toContain("task_done_1");
    expect(rows[1]!.textContent).toContain("交付了任务二的真实摘要");
    expect(rows[0]!.textContent).not.toContain("任务已完成");
    expect(rows[0]!.querySelector(".text-text-faint")).toBeNull();
  });

  it("刚交付行分别显示各自摘要,摘要为空时不显示占位文本", async () => {
    const { container } = await mountToday(
      todayElement({
        tasks: [
          {
            taskId: "task_done_1",
            completedAt: "2026-10-17T08:00:00.000Z",
            snapshot: {
              task: { status: "done", title: "刚交付的任务一" },
              executions: [
                {
                  iteration: 1,
                  submission: { completionClaim: "方案摘要一", deliverables: [], outputs: [] },
                },
              ],
            },
          },
          {
            taskId: "task_done_2",
            completedAt: "2026-10-17T06:30:00.000Z",
            snapshot: {
              task: { status: "done", title: "刚交付的任务二" },
              executions: [
                {
                  iteration: 1,
                  submission: { completionClaim: "方案摘要二", deliverables: [], outputs: [] },
                },
              ],
            },
          },
        ] as unknown as TaskSnapshotProjectionRow[],
      }),
    );
    const rows = [...container.querySelectorAll('[data-testid^="today-delivered-row-"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("方案摘要一");
    expect(rows[0]!.textContent).not.toContain("方案摘要二");
    expect(rows[1]!.textContent).toContain("方案摘要二");
    expect(rows[1]!.textContent).not.toContain("方案摘要一");
  });
});

describe("今天:行上的首要动作与下钻", () => {
  it("awaits 行的首要动作是就地答复,点开答复面板(portal 落在 document.body)", async () => {
    const { container } = await mountToday(todayElement());
    click(container, "today-answer-rel_task");
    expect(document.querySelector('[data-testid="awaits-answer-panel"]')).not.toBeNull();
  });

  it("非 awaits 行「去处理」开单层抽屉,抽屉里给「打开完整详情」", async () => {
    const { container } = await mountToday(todayElement());
    click(container, "today-handle-dec_judge");
    expect(byTestId(container, "today-drawer-open")).not.toBeNull();
  });

  it("正在跑行开抽屉给任务详情出口;卡住的任务标红档", async () => {
    const { container } = await mountToday(todayElement());
    const stuck = byTestId(container, "today-running-row-task_stuck")!;
    expect(stuck.querySelector('[data-status-tone="bad"]')).not.toBeNull();
    const running = byTestId(container, "today-running-row-task_a")!;
    expect(running.querySelector('[data-status-tone="active"]')).not.toBeNull();
    await act(async () => {
      (running.querySelector("button") as HTMLButtonElement)!.click();
    });
    expect(byTestId(container, "today-running-drawer-open")).not.toBeNull();
  });

  it("刚交付行点开直接进任务详情(不经过抽屉)", async () => {
    const opened: string[] = [];
    const { container } = await mountToday(
      todayElement({
        titles: new Map([["task_done_1", "刚交付的任务一"]]),
        onOpenTask: (taskId) => opened.push(taskId),
      }),
    );
    await act(async () => {
      (byTestId(container, "today-delivered-row-task_done_1")!.querySelector("button") as HTMLButtonElement)!.click();
    });
    expect(opened).toEqual(["task_done_1"]);
  });
});

describe("今天:空态与错误不冒充", () => {
  it("议程全空时等你处理区一行人话", async () => {
    const { container } = await mountToday(todayElement({ agenda: agenda() }));
    expect(container.textContent).toContain("现在没有要你处理的事");
  });

  it("议程读失败时区域显式报错,不冒充空态", async () => {
    const { container } = await mountToday(todayElement({ agenda: undefined, agendaError: "bridge down" }));
    expect(container.textContent).toContain("读取失败：bridge down");
  });
});

describe("runningRowsOf:会话组 → 正在跑行", () => {
  it("只收 runningCount>0 的组;startedAt/agent 来自最新一轮;latestStatus 透传", () => {
    const rows = runningRowsOf(
      sessionGroups([
        groupOf(),
        groupOf({ key: "task/idle", runningCount: 0, latestStatus: "succeeded" }),
        groupOf({
          key: "unattributed:no-task",
          label: "未归属",
          taskId: undefined,
          runningCount: 0,
          latestRound: null,
        }),
      ]),
    );
    expect(rows.map(({ key }) => key)).toEqual(["task/task_a"]);
    expect(rows[0]).toMatchObject({ agent: "GLM 实现 worker", startedAt: AT, status: "running" });
  });

  it("running 状态超过 24 小时无进展时标记卡住", () => {
    const staleGroup = groupOf({ latestActivityAt: "2026-10-15T00:00:00.000Z", latestStatus: "running" });
    expect(runningRowsOf(sessionGroups([staleGroup]), Date.parse("2026-10-17T00:00:01.000Z"))[0]?.status).toBe(
      "blocked",
    );
    expect(runningRowsOf(sessionGroups([staleGroup]), Date.parse("2026-10-15T23:59:59.999Z"))[0]?.status).toBe(
      "running",
    );
  });
});
