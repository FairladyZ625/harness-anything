// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HomeView } from "../src/renderer/views/HomeView.tsx";
import { OverviewView } from "../src/renderer/views/OverviewView.tsx";
import { BoardView } from "../src/renderer/views/BoardView.tsx";
import { DecisionsView } from "../src/renderer/views/DecisionsView.tsx";
import { DecisionPoolView } from "../src/renderer/views/DecisionPoolView.tsx";
import { FactDetailView } from "../src/renderer/views/EntityDetailView.tsx";
import { DecisionDetailView } from "../src/renderer/components/decisionDetail/DecisionDetailView.tsx";
import { FreshnessView } from "../src/renderer/views/FreshnessView.tsx";
import { freshnessCandidates } from "../src/renderer/model/freshness.ts";
import { EntityWorkspace } from "../src/renderer/components/EntityWorkspace.tsx";
import { PresetsView } from "../src/renderer/views/PresetsView.tsx";
import { AdaptersView } from "../src/renderer/views/AdaptersView.tsx";
import { SessionsView } from "../src/renderer/views/SessionsView.tsx";
import { AgentSquadView } from "../src/renderer/views/AgentSquadView.tsx";
import { ProvidersView } from "../src/renderer/views/ProvidersView.tsx";
import { SystemView } from "../src/renderer/views/SystemView.tsx";
import { DaemonObserveView } from "../src/renderer/views/DaemonObserveView.tsx";
import { SettingsView } from "../src/renderer/views/SettingsView.tsx";
import { TaskDetailView } from "../src/renderer/views/TaskDetailView.tsx";
import { TaskPreviewDrawer } from "../src/renderer/components/TaskPreviewDrawer.tsx";
import { CommandPalette, buildPaletteIndex } from "../src/renderer/components/CommandPalette.tsx";
import { FactInspector } from "../src/renderer/components/FactInspector.tsx";
import { EntityRefLink } from "../src/renderer/components/EntityRefLink.tsx";
import { agentRuntimeClient } from "../src/renderer/agent-runtime-client.ts";
import { harnessClient } from "../src/renderer/api-client.ts";
import { squadRunsClient } from "../src/renderer/squad-run-client.ts";
import { DEFAULT_TASK_FILTERS } from "../src/renderer/model/taskFilters.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { NAV_GROUPS } from "../src/renderer/navigation/navConfig.tsx";
import type { ViewId } from "../src/renderer/navigation/viewHistory.ts";
import type { SystemRepoRow } from "../src/renderer/api-client.ts";
import type { RelationCoverageRow } from "../src/renderer/api/renderer-dto.ts";
import {
  REPO_ID,
  TASK_A_ID,
  DECISION_ID,
  FACT_REF,
  AGENT_ID,
  SQUAD_ID,
  PROVIDER_ID,
  SESSION_ID,
  FIXTURE_TASKS,
  FIXTURE_DECISIONS,
  FIXTURE_FACTS,
  FIXTURE_RELATIONS,
  FIXTURE_PROJECT,
  FIXTURE_WORKSPACE_SUMMARY,
  FIXTURE_SESSION_DTO,
  FIXTURE_RUNTIME_OVERVIEW,
  FIXTURE_INSTANCE,
  FIXTURE_AGENT_ROW,
  FIXTURE_SQUAD_ROW,
  FIXTURE_AGENT_DETAIL,
  FIXTURE_SQUAD_DETAIL,
  FIXTURE_DOCK_ROW,
  FIXTURE_SESSION_GROUPS,
  ENTITY_ID_NEEDLES,
} from "./entityIdGateFixtures.ts";
import { scanDeadEntityIds } from "./entityIdScan.ts";

/**
 * G10 实体互链不变量 · 行为半边(主判据)。
 *
 * 把 ViewId 全集的每个视图用 fixture 实体宇宙渲染进真实 DOM,然后扫描:
 * 文本里出现实体 ID 而没有可激活祖先 = 违规(判据见 entityIdScan.ts)。
 *
 * 覆盖的完备性是机制性的:VIEW_RENDERERS 以 `satisfies Record<ViewId, …>`
 * 键在全 ViewId 联合上,新增视图不改这里会直接 type error;运行时再按
 * NAV_GROUPS 断言每个导航面都有渲染入口。
 */

const noop = () => undefined;
const AT = "2026-08-20T00:00:00.000Z";
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
  vi.restoreAllMocks();
});

function fixtureRepoRow(): SystemRepoRow {
  return {
    repoId: REPO_ID,
    displayName: "G10 Probe Repo",
    canonicalRoot: "/tmp/g10-probe",
    authoredBranch: "main",
    registrationState: "enabled",
    cellState: "attached",
    generation: 1,
    queueDepth: 0,
    lockState: "not_applicable",
    recoveryMs: null,
    lastError: null,
    unavailableReason: null,
  };
}

function seedRuntimeQueries(client: QueryClient): void {
  client.setQueryData(["runtime-instances", "machine"], {
    installations: FIXTURE_RUNTIME_OVERVIEW.installations,
    instances: [FIXTURE_INSTANCE],
  });
  client.setQueryData(["runtime-control", REPO_ID, "overview"], FIXTURE_RUNTIME_OVERVIEW);
  client.setQueryData(["agents", REPO_ID], [FIXTURE_AGENT_ROW]);
  client.setQueryData(["squads", REPO_ID], [FIXTURE_SQUAD_ROW]);
  client.setQueryData(["catalog", REPO_ID, "snapshot"], {
    status: "ready",
    catalogDigest: "digest-g10digest-g10digest-g10",
    defaults: { presetId: "preset-g10", locale: "zh-CN" },
    presets: [
      {
        id: "preset-g10",
        title: "G10 Preset",
        description: "fixture 预设",
        verticalId: "g10",
        sourceKind: "bundled",
        validity: "valid",
        version: "1",
        defaultProfile: null,
        entrypoints: [],
        issues: [],
        shadows: null,
      },
    ],
    verticals: [],
    templates: [],
    adapters: [],
  });
  client.setQueryData(["catalog", REPO_ID, "preset", "preset-g10", "zh-CN"], {
    preset: { id: "preset-g10", verticalId: "g10", extends: null, capabilityImports: [] },
    resolved: { digest: "digest-g10", provenance: {} },
  });
  client.setQueryData(["agent-skills", REPO_ID], []);
  client.setQueryData(["agent-detail", REPO_ID, AGENT_ID], FIXTURE_AGENT_DETAIL);
  client.setQueryData(["squad-detail", REPO_ID, SQUAD_ID], FIXTURE_SQUAD_DETAIL);
  client.setQueryData(["task-detail", REPO_ID, TASK_A_ID, "dispatches"], {
    ok: true,
    status: "ready",
    taskId: TASK_A_ID,
    watermark: 1,
    sourceRevision: 1,
    dispatches: [{ ...FIXTURE_DOCK_ROW, squad: null }],
  });
  client.setQueryData(["task-detail", REPO_ID, SESSION_ID, "session"], {
    ok: true,
    status: "ready",
    session: FIXTURE_SESSION_DTO,
    result: { ref: "artifact:g10", text: "G10 fixture 报告。" },
    watermark: 1,
    sourceRevision: 1,
  });
  client.setQueryData(["task-detail", REPO_ID, SESSION_ID, "events", "lifecycle:0"], {
    ok: true,
    runtimeSessionId: SESSION_ID,
    events: [{ cursor: "lifecycle:1", runtimeSessionId: SESSION_ID, type: "activity", occurredAt: AT }],
    cursor: "lifecycle:1",
    sourceCursor: "lifecycle:1",
    done: true,
  });
  // 决策详情正文(decision-show 单体 read 的缓存面):避免该视图在无桥环境下落到错误态。
  client.setQueryData(["decision-body", REPO_ID, DECISION_ID], {
    status: "ready",
    hint: null,
    decision: {
      decisionId: DECISION_ID,
      body: {
        path: `decisions/decision-${DECISION_ID}/decision.md`,
        blobSha256: `sha256:${"g10".repeat(32)}`,
        size: 64,
        mediaType: "text/markdown",
        body: "# 探针决策正文\n\n正文经单体 read 取回。",
        workspaceRevision: 1,
      },
    },
  } as never);
  client.setQueryData(["system", "global", "status"], {
    schema: "gui-system-status/v1",
    ok: true,
    observedAt: AT,
    daemon: {
      daemonId: "daemon-g10",
      pid: 1,
      startedAt: AT,
      protocolVersion: { major: 1, minor: 0 },
      uptimeMs: 1000,
      endpoint: "sock",
      build: { version: "g10", commitSha: null },
      activeControl: null,
    },
    repos: [fixtureRepoRow()],
  });
}

async function mountSurface(element: ReturnType<typeof createElement>, { seed = true } = {}): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seed) seedRuntimeQueries(client);
  vi.spyOn(agentRuntimeClient, "session").mockResolvedValue({
    ok: true,
    status: "ready",
    session: FIXTURE_SESSION_DTO,
    result: null,
    watermark: 1,
    sourceRevision: 1,
  } as never);
  vi.spyOn(agentRuntimeClient, "attach").mockImplementation((() => () => undefined) as never);
  vi.spyOn(agentRuntimeClient, "events").mockResolvedValue({
    ok: true,
    runtimeSessionId: SESSION_ID,
    events: [],
    cursor: "lifecycle:1",
    sourceCursor: "lifecycle:1",
    done: true,
  } as never);
  vi.spyOn(agentRuntimeClient, "sessionGroups").mockImplementation(async (_repoId, query = {}) =>
    query.groupBy === "task" || (query.query !== undefined && query.query !== "")
      ? FIXTURE_SESSION_GROUPS
      : { ...FIXTURE_SESSION_GROUPS, groups: [] },
  );
  vi.spyOn(agentRuntimeClient, "overview").mockImplementation(async (_repoId, taskId?: string) =>
    taskId === TASK_A_ID ? FIXTURE_RUNTIME_OVERVIEW : { ...FIXTURE_RUNTIME_OVERVIEW, sessions: [] },
  );
  vi.spyOn(harnessClient, "getTaskDispatches").mockImplementation(
    async (payload) =>
      ({
        ok: true,
        status: "ready",
        taskId: (payload as { readonly taskId: string }).taskId,
        dispatches:
          (payload as { readonly taskId: string }).taskId === TASK_A_ID
            ? [{ ...FIXTURE_DOCK_ROW, dispatchId: "dispatch-g10round", startedAt: AT }]
            : [],
        watermark: 1,
        sourceRevision: 1,
      }) as never,
  );
  // G6-B 观察页:observe.tail 按请求 kind 回一页含 fixture 实体引用的行,
  // 让死 ID 扫描覆盖到流内 chip 的渲染面(done=true → 挂载期只发生一次读)。
  vi.spyOn(harnessClient, "tailObservability").mockImplementation(async (payload) => {
    const kind = (payload as { readonly kind: "events" | "repo-log" | "daemon-log" }).kind,
      logCursor = { kind, fileId: "log-file-g10", offset: 12 },
      eventsCursor = { kind: "events" as const, revision: 7 };
    return {
      schema: "daemon.observe-tail/v2",
      ok: true,
      repoId: REPO_ID,
      mode: "local",
      kind,
      direction: payload.direction,
      status: "ready",
      items:
        kind === "events"
          ? [
              {
                schema: "task-event/v1",
                eventId: "ev-g10-task",
                workspaceRevision: 4,
                opId: "op-g10",
                type: "task_created",
                actor: { kind: "agent", id: AGENT_ID },
                source: { channel: "cli" },
                occurredAt: AT,
                taskId: TASK_A_ID,
                payload: { task: { title: "G10 探针任务甲" } },
              },
              {
                schema: "decision-event/v1",
                eventId: "ev-g10-decision",
                workspaceRevision: 5,
                opId: "op-g10",
                type: "decision_proposed",
                actor: { kind: "agent", id: AGENT_ID },
                source: { channel: "cli" },
                occurredAt: AT,
                decisionId: DECISION_ID,
                payload: { title: "G10 探针决策" },
              },
              {
                schema: "fact-event/v1",
                eventId: "ev-g10-fact",
                workspaceRevision: 6,
                opId: "op-g10",
                type: "fact_recorded",
                actor: { kind: "agent", id: AGENT_ID },
                source: { channel: "cli" },
                occurredAt: AT,
                taskId: TASK_A_ID,
                factId: "F-g10a",
                payload: { statement: "fixture 事实行" },
              },
              {
                schema: "agent-runtime-event/v1",
                eventId: "ev-g10-runtime",
                workspaceRevision: 7,
                opId: "op-g10",
                type: "runtime_session_started",
                actor: { kind: "agent", id: AGENT_ID },
                source: { channel: "cli" },
                occurredAt: AT,
                payload: { runtimeSessionId: SESSION_ID, instanceId: PROVIDER_ID },
              },
              {
                schema: "entity-event/v1",
                eventId: "ev-g10-entity",
                workspaceRevision: 8,
                opId: "op-g10",
                type: "entity_upserted",
                actor: { kind: "agent", id: AGENT_ID },
                source: { channel: "cli" },
                occurredAt: AT,
                payload: { entityKind: "agent", entityId: AGENT_ID },
              },
            ]
          : [
              {
                schema: kind === "repo-log" ? "daemon-request-log/v1" : "daemon-conn-log/v1",
                at: AT,
                method: "repo.tasks.list",
                event: "request",
                ok: true,
                durationMs: 3,
              },
            ],
      historyCursor: payload.direction === "history" ? (kind === "events" ? eventsCursor : logCursor) : null,
      liveCursor: kind === "events" ? eventsCursor : logCursor,
      sourceCursor: kind === "events" ? eventsCursor : logCursor,
      done: true,
    } as never;
  });
  vi.spyOn(squadRunsClient, "list").mockResolvedValue({
    ok: true,
    status: "ready",
    runs: [],
    totals: { runs: 0 },
    truncated: false,
    watermark: 1,
    sourceRevision: 1,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, element));
  });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

const SYSTEM_HEALTH = {
  daemon: { ok: true, observedAt: AT },
  repo: { repoId: REPO_ID, registrationState: "enabled" } as never,
  projection: { watermark: 1, sourceRevision: 1, status: "ready" } as never,
};

const runtimeTasks = [{ taskId: TASK_A_ID, title: "G10 探针任务甲" }];

const VIEW_RENDERERS = {
  home: () => createElement(HomeView, { repos: [fixtureRepoRow()], currentRepoId: REPO_ID, onOpenProject: noop }),
  overview: () =>
    createElement(OverviewView, {
      project: FIXTURE_PROJECT,
      tasks: FIXTURE_TASKS,
      decisions: FIXTURE_DECISIONS,
      workspaceSummary: FIXTURE_WORKSPACE_SUMMARY,
      relations: FIXTURE_RELATIONS,
      systemHealth: SYSTEM_HEALTH,
      onSelect: noop,
      onDrill: noop,
      onOpenInbox: noop,
      onOpenDecision: noop,
      onOpenSystem: noop,
    }),
  board: () =>
    createElement(BoardView, {
      tasks: FIXTURE_TASKS,
      allTasks: FIXTURE_TASKS,
      filters: DEFAULT_TASK_FILTERS,
      onFiltersChange: noop,
      onSelect: noop,
      relations: FIXTURE_RELATIONS,
      favorites: new Set<string>(),
      onToggleFavorite: noop,
      onStartTask: noop,
      mutationFeedback: noop,
    }),
  graph: () =>
    createElement(EntityWorkspace, {
      focusedEntityRef: `decision/${DECISION_ID}`,
      tasks: FIXTURE_TASKS,
      relations: FIXTURE_RELATIONS,
      decisions: FIXTURE_DECISIONS,
      facts: FIXTURE_FACTS,
      coverageRows: [],
      factAnchors: [],
      onNavigateEntity: noop,
      onOpenDecisionPool: noop,
      onFocusEntityChange: noop,
      recentRefs: [`decision/${DECISION_ID}`],
      entries: [],
      onOpenPalette: noop,
    }),
  decisions: () =>
    createElement(DecisionsView, {
      decisions: FIXTURE_DECISIONS,
      tasks: FIXTURE_TASKS,
      relations: FIXTURE_RELATIONS,
      facts: FIXTURE_FACTS,
      onJudge: () => Promise.resolve({ state: "success", kind: "accept", opId: "op-g10", hint: "fixture" } as never),
      mutationFeedback: noop,
      onCheckReceipt: noop,
      relationState: "ready",
      onNavigateDecision: noop,
      onNavigateTask: noop,
      onFocusGraph: noop,
      coverageRows: [],
    }),
  decisionPool: () =>
    createElement(DecisionPoolView, {
      repoId: REPO_ID,
      decisions: FIXTURE_DECISIONS,
      summary: FIXTURE_WORKSPACE_SUMMARY.decisions,
      facts: FIXTURE_FACTS,
      relations: FIXTURE_RELATIONS,
      coverageRows: [],
      relationState: "ready",
      onPropose: () => Promise.resolve({ state: "success", kind: "propose", opId: "op-g10", hint: "fixture" } as never),
      proposalFeedback: undefined,
      onJudge: () => Promise.resolve({ state: "success", kind: "accept", opId: "op-g10", hint: "fixture" } as never),
      mutationFeedback: noop,
      onCheckReceipt: noop,
      focusedDecisionId: DECISION_ID,
      onFocusGraph: noop,
    }),
  freshness: () =>
    createElement(FreshnessView, {
      decisions: FIXTURE_DECISIONS,
      coverageRows: FRESHNESS_COVERAGE_ROWS,
      relationState: "ready",
      onNavigateEntity: noop,
    }),
  decisionDetail: () =>
    createElement(DecisionDetailView, {
      repoId: REPO_ID,
      decisionId: DECISION_ID,
      decisions: FIXTURE_DECISIONS,
      tasks: FIXTURE_TASKS,
      relations: FIXTURE_RELATIONS,
      loading: false,
      onBack: noop,
      projectName: "G10",
      fromViewLabel: "决策池",
      onNavigateDecision: noop,
      onNavigateTask: noop,
      onNavigateEntity: noop,
      onFocusGraph: noop,
      onOpenPool: noop,
    }),
  factDetail: () =>
    createElement(FactDetailView, {
      factRef: FACT_REF,
      facts: FIXTURE_FACTS,
      tasks: FIXTURE_TASKS,
      decisions: FIXTURE_DECISIONS,
      relations: FIXTURE_RELATIONS,
      factAnchors: [],
      coverageRows: [],
      loading: false,
      onNavigateEntity: noop,
      onNavigateDecision: noop,
      onNavigateTask: noop,
      onFocusGraph: noop,
    }),
  presets: () =>
    createElement(PresetsView, {
      repoId: REPO_ID,
      focusedPresetId: null,
      onOpenPreset: noop,
      onExitDetail: noop,
      projectName: FIXTURE_PROJECT.name,
    }),
  adapters: () => createElement(AdaptersView, { repoId: REPO_ID, tasks: FIXTURE_TASKS }),
  sessions: () =>
    createElement(SessionsView, {
      repoId: REPO_ID,
      relations: FIXTURE_RELATIONS,
      focusedEntityRef: `session/${SESSION_ID}`,
      onSelectEntity: noop,
      onOpenTask: noop,
    }),
  agentSquad: () =>
    createElement(AgentSquadView, {
      repoId: REPO_ID,
      tasks: runtimeTasks.map((task) => ({ ...task, heldLease: false })),
      focusedEntityRef: `agent/${AGENT_ID}`,
      onSelectEntity: noop,
    }),
  providers: () =>
    createElement(ProvidersView, {
      repoId: REPO_ID,
      focusedEntityRef: `provider/${PROVIDER_ID}`,
      onSelectEntity: noop,
    }),
  system: () => createElement(SystemView, { activeRepoId: REPO_ID, onOpenObserve: noop }),
  daemonObserve: () =>
    createElement(DaemonObserveView, {
      repoId: REPO_ID,
      repos: [fixtureRepoRow()],
      onBack: noop,
      onNavigateEntity: noop,
    }),
  settings: () => createElement(SettingsView, {}),
} satisfies Record<ViewId, () => ReturnType<typeof createElement>>;

const navViewIds: readonly ViewId[] = NAV_GROUPS.flatMap((group: { items: readonly { id: ViewId }[] }) =>
  group.items.map((item) => item.id),
);

/**
 * 风化视图的 coverage 夹具:fixture 决策 dec_g10alpha 的承重 claim CH1 处于
 * uncovered(被活事实反驳),让 it.each 的死 ID 扫描覆盖到反驳事实链接的渲染面。
 * uncovered 行的成因由夹具直接以 freshnessReason 提供(daemon 读面附带、kernel
 * `freshnessReasonOf` 判定)——本测试不重算成因,与 renderer 同为纯消费者。
 */
function freshnessCoverage(patch: Partial<RelationCoverageRow> = {}): RelationCoverageRow {
  return {
    decisionRef: `decision/${DECISION_ID}`,
    claimRef: `decision/${DECISION_ID}/CH1`,
    status: "covered",
    fulfillment: "standing-policy",
    refutingFactRefs: [],
    relationPath: [],
    basisRevision: 1,
    ...patch,
  };
}
const FRESHNESS_COVERAGE_ROWS: readonly RelationCoverageRow[] = [
  freshnessCoverage({ status: "uncovered", refutingFactRefs: [FACT_REF], freshnessReason: "refuted" }),
  freshnessCoverage({ claimRef: `decision/${DECISION_ID}/CH2`, status: "covered" }),
];

describe("G10 entity-id-links 行为判据:视图渲染出的实体 ID 必须可激活", () => {
  it("ViewId 全集都有渲染入口,且与导航面一致(覆盖完备性)", () => {
    // 渲染面直接取 VIEW_RENDERERS 的键全集:映射里有的每个视图都必须真的被渲染,
    // 「在映射里但没渲染」的键在这里被导航面一致性断言拦下。
    const declared = new Set(Object.keys(VIEW_RENDERERS));
    expect([...declared].sort()).toEqual(
      [...navViewIds, "home", "decisionDetail", "factDetail", "daemonObserve"].sort(),
    );
    for (const id of navViewIds) expect(declared.has(id), `导航面 view ${id} 缺渲染入口`).toBe(true);
  });

  it.each(Object.keys(VIEW_RENDERERS))("视图 %s:fixture 实体宇宙渲染后无死 ID", async (viewId) => {
    const container = await mountSurface(
      (VIEW_RENDERERS as Record<string, () => ReturnType<typeof createElement>>)[viewId]!(),
    );
    const findings = scanDeadEntityIds(container, viewId, ENTITY_ID_NEEDLES);
    expect(findings).toEqual([]);
  });

  it("额外表面:总览打开决策预览抽屉后无死 ID", async () => {
    const container = await mountSurface(VIEW_RENDERERS.overview());
    const row = container.querySelector<HTMLButtonElement>('[data-testid="decision-stream-rows"] button');
    expect(row).not.toBeNull();
    await act(async () => {
      row!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(scanDeadEntityIds(container, "overview+decisionPreviewDrawer", ENTITY_ID_NEEDLES)).toEqual([]);
  });

  it("额外表面:Task 详情 / 预览抽屉 / 命令面板", async () => {
    const detail = await mountSurface(
      createElement(TaskDetailView, {
        task: FIXTURE_TASKS[0]!,
        tasks: FIXTURE_TASKS,
        relations: FIXTURE_RELATIONS,
        decisions: FIXTURE_DECISIONS,
        onBack: noop,
        onSelect: noop,
        projectName: FIXTURE_PROJECT.name,
        fromViewLabel: "总览",
        onNavigateDecision: noop,
        onNavigateEntity: noop,
        mutationFeedback: undefined,
        onProgress: noop,
        onSubmit: () => Promise.resolve(),
      }),
    );
    // 派工页签是 Task 详情最大的实体 ID 面:点开后再扫。
    const dispatchTab = detail.querySelector<HTMLButtonElement>("#task-tab-dispatch");
    expect(dispatchTab).not.toBeNull();
    await act(async () => {
      dispatchTab!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(scanDeadEntityIds(detail, "taskDetailView", ENTITY_ID_NEEDLES)).toEqual([]);

    const drawer = await mountSurface(
      createElement(TaskPreviewDrawer, {
        task: FIXTURE_TASKS[0]!,
        tasks: FIXTURE_TASKS,
        relations: FIXTURE_RELATIONS,
        onClose: noop,
        onOpenDetail: noop,
        onPreviewTask: noop,
      }),
    );
    expect(scanDeadEntityIds(drawer, "taskPreviewDrawer", ENTITY_ID_NEEDLES)).toEqual([]);

    const inspector = await mountSurface(
      createElement(FactInspector, {
        factRef: FACT_REF,
        facts: FIXTURE_FACTS,
        tasks: FIXTURE_TASKS,
        decisions: FIXTURE_DECISIONS,
        relations: FIXTURE_RELATIONS,
        onClose: noop,
        onNavigateDecision: noop,
        onNavigateTask: noop,
        onFocusGraph: noop,
        coverageRows: [],
      }),
    );
    expect(scanDeadEntityIds(inspector, "factInspector", ENTITY_ID_NEEDLES)).toEqual([]);

    const palette = await mountSurface(
      createElement(CommandPalette, {
        open: true,
        entries: buildPaletteIndex(FIXTURE_TASKS, FIXTURE_DECISIONS, FIXTURE_FACTS),
        onSelect: noop,
        onClose: noop,
      }),
    );
    expect(scanDeadEntityIds(palette, "commandPalette", ENTITY_ID_NEEDLES)).toEqual([]);
  });

  it("阳性对照:扫描器必须抓到死 ID(用真实 fixture ID,不靠字段名)", async () => {
    const container = await mountSurface(
      createElement(() => createElement("p", null, `派工会话 ${SESSION_ID} 已绑定 ${AGENT_ID}`), {}),
      { seed: false },
    );
    const findings = scanDeadEntityIds(container, "positive-control", ENTITY_ID_NEEDLES);
    expect(findings.map((finding) => finding.needle).sort()).toEqual([AGENT_ID, SESSION_ID].sort());
  });

  it("阴性对照:同一 ID 经 EntityRefLink 渲染即通过,且点击带出正确 ref", async () => {
    const navigated: string[] = [];
    const container = await mountSurface(
      createElement(
        () =>
          createElement(
            "p",
            null,
            "会话 ",
            createElement(EntityRefLink, {
              entityRef: `session/${SESSION_ID}`,
              onNavigate: (ref) => navigated.push(ref),
            }),
          ),
        {},
      ),
      { seed: false },
    );
    expect(scanDeadEntityIds(container, "negative-control", ENTITY_ID_NEEDLES)).toEqual([]);
    const link = container.querySelector("button");
    expect(link).not.toBeNull();
    await act(async () => {
      link!.click();
    });
    expect(navigated).toEqual([`session/${SESSION_ID}`]);
  });

  it("阴性对照:非可寻址标识符(execution/dispatch/person)不误报", async () => {
    const container = await mountSurface(
      createElement(
        () =>
          createElement(
            "p",
            null,
            `execution exec-g10 · dispatch dispatch-g10 · holder person-zeyu · preset preset-g10`,
          ),
        {},
      ),
      { seed: false },
    );
    expect(scanDeadEntityIds(container, "non-entity-ids", ENTITY_ID_NEEDLES)).toEqual([]);
  });
});

// ============ 风化视图(O-08)============
// 风化列表渲染的决策 ID / 反驳事实 ID 正是 G10 判据的对象,故视图契约测试落在本
// 文件(它也是 ViewId 渲染完备性的机制性维护点)。独立文件需要登记
// tools/gui-test-manifest.mjs——该文件在本任务禁区(tools/**)——故并档于此;
// 若登记 manifest,可原样拆出 freshness-view.vitest.ts。
describe("风化视图(O-08):uncovered 承重论点的聚合与跳转", () => {
  function mountFreshness(
    props: Partial<Parameters<typeof FreshnessView>[0]> = {},
    onNavigateEntity: (ref: string) => void = noop,
  ) {
    return mountSurface(
      createElement(FreshnessView, {
        decisions: FIXTURE_DECISIONS,
        coverageRows: FRESHNESS_COVERAGE_ROWS,
        relationState: "ready",
        onNavigateEntity,
        ...props,
      } as Parameters<typeof FreshnessView>[0]),
    );
  }

  it("纯函数:只收带成因分类的行,join 出 claim 原文与决策标题,按成因排序", () => {
    const rows = [
      freshnessCoverage({
        status: "uncovered",
        refutingFactRefs: [FACT_REF],
        freshnessReason: "refuted",
      }),
      freshnessCoverage({ claimRef: `decision/${DECISION_ID}/CH9`, status: "covered" }),
      freshnessCoverage({
        claimRef: `decision/${DECISION_ID}/CH8`,
        status: "uncovered",
        fulfillment: "evidenced",
        refutingFactRefs: [],
        freshnessReason: "no-live-evidence",
      }),
      freshnessCoverage({
        claimRef: `decision/${DECISION_ID}/CH7`,
        status: "uncovered",
        fulfillment: null,
        refutingFactRefs: [],
        freshnessReason: "fulfillment-undeclared",
      }),
      // 阴性:无 freshnessReason 的 uncovered 行(旧 daemon)不进候选——缺判据不猜。
      freshnessCoverage({
        claimRef: `decision/${DECISION_ID}/CH0`,
        status: "uncovered",
        fulfillment: "evidenced",
        refutingFactRefs: [],
      }),
    ];
    const candidates = freshnessCandidates(FIXTURE_DECISIONS, rows);
    expect(candidates.map((candidate) => candidate.claimId)).toEqual(["CH1", "CH8", "CH7"]);
    expect(candidates[0]).toMatchObject({
      decisionId: DECISION_ID,
      decisionTitle: "G10 探针决策",
      claimText: "判据必须是机制不是文案",
      reason: "refuted",
    });
    expect(candidates[1].reason).toBe("no-live-evidence");
    expect(candidates[2].reason).toBe("fulfillment-undeclared");
  });

  it("正向:候选行可跳转——决策链接与反驳事实链接都带出正确 ref", async () => {
    const navigated: string[] = [];
    const container = await mountFreshness({}, (ref) => navigated.push(ref));
    const rows = container.querySelectorAll("[data-testid='freshness-row']");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("判据必须是机制不是文案");
    expect(container.querySelector("[data-testid='freshness-reason-refuted']")).not.toBeNull();
    const buttons = [...container.querySelectorAll("button")];
    await act(async () => {
      buttons.find((button) => button.textContent === DECISION_ID)!.click();
      buttons.find((button) => button.textContent === FACT_REF)!.click();
    });
    expect(navigated).toEqual([`decision/${DECISION_ID}`, FACT_REF]);
  });

  it("负向:无候选时是明确空态而非空白;投影未就绪时如实报态", async () => {
    const empty = await mountFreshness({ coverageRows: [freshnessCoverage()] });
    expect(empty.querySelectorAll("[data-testid='freshness-row']")).toHaveLength(0);
    expect(empty.querySelector("[data-testid='freshness-rows']")).toBeNull();
    expect(empty.textContent).toContain("当前没有风化候选");

    const loading = await mountFreshness({ relationState: "loading" });
    expect(loading.textContent).toContain("关系投影加载中");
    const error = await mountFreshness({ relationState: "error" });
    expect(error.textContent).toContain("关系投影读取失败");
    for (const container of [loading, error]) {
      expect(container.querySelectorAll("[data-testid='freshness-row']")).toHaveLength(0);
    }
  });

  it("规模:全部候选一次完整渲染,不再有「再显示」按钮", async () => {
    const coverageRows = Array.from({ length: 15 }, (_, index) =>
      freshnessCoverage({
        claimRef: `decision/${DECISION_ID}/C${index}`,
        status: "uncovered",
        refutingFactRefs: [],
        freshnessReason: "no-live-evidence",
      }),
    );
    const container = await mountFreshness({ coverageRows });
    expect(container.querySelectorAll("[data-testid='freshness-row']")).toHaveLength(15);
    expect(container.querySelector("[data-testid='freshness-more']")).toBeNull();
  });
});
