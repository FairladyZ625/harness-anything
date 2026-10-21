// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeOverviewResult, AgentRuntimeSessionGroupDto } from "@harness-anything/daemon/protocol";
import type { TaskDispatchProjectionRow } from "../src/api/renderer-dto.ts";
import type { TaskWipRead } from "../../src/api/renderer-dto.ts";
import {
  AT,
  HEALTH_DOWN,
  WORKS_EMPTY,
  agenda,
  setupOverviewBoardEnvironment,
  mountOverview as mount,
  historyOf,
  textOf,
  flushUntil,
  unmountOverview as unmount,
} from "./overview-board.fixtures.ts";

/**
 * 总览(2026-10-04 注意力优先重构;2026-10-11 业主意见返工;2026-10-20 W2-T1 接入
 * Orca 五级序数与 Agent 泳道)的行为面:首块只列真实待人事项(Needs you 绝对顶置、
 * 橙色提问档),主区关注的工作里名下有 Needs you 的工作置顶;「执行与下钻」的
 * 「进行中的任务」tab 由 AgentLanes 泳道替换旧静态平铺名单(块内挂待拍板动作与
 * Prompt Cache 倒计时),旧 drillWipRows 派生已删除。左列最新产物速览架与产物二级页
 * (task_8a83698;2026-10-11 意见 1)的行为面在 overview-artifacts.vitest.tsx;共享
 * 挂载夹具在 overview-board.fixtures.ts。
 */

beforeAll(() => {
  setupOverviewBoardEnvironment();
});

const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

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

  it("checkpoint:Needs you 绝对顶置——分数再高也压不过提问阻塞,且用独立橙标识", () => {
    // Orca 五级序数(dec_C0AF8CBBFFECF71F4F34FB76F9/CH4):awaiting-you(class 1)排在
    // 一切 decision 之前,即使 decision 的注意力分(200)远高于它(132)。
    const read = agenda({
      attentionItems: [
        {
          ref: "decision/dec_hot",
          title: "高分待点头决策",
          kind: "decision",
          region: "mine",
          workTaskId: null,
          attention: { score: 200, reasons: [] },
        },
        ...agenda().attentionItems,
      ],
      awaitingDecision: [
        { decisionId: "dec_hot", title: "高分待点头决策", riskTier: "low", urgency: "low", proposedAt: AT },
        ...agenda().awaitingDecision,
      ],
    });
    const container = mount({ agenda: read });
    const decisions = container.querySelector('[data-testid="overview-decisions-band"]')!;
    const rows = [...decisions.querySelectorAll("[data-decision]")];
    expect(rows[0]!.getAttribute("data-decision")).toBe("relation/rel_1");
    expect(rows[1]!.getAttribute("data-decision")).toBe("decision/dec_hot");
    // awaiting-you 行用 agent-question 橙 tone(严格区别于 wait 琥珀);decision 保持 wait。
    expect(rows[0]!.querySelector('[data-status-tone="agent-question"]')).not.toBeNull();
    expect(rows[1]!.querySelector('[data-status-tone="wait"]')).not.toBeNull();
    expect(textOf(decisions)).toContain("需要你");
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
    // 待初审(execution)住「跟进与返工」:切 tab 后名单首行即它,点行进放大层给「打开收口」。
    const drill = container.querySelector('[data-testid="overview-region-drill"]')!;
    act(() => (drill.querySelector('[data-testid="overview-drill-followups"]') as HTMLElement).click());
    act(() =>
      (container.querySelector('[data-drill-row="execution/exec_1"]')!.querySelector("button") as HTMLElement).click(),
    );
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
  it("置顶的非终态工作保留在前,其余近期工作随后;已收尾的置顶工作只计数", () => {
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
    // 置顶在前,近期有活动的工作随后(意见 4 的默认口径),已收尾的不进列表。
    const cards = [...works.querySelectorAll("[data-work-card]")].map((card) => card.getAttribute("data-work-card"));
    expect(cards).toEqual(["task_w1", "task_w2"]);
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

  it("工作行压缩为一到两行:进度/进行中/处理者/等你处理有值才进第二行", async () => {
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
    // 第二行是行内信息面(2026-10-11 意见 4;视觉规范 v2 改图形化):进度退成 SegBar
    // 分段条 + 紧凑 done/total 计数,随后是进行中子任务数、执行者、等你处理数;
    // 完整子任务/未完成/最近明细悬停给。
    expect([...card.querySelectorAll("[data-segment]")].map((node) => node.getAttribute("data-segment"))).toEqual([
      "done",
      "active",
    ]);
    expect(text).toContain("2/3");
    expect(text).toContain("进行中 1");
    expect(text).toContain("等你处理 1");
    expect(text).toContain("跟进 1");
    const hover = card.querySelector("[data-dense-row]")!.getAttribute("title")!;
    expect(hover).toContain("子任务完成 2/3");
    expect(hover).toContain("未完成 1");
    // 处理者来自 runtime overview 的 live 会话(who = kind · model)。
    expect(text).toContain("codex · glm-5.3");
    // 行尾时间给最近活动的相对年龄(活动窗口的口径本体)。
    expect(text).toMatch(/分钟前|小时前|刚刚|天/u);
    // 点行进工作详情,不再需要行内「打开工作」按钮。
    act(() => (card.querySelector("button") as HTMLButtonElement).click());
    expect(onOpenTask).toHaveBeenCalledWith("task_w1");
    unmount();
    // 还原默认桥:后续用例的 runtime 读面回到确定性失败。
    vi.stubGlobal("harness", { request: () => Promise.reject(new Error("no bridge in test")) });
  });

  it("工作卡橙色计数只算 needs-you:返工与裁决等跟进项保持中性色", () => {
    const read = agenda({
      attentionItems: [
        {
          ref: "relation/rel_1",
          title: "待答复提问",
          kind: "awaiting-you",
          region: "mine",
          workTaskId: "task_w1",
          attention: { score: 100, reasons: [] },
        },
        {
          ref: "execution/exec_1",
          title: "待裁决提交",
          kind: "adjudication",
          region: "mine",
          workTaskId: "task_w1",
          attention: { score: 80, reasons: [] },
        },
        {
          ref: "task/task_rew",
          title: "待返工任务",
          kind: "rework",
          region: "mine",
          workTaskId: "task_w1",
          attention: { score: 70, reasons: [] },
        },
      ],
    });
    const container = mount({ agenda: read });
    try {
      const card = container.querySelector("[data-work-card='task_w1']")!;
      const text = textOf(card);
      // 橙色「等你处理」只算 awaiting-you 与 decision,计 1
      expect(text).toContain("等你处理 1");
      const mineSpan = card.querySelector("span[style*='--color-agent-question']")!;
      expect(mineSpan).not.toBeNull();
      expect(textOf(mineSpan)).toBe("等你处理 1");
      // 其余项(裁决 + 返工)保持中性色,计 2
      expect(text).toContain("跟进 2");
    } finally {
      unmount();
    }
  });

  it("在跑而无会话的工作行安静待命;消极提示文本不再出现", () => {
    // 默认夹具:task_w1 在跑(executing 1)且无 live 会话 → 静止待命,第二行只留进度与
    // 计数,不输出「无 agent 在跑」(视觉规范 v2:动效即心跳,静止即待命)。
    const container = mount();
    const w1 = container.querySelector("[data-work-card='task_w1']")!;
    expect(textOf(w1)).not.toContain("无 agent");
    expect(w1.className).not.toContain("live-row");
    // task_w2 只有卡点没有在跑子任务:分段条按 blocked/planned 构成着色,计数 0/3。
    const w2 = container.querySelector("[data-work-card='task_w2']")!;
    expect([...w2.querySelectorAll("[data-segment]")].map((node) => node.getAttribute("data-segment"))).toEqual([
      "blocked",
      "planned",
    ]);
    expect(textOf(w2)).toContain("0/3");
    expect(textOf(w2)).not.toContain("无 agent");
    // 两行档的标题/原因各占一个 block 行,不超过两行(SegBar 的分段 span 不算行)。
    expect(w1.querySelectorAll("[data-dense-row] .block.truncate").length).toBe(2);
    unmount();
  });

  it("近期变化收进行悬停:关注工作的任务在,别人的任务不在", async () => {
    const startedAt = Date.now(),
      occurredAt = (minutes: number) => new Date(startedAt - minutes * 60_000).toISOString();
    const item = (patch: Record<string, unknown>) => ({
      eventId: `evt-${Math.random().toString(36).slice(2, 8)}`,
      occurredAt: occurredAt(60),
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
                item({ type: "execution_started", taskId: "task_m1", occurredAt: occurredAt(55) }),
                item({ type: "execution_submitted", taskId: "task_m1", occurredAt: occurredAt(40) }),
                item({ type: "task_completed", taskId: "task_other", occurredAt: occurredAt(20) }),
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
      () =>
        container
          .querySelector("[data-work-card='task_w1'] [data-dense-row]")
          ?.getAttribute("title")
          ?.includes("最近") === true,
    );
    const hover = container.querySelector("[data-work-card='task_w1'] [data-dense-row]")!.getAttribute("title")!;
    expect(hover).toContain("最近");
    expect(hover).toContain("开始");
    expect(hover).toContain("提交评审");
    // 紧凑行正文不铺近期变化(悬停才见);不属于任何关注工作的任务事件不进总览。
    expect(textOf(container.querySelector("[data-work-card='task_w1']")!)).not.toContain("提交评审");
    expect(hover).not.toContain("不属于关注工作的任务");
    unmount();
    vi.stubGlobal("harness", { request: () => Promise.reject(new Error("no bridge in test")) });
  });

  it("没有任何工作时给「去工作页」入口而不是空壳", () => {
    const onOpenWorks = vi.fn();
    const container = mount({ works: WORKS_EMPTY, onOpenWorks });
    const works = container.querySelector('[data-testid="overview-region-works"]')!;
    expect(textOf(works)).toContain("最近 3 天没有有活动的工作");
    const open = [...works.querySelectorAll("button")].find((button) => textOf(button).includes("去工作页"));
    act(() => open!.click());
    expect(onOpenWorks).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe("总览:执行与下钻(tab + 内联名单)", () => {
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

  /** 只给点名桥方法注入 fixture(可读 payload),其余保持确定性失败;返回还原函数。 */
  function stubBridge(handlers: Record<string, (payload?: unknown) => unknown>): () => void {
    const previous = (globalThis as { harness?: unknown }).harness;
    vi.stubGlobal("harness", {
      request: (method: string, payload: unknown) =>
        method in handlers
          ? Promise.resolve(handlers[method]!(payload))
          : Promise.reject(new Error("no bridge in test")),
    });
    return () => vi.stubGlobal("harness", previous);
  }

  const drillRows = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-testid="overview-drill-list"] [data-drill-row]')].map(
      (row) => row.getAttribute("data-drill-row")!,
    );

  /** 泳道三段读面的桥 stub:sessionGroups(agent 分组) + 活跃 agent 成员派工页 + 运行会话事件流。 */
  const agentGroup = (patch: Partial<AgentRuntimeSessionGroupDto>): AgentRuntimeSessionGroupDto => ({
    key: "agent:glm",
    kind: "agent",
    label: "GLM Worker",
    agentId: "glm",
    latestStatus: "running",
    latestActivityAt: AT,
    runningCount: 1,
    sessionCount: 2,
    roundCount: 2,
    latestRound: null,
    ...patch,
  });

  /** 总览的「现在」取渲染时刻的墙钟;泳道 6h 窗口内的块必须用近期时间构造,
   *  否则真实的窗口过滤会把它们当历史轮次丢掉(这本身就是要验证的行为)。 */
  const LANES_RECENT = new Date(Date.now() - 5 * 60_000).toISOString();

  const dispatchRow = (patch: Partial<TaskDispatchProjectionRow>): TaskDispatchProjectionRow => ({
    dispatchId: "disp_glm_1",
    taskId: "task_m1",
    executionId: "exec_1",
    runtimeSessionId: "rs_glm_1",
    instanceId: "inst_glm",
    attemptGroupId: "att_1",
    attemptIndex: 0,
    provider: { instance: "glm", model: "glm-5.3" },
    classification: null,
    reason: null,
    fallbackState: null,
    nextDispatchId: null,
    providerSessionId: null,
    eventStreamRef: null,
    startedAt: LANES_RECENT,
    endedAt: null,
    outcome: null,
    status: "running",
    ...patch,
  });

  function stubLanesBridge(input: {
    readonly groups?: readonly AgentRuntimeSessionGroupDto[];
    readonly members?: Readonly<Record<string, readonly TaskDispatchProjectionRow[]>>;
    readonly eventsBySession?: Readonly<Record<string, readonly string[]>>;
  }): () => void {
    // 桥 stub 收到的是 wireParams:带 payload facet 的方法包一层 { payload: params }。
    const paramsOf = (payload: unknown): Record<string, unknown> => {
      const wire = payload as { readonly payload?: Record<string, unknown> };
      return wire?.payload ?? (payload as Record<string, unknown>);
    };
    const handlers: Record<string, (payload?: unknown) => unknown> = {
      getTaskWip: () => wipSnapshot([]),
      // sessionGroups 走 use-case projection 信封(bridge 方法名 readUseCaseProjection)。
      readUseCaseProjection: (payload) => {
        const params = paramsOf(payload);
        if (params.name !== "runtime-session-groups") throw new Error(`unexpected projection: ${String(params.name)}`);
        return {
          ok: true,
          schema: "daemon.use-case-projection/v1",
          name: "runtime-session-groups",
          projection: {
            ok: true,
            status: "ready",
            groups: input.groups ?? [],
            sessionAgents: [],
            totals: { groups: (input.groups ?? []).length, sessions: 0 },
            truncated: false,
            watermark: 1,
            sourceRevision: 1,
          },
        };
      },
      getTaskDispatches: (payload) => {
        const params = paramsOf(payload);
        const agentId = String(params.agentId ?? "");
        const rows = input.members?.[agentId];
        if (rows === undefined) throw new Error(`unexpected member page: ${agentId}`);
        return {
          ok: true,
          status: "ready",
          // 成员页结果必须回显 agentId(单/批/成员三态的判别式,缺它读面按无效结果拒绝)。
          agentId,
          dispatches: rows,
          outcome: "unknown",
          exitCode: 0,
          taskLabels: [...new Set(rows.map(({ taskId }) => taskId))].map((taskId) => ({
            taskId,
            title: `任务 ${taskId}`,
          })),
          groups: [],
          totals: { groups: 1, sessions: rows.length },
          truncated: false,
          watermark: 1,
          sourceRevision: 1,
        };
      },
      getAgentRuntimeEvents: (payload) => {
        const params = paramsOf(payload);
        const runtimeSessionId = String(params.runtimeSessionId ?? "");
        const types = input.eventsBySession?.[runtimeSessionId];
        if (types === undefined) throw new Error(`unexpected events read: ${runtimeSessionId}`);
        let cursor = 0;
        return {
          ok: true,
          runtimeSessionId,
          events: types.map((type) => ({
            cursor: `lifecycle:${(cursor += 1)}`,
            runtimeSessionId,
            type,
            occurredAt: AT,
          })),
          cursor: `lifecycle:${cursor}`,
          sourceCursor: `lifecycle:${cursor}`,
          done: true,
        };
      },
    };
    return stubBridge(handlers);
  }

  it("进行中的任务 tab 是 AgentLanes 泳道:运行块生长、待拍板块橙色、块内缓存倒计时", async () => {
    // 成员页行:glm 在跑 task_m1(运行块)+ 刚完成 task_done + 阻塞 task_w1(挂未决 awaits);
    // sol 的运行块是 glm 手里 disp_glm_3 的委派源(跨 Agent 交接边)。
    const glmRows = [
      dispatchRow({ dispatchId: "disp_glm_1", taskId: "task_m1", runtimeSessionId: "rs_glm_1", status: "running" }),
      dispatchRow({
        dispatchId: "disp_glm_2",
        taskId: "task_done",
        runtimeSessionId: "rs_glm_2",
        status: "succeeded",
        endedAt: LANES_RECENT,
        outcome: "succeeded",
      }),
      dispatchRow({
        dispatchId: "disp_glm_3",
        taskId: "task_w1",
        runtimeSessionId: "rs_glm_3",
        status: "blocked",
        parentRuntimeSessionId: "rs_sol_1",
        delegatedByAgentId: "sol",
        delegatedByAgentName: "Sol",
      }),
    ];
    const solRows = [
      dispatchRow({
        dispatchId: "disp_sol_1",
        taskId: "task_m1",
        runtimeSessionId: "rs_sol_1",
        status: "running",
        startedAt: LANES_RECENT,
      }),
    ];
    const groups = [
      agentGroup({ key: "agent:glm", agentId: "glm", label: "GLM Worker", runningCount: 2 }),
      agentGroup({ key: "agent:sol", agentId: "sol", label: "Sol", runningCount: 1 }),
    ];
    const restore = stubLanesBridge({ groups, members: { glm: glmRows, sol: solRows } });
    const onOpenTask = vi.fn();
    const container = mount({ onOpenTask });
    try {
      await flushUntil(() => container.querySelector('[data-testid="overview-drill-lanes"]') !== null);
      const drill = container.querySelector('[data-testid="overview-region-drill"]')!;
      // 泳道标签列来自 sessionGroups 的 agent 分组:两条泳道各自可见。
      expect(textOf(drill)).toContain("GLM Worker");
      expect(textOf(drill)).toContain("Sol");
      const lanes = container.querySelector('[data-testid="overview-agent-lanes"]')!;
      // 测试明确切到近期档,让短任务有足够像素展示其可操作的待拍板入口。
      act(() => lanes.querySelector<HTMLButtonElement>('[data-testid="overview-agent-lanes-range-15m"]')!.click());
      // 运行块随 now 生长(endAt=null);已完成块有确定终点;阻塞块挂待拍板(橙色描边语义
      // 在 AgentLanes 原语测试里直证,这里证数据接线与动作落点)。
      expect(lanes.querySelector('[data-testid="overview-agent-lanes-task-disp_glm_1"]')).not.toBeNull();
      expect(
        lanes.querySelector('[data-testid="overview-agent-lanes-task-disp_glm_1"]')!.getAttribute("data-lane-status"),
      ).toBe("running");
      expect(
        lanes.querySelector('[data-testid="overview-agent-lanes-task-disp_glm_2"]')!.getAttribute("data-lane-status"),
      ).toBe("done");
      const blocked = lanes.querySelector('[data-testid="overview-agent-lanes-task-disp_glm_3"]')!;
      expect(blocked.getAttribute("data-lane-status")).toBe("awaiting");
      // 泳道不再挂 Prompt Cache 倒计时:触达读面只轮询运行中会话,而运行一轮内缓存由
      // 模型调用本身保温,倒计时对操作者无意义;聚合胶囊随数据源一并退役。
      expect(lanes.querySelector('[data-testid^="overview-agent-lanes-cache-"]')).toBeNull();
      expect(drill.querySelector('[data-testid="overview-drill-cache-timer"]')).toBeNull();
      // 点击泳道任务块:直跳对应 Task 详情
      const runningBlock = lanes.querySelector<HTMLElement>('[data-testid="overview-agent-lanes-task-disp_glm_1"]')!;
      act(() => runningBlock.click());
      expect(onOpenTask).toHaveBeenCalledWith("task_m1");

      // 待拍板动作:task_w1 有未决 awaits(默认夹具 rel_1 的 sourceRef)→ 开答复面板。
      const resolve = lanes.querySelector<HTMLButtonElement>(
        '[data-testid="overview-agent-lanes-resolve-disp_glm_3"]',
      )!;
      expect(resolve).not.toBeNull();
      expect(resolve.getAttribute("data-tip")).toBe("接口要不要兼容旧字段?");
      act(() => resolve.click());
      expect(document.body.querySelector('[data-testid="awaits-answer-panel"]')).not.toBeNull();
    } finally {
      unmount();
      restore();
    }
  });

  it("只有 blocked 会话的 agent 块上有待批动作:通过选择器读成员派工并在块上展示待拍板按钮", async () => {
    // glm agent 的 runningCount 为 0,只有 blocked 会话
    const glmRows = [
      dispatchRow({
        dispatchId: "disp_glm_blocked",
        taskId: "task_w1",
        runtimeSessionId: "rs_glm_b1",
        status: "blocked",
      }),
    ];
    const groups = [
      agentGroup({
        key: "agent:glm",
        agentId: "glm",
        label: "GLM Worker",
        runningCount: 0,
        latestStatus: "blocked",
        latestRound: {
          runtimeSessionId: "rs_glm_b1",
          dispatchId: "disp_glm_blocked",
          agentName: "GLM Worker",
          instanceId: "inst_glm",
          status: "blocked",
          startedAt: LANES_RECENT,
        },
      }),
    ];
    const restore = stubLanesBridge({ groups, members: { glm: glmRows } });
    const container = mount();
    try {
      await flushUntil(
        () =>
          container
            .querySelector('[data-testid="overview-agent-lanes-resolve-disp_glm_blocked"]')
            ?.getAttribute("data-tip") === "接口要不要兼容旧字段?",
      );
      const lanes = container.querySelector('[data-testid="overview-agent-lanes"]')!;
      const block = lanes.querySelector('[data-testid="overview-agent-lanes-task-disp_glm_blocked"]')!;
      expect(block).not.toBeNull();
      expect(block.getAttribute("data-lane-status")).toBe("awaiting");
      // 待批动作按钮出现且带有提示(task_w1 对应默认夹具中的 rel_1 提问)
      const resolve = lanes.querySelector<HTMLButtonElement>(
        '[data-testid="overview-agent-lanes-resolve-disp_glm_blocked"]',
      )!;
      expect(resolve).not.toBeNull();
      expect(textOf(resolve)).toContain("待拍板");
      expect(resolve.getAttribute("data-tip")).toBe("接口要不要兼容旧字段?");
      // 点击动作正常打开答复面板
      act(() => resolve.click());
      expect(document.body.querySelector('[data-testid="awaits-answer-panel"]')).not.toBeNull();
    } finally {
      unmount();
      restore();
    }
  });

  it("组头兜底块按 group.taskId 跳转;没有 taskId 的兜底块不给点击入口", async () => {
    // 成员页缺席(该 agent 不在活跃成员页里)时泳道用组头 latestRound 兜底一块:
    // 有 taskId 的块要能跳到那个任务,没有 taskId 的块不能拿派工 id 冒充任务 id。
    const groups = [
      agentGroup({
        key: "agent:glm",
        agentId: "glm",
        label: "GLM Worker",
        runningCount: 1,
        taskId: "task_from_group",
        latestRound: {
          runtimeSessionId: "rs_glm_round",
          dispatchId: "disp_glm_round",
          agentName: "GLM Worker",
          instanceId: "inst_glm",
          status: "running",
          startedAt: LANES_RECENT,
        },
      }),
      agentGroup({
        key: "agent:sol",
        agentId: "sol",
        label: "Sol",
        runningCount: 1,
        latestRound: {
          runtimeSessionId: "rs_sol_round",
          agentName: "Sol",
          instanceId: "inst_sol",
          status: "running",
          startedAt: LANES_RECENT,
        },
      }),
    ];
    const restore = stubLanesBridge({ groups, members: {}, eventsBySession: {} });
    const onOpenTask = vi.fn();
    const container = mount({ onOpenTask });
    try {
      await flushUntil(
        () => container.querySelector('[data-testid="overview-agent-lanes-task-disp_glm_round"]') !== null,
      );
      const withTask = container.querySelector<HTMLElement>(
        '[data-testid="overview-agent-lanes-task-disp_glm_round"]',
      )!;
      expect(withTask.getAttribute("role")).toBe("button");
      act(() => withTask.click());
      expect(onOpenTask).toHaveBeenCalledWith("task_from_group");

      onOpenTask.mockClear();
      const withoutTask = container.querySelector<HTMLElement>(
        '[data-testid="overview-agent-lanes-task-rs_sol_round"]',
      )!;
      expect(withoutTask.getAttribute("role")).toBe("group");
      act(() => withoutTask.click());
      expect(onOpenTask).not.toHaveBeenCalled();
    } finally {
      unmount();
      restore();
    }
  });

  it("泳道空态与读失败都如实:空窗给正向信息,失败给错误条不冒充空", async () => {
    const restore = stubLanesBridge({ groups: [] });
    const container = mount();
    try {
      await flushUntil(
        () =>
          container
            .querySelector('[data-testid="overview-drill-wip-empty"]')
            ?.textContent?.includes("当前窗口没有并行运行") === true,
      );
      expect(textOf(container.querySelector('[data-testid="overview-drill-wip-empty"]')!)).toContain(
        "当前窗口没有并行运行的 Agent",
      );
    } finally {
      unmount();
      restore();
    }
    const restoreError = stubBridge({});
    const containerError = mount();
    try {
      await flushUntil(() => containerError.querySelector('[data-testid="overview-drill-lanes-error"]') !== null);
      expect(textOf(containerError.querySelector('[data-testid="overview-drill-lanes-error"]')!)).toContain(
        "Agent 泳道读取失败",
      );
    } finally {
      unmount();
      restoreError();
    }
  });

  it("WIP 读失败显示错误提示:占用数显示破折号且展示错误条,与空态区分", async () => {
    const restore = stubBridge({
      getTaskWip: () => Promise.reject(new Error("wip read timeout")),
      readUseCaseProjection: (payload) => {
        const wire = payload as { readonly payload?: Record<string, unknown> };
        const params = wire?.payload ?? (payload as Record<string, unknown>);
        if (params.name !== "runtime-session-groups") throw new Error(`unexpected projection: ${String(params.name)}`);
        return {
          ok: true,
          schema: "daemon.use-case-projection/v1",
          name: "runtime-session-groups",
          projection: {
            ok: true,
            status: "ready",
            groups: [],
            sessionAgents: [],
            totals: { groups: 0, sessions: 0 },
            truncated: false,
            watermark: 1,
            sourceRevision: 1,
          },
        };
      },
    });
    const container = mount();
    try {
      await flushUntil(() => container.querySelector('[data-testid="overview-drill-wip-error"]') !== null);
      const errorNotice = container.querySelector('[data-testid="overview-drill-wip-error"]')!;
      expect(textOf(errorNotice)).toContain("工作台占用读取失败:wip read timeout");
      // 空态提示被抑制,不冒充「当前窗口没有并行运行的 Agent」
      expect(container.querySelector('[data-testid="overview-drill-wip-empty"]')).toBeNull();
      // WIP chip 显示 — 占位
      const chip = container.querySelector('[data-testid="overview-drill-wip"]')!;
      expect(textOf(chip)).toContain("—");
    } finally {
      unmount();
      restore();
    }
  });

  it("置顶承诺 tab:点行直接进任务详情", async () => {
    const onOpenTask = vi.fn();
    const read = agenda({
      pinnedEntities: [
        { ref: "task/task_pin_go", kind: "task", title: "可派的置顶承诺", status: "planned", pinnedAt: AT },
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
    });
    const restore = stubBridge({ getTaskWip: () => wipSnapshot([]) });
    const container = mount({ onOpenTask, agenda: read });
    try {
      await flushUntil(() => container.querySelector('[data-testid="overview-drill-pinned"]') !== null);
      act(() => (container.querySelector('[data-testid="overview-drill-pinned"]') as HTMLButtonElement).click());
      const pinnedRow = container.querySelector('[data-drill-row="task_pin_go"]')!;
      act(() => (pinnedRow.querySelector("button") as HTMLElement).click());
      expect(onOpenTask).toHaveBeenCalledWith("task_pin_go");
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      unmount();
      restore();
    }
  });

  it("跟进下钻放大层走全局历史:点行推栈,层内换选中原地改,后退关层前进原路返回", async () => {
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
    const restore = stubBridge({ getTaskWip: () => wipSnapshot([]) });
    const container = mount({ agenda: read });
    try {
      await flushUntil(() => container.querySelector('[data-testid="overview-drill-followups"]') !== null);
      act(() => (container.querySelector('[data-testid="overview-drill-followups"]') as HTMLButtonElement).click());
      expect(historyOf().location.overviewFocus ?? null).toBeNull();
      const followRow = container.querySelector('[data-drill-row="relation/follow"]')!;
      act(() => (followRow.querySelector("button") as HTMLElement).click());
      expect(historyOf().location.overviewFocus).toEqual({ key: "followups", selectedId: "relation/follow" });
      expect(historyOf().canBack).toBe(true);

      act(() => historyOf().back());
      expect(historyOf().location.overviewFocus ?? null).toBeNull();
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      act(() => historyOf().forward());
      expect(historyOf().location.overviewFocus?.key).toBe("followups");
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    } finally {
      unmount();
      restore();
    }
  });

  it("tab 切换换内容:跟进/置顶各自铺名单,评审 tab 没有行就不出现", async () => {
    const restore = stubLanesBridge({ groups: [] });
    const container = mount();
    await flushUntil(
      () =>
        container
          .querySelector('[data-testid="overview-drill-wip-empty"]')
          ?.textContent?.includes("当前窗口没有并行运行") === true,
    );
    const drill = container.querySelector('[data-testid="overview-region-drill"]')!;
    // 泳道空窗是正向信息(当前没有并行 Agent),不是破壳。
    expect(textOf(container.querySelector('[data-testid="overview-drill-wip-empty"]')!)).toContain(
      "当前窗口没有并行运行的 Agent",
    );
    // 评审执行 tab 只在有行时出现:默认夹具没有三组评审行。
    expect(drill.querySelector('[data-testid="overview-drill-review"]')).toBeNull();
    // 切到跟进与返工:默认夹具的待初审/阻塞/停滞行直接可见(注意力序)。
    act(() => (drill.querySelector('[data-testid="overview-drill-followups"]') as HTMLElement).click());
    expect(drillRows(container)).toEqual(["execution/exec_1", "task/task_blk", "task/task_stuck"]);
    expect(textOf(drill)).toContain("已提交待初审");
    // 切到置顶承诺:默认夹具没有置顶 → 空态给真实入口提示。
    act(() => (drill.querySelector('[data-testid="overview-drill-pinned"]') as HTMLElement).click());
    expect(drill.querySelector('[data-testid="overview-drill-pinned-empty"]')).not.toBeNull();
    expect(textOf(container.querySelector('[data-testid="overview-drill-pinned-empty"]')!)).toContain("没有置顶承诺");
    unmount();
    restore();
  });

  it("跟进与返工空态是正向信息,不是破壳", () => {
    const read = agenda({
      attentionItems: [],
      answeredForYou: [],
      awaitingRework: [],
      awaitingAdjudication: [],
      waitingOnOthers: [],
      stalled: [],
    });
    const container = mount({ agenda: read });
    const drill = container.querySelector('[data-testid="overview-region-drill"]')!;
    act(() => (drill.querySelector('[data-testid="overview-drill-followups"]') as HTMLElement).click());
    expect(drill.querySelector('[data-testid="overview-drill-followups-empty"]')).not.toBeNull();
    expect(textOf(container.querySelector('[data-testid="overview-drill-followups-empty"]')!)).toContain(
      "当前没有需要跟进或返工的事项",
    );
    unmount();
  });

  it("评审执行 tab:有行才出现,名单分组分明,点行详情给收口/决策落点", () => {
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
    const reviewTab = drill.querySelector('[data-testid="overview-drill-review"]')!;
    expect(textOf(reviewTab)).toContain("评审执行");
    expect(textOf(reviewTab)).toContain("2");
    act(() => (reviewTab as HTMLElement).click());
    // 分组标签直接在行上,不再挂在芯片悬停。
    expect(textOf(drill)).toContain("任务评审中");
    expect(textOf(drill)).toContain("决策待派审");
    act(() =>
      (
        container.querySelector('[data-drill-row="taskReviewing:exec_rev"]')!.querySelector("button") as HTMLElement
      ).click(),
    );
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(textOf(dialog)).toContain("评审中的任务");
    const closeout = [...dialog.querySelectorAll("button")].find((button) => textOf(button) === "打开收口");
    act(() => closeout!.click());
    expect(onNavigateEntity).toHaveBeenCalledWith("taskreview/task_rev");
    unmount();
  });

  it("跟进与返工名单不亮红不冒充需要用户;点行弹放大层给答复原文", () => {
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
    act(() => (drill.querySelector('[data-testid="overview-drill-followups"]') as HTMLElement).click());
    // 名单与放大层同一份行:点已答复行,详情给答复原文与答复人。
    act(() =>
      (container.querySelector('[data-drill-row="relation/follow"]')!.querySelector("button") as HTMLElement).click(),
    );
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(textOf(dialog)).toContain("已答复的跟进项");
    expect(textOf(dialog)).toContain("已答复:继续");
    // 不冒充需要用户:整层没有红档(bad)状态标签。
    expect(dialog!.querySelectorAll('[data-status-tone="bad"]')).toHaveLength(0);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    unmount();
  });

  // 置顶承诺 tab 的行与两条解 pin 通道(任务 pin / 实体级解 pin)的行为面在
  // overview-pinned.vitest.tsx(按职责拆分自本文件,与行数上限无关)。

  it("全部工作/全部任务/会话入口收进区域页脚,接真实回调", () => {
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
    const runAt = minutesAgo(60);
    const previous = (globalThis as { harness?: unknown }).harness;
    vi.stubGlobal("harness", {
      request: (method: string) =>
        method === "getCiObservatory"
          ? Promise.resolve({
              schema: "daemon.ci-observatory/v1",
              ok: true,
              status: "ready",
              window: 30,
              importer: null,
              statisticsAvailability: "pending",
              missingDetails: [],
              tests: [],
              recoveries: [],
              shardDurations: [],
              gateTrends: [],
              l0MedianMs: null,
              runs: [
                {
                  eventId: "event-run-green",
                  identity: { workflow: "rewrite-ci", runAttempt: 1, databaseRunId: "123" },
                  scope: "job",
                  detailAvailability: "unavailable",
                  detail: null,
                  measurementCoverage: { status: "unknown", missingReason: "fixture" },
                  failedTests: [],
                  fileOutcomes: [],
                  runId: "run-green",
                  sha: "850840cdffffffffffffffffffffffffffffffff",
                  branch: "main",
                  prNumber: null,
                  job: "integration-shard-6",
                  wallclockMs: 600000,
                  runner: "ubuntu",
                  occurredAt: runAt,
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
    expect(textOf(topbar)).toContain("daemon 正常");
    expect(textOf(topbar)).not.toContain("main CI 绿");
    expect(textOf(topbar)).toContain("进行中 2");
    expect(topbar.querySelector('[data-testid="overview-ci-alert"]')).toBeNull();
    unmount();
    vi.stubGlobal("harness", previous);
  });

  it("daemon 无响应与投影落后升成显眼状态点", async () => {
    const failedRunAt = minutesAgo(60),
      pullRequestRunAt = minutesAgo(120);
    const restore = (globalThis as { harness?: unknown }).harness;
    vi.stubGlobal("harness", {
      request: (method: string) =>
        method === "getCiObservatory"
          ? Promise.resolve({
              schema: "daemon.ci-observatory/v1",
              ok: true,
              status: "ready",
              window: 30,
              importer: null,
              statisticsAvailability: "pending",
              missingDetails: [],
              tests: [],
              recoveries: [],
              shardDurations: [],
              gateTrends: [],
              l0MedianMs: null,
              runs: [
                {
                  eventId: "event-run-1",
                  identity: { workflow: "rewrite-ci", runAttempt: 1, databaseRunId: "123" },
                  scope: "job",
                  detailAvailability: "unavailable",
                  detail: null,
                  measurementCoverage: { status: "unknown", missingReason: "fixture" },
                  failedTests: [],
                  fileOutcomes: [],
                  runId: "run-1",
                  sha: "850840cdffffffffffffffffffffffffffffffff",
                  branch: "main",
                  prNumber: null,
                  job: "integration-shard-6",
                  wallclockMs: 600000,
                  runner: "ubuntu",
                  occurredAt: failedRunAt,
                  pass: false,
                  testCount: 10,
                  gateCount: 2,
                },
                {
                  eventId: "event-run-pr",
                  identity: { workflow: "rewrite-ci", runAttempt: 1, databaseRunId: "123" },
                  scope: "job",
                  detailAvailability: "unavailable",
                  detail: null,
                  measurementCoverage: { status: "unknown", missingReason: "fixture" },
                  failedTests: [],
                  fileOutcomes: [],
                  runId: "run-pr",
                  sha: "aaaaaaaaffffffffffffffffffffffffffffffff",
                  branch: "task_x",
                  prNumber: 3000,
                  job: "integration-shard-6",
                  wallclockMs: 600000,
                  runner: "ubuntu",
                  occurredAt: pullRequestRunAt,
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
    await flushUntil(() => textOf(container.querySelector('[data-testid="overview-topbar"]')).includes("投影落后 3"));
    const topbar = container.querySelector('[data-testid="overview-topbar"]')!;
    expect(textOf(topbar)).toContain("daemon 无响应");
    expect(textOf(topbar)).toContain("投影落后 3");
    // 正常小字被异常替代,不再同时出现。
    expect(textOf(topbar)).not.toContain("daemon 正常");
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

describe("总览顶栏状态词表(X4:一个词只指一件事)", () => {
  it("协作入口只报总数,不再并列一个按 lease 算的「执行中」", async () => {
    // 顶栏同时有「进行中 {活跃任务}」与「进行中占用 {count}/{limit}」两个同词计数;
    // 再来一个「执行中 {lease phase}」就是同一个词指两件事、数字还不一样(X4)。
    const container = mount({ collaboration: { total: 8, executing: 2 }, onOpenCollaboration: () => undefined });
    await flushUntil(
      () => container.querySelector('[data-testid="overview-topbar"]')?.textContent?.includes("协作") === true,
    );
    const entry = container.querySelector('[data-testid="overview-collaboration-entry"]')!;
    expect(textOf(entry)).toContain("协作 8");
    // 3 是入口上的总数,2 是旧的 lease 执行数:后者不许再出现。
    expect(textOf(entry)).not.toContain("执行中");
    expect(textOf(entry)).not.toContain("2");
    unmount();
  });

  it("顶栏所有状态计数只用「进行中」一词,不再混入「执行中」", async () => {
    const container = mount({ collaboration: { total: 8, executing: 2 }, onOpenCollaboration: () => undefined });
    await flushUntil(
      () => container.querySelector('[data-testid="overview-topbar"]')?.textContent?.includes("进行中") === true,
    );
    const topbar = container.querySelector('[data-testid="overview-topbar"]')!;
    expect(textOf(topbar)).not.toContain("执行中");
    unmount();
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
    // 只报总数:再并列一个按 lease phase 算的「执行中 2」就是同一个词指两件事(X4)。
    expect(entry!.textContent).toContain("8");
    expect(entry!.textContent).not.toContain("执行中");
    act(() => entry!.click());
    expect(opened).toEqual(["collaboration"]);
    unmount();

    const local = mount({ collaboration: null });
    expect(local.querySelector('[data-testid="overview-collaboration-entry"]')).toBeNull();
    unmount();
  });
});
