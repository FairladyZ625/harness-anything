// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OverviewNextView } from "../src/renderer/views/OverviewNextView.tsx";
import { NAV_GROUPS, navLabel } from "../src/renderer/navigation/navConfig.tsx";
import { harnessClient, type AgendaSuccess } from "../src/renderer/api-client.ts";
import type { ObserveTailRead } from "../src/api/renderer-dto.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { AgentRuntimeSessionDto } from "@harness-anything/daemon/protocol";
import {
  attentionItemsOf,
  changeCategoryOf,
  keyWorkRowsOf,
  type AttentionItem,
} from "../src/renderer/model/overview-next.ts";
import { cadenceEventOf } from "../src/renderer/model/cadence.ts";

/**
 * 总览(新)(S3)的装配判据(happy-dom):
 *  - 导航:新一级项「总览(新)」在 workspace 组内,旧「总览」原位保留;恢复白名单
 *    覆盖新 ViewId(编译期穷举 + 运行期在列)。
 *  - G2:议程三分组(评审返回/待初审/决策待裁)渲染真实行;点击行只走统一实体
 *    导航(task/<id>、decision/<id>),不在主行放一键接受;agenda 未读到时显示
 *    读取中,读到但为空显示良好空态,读失败显示错误与原始消息。
 *  - G3:置顶段 + 任务组段;组点击走单点切换位 onOpenGroup(S1 未合入=任务详情)。
 *  - G4:任务 active 与运行 live 分列;live 会话行点击走 selectRuntimeEntity(session/<id>)。
 *  - G5:事件归类词表;follow 新事件只计数不插入已展示列表,点「查看」才进(不抢焦点)。
 */

const REPO_ID = "overview-next-probe",
  NOW = "2026-09-20T12:00:00.000Z";

function nextTask(patch: Partial<TaskRow> & { readonly taskId: string }): TaskRow {
  return {
    title: patch.taskId,
    projectId: REPO_ID,
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "kernel/task-lifecycle/v1",
    origin: "native",
    source: "local-document",
    module: "gui",
    lastKnownAt: NOW,
    gates: [],
    board: projectedTaskFields("active").board,
    visibility: projectedTaskFields("active").visibility,
    capabilities: projectedTaskFields("active").capabilities,
    risk: projectedTaskFields("active").risk,
    phase: projectedTaskFields("active").phase,
    docs: [],
    ...patch,
  } as TaskRow;
}

function eventItem(input: {
  readonly id: string;
  readonly type: string;
  readonly revision: number;
  readonly taskId?: string;
  readonly decisionId?: string;
  readonly at?: string;
  readonly payload?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    schema: "task-event/v1",
    eventId: input.id,
    workspaceRevision: input.revision,
    opId: "op-overview-next",
    type: input.type,
    actor: { principal: { personId: "probe" } },
    source: { channel: "cli" },
    occurredAt: input.at ?? NOW,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.decisionId ? { decisionId: input.decisionId } : {}),
    ...(input.payload ? { payload: input.payload } : {}),
  };
}

function tailPage(
  items: readonly Record<string, unknown>[],
  options: { readonly done?: boolean; readonly historyCursorRevision?: number } = {},
): ObserveTailRead {
  const top = items.length === 0 ? 0 : Math.max(...items.map((item) => Number(item.workspaceRevision)));
  const done = options.done ?? true;
  return {
    schema: "daemon.observe-tail/v3",
    ok: true,
    repoId: REPO_ID,
    mode: "local",
    kind: "events",
    direction: "history",
    status: "ready",
    items: items as never,
    historyCursor: done || options.historyCursorRevision === undefined ? null : { kind: "events", revision: top },
    liveCursor: { kind: "events", revision: top },
    sourceCursor: { kind: "events", revision: top },
    done,
  };
}

function agendaFixture(patch: Partial<AgendaSuccess> = {}): AgendaSuccess {
  return {
    ok: true,
    status: "ready",
    pinnedEntities: [],
    pinnedEntityOverflow: 0,
    inFlight: [],
    awaitingAdjudication: [
      {
        taskId: "task_submitted",
        title: "待初审任务",
        pinned: false,
        executionId: "exec_1",
        submittedAt: NOW,
        blockingAssessment: {
          taskId: "task_submitted",
          state: "blocked",
          label: "relations",
          blockers: [],
          warnings: [],
        },
      },
    ],
    underReview: [
      {
        taskId: "task_inreview",
        title: "评审中任务",
        pinned: false,
        executionId: "exec_2",
        submittedAt: NOW,
        blockingAssessment: {
          taskId: "task_inreview",
          state: "clear",
          label: "none",
          blockers: [],
          warnings: [],
        },
      },
    ],
    awaitingDecision: [
      {
        decisionId: "dec_probe",
        title: "待裁决策标题",
        riskTier: "medium",
        urgency: "high",
        proposedAt: NOW,
      },
    ],
    awaitingRework: [
      {
        taskId: "task_rework",
        title: "评审返回任务",
        status: "active",
        pinned: false,
        updatedAt: NOW,
        leaseExecutionId: null,
        activeExecutionIds: [],
        blockingAssessment: { taskId: "task_rework", state: "clear", label: "none", blockers: [], warnings: [] },
      },
    ],
    waitingOnOthers: [],
    dispatchable: [],
    summary: "",
    page: { sourceLimit: 100, cursor: null, nextCursor: null },
    watermark: 12,
    sourceRevision: 3,
    ...patch,
  } as AgendaSuccess;
}

function sessionFixture(input: {
  readonly id: string;
  readonly liveness: AgentRuntimeSessionDto["liveness"];
  readonly taskId?: string;
}): AgentRuntimeSessionDto {
  return {
    runtimeSessionId: input.id,
    providerSessionId: null,
    instanceId: `${input.id}-instance`,
    installationId: "inst-probe",
    kindId: "codex",
    definitionSnapshotRef: "snap",
    definitionSnapshot: null,
    definitionSnapshotPersisted: true,
    liveness: input.liveness,
    attachCapability: "supported",
    streamCursor: "lifecycle:0",
    associations: input.taskId ? [{ taskId: input.taskId, executionId: "exe_probe", holder: null, lease: null }] : [],
    activity: { lastObservedAt: NOW, outcome: null, exitCode: null, resultRef: null, missingEvidence: null },
  } as AgentRuntimeSessionDto;
}

const PROJECT = {
  id: REPO_ID,
  name: "overview-next-probe",
  path: "/tmp/overview-next-probe",
  preset: "standard-task",
  engines: ["kernel"],
  watermarkAt: NOW,
};

const HEALTH = {
  daemon: { state: "responsive", observedAgeSec: 1, uptimeMs: 60_000 },
  cell: { state: "ok", queueDepth: 0, problem: null },
  projection: { status: "ready", lag: 0 },
  ledgerChange: { at: NOW, ageSec: 1 },
} as Parameters<typeof OverviewNextView>[0]["health"];

const TASKS = [
  nextTask({ taskId: "task_root", title: "根任务组", rootTaskId: "task_root", canonicalStatus: "active" }),
  nextTask({ taskId: "task_child", title: "子任务", rootTaskId: "task_root", parentTaskId: "task_root" }),
  nextTask({ taskId: "task_submitted", title: "待初审任务", rootTaskId: "task_root", activeExecutionId: "exec_1" }),
  nextTask({
    taskId: "task_milestone",
    title: "无子任务 Milestone",
    rootTaskId: "task_milestone",
    taskClass: "milestone",
  }),
  nextTask({ taskId: "task_leaf", title: "独立任务", rootTaskId: "task_root" }),
].map((task) =>
  task.taskId === "task_root"
    ? { ...task, rootAssessment: { reason: "declared" as const, directChildCount: 3, threshold: 6 } }
    : task,
);

setActiveLocale("zh-CN");

const mounted: { root: Root; container: HTMLElement }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

interface Mounted {
  readonly container: HTMLElement;
  readonly navigateEntity: ReturnType<typeof vi.fn>;
  readonly openGroup: ReturnType<typeof vi.fn>;
  readonly selectRuntimeEntity: ReturnType<typeof vi.fn>;
  /** observe.tail 的待应答队列:每次 loop 调用压入一个 resolver,测试按序消费。 */
  readonly queue: Array<(page: ObserveTailRead) => void>;
}

/** 挂载视图并接管 observe.tail:每个调用返回一个手动 resolve 的 promise(零墙钟等待)。 */
async function mountOverviewNext(options: {
  readonly agenda?: AgendaSuccess;
  readonly agendaError?: string;
  readonly sessions?: readonly AgentRuntimeSessionDto[];
  readonly runtimeError?: string;
  readonly tasks?: readonly TaskRow[];
}): Promise<Mounted> {
  const navigateEntity = vi.fn(),
    openGroup = vi.fn(),
    selectRuntimeEntity = vi.fn(),
    queue: Array<(page: ObserveTailRead) => void> = [];
  vi.spyOn(harnessClient, "tailObservability").mockImplementation(
    () =>
      new Promise<ObserveTailRead>((resolve) => {
        queue.push(resolve);
      }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(OverviewNextView, {
        repoId: REPO_ID,
        project: PROJECT,
        tasks: options.tasks ?? TASKS,
        agenda: options.agenda,
        agendaError: options.agendaError ?? null,
        activeSessions: options.sessions ?? [],
        runtimeError: options.runtimeError ?? null,
        health: HEALTH,
        daemonReadFailed: false,
        ledgerRevision: { watermark: 12, sourceRevision: 3 },
        onNavigateEntity: navigateEntity,
        onOpenGroup: openGroup,
        onSelectRuntimeEntity: selectRuntimeEntity,
        onOpenPool: () => undefined,
        onOpenSessions: () => undefined,
      }),
    );
  });
  return { container, navigateEntity, openGroup, selectRuntimeEntity, queue };
}

/**
 * 推一页事件并等渲染安定。done=false 的页之后 loop 用 setTimeout(0) 续读并压入下一个
 * 待应答——这里用有界的 setTimeout(0) 泵等它出现(事件循环让步,不是墙钟等待)。
 */
async function pushPage(view: Mounted, page: ObserveTailRead): Promise<void> {
  await act(async () => {
    for (let spins = 0; view.queue.length === 0; spins += 1) {
      expect(spins, "observe.tail follow-up read never arrived").toBeLessThan(200);
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    view.queue.shift()!(page);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
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

function textOf(container: HTMLElement, testId: string): string {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

function clickRow(container: HTMLElement, testId: string, title: string): void {
  const row = [...container.querySelectorAll(`[data-testid="${testId}"] button`)].find((button) =>
    button.textContent?.includes(title),
  );
  expect(row, `button containing "${title}" in ${testId}`).toBeDefined();
  act(() => {
    row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("overview next: navigation registration", () => {
  it("registers the new primary nav item next to the untouched old overview", () => {
    const workspace = NAV_GROUPS.find((group) => group.id === "workspace");
    expect(workspace?.items.map((item) => item.id)).toEqual(["overview", "overviewNext", "board", "graph"]);
    expect(navLabel("overview")).toBe("总览");
    expect(navLabel("overviewNext")).toBe("总览（新）");
    // 恢复白名单对新 ViewId 的覆盖由 viewHistoryStorage 的编译期穷举检查把守
    // (漏登记 tsc 变红);这里不再断言模块私有列表。
  });
});

describe("overview next: attention region (G2)", () => {
  it("renders the four agenda groups and routes row clicks through entity navigation", async () => {
    const view = await mountOverviewNext({ agenda: agendaFixture() });
    const rows = textOf(view.container, "overview-next-attention-rows");
    expect(rows).toContain("评审返回");
    expect(rows).toContain("待初审");
    expect(rows).toContain("评审中/等 consent");
    expect(rows).toContain("决策待裁");
    expect(rows).toContain("待初审任务");
    expect(rows).toContain("待裁决策标题");
    expect(rows).toContain("评审返回任务");
    clickRow(view.container, "overview-next-attention-rows", "待初审任务");
    expect(view.navigateEntity).toHaveBeenCalledWith("task/task_submitted");
    clickRow(view.container, "overview-next-attention-rows", "待裁决策标题");
    expect(view.navigateEntity).toHaveBeenCalledWith("decision/dec_probe");
    clickRow(view.container, "overview-next-attention-rows", "评审返回任务");
    expect(view.navigateEntity).toHaveBeenCalledWith("task/task_rework");
  });

  it("shows loading before the agenda cut arrives, a healthy empty state when empty, and the error when it fails", async () => {
    const loading = await mountOverviewNext({});
    expect(textOf(loading.container, "overview-next-attention")).toContain("正在读取议程");
    const empty = await mountOverviewNext({
      agenda: agendaFixture({ awaitingRework: [], awaitingAdjudication: [], underReview: [], awaitingDecision: [] }),
    });
    expect(textOf(empty.container, "overview-next-attention")).toContain("没有需要你处理的事项");
    const failed = await mountOverviewNext({ agendaError: "socket closed" });
    expect(textOf(failed.container, "overview-next-attention")).toContain("议程读取失败");
    expect(textOf(failed.container, "overview-next-attention")).toContain("socket closed");
  });

  it("sorts pinned first and marks blocked rows from blockingAssessment, not urgency", () => {
    const items = attentionItemsOf(agendaFixture()) as readonly AttentionItem[];
    expect(items).not.toBeNull();
    const rework = items!.find((item) => item.group === "reviewReturned")!;
    const initial = items!.find((item) => item.group === "initialReview")!;
    const underReview = items!.find((item) => item.group === "underReview")!;
    const decision = items!.find((item) => item.group === "decision")!;
    expect(initial.blocking).toBe(true);
    expect(underReview.blocking).toBe(false);
    expect(underReview.title).toBe("评审中任务");
    expect(rework.blocking).toBe(false);
    expect(decision.blocking).toBe(false);
    const pinnedFirst = attentionItemsOf(
      agendaFixture({
        awaitingRework: [
          {
            taskId: "task_rework",
            title: "置顶返回",
            status: "active",
            pinned: true,
            updatedAt: NOW,
            leaseExecutionId: null,
            activeExecutionIds: [],
            blockingAssessment: { taskId: "task_rework", state: "clear", label: "none", blockers: [], warnings: [] },
          },
        ],
      }),
    );
    expect(pinnedFirst![0].title).toBe("置顶返回");
  });
});

describe("overview next: key work region (G3)", () => {
  it("lists pinned entities and root groups, routing group clicks through the single switch point", async () => {
    const view = await mountOverviewNext({
      agenda: agendaFixture({
        pinnedEntities: [{ ref: "task/task_root", kind: "task", title: "置顶的组", status: "active", pinnedAt: NOW }],
      }),
    });
    const rows = textOf(view.container, "overview-next-keywork-rows");
    expect(rows).toContain("置顶工作");
    expect(rows).toContain("任务组 / Milestone");
    expect(rows).toContain("置顶的组");
    expect(rows).toContain("根任务组");
    expect(rows).toContain("无子任务 Milestone");
    expect(rows).toContain("目标待补充");
    // 子任务与独立叶子不进组段。
    expect(rows).not.toContain("独立任务");
    clickRow(view.container, "overview-next-keywork-rows", "根任务组");
    expect(view.openGroup).toHaveBeenCalledWith("task_root");
  });

  it("keeps an honest empty state when no groups exist", async () => {
    const view = await mountOverviewNext({
      tasks: [nextTask({ taskId: "task_leaf", title: "独立任务", rootTaskId: "task_root" })],
    });
    expect(textOf(view.container, "overview-next-keywork-rows")).toContain("暂无任务组");
  });
});

describe("overview next: execution region (G4)", () => {
  it("separates live sessions from active tasks and routes each to its own detail", async () => {
    const view = await mountOverviewNext({
      sessions: [
        sessionFixture({ id: "runtime_live", liveness: "live", taskId: "task_child" }),
        sessionFixture({ id: "runtime_exited", liveness: "exited" }),
      ],
    });
    const rows = textOf(view.container, "overview-next-execution-rows");
    expect(rows).toContain("运行中(live)");
    expect(rows).toContain("任务 active");
    expect(rows).toContain("另有 1 个非存活会话");
    // exited 会话不进 live 列。
    expect(rows).not.toContain("runtime_exited");
    clickRow(view.container, "overview-next-execution-rows", "子任务");
    expect(view.selectRuntimeEntity).toHaveBeenCalledWith("session/runtime_live");
    clickRow(view.container, "overview-next-execution-rows", "待初审任务");
    expect(view.openGroup).toHaveBeenCalledWith("task_submitted");
  });

  it("keeps honest empties for both lanes and surfaces runtime read errors", async () => {
    const idleTasks = TASKS.map((task) =>
      task.taskId === "task_submitted" ? { ...task, activeExecutionId: undefined } : task,
    );
    const empty = await mountOverviewNext({ tasks: idleTasks });
    const rows = textOf(empty.container, "overview-next-execution-rows");
    expect(rows).toContain("当前没有存活的运行会话");
    expect(rows).toContain("没有持有执行的任务");
    const failed = await mountOverviewNext({ runtimeError: "bridge down" });
    expect(textOf(failed.container, "overview-next-executions")).toContain("运行读面读取失败");
  });
});

describe("overview next: changes region (G5)", () => {
  it("classifies events by the presentation vocabulary", () => {
    const of = (type: string, extra: Record<string, unknown> = {}) =>
      changeCategoryOf(cadenceEventOf({ type, occurredAt: NOW, ...extra }));
    expect(of("task_created")).toBe("new");
    expect(of("task_progress_appended")).toBe("progress");
    expect(of("fact_recorded")).toBe("progress");
    expect(of("task_completed")).toBe("complete");
    expect(of("submission_returned")).toBe("blocked");
    expect(of("review_recorded", { payload: { review: { verdict: "changes_requested" } } })).toBe("blocked");
    expect(of("review_recorded", { payload: { review: { verdict: "approved" } } })).toBe("delivery");
    expect(of("completion_gate_verified", { payload: { witness: { result: "fail" } } })).toBe("blocked");
    expect(of("execution_submitted")).toBe("delivery");
    expect(of("decision_judged", { decisionId: "dec_x" })).toBe("decision");
    // 词表外的 type 不归类(仍计入事件数,只在「全部」出现)。
    expect(of("daemon_heartbeat")).toBe(null);
  });

  it("counts follow-up events without touching the visible list until the user asks (no focus steal)", async () => {
    const view = await mountOverviewNext({ agenda: agendaFixture() });
    // 第一页(未读完):feed 立即续读,第二个 promise 悬着——列表稳定在第一页内容。
    await pushPage(
      view,
      tailPage([eventItem({ id: "e1", type: "task_created", revision: 1, taskId: "task_root" })], { done: false }),
    );
    expect(textOf(view.container, "overview-next-changes-rows")).toContain("根任务组");
    expect(view.container.querySelector('[data-testid="overview-next-changes-new"]')).toBeNull();
    // 第二页到达:新事件只计数,已展示列表不动。
    await pushPage(
      view,
      tailPage([
        eventItem({ id: "e1", type: "task_created", revision: 1, taskId: "task_root" }),
        eventItem({ id: "e2", type: "task_completed", revision: 2, taskId: "task_child" }),
      ]),
    );
    const rowsText = textOf(view.container, "overview-next-changes-rows");
    expect(rowsText).toContain("根任务组");
    expect(rowsText).not.toContain("子任务");
    const counter = view.container.querySelector('[data-testid="overview-next-changes-new"]');
    expect(counter?.textContent).toContain("1 条新变化");
    act(() => {
      counter!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(textOf(view.container, "overview-next-changes-rows")).toContain("子任务");
  });

  it("shows the bounded-window note and healthy empty state", async () => {
    const view = await mountOverviewNext({ agenda: agendaFixture() });
    await pushPage(view, tailPage([]));
    const region = textOf(view.container, "overview-next-changes");
    expect(region).toContain("仅最近窗口");
    expect(region).toContain("最近窗口没有变化事件");
  });
});

describe("overview next: pure derivations", () => {
  it("keyWorkRowsOf separates pinned entities from root groups without recomputing counts", () => {
    const { pinned, groups } = keyWorkRowsOf(
      agendaFixture({
        pinnedEntities: [
          { ref: "decision/dec_probe", kind: "decision", title: "置顶决策", status: "proposed", pinnedAt: NOW },
        ],
      }),
      TASKS,
    );
    expect(pinned.map((row) => row.ref)).toEqual(["decision/dec_probe"]);
    expect(groups.map((row) => row.taskId)).toEqual(["task_root", "task_milestone"]);
    expect(groups.find((row) => row.taskId === "task_root")?.note).toBe("children:3");
    expect(groups.find((row) => row.taskId === "task_milestone")?.note).toBe("milestone");
  });

  it("attentionItemsOf returns null for an unread agenda, not an empty list", () => {
    expect(attentionItemsOf(undefined)).toBeNull();
  });
});
