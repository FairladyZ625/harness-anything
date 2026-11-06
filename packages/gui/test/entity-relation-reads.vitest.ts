// @vitest-environment happy-dom
// harness-test-tier: fast
//
// 切片 A:详情面按焦点实体读关系。这里挂真实 App,断言桥上真正发出的 selector:
//   1. factDetail / decisionDetail 只发 entity 页读,不再排空全量 relations;
//   2. 阴性对照:关系图(领地)视图仍发完整图读。
// 这些断言在改造前是红的(factDetail/decisionDetail 只发 `{repoId, limit:500}` 全量读)。
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "../src/renderer/App.tsx";
import { DEFAULT_TASK_FILTERS } from "../src/renderer/model/taskFilters.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { TaskRelationsTab } from "../src/renderer/components/taskDetail/TaskRelationsTab.tsx";
import { projectedTaskFields } from "./task-projection-fields.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";

const REPO_ID = "canonical";
const AT = "2026-08-29T00:00:00.000Z";

type RecordedCall = { readonly method: string; readonly payload: Record<string, unknown> | null };

function taskRow(taskId: string): Record<string, unknown> {
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

const EMPTY_GRAPH = { ok: true, edges: [], coverageRows: [], factAnchors: [], facts: [], warnings: [] };
const PAGE = { limit: 500, cursor: null, nextCursor: null };

/** 以某个视图(可带焦点实体)启动,等价于「会话停在这个页面」。 */
function startOnView(view: string, focusedEntityRef: string | null = null) {
  window.localStorage.setItem(
    `harness-view-history:${REPO_ID}`,
    JSON.stringify({
      schema: "gui-view-history/v1",
      history: {
        entries: [
          {
            view,
            selectedId: null,
            previewId: null,
            focusedEntityRef,
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

async function mountApp(view: string, focusedEntityRef: string | null = null) {
  const calls: RecordedCall[] = [];
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
    getTasks: async () => ({
      ok: true,
      status: "ready",
      rows: [taskRow("task_probe")],
      invalidRows: [],
      watermark: 1,
      sourceRevision: 1,
      warnings: [],
    }),
    getWorkspaceSummary: async () => ({
      schema: "daemon.workspace-summary/v1",
      ok: true,
      status: "ready",
      tasks: { lastChangedAt: null, total: 1, byStatus: { planned: 1 } },
      decisions: {
        total: 0,
        inboxCount: 0,
        byState: { proposed: 0, in_effect: 0, rejected: 0, deferred: 0, superseded: 0, outcome_retired: 0 },
        groups: [
          { id: "proposed", states: ["proposed"], count: 0, decisionIds: [] },
          { id: "in_effect", states: ["in_effect"], count: 0, decisionIds: [] },
          { id: "rejected", states: ["rejected"], count: 0, decisionIds: [] },
          { id: "deferred", states: ["deferred"], count: 0, decisionIds: [] },
          { id: "retired", states: ["superseded", "outcome_retired"], count: 0, decisionIds: [] },
        ],
      },
      watermark: 1,
      sourceRevision: 1,
      warnings: [],
    }),
    getCatalogSnapshot: async () => ({
      schema: "gui-catalog-snapshot/v2",
      ok: true,
      status: "ready",
      repoId: REPO_ID,
      observedAt: AT,
      catalogDigest: "probe-digest--------------------------",
      defaults: { verticalId: "software/coding", presetId: "standard-task", profileId: "baseline", locale: "zh-CN" },
      presets: [],
      templates: [],
      scaffolds: { task: [], repository: [] },
      bundledAgents: [],
    }),
    getAgenda: async () => ({
      ok: true,
      status: "ready",
      inFlight: [],
      pinnedEntities: [],
      pinnedEntityOverflow: 0,
      awaitingRestart: [],
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
      watermark: 1,
      sourceRevision: 1,
    }),
    // 关系读:记录 selector;entity 页回空页,完整图/facet 回空形状。
    getRelationGraph: async (payload) => {
      calls.push({ method: "getRelationGraph", payload: payload ?? null });
      return payload?.facet === undefined
        ? { ...EMPTY_GRAPH, page: PAGE }
        : { ...EMPTY_GRAPH, facet: payload.facet, page: PAGE };
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
        return async (payload?: Record<string, unknown> | null) => {
          calls.push({ method, payload: payload ?? null });
          return { ok: true };
        };
      },
    }),
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  startOnView(view, focusedEntityRef);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(App)));
  });
  for (let index = 0; index < 8; index += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  return { calls: () => calls.slice() };
}

const graphCalls = (calls: readonly RecordedCall[]) =>
  calls.filter(({ method }) => method === "getRelationGraph").map(({ payload }) => payload ?? {});
const fullGraphCalls = (calls: readonly RecordedCall[]) =>
  graphCalls(calls).filter((payload) => payload.entity === undefined && payload.facet === undefined);
const entityCalls = (calls: readonly RecordedCall[]) =>
  graphCalls(calls).filter((payload) => typeof payload.entity === "string");

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

describe("详情面按焦点实体读关系", () => {
  it("factDetail 只发 fact 的 entity 页读,不触发全量 relations", async () => {
    const { calls } = await mountApp("factDetail", "fact/F-ABC12345");
    expect(entityCalls(calls())).toContainEqual({ repoId: REPO_ID, entity: "fact/F-ABC12345", limit: 500 });
    expect(fullGraphCalls(calls())).toEqual([]);
  });

  it("decisionDetail 只发 decision 的 entity 页读,不触发全量 relations", async () => {
    const { calls } = await mountApp("decisionDetail", "decision/dec-1");
    expect(entityCalls(calls())).toContainEqual({ repoId: REPO_ID, entity: "decision/dec-1", limit: 500 });
    expect(fullGraphCalls(calls())).toEqual([]);
  });

  it("阴性对照:关系图(领地)视图仍取完整图", async () => {
    const { calls } = await mountApp("graph");
    expect(fullGraphCalls(calls())).toContainEqual({ repoId: REPO_ID, limit: 500 });
    expect(entityCalls(calls())).toEqual([]);
  });
});

describe("TaskRelationsTab", () => {
  const task: TaskRow = {
    taskId: "task-bound",
    title: "Bound task",
    projectId: REPO_ID,
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    lastKnownAt: AT,
    gates: [],
    docs: [],
    ...projectedTaskFields("active"),
  };

  it("按 task 实体读并排空该实体的页,不读完整关系图", async () => {
    const calls: Record<string, unknown>[] = [];
    viStubRelationGraph(async (payload) => {
      calls.push(payload);
      return payload.cursor === undefined
        ? {
            ...EMPTY_GRAPH,
            edges: [
              {
                relationId: "rel-1",
                sourceRef: "task/task-bound",
                targetRef: "task/task-other",
                relationType: "depends-on",
                direction: "directed",
                strength: "strong",
                origin: "declared",
                state: "active",
                current: true,
                rationale: "fixture",
                ownerRef: "task/task-bound",
                sourcePath: "event:fixture",
                recordIndex: 0,
              },
            ],
            page: { limit: 500, cursor: null, nextCursor: "entity-next" },
          }
        : { ...EMPTY_GRAPH, page: { limit: 500, cursor: "entity-next", nextCursor: null } };
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await act(async () => {
        root.render(
          createElement(
            QueryClientProvider,
            { client },
            createElement(TaskRelationsTab, { task, onOpenSession: () => undefined }),
          ),
        );
      });
      for (let index = 0; index < 8; index += 1)
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      expect(calls).toEqual([
        { repoId: REPO_ID, entity: "task/task-bound", limit: 500 },
        { repoId: REPO_ID, entity: "task/task-bound", limit: 500, cursor: "entity-next" },
      ]);
    } finally {
      await act(async () => root.unmount());
      Reflect.deleteProperty(window, "harness");
    }
  });
});

function viStubRelationGraph(
  read: (payload: { readonly cursor?: string } & Record<string, unknown>) => Promise<unknown>,
) {
  Object.defineProperty(window, "harness", {
    configurable: true,
    value: {
      getRelationGraph: read,
      getAgentRuntimeOverview: async () => ({ ok: true, sessions: [] }),
    },
  });
}
