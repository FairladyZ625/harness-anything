// harness-test-tier: fast
// @vitest-environment happy-dom
//
// 行集完整性必须经 App 的真实接线显形(task_029cf45349d179ef8bd2b94f6e 评审 BF1)。
//
// 缺陷现场(2026-10-25 看板 92 / 台账 4,469):侧栏与看板标题的口径只有「投影落后
// revisions」。水化被 `HYDRATION_PAGE_BUDGET` 截断时切面仍带 `page.nextCursor`,行集
// 只是「已读到的部分」,而 lag 可以是 0——于是可见行照打「运行正常 · 落后 0 revisions」,
// 看板照打「共 M」(M 是部分行集)。组件单测曾手工喂 `hydrating:true` 而假绿:生产路径
// 从来没有把切面的水化事实交给派生。这里直接挂真实的 App,用桥接替身驱动「预算截断」,
// 断言的是 DOM 上业主看到的那两行字。
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "../src/renderer/App.tsx";
import { DEFAULT_TASK_FILTERS } from "../src/renderer/model/taskFilters.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { HYDRATION_PAGE_BUDGET, TASK_LIST_PAGE_LIMIT } from "../src/renderer/task-data.ts";

const REPO_ID = "canonical";
const AT = "2026-10-26T00:00:00.000Z";
/** daemon 观测时刻取当下:观测年龄超过阈值会单独把灯判红,掩盖被测的「不完整」降级。 */
const OBSERVED_AT = new Date().toISOString();

/** 最小但通过读取校验的投影行(snapshot.task 与 taskId 必须一致)。 */
function projectionRow(taskId: string) {
  return {
    taskId,
    generation: "v1",
    workspaceRevision: 1,
    createdAt: AT,
    completedAt: null,
    updatedAt: AT,
    packagePath: `tasks/${taskId}-probe`,
    coordinationStatus: "planned",
    snapshotAvailability: { consents: "known", gateWitnesses: "known" },
    closeoutAssessment: { readiness: "not_required", gates: [] },
    blockingAssessment: { taskId, state: "clear", blockers: [], warnings: [] },
    placement: {
      productLines: ["desktop"],
      spawningDecisionIds: [],
      parentTaskId: null,
      origin: "native",
      engine: "kernel/task-lifecycle/v1",
      packageDisposition: "active",
      provenance: [{ kind: "l2", ref: `tasks/${taskId}-probe/INDEX.md` }],
    },
    executionEvidence: [],
    board: { columnId: "open", rank: 3 },
    visibility: { archived: false, noise: false },
    capabilities: [{ id: "start", available: true, reason: null }],
    risk: { flagged: false },
    phase: { index: 0, reason: null, steps: ["planned", "active", "in_review", "done"] },
    snapshot: {
      revision: 1,
      task: {
        schema: "task/v2",
        taskId,
        title: `Probe ${taskId}`,
        taskClass: "standard",
        status: "planned",
        graph: "D>K",
        currentNode: "implementation",
        iteration: 0,
        createdBy: { principal: { personId: "person-probe" }, executor: null },
        completionGateIds: [],
        presetSnapshotDigest: null,
        pinned: false,
        metadata: {
          idempotencyKey: null,
          parentTaskId: null,
          workKind: "feat",
          riskTier: "low",
          urgency: "low",
          verticalId: "software/coding",
          presetId: "standard-task",
          profileId: "baseline",
          moduleKey: null,
          slug: taskId,
          surfaces: [],
          fromLegacyId: null,
        },
      },
      executions: [],
      reviews: [],
      consents: [],
      gateWitnesses: [],
      edgesTaken: [],
      lease: null,
      decisionRelations: [],
    },
  };
}

/** 会话从看板起步(等价于「上次停在看板」):视图由可寻址历史栈提供。 */
function startOnBoard() {
  window.localStorage.setItem(
    `harness-view-history:${REPO_ID}`,
    JSON.stringify({
      schema: "gui-view-history/v1",
      history: {
        entries: [
          {
            view: "board",
            selectedId: null,
            previewId: null,
            focusedEntityRef: null,
            taskFilters: { ...DEFAULT_TASK_FILTERS },
            drill: null,
          },
        ],
        index: 0,
      },
    }),
  );
}

const mounted: { root: Root; container: HTMLElement }[] = [];

/**
 * 挂真实的 App,`getTasks` 由桥接替身提供:
 *   - `truncated`:首页 500 行 + 每页都报 nextCursor —— 水化会在页预算处截断,切面
 *     带 `page.nextCursor` 且 `status: "pending"`,但 watermark === sourceRevision(lag 0)。
 *     这正是「不完整却自称已追平」的形状。
 *   - `complete`:首页就是最后一页(nextCursor null),切面 ready。
 */
async function mountBoard(options: {
  readonly truncated: boolean;
}): Promise<{ readonly container: HTMLElement; readonly tasksReads: () => number }> {
  let tasksReads = 0;
  const page = (payload: { readonly cursor?: string }) => {
    tasksReads += 1;
    const first = payload.cursor === undefined;
    // 首页给两行(一行服务、一行被 daemon 隔离),续读页给一页空行也照样报游标:
    // 行集是否完整与这一页有没有行无关,只由 reader 的 `done`(nextCursor)决定。
    const rows = first ? [projectionRow("task_000001"), projectionRow("task_000002")] : [];
    return {
      ok: true as const,
      status: "ready" as const,
      rows,
      invalidRows: [],
      watermark: 1_000,
      sourceRevision: 1_000,
      warnings: [],
      page: {
        limit: TASK_LIST_PAGE_LIMIT,
        cursor: payload.cursor ?? null,
        nextCursor: options.truncated ? (payload.cursor ?? "task_000002") : null,
      },
    };
  };
  const bridge: Record<string, (payload?: Record<string, unknown> | null) => Promise<unknown>> = {
    getSystemStatus: async () => ({
      schema: "gui-system-status/v1",
      ok: true,
      observedAt: OBSERVED_AT,
      daemon: { uptimeMs: 1 },
      repos: [
        {
          repoId: REPO_ID,
          displayName: "Probe",
          canonicalRoot: "/tmp/probe",
          authoredBranch: "main",
          registrationState: "enabled",
          mode: "local",
          connectionId: "local",
          cellState: "attached",
          generation: 1,
          queueDepth: 0,
          lockState: "not_applicable",
          recoveryMs: null,
          lastError: null,
          unavailableReason: null,
        },
      ],
    }),
    getTasks: async (payload) => page((payload ?? {}) as { readonly cursor?: string }),
    getWorkspaceSummary: async () => ({
      schema: "daemon.workspace-summary/v1",
      ok: true,
      status: "ready",
      tasks: { lastChangedAt: null, total: 2, byStatus: { planned: 2 } },
      decisions: {
        total: 0,
        inboxCount: 0,
        byState: {},
        groups: [
          { id: "proposed", states: ["proposed"], count: 0, decisionIds: [] },
          { id: "in_effect", states: ["in_effect"], count: 0, decisionIds: [] },
          { id: "rejected", states: ["rejected"], count: 0, decisionIds: [] },
          { id: "deferred", states: ["deferred"], count: 0, decisionIds: [] },
          { id: "retired", states: ["superseded", "outcome_retired"], count: 0, decisionIds: [] },
        ],
      },
      watermark: 1_000,
      sourceRevision: 1_000,
      warnings: [],
    }),
    getAgenda: async () => ({
      ok: true,
      status: "ready",
      inFlight: [],
      pinnedEntities: [],
      pinnedEntityOverflow: 0,
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
      watermark: 1_000,
      sourceRevision: 1_000,
    }),
  };
  Object.defineProperty(window, "harness", {
    configurable: true,
    value: new Proxy(bridge, {
      get(target, method: string) {
        if (method in target) return target[method];
        // 与看板无关的读面统一回空成功:断言面不扩到它们。
        return async () => ({ ok: true });
      },
    }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  startOnBoard();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(App)));
  });
  // 挂载链(render → systemStatus → repoId → 各读面 → 水化续读)跨多个 promise 世代,
  // 微任务轮次不够。宏任务轮次排空(0ms),不用墙钟等待固定条件之外的时间。
  for (let turn = 0; turn < 12; turn += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  return { container, tasksReads: () => tasksReads };
}

function projectionLine(container: HTMLElement): string {
  return container.querySelector('[data-testid="sidebar-system-status-projection"]')?.textContent ?? "";
}
function headerSummary(container: HTMLElement): string {
  return container.querySelector('[data-testid="board-header-summary"]')?.textContent ?? "";
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  Reflect.deleteProperty(window, "harness");
  window.localStorage.clear();
});

describe("预算截断的水化:行集不完整时不得声称已追平(BF1 经 App 的接线)", () => {
  it("visible sidebar line and board title say the row set is still loading", async () => {
    const { container, tasksReads } = await mountBoard({ truncated: true });
    // 前提:确实发生了预算截断(不是首屏未读到)——单次刷新至少打满页预算,切面仍带游标。
    expect(tasksReads()).toBeGreaterThanOrEqual(HYDRATION_PAGE_BUDGET);
    // lag 是 0(watermark === sourceRevision),所以「落后 0 revisions」在数字上并不是
    // 假话,但它回答的是另一个问题;行集不完整必须自己显形。
    const line = projectionLine(container);
    expect(line).toContain("行集加载中");
    expect(line).not.toContain("落后 0 revisions");
    // 整体灯不得是「运行正常」:水化未完是「启动中」中性档,既不是已追平,也不是降级/daemon 挂。
    const panel = container.querySelector('[data-testid="sidebar-system-status"]') as HTMLElement;
    expect(panel.textContent).not.toContain("运行正常");
    expect(panel.textContent).toContain("启动中");
    expect(panel.textContent).not.toContain("降级运行");
    expect(container.querySelector('[data-testid="sidebar-system-status-lamp"]')?.className).toContain("bg-text-faint");
    // 看板标题:部分行集不能当台账规模报「共 N」。
    const summary = headerSummary(container);
    expect(summary).not.toContain("共");
    expect(summary).toContain("行集加载中");
  });

  it("once the cut is complete again the title and the sidebar go back to the caught-up reading", async () => {
    // 同一条 App 接线在完整切面上必须回到原口径:修复不能把「加载中」永久粘住。
    const { container } = await mountBoard({ truncated: false });
    expect(projectionLine(container)).toContain("落后 0 revisions");
    expect(projectionLine(container)).not.toContain("行集加载中");
    expect(headerSummary(container)).toContain("共 2");
    expect(headerSummary(container)).not.toContain("行集加载中");
  });
});
