// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CadenceView } from "../src/renderer/views/CadenceView.tsx";
import { harnessClient, type AgendaSuccess } from "../src/renderer/api-client.ts";
import type { ObserveTailRead } from "../src/api/renderer-dto.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 研发态势视图的装配判据(happy-dom):
 *  - observe.tail events 页(history 方向,单页 done)进入 HUD/音轨/摩擦/产出;
 *  - 实体跳转走 onNavigateEntity(task/<id>、decision/<id>);
 *  - `unavailable`(远端 edge 无事件流)显式横幅,不冒充空驾驶舱;
 *  - 议程缺位时堵点卡片如实显示读取中,不冒充「无堵点」。
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
    module: "gui",
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
    actor: { kind: "agent", id: "agent_cv" },
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
  awaitingDecision: [
    {
      kind: "decision",
      decisionId: "dec_probe",
      title: "探针决策:切换读取形态",
      riskTier: "medium",
      urgency: "high",
      proposedAt: NOW,
    },
    {
      kind: "execution",
      taskId: "task_live",
      title: "在飞任务",
      pinned: false,
      executionId: "exec_1",
      submittedAt: NOW,
      blockingAssessment: { state: "clear", contributors: [], warnings: [] },
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

interface Mounted {
  readonly container: HTMLElement;
  readonly navigate: ReturnType<typeof vi.fn>;
}

async function mountCadence(options: {
  readonly page: ObserveTailRead;
  readonly agenda?: AgendaSuccess;
}): Promise<Mounted> {
  const navigate = vi.fn();
  vi.spyOn(harnessClient, "tailObservability").mockImplementation(async () => options.page);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(CadenceView, {
        repoId: REPO_ID,
        projectName: "cadence-probe",
        tasks: [
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

function textOf(container: HTMLElement, testId: string): string {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

describe("CadenceView", () => {
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
    // HUD:两行投影里在飞 1;今日收口 1;待人工 = 议程 awaitingDecision 2 条(1 决策 + 1 执行)。
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
    // 摩擦雷达:门禁失败 1 · 评审打回 1;产出:今日 Fact 1,模块热度含 gui。
    expect(textOf(container, "cadence-friction")).toContain("门禁失败 1");
    expect(textOf(container, "cadence-yield-facts")).toContain("1");
    expect(container.querySelector('[data-testid="cadence-yield-modules"]')?.textContent).toContain("gui");
    // 堵点卡片:待裁决策与待裁决执行两组都在。
    const blockers = container.querySelector('[data-testid="cadence-blockers-groups"]');
    expect(blockers?.textContent).toContain("探针决策:切换读取形态");
    expect(blockers?.textContent).toContain("待裁决执行 1");
  });

  it("navigates to task and decision entities from the rendered cards", async () => {
    const { container, navigate } = await mountCadence({
      page: historyPage([
        eventItem({ id: "e1", type: "task_created", revision: 1, taskId: "task_live" }),
        eventItem({ id: "e2", type: "fact_recorded", revision: 2, taskId: "task_live", factId: "F-probe000", at: NOW }),
      ]),
      agenda: AGENDA,
    });
    const titleButton = [...container.querySelectorAll('[data-testid="cadence-rhythm-row"] button')].find((button) =>
      button.textContent?.includes("在飞任务"),
    )!;
    await act(async () => {
      titleButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigate).toHaveBeenCalledWith("task/task_live");
    const decisionRow = [...container.querySelectorAll('[data-testid="cadence-blockers"] button')].find((button) =>
      button.textContent?.includes("探针决策:切换读取形态"),
    )!;
    await act(async () => {
      decisionRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigate).toHaveBeenCalledWith("decision/dec_probe");
    const factLink = [...container.querySelectorAll('[data-testid="cadence-yield"] button')].find((button) =>
      button.textContent?.includes("F-probe000"),
    );
    expect(factLink).toBeDefined();
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
