// harness-test-tier: fast
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  agentLanesOf,
  awaitsByTask,
  decisionRows,
  followUpRows,
  pinnedTaskRows,
  watchedWorks,
  workRows,
  reviewRows,
  reviewCounts,
  runRows,
  workHandlers,
} from "../src/renderer/views/overview-model.ts";
import type { AgentRuntimeOverviewResult, AgentRuntimeSessionGroupDto } from "@harness-anything/daemon/protocol";
import type { TaskDispatchProjectionRow } from "../src/api/renderer-dto.ts";
import { AT, WORKS, agenda } from "./overview-board.fixtures.ts";

/**
 * 总览的模型层判据(纯函数,不挂载组件):注意力分区(decisionRows/followUpRows)、
 * 关注的工作(watchedWorks/workRows)、评审执行分区与计数(reviewRows/reviewCounts)、
 * 置顶行(pinnedTaskRows),以及「进行中的任务」泳道的数据投影(agentLanesOf:
 * 块起点/终点/状态、待拍板问句、跨 Agent 交接边、块 id 与任务 id 的分工)。
 * 视图行为面(挂载、交互、区域排布)在 overview-board.vitest.tsx;共享夹具在
 * overview-board.fixtures.ts,两边同一份。

 */

describe("总览派生(纯函数)", () => {
  it("decisionRows 只收真实待人两类,followUpRows 收跟进、返工、阻塞与审计发现", () => {
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
        {
          ref: "audit-finding/schedule-1/repeated-check",
          title: "重复的结算见证误判",
          kind: "audit-finding",
          region: "mine",
          workTaskId: null,
          attention: { score: 85, reasons: [{ label: "审计发现", contribution: 85 }] },
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
    ).toEqual(["adjudication", "answered", "audit-finding", "blocked", "stalled"]);
    expect(followUpRows(read).find(({ id }) => id === "audit-finding/schedule-1/repeated-check")).toMatchObject({
      kind: "audit-finding",
      title: "重复的结算见证误判",
    });
  });

  it("watchedWorks:置顶保留在前不受窗口限制;其余按活动窗口过滤、终态置顶只计数", () => {
    const base = agenda();
    const pinned = watchedWorks(WORKS, {
      ...base,
      pinnedEntities: [
        { ref: "task/task_w1", kind: "task", title: "代码质量长期检验", status: "active", pinnedAt: AT },
      ],
    });
    expect(pinned.watched.map(({ work, source }) => [work.taskId, source])).toEqual([
      ["task_w1", "pinned"],
      ["task_w2", "recent"],
    ]);
    const closed = watchedWorks(WORKS, {
      ...base,
      pinnedEntities: [{ ref: "task/task_w_done", kind: "task", title: "已收尾的工作", status: "done", pinnedAt: AT }],
    });
    expect(closed.pinnedClosed).toBe(1);
    expect(closed.watched.map(({ work }) => work.taskId)).toEqual(["task_w1", "task_w2"]);
    expect(closed.watched.every(({ source }) => source === "recent")).toBe(true);
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
    expect(windowed.watched.map(({ work }) => work.taskId)).toEqual(["task_w1", "task_w2"]);
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
    expect(result.watched.map(({ work }) => work.taskId)).toEqual([
      "work_pinned_running",
      "work_recent_running",
      "work_recent_running_stale_activity",
      "work_pinned_newer",
      "work_pinned_older",
      "work_recent_newer",
      "work_recent_older",
    ]);
    expect(result.watched.find(({ work }) => work.taskId === "work_recent_running_stale_activity")?.source).toBe(
      "recent",
    );
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
    // 成员页真块的块 id 是派工 id,跳转目标是它背后的 taskId(块 id 不是任务 id)。
    expect(glmTasks.map(({ id, taskId }) => [id, taskId])).toEqual([
      ["disp_glm_2", "task_w1"],
      ["disp_glm_1", "task_run"],
    ]);
    expect(lanes.lanes[1]!.tasks[0]).toMatchObject({
      id: "disp_cx",
      status: "done",
      endAt: Date.parse("2026-09-29T01:30:00.000Z"),
    });
    // 组头没有 taskId 的兜底块不许编一个:否则点击会跳到不存在的任务。
    expect(lanes.lanes[1]!.tasks[0]).not.toHaveProperty("taskId");
    // 块源映射与运行会话集合:视图层据此接动作与缓存触达读。
    expect(lanes.blockOf.get("disp_glm_2")).toEqual({
      taskId: "task_w1",
      runtimeSessionId: "rs_glm_2",
      awaiting: true,
    });
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
    const { watched } = watchedWorks(baseWorks, read, { days: 3, now: "2026-10-14T12:00:00.000Z" }, runtime);
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

describe("关注的工作处理者:模型元组不上屏(X2)", () => {
  // 会话型运行时把候选模型清单以 JSON 数组文本写进 definitionSnapshot.model(声明 schema
  // 只要求非空字符串)。主表面必须只给列表短标签:首个候选 +N;原文/方括号/引号一个
  // 都不能出现在 who 里,否则关注工作的行会把底层配置字面量直接摊给业主。
  const runtime = {
    ok: true,
    status: "ready",
    installations: [],
    instances: [],
    sessions: [
      {
        runtimeSessionId: "rs_tuple",
        kindId: "deepseek-harness",
        liveness: "live",
        definitionSnapshot: { model: '["deepseek-official","DeepSeek-V4.1-Flash","DeepSeek-V3.2"]' },
        associations: [{ taskId: "task_m1" }],
        activity: { lastObservedAt: AT },
      },
    ],
    watermark: 3,
    sourceRevision: 3,
  } as unknown as AgentRuntimeOverviewResult;

  it("runRows 的 who 用短标签,不残留候选清单 JSON 原文", () => {
    const [row] = runRows(runtime, undefined);
    expect(row!.who).toBe("deepseek-harness · deepseek-official +2");
    expect(row!.who).not.toContain("[");
    expect(row!.who).not.toContain('"');
  });

  it("workHandlers 透传同一短标签(关注工作的「处理者」直接消费它)", () => {
    expect(workHandlers(runtime, "task_m1", [])).toEqual(["deepseek-harness · deepseek-official +2"]);
  });

  it("普通模型名与缺失快照都不加戏:名字原样,快照缺失退化成 kindId", () => {
    const plain = {
      ...runtime,
      sessions: [
        {
          ...runtime.sessions[0]!,
          runtimeSessionId: "rs_plain",
          definitionSnapshot: { model: "glm-5.3" },
        },
        {
          ...runtime.sessions[0]!,
          runtimeSessionId: "rs_none",
          definitionSnapshot: null,
        },
      ],
    } as unknown as AgentRuntimeOverviewResult;
    expect(
      runRows(plain, undefined)
        .map(({ who }) => who)
        .sort(),
    ).toEqual(["deepseek-harness", "deepseek-harness · glm-5.3"]);
  });
});
