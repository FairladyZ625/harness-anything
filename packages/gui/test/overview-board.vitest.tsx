// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  decisionRows,
  drillWipRows,
  followUpRows,
  pinnedTaskRows,
  watchedWorks,
  workRows,
  reviewRows,
  reviewCounts,
} from "../src/renderer/views/overview-model.ts";
import type { AgentRuntimeOverviewResult } from "@harness-anything/daemon/protocol";
import type { TaskWipRead } from "../../src/api/renderer-dto.ts";
import {
  AT,
  HEALTH_DOWN,
  WORKS,
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
 * 总览(2026-10-04 注意力优先重构;2026-10-11 业主意见返工)的行为面:首块只列真实待人
 * 事项并给真实动作;主区关注的工作(置顶在前,其余按「关注的工作活动天数」设置项的
 * 活动窗口列);「执行与下钻」的「进行中的任务」并进原在飞任务流的执行者/最近活动
 * 信息(在飞任务流区块已删除)。旧九区瀑布板与 overview-layout 已删除,布局断言不再
 * 适用;注意力派生的纯函数另测。左列最新产物速览架与产物二级页(task_8a83698;
 * 2026-10-11 意见 1)的行为面在 overview-artifacts.vitest.tsx;共享挂载夹具在
 * overview-board.fixtures.ts。
 */

beforeAll(() => {
  setupOverviewBoardEnvironment();
});

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
    expect(text).toContain("等你处理 2");
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

  const drillRows = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-testid="overview-drill-list"] [data-drill-row]')].map(
      (row) => row.getAttribute("data-drill-row")!,
    );

  it("WIP tab 是内联名单:四态全量平铺、注意力分排序,满额亮警示档", async () => {
    const counted = defaultCounted();
    // 给 blocked 组的两条塞高注意力分:它们必须排到名单最前(排序透传议程分数)。
    const read = agenda({
      attentionItems: [
        {
          ref: "task/task_wipblocked1",
          title: "占位任务 blocked1",
          kind: "blocked",
          region: "stuck",
          workTaskId: null,
          attention: { score: 99, reasons: [] },
        },
        {
          ref: "task/task_wipblocked0",
          title: "占位任务 blocked0",
          kind: "blocked",
          region: "stuck",
          workTaskId: null,
          attention: { score: 51, reasons: [] },
        },
        ...agenda().attentionItems,
      ],
    });
    const snapshot = wipSnapshot(counted, 10);
    const restore = stubBridge({ getTaskWip: () => snapshot });
    const onOpenTask = vi.fn();
    const container = mount({ agenda: read, onOpenTask });
    await flushUntil(
      () => container.querySelector('[data-testid="overview-region-drill"]')?.textContent?.includes("10/10") === true,
    );
    const drill = container.querySelector('[data-testid="overview-region-drill"]')!;
    // tab 常驻:占用在 tab 计数上,满额给显眼警示档(不再只是芯片上的小点)。
    const wipTab = drill.querySelector('[data-testid="overview-drill-wip"]')!;
    expect(textOf(wipTab)).toContain("10/10");
    expect(textOf(drill)).toContain("满额");
    // 名单内联平铺:四态 10 条全在首屏区域里,不是「点开才有内容」。
    expect(drillRows(container)).toEqual([
      "task_wipblocked1",
      "task_wipblocked0",
      ...counted
        .filter(({ taskId }) => taskId !== "task_wipblocked1" && taskId !== "task_wipblocked0")
        .map(({ taskId }) => taskId),
    ]);
    // 点行直接跳任务详情(业主 2026-10-13 裁定:总览点任务直接进任务详情,移除冗余二级弹窗)。
    act(() =>
      (container.querySelector('[data-drill-row="task_wipblocked1"]')!.querySelector("button") as HTMLElement).click(),
    );
    expect(onOpenTask).toHaveBeenCalledWith("task_wipblocked1");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    unmount();
    restore();
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

  it("WIP 放大层在位置恢复或历史直达时仍可用:分组过滤与搜索正常工作", async () => {
    const counted = defaultCounted();
    const restore = stubBridge({ getTaskWip: () => wipSnapshot(counted) });
    const container = mount({
      overviewLayer: {
        overviewArtifactId: null,
        overviewFocus: { key: "wip", selectedId: "task_wipactive0" },
      },
    });
    try {
      await flushUntil(
        () => container.querySelector('[data-testid="overview-region-drill"]')?.textContent?.includes("10/30") === true,
      );
      const dialog = document.body.querySelector('[role="dialog"]')!;
      expect(dialog.querySelectorAll("[data-focus-list] [data-dense-row]")).toHaveLength(10);
      act(() =>
        (
          [...dialog.querySelectorAll("[role='group'] button")].find((button) =>
            textOf(button).startsWith("活跃"),
          ) as HTMLElement
        ).click(),
      );
      expect(dialog.querySelectorAll("[data-focus-list] [data-dense-row]")).toHaveLength(1);

      const search = dialog.querySelector("[data-testid='overview-task-wip-search']") as HTMLInputElement;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "active0");
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(dialog.querySelectorAll("[data-focus-list] [data-dense-row]")).toHaveLength(1);
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
    const restore = stubBridge({ getTaskWip: () => wipSnapshot([]) });
    const container = mount();
    await flushUntil(
      () =>
        container.querySelector('[data-testid="overview-drill-wip-empty"]')?.textContent?.includes("工作台空闲") ===
        true,
    );
    const drill = container.querySelector('[data-testid="overview-region-drill"]')!;
    // WIP 空态是正向信息(工作台空闲),不是破壳。
    expect(textOf(container.querySelector('[data-testid="overview-drill-wip-empty"]')!)).toContain("工作台空闲");
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

  it("「进行中的任务」行并进执行者与最近活动;有执行者挂呼吸,静止行安静待命", async () => {
    // 意见 3 的合并面:原在飞任务流的信息(时间、当前哪个 agent 在跑)进「执行与下钻」
    // 的「进行中的任务」行,四态仍同列(blocked 不再被过滤——放大层与跟进名单另有分组)。
    // 视觉规范 v2:有执行者的行挂 live-row 呼吸光条,静止行不再输出「无 agent 在跑」。
    const restore = stubBridge({
      getTaskWip: () =>
        wipSnapshot([
          { taskId: "task_run", status: "active" as const, title: "有会话的进行中任务" },
          { taskId: "task_idle", status: "submitted" as const, title: "无会话的进行中任务" },
        ]),
      getAgentRuntimeOverview: () =>
        ({
          ok: true,
          status: "ready",
          installations: [],
          instances: [],
          sessions: [
            {
              runtimeSessionId: "rs_run",
              kindId: "codex",
              liveness: "live",
              definitionSnapshot: { model: "glm-5.3" },
              associations: [{ taskId: "task_run" }],
              activity: { lastObservedAt: AT },
            },
          ],
          watermark: 7,
          sourceRevision: 7,
        }) as unknown as AgentRuntimeOverviewResult,
    });
    const container = mount();
    await flushUntil(() => container.querySelector('[data-drill-row="task_run"]') !== null);
    const drill = container.querySelector('[data-testid="overview-region-drill"]')!;
    // tab 名是「进行中的任务」(「在飞任务」字样全部退役),占用仍在 tab 计数。
    expect(textOf(drill.querySelector('[data-testid="overview-drill-wip"]'))).toContain("进行中的任务");
    expect(textOf(drill)).toContain("进行中的任务");
    expect(textOf(drill)).not.toContain("在飞");
    const running = container.querySelector('[data-drill-row="task_run"]')!;
    expect(running.className).toContain("live-row");
    expect(textOf(running)).toContain("codex · glm-5.3");
    const idle = container.querySelector('[data-drill-row="task_idle"]')!;
    expect(idle.className).not.toContain("live-row");
    expect(textOf(idle)).not.toContain("无 agent");
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

  it("置顶承诺 tab:可派在前,行上就地取消置顶接真实 pin 通道", () => {
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
    act(() => (drill.querySelector('[data-testid="overview-drill-pinned"]') as HTMLElement).click());
    expect(drillRows(container)).toEqual(["task_pin_go", "task_pin_active"]);
    const unpin = container.querySelector<HTMLButtonElement>('[data-testid="overview-unpin-task_pin_active"]')!;
    act(() => unpin.click());
    expect(onUnpin).toHaveBeenCalledWith("task_pin_active");
    unmount();
  });

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
    expect(textOf(topbar)).toContain("daemon 正常");
    expect(textOf(topbar)).not.toContain("main CI 绿");
    expect(textOf(topbar)).toContain("进行中 2");
    expect(topbar.querySelector('[data-testid="overview-ci-alert"]')).not.toBeNull();
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
                  occurredAt: "2026-09-29T07:18:00.000Z",
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
    await flushUntil(() => textOf(container.querySelector('[data-testid="overview-ci-alert"]')).includes("失败观察 1"));
    const topbar = container.querySelector('[data-testid="overview-topbar"]')!;
    expect(textOf(topbar)).toContain("daemon 无响应");
    expect(textOf(topbar)).toContain("投影落后 3");
    expect(textOf(topbar)).toContain("窗口中 main 失败观察 1");
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
    // 活动窗口(意见 4):未置顶工作只在窗口内才列,置顶不受窗口限制。
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
    expect(windowed.watched.map(({ work }) => work.taskId)).toEqual(["task_w2", "task_w1"]);
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

  it("drillWipRows:注意力分降序,平分按占位状态生命周期序,再按 taskId 定序;行带执行者与最近活动", () => {
    const counted = [
      { taskId: "task_c", status: "active" as const, title: "c" },
      { taskId: "task_a", status: "blocked" as const, title: "a" },
      { taskId: "task_e", status: "active" as const, title: "e" },
      { taskId: "task_b", status: "in_review" as const, title: "b" },
      { taskId: "task_d", status: "active" as const, title: "d" },
    ];
    const read = agenda({
      attentionItems: [
        {
          ref: "task/task_d",
          title: "d",
          kind: "task",
          region: "stuck",
          workTaskId: null,
          attention: { score: 42, reasons: [] },
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
          runtimeSessionId: "rs_d",
          kindId: "codex",
          liveness: "live",
          definitionSnapshot: { model: "glm-5.3" },
          associations: [{ taskId: "task_d" }],
          activity: { lastObservedAt: AT },
        },
      ],
      watermark: 7,
      sourceRevision: 7,
    } as unknown as AgentRuntimeOverviewResult;
    const snapshot = { ok: true, limit: 30, limitLabel: "l", counted, roots: [], threshold: 3 } as never;
    // 高分行最前;平分(active 的 c/e)按 taskId;随后 in_review,blocked 殿后(状态生命周期序)。
    // 行内并进原在飞任务流的执行信息:有 live 会话的行给执行者与 lastObservedAt,没有的
    // 如实给空执行者与议程 updatedAt 兜底(合并自 overview-inflight-shelf 的行为面)。
    expect(drillWipRows(snapshot, runtime, read).map(({ taskId, score }) => [taskId, score])).toEqual([
      ["task_d", 42],
      ["task_c", 0],
      ["task_e", 0],
      ["task_b", 0],
      ["task_a", 0],
    ]);
    const rows = drillWipRows(snapshot, runtime, read);
    expect(rows.find(({ taskId }) => taskId === "task_d")!.handlers).toEqual(["codex · glm-5.3"]);
    expect(rows.find(({ taskId }) => taskId === "task_d")!.since).toBe(AT);
    expect(rows.find(({ taskId }) => taskId === "task_c")!.handlers).toEqual([]);
    // 无 agenda(读面未到)时仍有确定序;无快照给空名单。
    expect(drillWipRows(snapshot, undefined, undefined).map(({ taskId }) => taskId)).toEqual([
      "task_c",
      "task_d",
      "task_e",
      "task_b",
      "task_a",
    ]);
    expect(drillWipRows(undefined, runtime, read)).toEqual([]);
  });

  it("drillWipRows:活跃执行任务优先置顶,再按最新活动时间(since)倒序,缺失时间回退分数与状态", () => {
    const counted = [
      { taskId: "task_idle_high_score_older", status: "active" as const, title: "高分旧任务" },
      { taskId: "task_running_older", status: "active" as const, title: "在跑较早任务" },
      { taskId: "task_idle_no_time", status: "active" as const, title: "无时间待命中任务" },
      { taskId: "task_blocked_no_time", status: "blocked" as const, title: "无时间阻塞任务" },
      { taskId: "task_running_newer", status: "active" as const, title: "在跑最新任务" },
      { taskId: "task_idle_low_score_newer", status: "active" as const, title: "低分较新任务" },
    ];
    const read = agenda({
      attentionItems: [
        {
          ref: "task/task_idle_high_score_older",
          title: "高分旧任务",
          kind: "task",
          region: "stuck",
          workTaskId: null,
          attention: { score: 100, reasons: [] },
        },
        {
          ref: "task/task_running_older",
          title: "在跑较早任务",
          kind: "task",
          region: "stuck",
          workTaskId: null,
          attention: { score: 50, reasons: [] },
        },
        {
          ref: "task/task_idle_no_time",
          title: "无时间待命中任务",
          kind: "task",
          region: "stuck",
          workTaskId: null,
          attention: { score: 20, reasons: [] },
        },
        {
          ref: "task/task_blocked_no_time",
          title: "无时间阻塞任务",
          kind: "task",
          region: "stuck",
          workTaskId: null,
          attention: { score: 20, reasons: [] },
        },
      ],
      stalled: [
        {
          taskId: "task_idle_high_score_older",
          title: "高分旧任务",
          status: "active",
          updatedAt: "2026-10-14T08:00:00.000Z",
          attention: { score: 100, reasons: [] },
        },
        {
          taskId: "task_idle_low_score_newer",
          title: "低分较新任务",
          status: "active",
          updatedAt: "2026-10-14T09:30:00.000Z",
          attention: { score: 5, reasons: [] },
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
          runtimeSessionId: "rs_older",
          kindId: "codex",
          liveness: "live",
          definitionSnapshot: { model: "gpt-6.1-sol" },
          associations: [{ taskId: "task_running_older" }],
          activity: { lastObservedAt: "2026-10-14T10:00:00.000Z" },
        },
        {
          runtimeSessionId: "rs_newer",
          kindId: "zcode",
          liveness: "live",
          definitionSnapshot: { model: "glm-5.3" },
          associations: [{ taskId: "task_running_newer" }],
          activity: { lastObservedAt: "2026-10-14T11:00:00.000Z" },
        },
      ],
      watermark: 8,
      sourceRevision: 8,
    } as unknown as AgentRuntimeOverviewResult;
    const snapshot = { ok: true, limit: 30, limitLabel: "l", counted, roots: [], threshold: 3 } as never;

    const rows = drillWipRows(snapshot, runtime, read);
    // 1. 在跑任务(handlers.length > 0)全部置顶,且按 lastObservedAt 降序(11:00 在前、10:00 在后)
    // 2. 待命任务按 updatedAt 降序(09:30 在前、08:00 在后,不被高分 100 反客为主)
    // 3. 无时间任务回退至注意力分与状态定序(active 在 blocked 前)
    expect(rows.map(({ taskId }) => taskId)).toEqual([
      "task_running_newer",
      "task_running_older",
      "task_idle_low_score_newer",
      "task_idle_high_score_older",
      "task_idle_no_time",
      "task_blocked_no_time",
    ]);
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
    expect(entry!.textContent).toContain("2");
    act(() => entry!.click());
    expect(opened).toEqual(["collaboration"]);
    unmount();

    const local = mount({ collaboration: null });
    expect(local.querySelector('[data-testid="overview-collaboration-entry"]')).toBeNull();
    unmount();
  });
});
