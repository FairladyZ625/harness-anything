// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentLanesOf,
  awaitsByTask,
  decisionRows,
  pinnedTaskRows,
  runRows,
  runningTaskRows,
  watchedWorks,
  workRows,
} from "../src/renderer/views/overview-model.ts";
import type { AgentRuntimeOverviewResult, AgentRuntimeSessionGroupDto } from "@harness-anything/daemon/protocol";
import type { TaskDispatchProjectionRow } from "../src/api/renderer-dto.ts";
import { harnessClient } from "../src/renderer/api-client.ts";
import {
  AT,
  HEALTH,
  HEALTH_DOWN,
  WORKS,
  WORKS_EMPTY,
  agenda,
  setupOverviewBoardEnvironment,
  mountOverview as mount,
  textOf,
  flushUntil,
  unmountOverview as unmount,
} from "./overview-board.fixtures.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";

/**
 * 总览(2026-10-21 任务列表为主,泳道移出总览)的行为面:左上「在跑的任务」
 * 窄行名单(标题、谁在跑、跑了多久、现在哪一步;卡点行的问句进悬停与答复动作),右上
 * 「置顶与议程」把 pin 拿回总览,左下「关注的工作」只留标题、进度、负责人,右下
 * 「等你处理的事」取待办签发前几条(Needs you 绝对顶置、橙色提问档)。置顶区的行为面
 * 在 overview-pinned.vitest.tsx;共享挂载夹具在 overview-board.fixtures.ts。
 */

beforeAll(() => {
  setupOverviewBoardEnvironment();
});

const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

describe("总览:右下「等你处理的事」", () => {
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
    const awaits = container.querySelector('[data-testid="overview-region-awaits"]')!;
    expect(textOf(awaits)).toContain("边缘 RBAC 设计裁决");
    expect(textOf(awaits)).toContain("是否冻结旧投影字段");
    // 四类不进待办签发:待初审是 owning CEO 的机器双闸,待跟进/返工/阻塞同样不冒充需要用户。
    expect(textOf(awaits)).not.toContain("总览重构的提交");
    expect(textOf(awaits)).not.toContain("已答复的跟进项");
    expect(textOf(awaits)).not.toContain("返工中的任务");
    expect(textOf(awaits)).not.toContain("被阻塞的成员任务");
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
    const awaits = container.querySelector('[data-testid="overview-awaits"]')!;
    const rows = [...awaits.querySelectorAll("[data-awaits-row]")];
    expect(rows[0]!.getAttribute("data-awaits-row")).toBe("relation/rel_1");
    expect(rows[1]!.getAttribute("data-awaits-row")).toBe("decision/dec_hot");
    // awaiting-you 行用 agent-question 橙 tone(严格区别于 wait 琥珀);decision 保持 wait。
    expect(rows[0]!.querySelector('[data-status-tone="agent-question"]')).not.toBeNull();
    expect(rows[1]!.querySelector('[data-status-tone="wait"]')).not.toBeNull();
    expect(textOf(awaits)).toContain("需要你");
    unmount();
  });

  it("每条说明问题、受影响工作与推荐(未提供不造假)", () => {
    const container = mount();
    const awaits = container.querySelector('[data-testid="overview-awaits"]')!;
    // 问题:awaits 的问句原话。
    expect(textOf(awaits)).toContain("接口要不要兼容旧字段?");
    // 受影响工作:工作索引的标题。
    expect(textOf(awaits)).toContain("代码质量长期检验");
    // 决策行如实写「未归属工作」;两类各带一条「推荐:未提供」。
    expect(textOf(awaits)).toContain("未归属工作");
    expect(textOf(awaits).split("推荐:未提供").length - 1).toBe(2);
    unmount();
  });

  it("动作接真实落点:答复开面板,裁决走实体导航", () => {
    const onNavigateEntity = vi.fn();
    const container = mount({ onNavigateEntity });
    const awaits = container.querySelector('[data-testid="overview-awaits"]')!;
    const answer = [...awaits.querySelectorAll("button")].find((button) => textOf(button) === "答复");
    expect(answer).toBeDefined();
    act(() => answer!.click());
    expect(document.body.querySelector('[data-testid="awaits-answer-panel"]')).not.toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.body.querySelector('[data-testid="awaits-answer-panel"]')).toBeNull();
    const adjudicate = [...awaits.querySelectorAll("button")].find((button) => textOf(button) === "去裁决");
    act(() => adjudicate!.click());
    expect(onNavigateEntity).toHaveBeenCalledWith("decision/dec_1");
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
    const awaits = container.querySelector('[data-testid="overview-awaits"]')!;
    expect(awaits.querySelectorAll("[data-awaits-row]")).toHaveLength(3);
    expect(awaits.querySelector('[data-testid="overview-awaits-expand"]')).not.toBeNull();
    expect(textOf(awaits)).toContain("还有 3 项");
    act(() => (awaits.querySelector('[data-testid="overview-awaits-expand"]') as HTMLButtonElement).click());
    expect(awaits.querySelectorAll("[data-awaits-row]")).toHaveLength(6);
    expect(textOf(awaits)).toContain("追加决策 3");
    act(() => (awaits.querySelector('[data-testid="overview-awaits-collapse"]') as HTMLButtonElement).click());
    expect(awaits.querySelectorAll("[data-awaits-row]")).toHaveLength(3);
    unmount();
  });

  it("空态是正向信息,并如实指回去处(不与侧栏待办签发角标矛盾)", () => {
    const onOpenPool = vi.fn();
    const container = mount({
      onOpenPool,
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
    const awaits = container.querySelector('[data-testid="overview-awaits"]')!;
    expect(textOf(awaits)).toContain("没有等你拍板的事项");
    expect(textOf(awaits)).not.toContain("边缘 RBAC");
    // 本块只列要本人动手的;「决策待裁」域里的其余 proposed(评审中等)在总池,给条数与入口。
    expect(textOf(awaits)).toContain("待办签发共 2 项决策待裁");
    const pool = awaits.querySelector<HTMLButtonElement>('[data-testid="overview-awaits-inbox-open"]')!;
    act(() => pool.click());
    expect(onOpenPool).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe("总览:右下「等你处理的事」含任务侧人签", () => {
  /** 带冻结契约的 submitted execution(与待办签发总池同一形状,判据在 model/attestation-pool.ts)。 */
  const submittedExecution = (taskId: string, gateId: string) => ({
    schema: "execution/v1",
    executionId: `execution-${taskId}`,
    taskId,
    nodeId: "implementation",
    iteration: 0,
    state: "submitted",
    actor: { principal: { personId: "person-owner" }, executor: null },
    claimedAt: AT,
    submittedAt: AT,
    closedAt: null,
    submission: {
      completionClaim: "done",
      deliverables: ["report"],
      outputs: ["artifacts/report.md"],
      verificationNotes: [],
      knownGaps: [],
      residualRisks: [],
      commitSha: "a".repeat(40),
      completionContract: {
        gates: [
          {
            gateId,
            appliesTo: "submission",
            witness: { adapterId: "manual-attest", adapterOptions: {} },
          },
        ],
      },
    },
  });

  const signoffTask = (overrides: Record<string, unknown>) =>
    ({
      title: "待签发任务",
      projectId: "probe-repo",
      coordinationStatus: "in_review",
      rawStatus: "in_review/review",
      freshness: "fresh",
      packageDisposition: "active",
      closeoutReadiness: "incomplete",
      engine: "kernel/task-lifecycle/v1",
      origin: "native",
      source: "local-document",
      lastKnownAt: AT,
      gates: [],
      board: projectedTaskFields("in_review").board,
      visibility: projectedTaskFields("in_review").visibility,
      capabilities: projectedTaskFields("in_review").capabilities,
      risk: projectedTaskFields("in_review").risk,
      phase: projectedTaskFields("in_review").phase,
      docs: [],
      ...overrides,
    }) as never;

  it("人签行与决策行并列;空态只在两类都为空时出现(不再与侧栏待办签发矛盾)", () => {
    const gateTask = signoffTask({
      taskId: "task_gate",
      title: "待签门的任务",
      iteration: 0,
      gates: [{ name: "ux-signoff", ok: null, status: "missing", detail: "no witness" }],
      executions: [submittedExecution("task_gate", "ux-signoff")],
    });
    const consentTask = signoffTask({ taskId: "task_consent", title: "待同意收口的任务", closeoutBlocker: "consent" });
    const onOpenTask = vi.fn();
    const onOpenSignoffs = vi.fn();
    const container = mount({
      tasks: [gateTask, consentTask],
      // 决策侧为空:只有人签时不再显示「没有等你处理的事项」。
      agenda: agenda({ attentionItems: [], awaitingYou: [], awaitingDecision: [], awaitingAdjudication: [] }),
      onOpenTask,
      onOpenSignoffs,
    });
    const awaits = container.querySelector('[data-testid="overview-awaits"]')!;
    expect(textOf(awaits)).not.toContain("没有等你处理的事项");
    // 区域头标签数的是块里列出的两类(决策 + 人签),与块内行数一致。
    expect(textOf(container.querySelector('[data-testid="overview-region-awaits"]'))).toContain("待你拍板 2 项");
    expect(textOf(awaits)).toContain("待签门的任务");
    expect(textOf(awaits)).toContain("待我签");
    expect(textOf(awaits)).toContain("ux-signoff");
    expect(textOf(awaits)).toContain("待同意收口的任务");
    expect(textOf(awaits)).toContain("待同意");
    // 门签落任务详情(签发表单在那里),收口同意落待办签发总池。
    const gateRow = container.querySelector('[data-signoff-row="task_gate:ux-signoff"]')!;
    act(() => (gateRow.querySelector("button") as HTMLButtonElement).click());
    expect(onOpenTask).toHaveBeenCalledWith("task_gate");
    const consentRow = container.querySelector('[data-signoff-row="task_consent:consent"]')!;
    act(() => (consentRow.querySelector("button") as HTMLButtonElement).click());
    expect(onOpenSignoffs).toHaveBeenCalledWith("task_consent");
    unmount();
  });
});

describe("总览:左下「关注的工作」", () => {
  it("置顶的工作保留在前(含已收尾的),其余近期工作随后", () => {
    const container = mount({
      agenda: agenda({
        pinnedEntities: [
          { ref: "task/task_w1", kind: "task", title: "代码质量长期检验", status: "active", pinnedAt: AT },
          { ref: "task/task_w_done", kind: "task", title: "已收尾的工作", status: "done", pinnedAt: AT },
        ],
      }),
    });
    const works = container.querySelector('[data-testid="overview-region-works"]')!;
    // 块头「置顶 N 项」数的是本块列出的置顶工作行,含已收尾的那一项。
    expect(textOf(works)).toContain("置顶 2 项 · 3");
    expect(textOf(works)).toContain("代码质量长期检验");
    // 已收尾的置顶工作仍列名可见(业主 2026-10-21:不管 pin 什么,总览上都要能看到),
    // 只是排在非终态置顶与其后的近期工作之后。
    expect(textOf(works)).toContain("已收尾的工作");
    const cards = [...works.querySelectorAll("[data-work-card]")].map((card) => card.getAttribute("data-work-card"));
    expect(cards).toEqual(["task_w1", "task_w2", "task_w_done"]);
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

  it("工作行只留标题、进度与负责人;模型名用短标签,不出现候选元组", async () => {
    // 会话型运行时把候选清单写进 model(JSON 数组文本):短标签只给第一个候选加 +N,
    // 元组字符串不进正文(2026-10-21 CEO 截图补充:处理者显示成元组字符串是缺陷)。
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
                  definitionSnapshot: { model: '["deepseek-official","Deepseek-V4.1-Flash"]' },
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
      () => container.querySelector("[data-work-card='task_w1']")?.textContent?.includes("deepseek") === true,
    );
    const card = container.querySelector("[data-work-card='task_w1']")!;
    const text = textOf(card);
    // 第二行(2026-10-21 定案只留标题、进度、负责人):SegBar 分段条 + 紧凑 done/total
    // 计数、进行中子任务数、执行者;等你处理/跟进计数不挤工作行(右下块已覆盖)。
    expect([...card.querySelectorAll("[data-segment]")].map((node) => node.getAttribute("data-segment"))).toEqual([
      "done",
      "active",
    ]);
    expect(text).toContain("2/3");
    expect(text).toContain("进行中 1");
    expect(text).toContain("deepseek-official +1");
    expect(text).not.toContain('["deepseek-official","Deepseek-V4.1-Flash"]');
    expect(text).not.toContain("等你处理");
    const hover = card.querySelector("[data-dense-row]")!.getAttribute("title")!;
    expect(hover).toContain("子任务完成 2/3");
    expect(hover).toContain("未完成 1");
    // 行尾时间给最近活动的相对年龄(活动窗口的口径本体)。
    expect(text).toMatch(/分钟前|小时前|刚刚|天/u);
    // 点行进工作详情,不再需要行内「打开工作」按钮。
    act(() => (card.querySelector("button") as HTMLButtonElement).click());
    expect(onOpenTask).toHaveBeenCalledWith("task_w1");
    unmount();
    // 还原默认桥:后续用例的 runtime 读面回到确定性失败。
    vi.stubGlobal("harness", { request: () => Promise.reject(new Error("no bridge in test")) });
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

describe("总览:左上「在跑的任务」(窄行名单,泳道数据同源)", () => {
  /** 泳道三段读面的桥 stub:sessionGroups(agent 分组) + 活跃 agent 成员派工页。 */
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

  /** 总览的「现在」取渲染时刻的墙钟;6h 窗口内的块必须用近期时间构造,否则真实的
   *  窗口过滤会把它们当历史轮次丢掉(这本身就是要验证的行为)。 */
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
  }): () => void {
    const previous = (globalThis as { harness?: unknown }).harness;
    const paramsOf = (payload: unknown): Record<string, unknown> => {
      const wire = payload as { readonly payload?: Record<string, unknown> };
      return wire?.payload ?? (payload as Record<string, unknown>);
    };
    vi.stubGlobal("harness", {
      request: (method: string, payload: unknown) => {
        if (method === "readUseCaseProjection") {
          const params = paramsOf(payload);
          if (params.name !== "runtime-session-groups")
            return Promise.reject(new Error(`unexpected projection: ${String(params.name)}`));
          return Promise.resolve({
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
          });
        }
        if (method === "getTaskDispatches") {
          const params = paramsOf(payload);
          const agentId = String(params.agentId ?? "");
          const rows = input.members?.[agentId];
          if (rows === undefined) return Promise.reject(new Error(`unexpected member page: ${agentId}`));
          return Promise.resolve({
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
          });
        }
        return Promise.reject(new Error("no bridge in test"));
      },
    });
    return () => vi.stubGlobal("harness", previous);
  }

  it("运行行给标题/执行者/时长;卡点行置前并给答复动作,点行直接进任务", async () => {
    // glm 在跑 task_m1(运行行)+ 阻塞 task_w1(挂未决 awaits,卡点行);sol 也在跑
    // task_m1(同一任务收敛成一行,取卡点侧)。模型短标签收候选清单。
    const glmRows = [
      dispatchRow({
        dispatchId: "disp_glm_1",
        taskId: "task_m1",
        runtimeSessionId: "rs_glm_1",
        status: "running",
        provider: { instance: "glm", model: '["deepseek-official","Deepseek-V4.1-Flash"]' },
      }),
      dispatchRow({
        dispatchId: "disp_glm_3",
        taskId: "task_w1",
        runtimeSessionId: "rs_glm_3",
        status: "blocked",
      }),
    ];
    const solRows = [
      dispatchRow({
        dispatchId: "disp_sol_1",
        taskId: "task_m1",
        runtimeSessionId: "rs_sol_1",
        status: "running",
        // 比 glm 的运行块更早:同一任务收敛一行时取更新的 glm 块(带候选清单模型)。
        startedAt: new Date(Date.now() - 9 * 60_000).toISOString(),
      }),
    ];
    const groups = [
      agentGroup({ key: "agent:glm", agentId: "glm", label: "GLM Worker", runningCount: 1 }),
      agentGroup({ key: "agent:sol", agentId: "sol", label: "Sol", runningCount: 1 }),
    ];
    const onOpenTask = vi.fn();
    const restore = stubLanesBridge({ groups, members: { glm: glmRows, sol: solRows } });
    const container = mount({ onOpenTask });
    try {
      await flushUntil(() => container.querySelectorAll("[data-running-row]").length >= 2);
      const rows = [...container.querySelectorAll("[data-running-row]")].map(
        (row) => row.getAttribute("data-running-row")!,
      );
      // 卡点行置前(业主要先看「卡在哪」);同一任务多 agent 收敛一行。
      expect(rows).toEqual(["task_w1", "task_m1"]);
      const blocked = container.querySelector("[data-running-row='task_w1']")!;
      // 状态词用会话侧运行词表:卡点 = 待拍板,运行 = 运行中。
      expect(textOf(blocked)).toContain("待拍板");
      expect(textOf(blocked)).toContain("GLM Worker · glm-5.3");
      // 卡点问句进悬停(不挤窄行正文),同时是这一行的「现在哪一步」。
      expect(blocked.querySelector("[data-dense-row]")!.getAttribute("title")).toContain("接口要不要兼容旧字段?");
      expect(textOf(blocked)).toContain("接口要不要兼容旧字段?");
      const running = container.querySelector("[data-running-row='task_m1']")!;
      expect(textOf(running)).toContain("运行中");
      // 现在哪一步:普通派工给「实现」,行内可见,不只悬停。
      expect(textOf(running)).toContain("实现");
      // 模型短标签:候选清单收成第一个候选 +N,元组字符串不进正文。
      expect(textOf(running)).toContain("deepseek-official +1");
      expect(textOf(running)).not.toContain('["deepseek-official","Deepseek-V4.1-Flash"]');
      // 时长给了(块起点至今,紧凑写法)。
      expect(textOf(running)).toMatch(/\d+[smh]/u);
      // 卡点行的「答复」开答复面板;点行本身直接进任务详情。
      const resolve = [...blocked.querySelectorAll("button")].find((button) => textOf(button) === "答复")!;
      act(() => resolve.click());
      expect(document.body.querySelector('[data-testid="awaits-answer-panel"]')).not.toBeNull();
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });
      act(() => (running.querySelector("button") as HTMLButtonElement).click());
      expect(onOpenTask).toHaveBeenCalledWith("task_m1");
    } finally {
      unmount();
      restore();
    }
  });

  it("评审派工行给「评审任务/评审决策」这一步(派工行 reviewTarget 的直接读法)", async () => {
    const reviewer = dispatchRow({
      dispatchId: "disp_glm_rev",
      taskId: "task_rev",
      runtimeSessionId: "rs_glm_rev",
      status: "running",
      reviewTarget: { kind: "task", taskId: "task_rev", executionId: "exec_rev", digest: "sha256:review" },
    });
    const decisionReviewer = dispatchRow({
      dispatchId: "disp_glm_dec",
      taskId: "task_dec",
      runtimeSessionId: "rs_glm_dec",
      status: "running",
      reviewTarget: { kind: "decision", decisionId: "dec_rev", digest: "sha256:decision" },
    });
    const restore = stubLanesBridge({
      groups: [agentGroup({ runningCount: 2 })],
      members: { glm: [reviewer, decisionReviewer] },
    });
    const container = mount();
    try {
      await flushUntil(() => container.querySelectorAll("[data-running-row]").length >= 2);
      expect(textOf(container.querySelector("[data-running-row='task_rev']"))).toContain("评审任务");
      expect(textOf(container.querySelector("[data-running-row='task_dec']"))).toContain("评审决策");
    } finally {
      unmount();
      restore();
    }
  });

  it("blocked 但没有未决 awaits 的行不给假答复入口,点行直接进任务详情", async () => {
    const glmRows = [
      dispatchRow({
        dispatchId: "disp_glm_b",
        taskId: "task_other",
        runtimeSessionId: "rs_glm_b",
        status: "blocked",
        reason: "quota_exhausted",
      }),
    ];
    const onOpenTask = vi.fn();
    const restore = stubLanesBridge({
      groups: [agentGroup({ runningCount: 0, latestStatus: "blocked" })],
      members: { glm: glmRows },
    });
    const container = mount({ onOpenTask, agenda: agenda({ awaitingYou: [] }) });
    try {
      await flushUntil(() => container.querySelector("[data-running-row='task_other']") !== null);
      const blocked = container.querySelector("[data-running-row='task_other']")!;
      expect([...blocked.querySelectorAll("button")].some((button) => textOf(button) === "答复")).toBe(false);
      // reason 进悬停,如实说明卡点。
      expect(blocked.querySelector("[data-dense-row]")!.getAttribute("title")).toContain("quota_exhausted");
      act(() => (blocked.querySelector("button") as HTMLButtonElement).click());
      expect(onOpenTask).toHaveBeenCalledWith("task_other");
    } finally {
      unmount();
      restore();
    }
  });

  it("空态与读失败都如实:空窗给正向信息,失败给错误条不冒充空", async () => {
    const restore = stubLanesBridge({ groups: [] });
    const container = mount();
    try {
      await flushUntil(
        () =>
          container
            .querySelector('[data-testid="overview-running-empty"]')
            ?.textContent?.includes("当前窗口没有在跑的任务") === true,
      );
    } finally {
      unmount();
      restore();
    }
    const restoreError = (() => {
      const previous = (globalThis as { harness?: unknown }).harness;
      vi.stubGlobal("harness", { request: () => Promise.reject(new Error("no bridge in test")) });
      return () => vi.stubGlobal("harness", previous);
    })();
    const containerError = mount();
    try {
      await flushUntil(() => containerError.querySelector('[data-testid="overview-running-error"]') !== null);
      expect(textOf(containerError.querySelector('[data-testid="overview-running-error"]')!)).toContain(
        "在跑任务读取失败",
      );
    } finally {
      unmount();
      restoreError();
    }
  });
});

describe("总览:区域页脚与全量入口", () => {
  it("全部任务/查看会话收在跑任务块页脚,全部工作收关注工作块页脚,接真实回调", () => {
    const onOpenWorks = vi.fn();
    const onOpenTasks = vi.fn();
    const onOpenSessions = vi.fn();
    const container = mount({ onOpenWorks, onOpenTasks, onOpenSessions });
    const running = container.querySelector('[data-testid="overview-region-running"]')!;
    const works = container.querySelector('[data-testid="overview-region-works"]')!;
    act(() =>
      ([...running.querySelectorAll("button")].find((b) => textOf(b) === "全部任务") as HTMLButtonElement).click(),
    );
    act(() =>
      ([...running.querySelectorAll("button")].find((b) => textOf(b) === "查看会话") as HTMLButtonElement).click(),
    );
    act(() =>
      ([...works.querySelectorAll("button")].find((b) => textOf(b) === "全部工作") as HTMLButtonElement).click(),
    );
    expect(onOpenWorks).toHaveBeenCalledTimes(1);
    expect(onOpenTasks).toHaveBeenCalledTimes(1);
    expect(onOpenSessions).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe("总览:四块布局", () => {
  it("左上在跑任务、右上置顶议程、左下关注工作、右下等你处理;产物与全局泳道不在总览", () => {
    const container = mount();
    for (const region of [
      "overview-region-running",
      "overview-region-pins",
      "overview-region-works",
      "overview-region-awaits",
    ]) {
      expect(container.querySelector(`[data-testid="${region}"]`), region).not.toBeNull();
    }
    // 全局泳道与最新产物速览架已移出总览(2026-10-21 定案):组件保留给任务弹层/现场页。
    expect(container.querySelector('[data-testid="overview-agent-lanes"]')).toBeNull();
    expect(container.querySelector('[data-testid="overview-region-artifacts"]')).toBeNull();
    expect(container.querySelector('[data-testid="overview-decisions-band"]')).toBeNull();
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

  it("daemon 无响应仍是显眼状态点，且不被投影读数抢走", async () => {
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
      health: { ...HEALTH_DOWN, projection: { ...HEALTH_DOWN.projection, lag: 3, status: "pending" } },
    });
    await flushUntil(() =>
      textOf(container.querySelector('[data-testid="overview-topbar"]')).includes("daemon 无响应"),
    );
    const topbar = container.querySelector('[data-testid="overview-topbar"]')!;
    expect(textOf(topbar)).toContain("daemon 无响应");
    // 新判定里 daemon 无响应是 down,不再并列一个「投影落后」pill(投影读不出来时后者没有增量)。
    expect(textOf(topbar)).not.toContain("投影落后 3");
    // 正常小字被异常替代,不再同时出现。
    expect(textOf(topbar)).not.toContain("daemon 正常");
    unmount();
    vi.stubGlobal("harness", restore);
  });

  it("持续跨过宽限的投影落后才升成告警状态点", async () => {
    const container = mount({
      health: {
        ...HEALTH,
        projection: { ...HEALTH.projection, lag: 3, status: "pending" },
        transient: { lagSince: minutesAgo(2), unknownSince: null, lagAgeSec: 120, unknownAgeSec: null },
      },
    });
    await flushUntil(() => textOf(container.querySelector('[data-testid="overview-topbar"]')).includes("投影落后 3"));
    const topbar = container.querySelector('[data-testid="overview-topbar"]')!;
    expect(textOf(topbar)).toContain("投影落后 3");
    expect(textOf(topbar)).not.toContain("daemon 正常");
    unmount();
  });

  it("瞬时投影落后保持中性，不在顶栏升成告警", async () => {
    const container = mount({
      health: {
        ...HEALTH,
        projection: { ...HEALTH.projection, lag: 3, status: "pending" },
        transient: { lagSince: minutesAgo(0), unknownSince: null, lagAgeSec: 2, unknownAgeSec: null },
      },
    });
    await flushUntil(() => container.querySelector('[data-testid="overview-topbar"]') !== null);
    expect(textOf(container.querySelector('[data-testid="overview-topbar"]'))).not.toContain("投影落后 3");
    unmount();
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
  it("decisionRows 只收真实待人两类", () => {
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
  });

  it("runRows 的执行者给模型短标签:候选清单收短,普通模型名原样", () => {
    const overview = {
      ok: true,
      status: "ready",
      installations: [],
      instances: [],
      sessions: [
        {
          runtimeSessionId: "rs_tuple",
          kindId: "codex",
          liveness: "live",
          definitionSnapshot: { model: '["deepseek-official","Deepseek-V4.1-Flash"]' },
          associations: [{ taskId: "task_m1" }],
          activity: { lastObservedAt: AT },
        },
        {
          runtimeSessionId: "rs_plain",
          kindId: "zcode",
          liveness: "live",
          definitionSnapshot: { model: "glm-5.3" },
          associations: [{ taskId: "task_w1" }],
          activity: { lastObservedAt: AT },
        },
        {
          runtimeSessionId: "rs_nosnap",
          kindId: "codex",
          liveness: "live",
          definitionSnapshot: null,
          associations: [],
          activity: { lastObservedAt: AT },
        },
      ],
      watermark: 7,
      sourceRevision: 7,
    } as unknown as AgentRuntimeOverviewResult;
    const whoOf = new Map(runRows(overview, undefined).map(({ runtimeSessionId, who }) => [runtimeSessionId, who]));
    expect(whoOf.get("rs_tuple")).toBe("codex · deepseek-official +1");
    expect(whoOf.get("rs_plain")).toBe("zcode · glm-5.3");
    expect(whoOf.get("rs_nosnap")).toBe("codex");
  });

  it("watchedWorks:置顶保留在前不受窗口限制;其余按活动窗口过滤;终态置顶仍列出但沉后", () => {
    const base = agenda();
    const pinned = watchedWorks(WORKS, {
      ...base,
      pinnedEntities: [
        { ref: "task/task_w1", kind: "task", title: "代码质量长期检验", status: "active", pinnedAt: AT },
      ],
    });
    expect(pinned.map(({ work, source }) => [work.taskId, source])).toEqual([
      ["task_w1", "pinned"],
      ["task_w2", "recent"],
    ]);
    // 已收尾的置顶工作仍列出(业主:不管 pin 什么总览都要能看到),只是沉到非终态之后。
    const closed = watchedWorks(WORKS, {
      ...base,
      pinnedEntities: [{ ref: "task/task_w_done", kind: "task", title: "已收尾的工作", status: "done", pinnedAt: AT }],
    });
    expect(closed.map(({ work }) => work.taskId)).toEqual(["task_w1", "task_w2", "task_w_done"]);
    expect(closed.filter(({ source }) => source === "pinned").map(({ work }) => work.taskId)).toEqual(["task_w_done"]);
    expect(closed.some(({ work }) => work.taskId === "task_w_done")).toBe(true);
    // 活动窗口(意见 4):未置顶工作只在窗口内才列,置顶不受窗口限制;W2-T1 起名下有
    // Needs you 项的工作(默认夹具 rel_1 挂在 task_w1)压过置顶——它卡在等人。
    const stale = { ...WORKS.works[1]!, lastActivityAt: "2026-09-01T00:00:00.000Z" },
      fresh = WORKS.works[0]!,
      windowed = watchedWorks(
        { ...WORKS, works: [stale, fresh, WORKS.works[2]!] },
        {
          ...base,
          pinnedEntities: [
            { ref: "task/task_w2", kind: "task", title: "网关读面加缓存", status: "active", pinnedAt: AT },
          ],
        },
        { days: 3, now: new Date().toISOString() },
      );
    expect(windowed.map(({ work }) => work.taskId)).toEqual(["task_w1", "task_w2"]);
  });

  it("watchedWorks:活跃执行工作优先置顶,再按最新活动时间倒序,在跑工作不被窗口截断", () => {
    const baseWorks: WorkIndexRead = {
      schema: "daemon.work-index/v1",
      ok: true,
      status: "ready",
      works: [
        {
          taskId: "work_pinned_older",
          title: "旧置顶待命工作",
          status: "active",
          root: "declared",
          parentTaskId: null,
          taskCount: 1,
          counts: { done: 0, executing: 0, pending: 0, blocked: 0, planned: 1, cancelled: 0 },
          lastActivityAt: "2026-10-14T08:00:00.000Z",
          memberTaskIds: ["task_m_po"],
        },
        {
          taskId: "work_pinned_newer",
          title: "新置顶待命工作",
          status: "active",
          root: "declared",
          parentTaskId: null,
          taskCount: 1,
          counts: { done: 0, executing: 0, pending: 0, blocked: 0, planned: 1, cancelled: 0 },
          lastActivityAt: "2026-10-14T10:00:00.000Z",
          memberTaskIds: ["task_m_pn"],
        },
        {
          taskId: "work_recent_older",
          title: "旧近期待命工作",
          status: "active",
          root: "declared",
          parentTaskId: null,
          taskCount: 1,
          counts: { done: 0, executing: 0, pending: 0, blocked: 0, planned: 1, cancelled: 0 },
          lastActivityAt: "2026-10-14T07:00:00.000Z",
          memberTaskIds: ["task_m_ro"],
        },
        {
          taskId: "work_recent_newer",
          title: "新近期待命工作",
          status: "active",
          root: "declared",
          parentTaskId: null,
          taskCount: 1,
          counts: { done: 0, executing: 0, pending: 0, blocked: 0, planned: 1, cancelled: 0 },
          lastActivityAt: "2026-10-14T11:00:00.000Z",
          memberTaskIds: ["task_m_rn"],
        },
        {
          taskId: "work_recent_running",
          title: "近期在跑工作",
          status: "active",
          root: "declared",
          parentTaskId: null,
          taskCount: 2,
          counts: { done: 0, executing: 1, pending: 0, blocked: 0, planned: 1, cancelled: 0 },
          lastActivityAt: "2026-10-14T09:00:00.000Z",
          memberTaskIds: ["task_m_rr"],
        },
        {
          taskId: "work_pinned_running",
          title: "置顶在跑工作",
          status: "active",
          root: "declared",
          parentTaskId: null,
          taskCount: 2,
          counts: { done: 0, executing: 1, pending: 0, blocked: 0, planned: 1, cancelled: 0 },
          lastActivityAt: "2026-10-14T09:30:00.000Z",
          memberTaskIds: ["task_m_pr"],
        },
        {
          taskId: "work_recent_running_stale_activity",
          title: "窗口外但在跑工作",
          status: "active",
          root: "declared",
          parentTaskId: null,
          taskCount: 2,
          counts: { done: 0, executing: 1, pending: 0, blocked: 0, planned: 1, cancelled: 0 },
          lastActivityAt: "2026-10-01T00:00:00.000Z", // 远早于3天窗口
          memberTaskIds: ["task_m_stale_running"],
        },
      ],
      watermark: 1,
      sourceRevision: 1,
      warnings: [],
    };

    const agendaData = agenda({
      pinnedEntities: [
        { ref: "task/work_pinned_older", kind: "task", title: "旧置顶待命工作", status: "active", pinnedAt: AT },
        { ref: "task/work_pinned_newer", kind: "task", title: "新置顶待命工作", status: "active", pinnedAt: AT },
        { ref: "task/work_pinned_running", kind: "task", title: "置顶在跑工作", status: "active", pinnedAt: AT },
      ],
    });

    const runtimeData = {
      ok: true,
      status: "ready",
      installations: [],
      instances: [],
      sessions: [
        {
          runtimeSessionId: "rs_pr",
          kindId: "codex",
          liveness: "live",
          definitionSnapshot: { model: "gpt-6.1-sol" },
          associations: [{ taskId: "task_m_pr" }],
          activity: { lastObservedAt: "2026-10-14T09:30:00.000Z" },
        },
        {
          runtimeSessionId: "rs_rr",
          kindId: "zcode",
          liveness: "live",
          definitionSnapshot: { model: "glm-5.3" },
          associations: [{ taskId: "task_m_rr" }],
          activity: { lastObservedAt: "2026-10-14T09:00:00.000Z" },
        },
        {
          runtimeSessionId: "rs_stale",
          kindId: "codex",
          liveness: "live",
          definitionSnapshot: { model: "gpt-6.1-sol" },
          associations: [{ taskId: "task_m_stale_running" }],
          activity: { lastObservedAt: "2026-10-14T08:30:00.000Z" },
        },
      ],
      watermark: 3,
      sourceRevision: 3,
    } as unknown as AgentRuntimeOverviewResult;

    const result = watchedWorks(baseWorks, agendaData, { days: 3, now: "2026-10-14T12:00:00.000Z" }, runtimeData);

    // 1. 活跃执行中任务全部置顶(不论是否置顶),且按 lastActivityAt 倒序
    //    - work_pinned_running (09:30)
    //    - work_recent_running (09:00)
    //    - work_recent_running_stale_activity (虽为 10-01 但在跑不被截断,排名下)
    // 2. 待命中置顶工作保持在近期工作前,且按 lastActivityAt 倒序
    //    - work_pinned_newer (10:00)
    //    - work_pinned_older (08:00)
    // 3. 待命中近期工作按 lastActivityAt 倒序
    //    - work_recent_newer (11:00)
    //    - work_recent_older (07:00)
    expect(result.map(({ work }) => work.taskId)).toEqual([
      "work_pinned_running",
      "work_recent_running",
      "work_recent_running_stale_activity",
      "work_pinned_newer",
      "work_pinned_older",
      "work_recent_newer",
      "work_recent_older",
    ]);
    expect(result.find(({ work }) => work.taskId === "work_recent_running_stale_activity")?.source).toBe("recent");
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

  it("agentLanesOf:成员页给真块(起点/终点/状态/待拍板),latestRound 兜底块不生长", () => {
    const nowMs = Date.parse("2026-09-29T02:00:00.000Z");
    const glmGroup: AgentRuntimeSessionGroupDto = {
      key: "agent:glm",
      kind: "agent",
      label: "GLM Worker",
      agentId: "glm",
      latestStatus: "running",
      latestActivityAt: AT,
      runningCount: 2,
      sessionCount: 3,
      roundCount: 3,
      latestRound: null,
    };
    const idleGroup: AgentRuntimeSessionGroupDto = {
      key: "agent:codex",
      kind: "agent",
      label: "Codex",
      agentId: "codex",
      latestStatus: "succeeded",
      latestActivityAt: "2026-09-29T01:30:00.000Z",
      runningCount: 0,
      sessionCount: 1,
      roundCount: 1,
      latestRound: {
        runtimeSessionId: "rs_cx",
        dispatchId: "disp_cx",
        agentName: "Codex",
        instanceId: "inst_cx",
        status: "succeeded",
        startedAt: "2026-09-29T01:00:00.000Z",
      },
    };
    const rows: readonly TaskDispatchProjectionRow[] = [
      {
        dispatchId: "disp_glm_1",
        taskId: "task_run",
        executionId: "exec_1",
        runtimeSessionId: "rs_glm_1",
        instanceId: "inst_glm",
        attemptGroupId: "att",
        attemptIndex: 0,
        provider: { instance: "glm", model: "glm-5.3" },
        classification: null,
        reason: null,
        fallbackState: null,
        nextDispatchId: null,
        providerSessionId: null,
        eventStreamRef: null,
        startedAt: "2026-09-29T01:10:00.000Z",
        endedAt: null,
        outcome: null,
        status: "running",
      },
      {
        dispatchId: "disp_glm_2",
        taskId: "task_w1",
        executionId: "exec_2",
        runtimeSessionId: "rs_glm_2",
        instanceId: "inst_glm",
        attemptGroupId: "att2",
        attemptIndex: 0,
        provider: { instance: "glm", model: "glm-5.3" },
        classification: null,
        reason: "gate_red",
        fallbackState: null,
        nextDispatchId: null,
        providerSessionId: null,
        eventStreamRef: null,
        startedAt: "2026-09-29T01:20:00.000Z",
        endedAt: null,
        outcome: null,
        status: "blocked",
        parentRuntimeSessionId: "rs_glm_1",
        delegatedByAgentId: "leader",
        delegatedByAgentName: "Leader",
      },
    ];
    const lanes = agentLanesOf({
      groups: [glmGroup, idleGroup],
      memberPages: new Map([
        [
          "glm",
          {
            rows,
            titleOf: new Map([
              ["task_run", "运行中的任务"],
              ["task_w1", "等你拍板的任务"],
            ]),
          },
        ],
      ]),
      taskTitles: new Map(),
      // task_w1 挂未决 awaits:问句取 awaits 原话,不落到 reason。
      awaits: awaitsByTask(
        agenda({
          awaitingYou: [
            {
              relationId: "rel_w1",
              sourceRef: "task/task_w1",
              title: "提案 rel_w1",
              status: "active",
              personId: "person_me",
              askKind: "question",
              question: "继续还是收口?",
              askedAt: AT,
              askedBy: "person_worker",
            },
          ],
        }),
      ),
      awaitingFallbackQuestion: "该任务已阻塞,需要你处理",
      nowMs,
    });
    // 两条泳道:活跃 agent 用成员页真块;闲置 agent 只有 latestRound 兜底块(终点=组活动时间)。
    expect(lanes.lanes.map(({ agentId, role }) => [agentId, role])).toEqual([
      ["glm", "GLM Worker"],
      ["codex", "Codex"],
    ]);
    const glmTasks = lanes.lanes[0]!.tasks;
    // 成员页按 startedAt 新→旧排块(最新一块在最前)。
    expect(glmTasks.map(({ id, status, endAt }) => [id, status, endAt])).toEqual([
      // 阻塞块必须给 endAt(不随 now 生长),状态词落 awaiting(Orca 提问档)。
      ["disp_glm_2", "awaiting", nowMs],
      ["disp_glm_1", "running", null],
    ]);
    expect(glmTasks[0]!.awaiting).toEqual({ question: "继续还是收口?" });
    expect(lanes.lanes[1]!.tasks[0]).toMatchObject({
      id: "disp_cx",
      status: "done",
      endAt: Date.parse("2026-09-29T01:30:00.000Z"),
    });
    // 块源映射与运行会话集合:视图层据此接动作与缓存触达读。
    expect(lanes.blockOf.get("disp_glm_2")).toEqual({
      taskId: "task_w1",
      runtimeSessionId: "rs_glm_2",
      awaiting: true,
      // 普通派工没有 reviewTarget:这一步是实现。
      stage: "implementation",
    });
    // 无任务归属的兜底块没有落点,不进块源映射。
    expect(lanes.blockOf.has("disp_cx")).toBe(false);
    // 有任务归属的兜底块没有派工行(也就没有 reviewTarget):这一步如实给 null,不猜。
    const fallback = agentLanesOf({
      groups: [{ ...idleGroup, key: "task:task_fb", kind: "task", taskId: "task_fb", latestStatus: "running" }],
      memberPages: new Map(),
      taskTitles: new Map(),
      awaits: new Map(),
      awaitingFallbackQuestion: "x",
      nowMs,
    });
    expect(fallback.blockOf.get("disp_cx")).toMatchObject({ taskId: "task_fb", stage: null });
    expect(lanes.runningSessionIds).toEqual(["rs_glm_1"]);
    // 跨 Agent 交接:parent 会话的块在窗口内 → 画边;leader 会话不在窗口内 → 不虚构。
    expect(lanes.handoffs).toEqual([{ fromTaskId: "disp_glm_1", toTaskId: "disp_glm_2", label: "Leader →" }]);
    // 空输入给空泳道,不猜。
    expect(
      agentLanesOf({
        groups: [],
        memberPages: new Map(),
        taskTitles: new Map(),
        awaits: new Map(),
        awaitingFallbackQuestion: "x",
        nowMs,
      }).lanes,
    ).toEqual([]);
  });

  it("agentLanesOf:blocked 无 awaits 问句时,提示退到派工行 reason,再退到兜底文案", () => {
    const row: TaskDispatchProjectionRow = {
      dispatchId: "disp_b",
      taskId: "task_b",
      executionId: "exec_b",
      runtimeSessionId: "rs_b",
      instanceId: "inst",
      attemptGroupId: "att",
      attemptIndex: 0,
      provider: { instance: "glm", model: "glm-5.3" },
      classification: null,
      reason: "quota_exhausted",
      fallbackState: null,
      nextDispatchId: null,
      providerSessionId: null,
      eventStreamRef: null,
      startedAt: AT,
      endedAt: null,
      outcome: null,
      status: "blocked",
    };
    const group: AgentRuntimeSessionGroupDto = {
      key: "agent:glm",
      kind: "agent",
      label: "GLM",
      agentId: "glm",
      latestStatus: "running",
      latestActivityAt: AT,
      runningCount: 1,
      sessionCount: 1,
      roundCount: 1,
      latestRound: null,
    };
    const input = {
      groups: [group] as const,
      memberPages: new Map([["glm", { rows: [row] as const, titleOf: new Map() }]]),
      taskTitles: new Map(),
      awaits: new Map(),
      nowMs: Date.parse(AT),
    };
    expect(agentLanesOf({ ...input, awaitingFallbackQuestion: "兜底" }).lanes[0]!.tasks[0]!.awaiting).toEqual({
      question: "quota_exhausted",
    });
  });

  it("runningTaskRows:与泳道同源的窄行——卡点优先、同任务收敛、只收运行与卡点块", () => {
    const nowMs = Date.parse("2026-09-29T02:00:00.000Z");
    const model = agentLanesOf({
      groups: [
        {
          key: "agent:glm",
          kind: "agent",
          label: "GLM Worker",
          agentId: "glm",
          latestStatus: "running",
          latestActivityAt: AT,
          runningCount: 1,
          sessionCount: 1,
          roundCount: 1,
          latestRound: null,
        },
        {
          key: "agent:sol",
          kind: "agent",
          label: "Sol",
          agentId: "sol",
          latestStatus: "running",
          latestActivityAt: AT,
          runningCount: 1,
          sessionCount: 1,
          roundCount: 1,
          latestRound: null,
        },
      ],
      memberPages: new Map([
        [
          "glm",
          {
            rows: [
              {
                dispatchId: "disp_glm_new",
                taskId: "task_new",
                executionId: "exec_n",
                runtimeSessionId: "rs_n",
                instanceId: "i",
                attemptGroupId: "a",
                attemptIndex: 0,
                provider: { instance: "glm", model: '["a-model","b-model"]' },
                classification: null,
                reason: null,
                fallbackState: null,
                nextDispatchId: null,
                providerSessionId: null,
                eventStreamRef: null,
                startedAt: "2026-09-29T01:50:00.000Z",
                endedAt: null,
                outcome: null,
                status: "running",
              },
              {
                dispatchId: "disp_glm_old",
                taskId: "task_old",
                executionId: "exec_o",
                runtimeSessionId: "rs_o",
                instanceId: "i",
                attemptGroupId: "a",
                attemptIndex: 0,
                provider: { instance: "glm", model: "glm-5.3" },
                classification: null,
                reason: null,
                fallbackState: null,
                nextDispatchId: null,
                providerSessionId: null,
                eventStreamRef: null,
                startedAt: "2026-09-29T01:10:00.000Z",
                endedAt: null,
                outcome: null,
                status: "running",
              },
              {
                dispatchId: "disp_glm_done",
                taskId: "task_done",
                executionId: "exec_d",
                runtimeSessionId: "rs_d",
                instanceId: "i",
                attemptGroupId: "a",
                attemptIndex: 0,
                provider: { instance: "glm", model: "glm-5.3" },
                classification: null,
                reason: null,
                fallbackState: null,
                nextDispatchId: null,
                providerSessionId: null,
                eventStreamRef: null,
                startedAt: "2026-09-29T01:00:00.000Z",
                endedAt: "2026-09-29T01:30:00.000Z",
                outcome: "succeeded",
                status: "succeeded",
              },
            ],
            titleOf: new Map([
              ["task_new", "新任务"],
              ["task_old", "旧任务"],
              ["task_done", "已收口"],
            ]),
          },
        ],
        [
          "sol",
          {
            rows: [
              {
                dispatchId: "disp_sol_stuck",
                taskId: "task_new",
                executionId: "exec_s",
                runtimeSessionId: "rs_s",
                instanceId: "i",
                attemptGroupId: "a",
                attemptIndex: 0,
                provider: { instance: "sol", model: "glm-5.3" },
                classification: null,
                reason: null,
                fallbackState: null,
                nextDispatchId: null,
                providerSessionId: null,
                eventStreamRef: null,
                startedAt: "2026-09-29T01:40:00.000Z",
                endedAt: null,
                outcome: null,
                status: "blocked",
              },
            ],
            titleOf: new Map(),
          },
        ],
      ]),
      taskTitles: new Map(),
      awaits: new Map([
        [
          "task_new",
          {
            relationId: "rel_n",
            sourceRef: "task/task_new",
            title: "提案",
            status: "active",
            personId: "person_me",
            askKind: "question",
            question: "继续?",
            askedAt: AT,
            askedBy: "person_worker",
          },
        ],
      ]),
      awaitingFallbackQuestion: "兜底",
      nowMs,
    });
    const modelOf = new Map([
      ["disp_glm_new", '["a-model","b-model"]'],
      ["disp_glm_old", "glm-5.3"],
      ["disp_sol_stuck", "glm-5.3"],
    ]);
    const rows = runningTaskRows(model, modelOf);
    // task_new 同任务两块都挂问句(任务有未决 awaits 时运行块也带问句):取更新的 glm 块;
    // 卡点问句优先于纯运行,已收口块不进名单。
    expect(rows.map(({ taskId }) => taskId)).toEqual(["task_new", "task_old"]);
    expect(rows[0]).toMatchObject({
      id: "disp_glm_new",
      title: "新任务",
      agent: "GLM Worker",
      // 模型查表是原样透传:候选清单的收短发生在视图层建表(runtimeModelShortLabel)。
      model: '["a-model","b-model"]',
      awaiting: "继续?",
    });
    expect(rows[1]).toMatchObject({ id: "disp_glm_old", model: "glm-5.3", awaiting: null });
    // 查表键缺席的块如实给 null,模型层不猜。
    const withMissing = runningTaskRows(model, new Map([["disp_glm_old", "m"]]));
    expect(withMissing[0]!.model).toBeNull();
    expect(withMissing[1]!.model).toBe("m");
  });

  it("watchedWorks:Needs you 工作压过在跑工作(五级第 1 级 > 第 3 级)", () => {
    const baseWorks: WorkIndexRead = {
      schema: "daemon.work-index/v1",
      ok: true,
      status: "ready",
      works: [
        {
          taskId: "task_running",
          title: "在跑工作",
          status: "active",
          root: "declared",
          parentTaskId: null,
          taskCount: 1,
          counts: { done: 0, executing: 1, pending: 0, blocked: 0, planned: 0, cancelled: 0 },
          lastActivityAt: "2026-10-14T11:00:00.000Z",
          memberTaskIds: ["task_running_m"],
        },
        {
          taskId: "task_needs",
          title: "等你拍板的工作",
          status: "active",
          root: "declared",
          parentTaskId: null,
          taskCount: 1,
          counts: { done: 0, executing: 0, pending: 0, blocked: 0, planned: 1, cancelled: 0 },
          lastActivityAt: "2026-10-14T07:00:00.000Z",
          memberTaskIds: ["task_needs_m"],
        },
      ],
      watermark: 1,
      sourceRevision: 1,
      warnings: [],
    };
    const read = agenda({
      attentionItems: [
        {
          ref: "relation/rel_needs",
          title: "等你拍板的成员任务",
          kind: "awaiting-you",
          region: "mine",
          workTaskId: "task_needs",
          attention: { score: 90, reasons: [] },
        },
      ],
      awaitingYou: [
        {
          relationId: "rel_needs",
          sourceRef: "task/task_needs_m",
          title: "等你拍板的成员任务",
          status: "active",
          personId: "person_me",
          askKind: "question",
          question: "继续?",
          askedAt: AT,
          askedBy: "person_worker",
        },
      ],
    });
    const runtime = {
      ok: true,
      status: "ready",
      installations: [],
      instances: [],
      sessions: [
        {
          runtimeSessionId: "rs_r",
          kindId: "codex",
          liveness: "live",
          definitionSnapshot: { model: "gpt-6.1-sol" },
          associations: [{ taskId: "task_running_m" }],
          activity: { lastObservedAt: "2026-10-14T11:00:00.000Z" },
        },
      ],
      watermark: 3,
      sourceRevision: 3,
    } as unknown as AgentRuntimeOverviewResult;
    // 在跑工作活动更新(11:00 > 07:00),但 Needs you 是第 1 级:绝对排在一切运行态之前。
    const watched = watchedWorks(baseWorks, read, { days: 3, now: "2026-10-14T12:00:00.000Z" }, runtime);
    expect(watched.map(({ work }) => work.taskId)).toEqual(["task_needs", "task_running"]);
  });

  it("pinnedTaskRows:可派在前,其余按议程注意力分降序", () => {
    const read = agenda({
      pinnedEntities: [
        { ref: "task/task_low", kind: "task", title: "低分置顶", status: "active", pinnedAt: AT },
        { ref: "task/task_high", kind: "task", title: "高分置顶", status: "active", pinnedAt: AT },
        { ref: "task/task_go", kind: "task", title: "可派置顶", status: "planned", pinnedAt: AT },
      ],
      dispatchable: [
        {
          taskId: "task_go",
          title: "可派置顶",
          work: null,
          status: "planned",
          pinned: true,
          updatedAt: AT,
          leaseExecutionId: null,
          activeExecutionIds: [],
          blockingAssessment: { state: "clear", blockers: [], warnings: [] },
        },
      ],
      attentionItems: [
        ...agenda().attentionItems,
        {
          ref: "task/task_high",
          title: "高分置顶",
          kind: "task",
          region: "stuck",
          workTaskId: null,
          attention: { score: 77, reasons: [] },
        },
        {
          ref: "task/task_low",
          title: "低分置顶",
          kind: "task",
          region: "stuck",
          workTaskId: null,
          attention: { score: 5, reasons: [] },
        },
      ],
    });
    expect(pinnedTaskRows(read, WORKS).map(({ taskId }) => taskId)).toEqual(["task_go", "task_high", "task_low"]);
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
    expect(entry!.textContent).not.toContain("执行中");
    act(() => entry!.click());
    expect(opened).toEqual(["collaboration"]);
    unmount();

    const local = mount({ collaboration: null });
    expect(local.querySelector('[data-testid="overview-collaboration-entry"]')).toBeNull();
    unmount();
  });
});

describe("总览工作简报", () => {
  it("显示工作状态与近期交付,并保留答复和任务下钻入口", async () => {
    vi.spyOn(harnessClient, "getWorkBriefs").mockResolvedValue({
      schema: "daemon.work-briefs/v1",
      ok: true,
      status: "ready",
      watermark: 7,
      sourceRevision: 7,
      warnings: [],
      briefs: [
        {
          taskId: "task_w1",
          title: "代码质量长期检验",
          bucket: "waiting",
          lastActivityAt: AT,
          deliveredAt: null,
          sentenceParts: [{ kind: "ask", title: "接口兼容方案", askKind: "question" }],
          asks: [
            {
              relationId: "rel_brief",
              relationRevision: 1,
              sourceRef: "task/task_w1",
              title: "接口兼容方案",
              status: "active",
              personId: "person_me",
              askKind: "question",
              question: "是否保留旧字段？",
              askedAt: AT,
              askedBy: "person_worker",
            },
          ],
          openTasks: [],
          deliveredTasks: [],
          pullRequests: [],
        },
        {
          taskId: "task_delivered",
          title: "接口读取器优化",
          bucket: "done",
          lastActivityAt: AT,
          deliveredAt: AT,
          sentenceParts: [{ kind: "delivered", title: "读取器" }],
          asks: [],
          openTasks: [],
          deliveredTasks: [],
          pullRequests: [],
        },
      ],
    } as never);
    const onOpenTask = vi.fn(),
      container = mount({ onOpenTask });
    try {
      await flushUntil(() => container.querySelector("[data-brief-row='task_delivered']") !== null);
      const briefs = container.querySelector('[data-testid="overview-region-briefs"]')!;
      expect(textOf(briefs)).toContain("工作简报");
      expect(textOf(briefs)).toContain("等你处理");
      expect(textOf(briefs)).toContain("在等你答复");
      expect(textOf(briefs)).toContain("接口读取器优化");
      expect(textOf(briefs)).toContain("已交付");

      const waitingRow = container.querySelector<HTMLElement>("[data-brief-row='task_w1']")!;
      const answer = [...waitingRow.querySelectorAll("button")].find((button) => button.textContent === "答复")!;
      await act(async () => answer.click());
      expect(document.body.querySelector('[data-testid="awaits-answer-panel"]')).not.toBeNull();
      await act(async () => waitingRow.querySelector("button")!.click());
      expect(onOpenTask).toHaveBeenCalledWith("task_w1");
    } finally {
      unmount();
    }
  });
});
