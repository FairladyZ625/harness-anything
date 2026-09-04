// harness-test-tier: integration
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ViewInGraphButton } from "../src/renderer/components/ViewInGraphButton.tsx";
import { TaskDetailView } from "../src/renderer/views/TaskDetailView.tsx";
import { ScheduleDetailView } from "../src/renderer/views/ScheduleDetailView.tsx";
import { FactInspector } from "../src/renderer/components/FactInspector.tsx";
import { AgentCard } from "../src/renderer/components/runtime/AgentCard.tsx";
import { schedulesClient } from "../src/renderer/schedules-client.ts";
import type { ScheduleGuiRowDto } from "../../../daemon/src/protocol/schedules-gui-contract.ts";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../src/renderer/model/types.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 统一「在关系图中查看」入口(task_89d324b5):关系图节点空间的五种实体 kind
 * (task/decision/fact/agent/schedule)各自的详情面都从同一个共享组件取按钮,
 * 点击经 onFocusGraph(ref) 跳关系图并聚焦该实体 —— 与 Decision 详情页既有按钮同路。
 */
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});
afterEach(async () => {
  await act(async () => {
    for (const { root, client } of mounted.splice(0)) {
      root.unmount();
      client.clear();
    }
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const mounted: { readonly root: Root; readonly client: QueryClient }[] = [];

async function mount(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  mounted.push({ root, client });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, node));
  });
  return container;
}

describe("shared ViewInGraphButton", () => {
  it("renders one labeled entry that focuses the given entity ref", async () => {
    const onFocusGraph = vi.fn();
    const container = await mount(createElement(ViewInGraphButton, { entityRef: "task/task_1", onFocusGraph }));
    const button = container.querySelector<HTMLButtonElement>("[data-testid='view-in-graph-button']");
    expect(button?.textContent).toContain("在关系图中查看");
    expect(button?.title).toBe("task/task_1");
    await act(async () => {
      button!.click();
    });
    expect(onFocusGraph).toHaveBeenCalledWith("task/task_1");
  });

  it("renders nothing without a focus callback (host decides the exit exists)", () => {
    const markup = renderToStaticMarkup(createElement(ViewInGraphButton, { entityRef: "task/task_1" }));
    expect(markup).toBe("");
  });
});

const task: TaskRow = {
  taskId: "task-gui",
  title: "详情面双修",
  projectId: "repo-a",
  coordinationStatus: "in_review",
  rawStatus: "in_review/review",
  freshness: "fresh",
  packageDisposition: "active",
  closeoutReadiness: "not_required",
  engine: "kernel/task-lifecycle/v1",
  source: "local-document",
  module: "gui",
  packagePath: "tasks/task-gui-detail",
  gates: [],
  docs: [],
  ...projectedTaskFields("in_review"),
};

describe("graph entry on each graph-focusable detail surface", () => {
  it("Task detail header carries the button with the task ref", async () => {
    vi.stubGlobal("window", {
      harness: {
        getTaskDocuments: vi.fn(async () => ({ ok: true, status: "ready", taskId: "task-gui", documents: [] })),
        getTaskDocument: vi.fn(),
      },
    });
    const onFocusGraph = vi.fn();
    const container = await mount(
      createElement(TaskDetailView, {
        task,
        onBack: () => undefined,
        projectName: "Harness",
        onNavigateDecision: () => undefined,
        onNavigateEntity: () => undefined,
        onFocusGraph,
      }),
    );
    const button = container.querySelector<HTMLButtonElement>("[data-testid='view-in-graph-button']");
    expect(button?.title).toBe("task/task-gui");
    await act(async () => {
      button!.click();
    });
    expect(onFocusGraph).toHaveBeenCalledWith("task/task-gui");
  });

  it("Task detail omits the button when the host provides no graph exit", async () => {
    vi.stubGlobal("window", {
      harness: {
        getTaskDocuments: vi.fn(async () => ({ ok: true, status: "ready", taskId: "task-gui", documents: [] })),
        getTaskDocument: vi.fn(),
      },
    });
    const container = await mount(
      createElement(TaskDetailView, {
        task,
        onBack: () => undefined,
        projectName: "Harness",
        onNavigateDecision: () => undefined,
        onNavigateEntity: () => undefined,
      }),
    );
    expect(container.querySelector("[data-testid='view-in-graph-button']")).toBeNull();
  });

  it("Schedule detail header carries the button with the schedule ref", async () => {
    vi.spyOn(schedulesClient, "runs").mockResolvedValue({
      ok: true,
      status: "ready",
      repoId: "repo-a",
      scheduleId: "sched-probe",
      runs: [],
      activeRuns: [],
      watermark: 3,
      sourceRevision: 3,
    } as never);
    const onFocusGraph = vi.fn();
    const container = await mount(
      createElement(ScheduleDetailView, {
        repoId: "repo-a",
        row: scheduleRow(),
        options: scheduleOptions(),
        scheduleIds: ["sched-probe"],
        focusedEntityRef: null,
        busy: false,
        receipt: null,
        actionError: null,
        onAction: () => undefined,
        onSave: () => undefined,
        onDelete: () => undefined,
        onSelectEntity: () => undefined,
        onFocusGraph,
        onExitRun: () => undefined,
        onExit: () => undefined,
      }),
    );
    const button = container.querySelector<HTMLButtonElement>("[data-testid='view-in-graph-button']");
    expect(button?.title).toBe("schedule/sched-probe");
    await act(async () => {
      button!.click();
    });
    expect(onFocusGraph).toHaveBeenCalledWith("schedule/sched-probe");
  });

  it("Agent detail card carries the button with the agent ref", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentCard, {
        detail: {
          id: "terra",
          name: "terra",
          runtimeType: "codex",
          role: "worker",
          instructions: "Work the mission.",
          model: null,
          skills: [],
          prompts: [],
          preset: null,
        },
        row: null,
        squads: [],
        instances: [],
        busy: false,
        onSave: () => undefined,
        onDispatch: () => undefined,
        onSelectSquad: () => undefined,
        onSelectRuntime: () => undefined,
        onSelectAgent: () => undefined,
        onFocusGraph: () => undefined,
      }),
    );
    expect(markup).toContain('data-testid="agent-view-in-graph"');
    expect(markup).toContain("在关系图中查看");
    const withoutExit = renderToStaticMarkup(
      createElement(AgentCard, {
        detail: {
          id: "terra",
          name: "terra",
          runtimeType: "codex",
          role: "worker",
          instructions: "Work the mission.",
          model: null,
          skills: [],
          prompts: [],
          preset: null,
        },
        row: null,
        squads: [],
        instances: [],
        busy: false,
        onSave: () => undefined,
        onDispatch: () => undefined,
        onSelectSquad: () => undefined,
        onSelectRuntime: () => undefined,
        onSelectAgent: () => undefined,
      }),
    );
    expect(withoutExit).not.toContain('data-testid="agent-view-in-graph"');
  });

  it("Fact inspector header carries the labeled button with the fact ref", () => {
    const fact: FactRef = {
      anchor: "fact/F-001",
      taskId: "task_a",
      category: "finding",
      text: "观察",
      at: "2026-07-01T00:00:00.000Z",
      confidence: "high",
    };
    const decisions: DecisionRow[] = [];
    const relations: RelationEdge[] = [];
    const markup = renderToStaticMarkup(
      createElement(FactInspector, {
        factRef: fact.anchor,
        facts: [fact],
        tasks: [],
        decisions,
        relations,
        coverageRows: [],
        onFocusGraph: () => undefined,
      }),
    );
    expect(markup).toContain('data-testid="fact-view-in-graph"');
    expect(markup).toContain("在关系图中查看");
  });
});

function scheduleRow(overrides: Partial<ScheduleGuiRowDto> = {}): ScheduleGuiRowDto {
  return {
    scheduleId: "sched-probe",
    name: "Heartbeat probe",
    state: "armed",
    mode: "detect",
    definitionResidency: "ledger",
    definitionRevision: 7,
    trigger: { kind: "interval", everyMs: 7_200_000, timezone: null, summary: "every 2h" },
    target: {
      kind: "agent",
      agentId: "probe-agent",
      runtimeInstanceId: "codex-schedule",
      model: null,
      reasoningEffort: null,
      cwd: null,
    },
    mission: "Keep the line green.",
    executionAvailability: "claimed-elsewhere",
    claim: { nodeId: "edge-two", assignmentId: "assignment-edge-two" },
    health: { recent: [], bucket: "clean", failedCount: 0, lastFailureDetail: null },
    nextRunAt: null,
    actions: {
      edit: { available: true, code: null, nextAction: null },
      delete: { available: true, code: null, nextAction: null },
      enable: { available: false, code: "no_changes", nextAction: "already armed" },
      disable: { available: true, code: null, nextAction: null },
      runNow: { available: true, code: null, nextAction: null },
    },
    activeRun: null,
    lastRun: null,
    missed: { count: 0, lastMissedAt: null, lastMissedReason: null },
    automaticEvaluatedThrough: null,
    updatedAt: "2026-08-27T08:00:00.000Z",
    ...overrides,
  };
}

function scheduleOptions() {
  return {
    agents: [{ agentId: "probe-agent", name: "Probe Agent", runtimeType: "codex" }],
    instances: [
      {
        instanceId: "codex-schedule",
        name: "Schedule Codex",
        kindId: "codex",
        models: ["gpt-5.6"],
        efforts: ["low", "medium", "high"],
      },
    ],
    cwd: ["."],
  };
}
