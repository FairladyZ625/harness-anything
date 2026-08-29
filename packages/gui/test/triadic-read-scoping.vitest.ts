// @vitest-environment happy-dom
// harness-test-tier: fast
//
// 三元读取的挂载域(task_9d53606292a719b973b7bb9e7c):
//   根级 chrome 只读 derives 边切面 + 决策摘要;事实切面归 ⌘K 面板;完整投影归渲染
//   它的视图。台账 cut 变化只重取挂载中的查询。这里直接挂真实的 App,断言桥上真正
//   发出的读面,而不是断言某个内部函数被调用过。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "../src/renderer/App.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

const REPO_ID = "canonical";
const AT = "2026-08-29T00:00:00.000Z";

/** 一个最小但通过读取校验的投影行:placement 带 daemon 派生的 spawningDecisionIds。 */
function taskRow(taskId: string) {
  return {
    taskId,
    generation: "v1",
    workspaceRevision: 1,
    createdAt: AT,
    updatedAt: AT,
    packagePath: `tasks/${taskId}-probe`,
    coordinationStatus: "planned",
    snapshotAvailability: { consents: "known", codeDocWitnesses: "known", gateWitnesses: "known" },
    closeoutAssessment: { readiness: "not_required", gates: [] },
    blockingAssessment: { taskId, state: "clear", blockers: [], warnings: [] },
    placement: {
      moduleKeys: ["gui"],
      productLines: ["desktop"],
      spawningDecisionIds: ["dec-probe"],
      parentTaskId: null,
      origin: "native",
      engine: "kernel/task-lifecycle/v1",
      packageDisposition: "active",
      provenance: [{ kind: "l2", ref: `tasks/${taskId}-probe/INDEX.md` }],
    },
    executionEvidence: [],
    snapshot: {
      revision: 1,
      task: {
        schema: "task/v1",
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
        metadata: {
          idempotencyKey: null,
          parentTaskId: null,
          workKind: "feat",
          riskTier: "low",
          urgency: "low",
          verticalId: "software/coding",
          presetId: "standard-task",
          profileId: "baseline",
          moduleKey: "gui",
          slug: taskId,
          surfaces: [],
          fromLegacyId: null,
        },
      },
      executions: [],
      reviews: [],
      consents: [],
      codeDocWitnesses: [],
      gateWitnesses: [],
      edgesTaken: [],
      lease: null,
      decisionRelations: [],
    },
  };
}

const EMPTY_GRAPH_FACET = {
  ok: true,
  edges: [],
  coverageRows: [],
  factAnchors: [],
  facts: [],
  warnings: [],
};

type RecordedCall = { readonly method: string; readonly payload: Record<string, unknown> | null };

function emptyRelationFacet(facet: string) {
  return { ...EMPTY_GRAPH_FACET, facet };
}

/** 直接以某个视图启动(等价于「会话停在这个页面」),避免先经过总览。 */
function startOnView(view: string) {
  window.sessionStorage.setItem(
    `harness-view-history:${REPO_ID}`,
    JSON.stringify({
      schema: "gui-view-history/v1",
      history: {
        entries: [
          {
            view,
            selectedId: null,
            previewId: null,
            focusedEntityRef: null,
            taskFilters: {
              query: "",
              module: "all",
              engine: "all",
              status: [],
              closeout: "all",
              freshness: "all",
              includeArchived: false,
              favoritesOnly: false,
            },
            drill: null,
          },
        ],
        index: 0,
      },
    }),
  );
}

/**
 * 挂 App,从 `options.view` 起步。`getTasks` 决定台账 cut:每次返回的 watermark/
 * sourceRevision 变化都会触发 `invalidateLedgerDependents`,这正是被测的失效面。
 */
async function mountApp(options: { readonly view: string }): Promise<{
  readonly calls: () => readonly RecordedCall[];
  readonly container: HTMLElement;
  readonly navigate: (label: string) => Promise<void>;
  readonly advanceLedger: () => Promise<void>;
  readonly mark: () => number;
}> {
  const calls: RecordedCall[] = [];
  let revision = 1;
  const bridge: Record<string, (payload?: Record<string, unknown> | null) => Promise<unknown>> = {
    getSystemStatus: async () => ({
      schema: "gui-system-status/v1",
      ok: true,
      observedAt: AT,
      daemon: { uptimeMs: 1 },
      repos: [
        {
          repoId: REPO_ID,
          displayName: "Probe",
          canonicalRoot: "/tmp/probe",
          registrationState: "enabled",
          cellState: "attached",
        },
      ],
    }),
    getTasks: async () => ({
      ok: true,
      status: "ready",
      rows: [taskRow("task_probe")],
      watermark: revision,
      sourceRevision: revision,
      warnings: [],
    }),
    getWorkspaceSummary: async () => ({
      schema: "daemon.workspace-summary/v1",
      ok: true,
      status: "ready",
      tasks: { total: 1, byStatus: { planned: 1 } },
      decisions: {
        total: 0,
        inboxCount: 0,
        byState: {},
        groups: [],
      },
      watermark: 1,
      sourceRevision: 1,
      warnings: [],
    }),
    getCatalogSnapshot: async () => ({
      schema: "gui-catalog-snapshot/v1",
      ok: true,
      status: "ready",
      repoId: REPO_ID,
      observedAt: AT,
      catalogDigest: "probe-digest--------------------------",
      defaults: { verticalId: "software/coding", presetId: "standard-task", profileId: "baseline", locale: "zh-CN" },
      presets: [],
      templates: [],
      scaffolds: { task: [], repository: [] },
      adapters: [],
    }),
    // 三元读面:任何切面都返回空集——这里测的是「谁被请求」,不是「返回什么」。
    getRelationGraph: async (payload) => {
      calls.push({ method: "getRelationGraph", payload: payload ?? null });
      const facet = payload?.facet;
      return facet === undefined ? EMPTY_GRAPH_FACET : emptyRelationFacet(String(facet));
    },
    getDecisions: async (payload) => {
      calls.push({ method: "getDecisions", payload: payload ?? null });
      return payload?.projection === "summary"
        ? { ok: true, projection: "summary", decisions: [], warnings: [] }
        : { ok: true, decisions: [], warnings: [] };
    },
  };
  Object.defineProperty(window, "harness", {
    configurable: true,
    value: new Proxy(bridge, {
      get(target, method: string) {
        if (method in target) return target[method];
        // 未显式建模的读面统一回空成功,避免把断言面扩大到无关查询。
        return async (payload?: Record<string, unknown> | null) => {
          calls.push({ method, payload: payload ?? null });
          return { ok: true };
        };
      },
    }),
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  startOnView(options.view);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(App)));
  });
  /** 宏任务轮次排空:挂载链(render → systemStatus → repoId → 各读面)与失效链
   *  (visibilitychange → 任务重读 → cut 前进 → invalidate → 挂载面重取)都要跨
   *  多个 promise 世代,微任务轮次不够。 */
  const flush = async () => {
    for (let index = 0; index < 8; index += 1)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
  };
  await flush();
  /**
   * 推进台账 cut:改 watermark 后用一次可见性变化触发任务列表重读(taskListQuery 是
   * `refetchOnWindowFocus:"always"`;react-query v5 的 focusManager 在 **window** 上听
   * `visibilitychange`,happy-dom 里 `document.visibilityState` 恒为 "visible")。
   */
  const advanceLedger = async () => {
    revision += 1;
    await act(async () => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
  };
  const mark = () => calls.length;
  const navigate = async (label: string) => {
    await act(async () => {
      const target = [...container.querySelectorAll("button")].find(
        (element) => element.textContent?.trim() === label && element.title === label,
      );
      expect(target, `导航按钮缺失:${label}`).toBeTruthy();
      target!.click();
    });
    await flush();
  };
  return { calls: () => calls.slice(), container, navigate, advanceLedger, mark };
}

const mounted: { root: Root; container: HTMLElement }[] = [];

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
  window.sessionStorage.clear();
  window.localStorage.clear();
});

const relationGraphCalls = (calls: readonly RecordedCall[]) =>
  calls.filter(({ method }) => method === "getRelationGraph");
const decisionCalls = (calls: readonly RecordedCall[]) => calls.filter(({ method }) => method === "getDecisions");

describe("三元读取按挂载域分层", () => {
  it("任务看板会话只读 derives 边切面与决策摘要,没有完整投影", async () => {
    const { calls } = await mountApp({ view: "board" });
    // 挂载水合时首批 tasks 数据到达会触发一次初始 cut 失效,常驻窄面因此各被读两遍
    // (读形不变,这是与 main 相同的既有行为);断言的是读面集合,不是次数。
    expect([...new Set(relationGraphCalls(calls()).map(({ payload }) => payload?.facet))]).toEqual(["edges"]);
    expect([...new Set(decisionCalls(calls()).map(({ payload }) => payload?.projection))]).toEqual(["summary"]);
  });

  it("台账 cut 前进时,看板上只重取挂载中的窄面,完整投影不被重取", async () => {
    const { calls, mark, advanceLedger } = await mountApp({ view: "board" });
    const atBoard = mark();
    await advanceLedger();
    const since = calls().slice(atBoard);
    // 失效确实发生了:常驻的 derives 切面与决策摘要被重取。
    expect(relationGraphCalls(since).some(({ payload }) => payload?.facet === "edges")).toBe(true);
    expect(decisionCalls(since).some(({ payload }) => payload?.projection === "summary")).toBe(true);
    // 但完整投影没有:没有视图挂载它,就没有它的请求。
    expect(relationGraphCalls(since).some(({ payload }) => payload?.facet === undefined)).toBe(false);
    expect(decisionCalls(since).some(({ payload }) => payload?.projection === undefined)).toBe(false);
  });

  it("关系图视图挂载时恰好读一次完整投影,离开后不再读", async () => {
    const { calls, navigate, mark } = await mountApp({ view: "board" });
    const atBoard = mark();
    await navigate("关系图");
    const atGraph = mark();
    // 进入图视图的那一次转换只读一份完整投影(图 + 决策全量行各一次)。
    expect(relationGraphCalls(calls().slice(atBoard, atGraph)).map(({ payload }) => payload?.facet)).toEqual([
      undefined,
    ]);
    expect(decisionCalls(calls().slice(atBoard, atGraph)).map(({ payload }) => payload?.projection)).toEqual([
      undefined,
    ]);
    await navigate("看板");
    expect(relationGraphCalls(calls().slice(atGraph)).some(({ payload }) => payload?.facet === undefined)).toBe(false);
  });

  it("关系图视图仍挂载时,台账 cut 会重取完整投影(挂载中的视图照常刷新)", async () => {
    const { calls, mark, advanceLedger } = await mountApp({ view: "graph" });
    const atGraph = mark();
    await advanceLedger();
    expect(relationGraphCalls(calls().slice(atGraph)).some(({ payload }) => payload?.facet === undefined)).toBe(true);
    expect(decisionCalls(calls().slice(atGraph)).some(({ payload }) => payload?.projection === undefined)).toBe(true);
  });

  it("⌘K 面板合着时不读事实切面", async () => {
    const { calls } = await mountApp({ view: "board" });
    expect(relationGraphCalls(calls()).some(({ payload }) => payload?.facet === "facts")).toBe(false);
  });
});
