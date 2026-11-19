import { mockRpcBridge } from "./mock-rpc-bridge.ts";
// harness-test-tier: fast
// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/renderer/App.tsx";
import { resetGuiTransportForTest } from "../src/renderer/gui-transport.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { DEFAULT_TASK_FILTERS } from "../src/renderer/model/taskFilters.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { OverviewView } from "../src/renderer/views/OverviewView.tsx";
import { SessionsView } from "../src/renderer/views/SessionsView.tsx";
import { WorkView } from "../src/renderer/views/WorkView.tsx";
import { harnessClient } from "../src/renderer/api-client.ts";
import { agentRuntimeClient } from "../src/renderer/agent-runtime-client.ts";
import { squadRunsClient } from "../src/renderer/squad-run-client.ts";
import { HEALTH, SUMMARY, agenda as makeAgendaFixture } from "./overview-board.fixtures.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  resetGuiTransportForTest();
});

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: "task-local",
    title: "Local Task",
    projectId: "repo-test",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    lastKnownAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
    gates: [],
    docs: [],
    createdByPersonId: "person_alice",
    activeOrLatestPersonId: "person_alice",
    originNodeId: "center",
    activeOrLatestNodeId: "center",
    ...projectedTaskFields(overrides.coordinationStatus ?? "active", {
      archived: (overrides.packageDisposition ?? "active") !== "active",
    }),
    ...overrides,
  };
}

function renderDom(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRoot(container);
  const mount = async (next: React.ReactElement = element) => {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client: queryClient }, next));
    });
  };
  return {
    container,
    mount,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function changeValue(element: HTMLSelectElement | HTMLInputElement | null | undefined, value: string) {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.value = value;
    element!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function flushMicroAndTimers() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("rework regressions: mixed two-member isolation, sessions consistency, node drawer safety & App integration", () => {
  const edgeA = "aaaa1111-1111-2222-3333-444455556666";
  const edgeB = "bbbb2222-1111-2222-3333-444455556666";
  const peopleMap = new Map([
    ["person_alice", "alice"],
    ["person_bob", "bob"],
  ]);
  it("isolates mixed two-member activity on OverviewView (dispatches, live handlers, cadence, counts)", async () => {
    const recentAt = new Date(Date.now() - 60_000).toISOString();
    vi.stubGlobal("harness", {
      request: () => Promise.reject(new Error("no bridge in test")),
    });
    vi.spyOn(agentRuntimeClient, "sessionGroups").mockImplementation(async (_repoId, query) => {
      const personId = query?.personId;
      const groups = [
        ...[
          {
            kind: "agent" as const,
            key: "agent:agent-shared",
            groupKey: "agent:agent-shared",
            label: "SharedAgent",
            agentId: "agent-shared",
            taskId: "t-shared",
            personId: personId ?? "person_bob",
            nodeId: personId === "person_alice" ? edgeA : edgeB,
            sessionCount: 1,
            roundCount: 1,
            runningCount: 1,
            latestStatus: "running" as const,
            latestActivityAt: recentAt,
            latestRound: {
              runtimeSessionId: personId === "person_alice" ? "rt-alice" : "rt-bob",
              dispatchId: personId === "person_alice" ? "d-alice" : "d-bob",
              agentName: "SharedAgent",
              instanceId: "inst-1",
              status: "running" as const,
              startedAt: recentAt,
            },
          },
        ],
      ];
      return {
        ok: true,
        repoId: "repo-test",
        groups,
        totals: { groups: groups.length, sessions: groups.length },
        truncated: false,
      } as never;
    });
    vi.spyOn(agentRuntimeClient, "overview").mockResolvedValue({
      ok: true,
      sessions: [
        {
          runtimeSessionId: "rt-bob",
          instanceId: "inst-1",
          kindId: "codex",
          lifecycle: { displayStatus: "running" },
          activity: { lastObservedAt: recentAt },
          associations: [
            {
              taskId: "w-shared",
              executionId: "exe-bob",
              holder: { personId: "person_bob", executorId: "agent-shared" },
              lease: null,
            },
          ],
        },
      ],
    } as never);
    const dispatchRead = vi.spyOn(harnessClient, "getTaskDispatches").mockImplementation(async (request) => {
      const newestBob = Array.from({ length: 12 }, (_, index) => ({
        dispatchId: `d-bob-${index}`,
        runtimeSessionId: `rt-bob-${index}`,
        personId: "person_bob",
        nodeId: edgeB,
        taskId: "t-shared",
        status: "running",
        startedAt: recentAt,
        endedAt: null,
      }));
      const olderAlice = {
        ...newestBob[0],
        dispatchId: "d-alice",
        runtimeSessionId: "rt-alice",
        personId: "person_alice",
        nodeId: edgeA,
        taskId: "sub-alice",
        startedAt: new Date(Date.parse(recentAt) - 60_000).toISOString(),
      };
      const matching = [...newestBob, olderAlice].filter(
        (row) => request.personId === undefined || row.personId === request.personId,
      );
      return {
        ok: true,
        dispatches: matching.slice(0, request.limit),
        taskLabels: [],
        truncated: matching.length > (request.limit ?? 0),
      } as never;
    });
    vi.spyOn(harnessClient, "tailObservability").mockResolvedValue({
      schema: "daemon.observe-tail/v3",
      ok: true,
      repoId: "repo-test",
      mode: "local",
      kind: "events",
      direction: "history",
      status: "ready",
      historyCursor: null,
      items: [
        {
          eventId: "ev-alice",
          type: "fact_recorded",
          occurredAt: recentAt,
          workspaceRevision: 10,
          taskId: "sub-alice",
          factId: "F-11111111",
          actor: { principal: { personId: "person_alice" }, executor: null },
          payload: { taskId: "sub-alice", statement: "Alice progress step" },
        },
        {
          eventId: "ev-bob",
          type: "fact_recorded",
          occurredAt: recentAt,
          workspaceRevision: 11,
          taskId: "w-shared",
          factId: "F-22222222",
          actor: { principal: { personId: "person_bob" }, executor: null },
          payload: { taskId: "w-shared", statement: "Bob secret progress" },
        },
      ],
    } as never);

    // Task created by Alice, but Bob ran a dispatch on it; plus shared work W-Shared with Alice & Bob subtasks
    const sharedTask = makeTask({
      taskId: "t-shared",
      title: "Alice Created Shared Task",
      coordinationStatus: "active",
      createdByPersonId: "person_alice",
      activeOrLatestPersonId: "person_alice",
      lastKnownAt: recentAt,
      updatedAt: recentAt,
    });
    const workRoot = makeTask({
      taskId: "w-shared",
      workId: "w-shared",
      title: "Shared Two-Member Work",
      coordinationStatus: "active",
      createdByPersonId: "person_alice",
      activeOrLatestPersonId: "person_alice",
      lastKnownAt: recentAt,
      updatedAt: recentAt,
    });
    const subAlice = makeTask({
      taskId: "sub-alice",
      parentTaskId: "w-shared",
      workId: "w-shared",
      title: "Alice Subtask",
      coordinationStatus: "active",
      createdByPersonId: "person_alice",
      activeOrLatestPersonId: "person_alice",
      createdAt: recentAt,
      lastKnownAt: recentAt,
      updatedAt: recentAt,
    });
    const subBob = makeTask({
      taskId: "sub-bob",
      parentTaskId: "w-shared",
      workId: "w-shared",
      title: "Bob Subtask",
      coordinationStatus: "active",
      createdByPersonId: "person_bob",
      activeOrLatestPersonId: "person_bob",
      lastKnownAt: recentAt,
      updatedAt: recentAt,
    });

    const works = {
      schema: "daemon.work-index/v1" as const,
      ok: true as const,
      works: [
        {
          taskId: "w-shared",
          title: "Shared Two-Member Work",
          status: "active",
          counts: { executing: 2 },
          lastActivityAt: recentAt,
          memberTaskIds: ["sub-alice", "sub-bob"],
        },
      ],
    };

    const view = renderDom(
      createElement(OverviewView, {
        repoId: "repo-test",
        connectionId: null,
        agenda: makeAgendaFixture({
          inFlight: [],
          stalled: [],
          awaitingYou: [],
          answeredForYou: [],
          awaitingRestart: [],
          awaitingRework: [],
          awaitingAdjudication: [],
          underReview: [],
          decisionReviewInProgress: [],
          awaitingDecisionReview: [],
          awaitingDecision: [],
          waitingOnOthers: [],
          attentionItems: [],
          pinnedEntities: [
            {
              ref: "decision/dec-alice",
              kind: "decision",
              title: "Alice Pinned Decision",
              status: "proposed",
              pinnedAt: recentAt,
              personIds: ["person_alice"],
            },
            {
              ref: "decision/dec-bob",
              kind: "decision",
              title: "Bob Pinned Decision",
              status: "proposed",
              pinnedAt: recentAt,
              personIds: ["person_bob"],
            },
            {
              ref: "decision/dec-unknown",
              kind: "decision",
              title: "Unattributed Pinned Decision",
              status: "proposed",
              pinnedAt: recentAt,
            },
          ],
          regionWeights: { mine: 0, stuck: 0, run: 0, review: 0, queue: 0, recent: 0, works: 1 },
        }),
        works: works as never,
        titles: new Map([
          ["task/t-shared", "Alice Created Shared Task"],
          ["task/w-shared", "Shared Two-Member Work"],
          ["task/sub-alice", "Alice Subtask"],
          ["task/sub-bob", "Bob Subtask"],
        ]),
        workspaceSummary: SUMMARY,
        health: HEALTH,
        tasks: [sharedTask, workRoot, subAlice, subBob],
        onNavigateEntity: () => {},
        onOpenTask: () => {},
        onOpenSearch: () => {},
        onOpenSessions: () => {},
        onOpenWorks: () => {},
        onOpenTasks: () => {},
        onOpenSignoffs: () => {},
        onOpenPool: () => {},
        onUnpin: () => {},
        onUnpinEntity: () => {},
        scopePersonId: "person_alice",
      }),
    );
    await view.mount();
    await flushMicroAndTimers();

    const text = view.container.textContent ?? "";
    expect(text).toContain("Shared Two-Member Work");
    const running = view.container.querySelector('[data-testid="overview-region-running"]');
    expect(dispatchRead).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-shared", personId: "person_alice", limit: 12 }),
    );
    expect(running?.textContent).toContain("Alice Subtask");
    expect(running?.textContent).not.toContain("Alice Created Shared Task");
    expect(text).toContain("Alice Pinned Decision");
    expect(text).not.toContain("Bob Pinned Decision");
    expect(text).not.toContain("Unattributed Pinned Decision");
    // Bob's cadence event on w-shared and Bob's handler on w-shared must not appear
    expect(text).not.toContain("Bob secret progress");
    expect(text).not.toContain("codex");
    // Recomputed leaf count for Alice is 1 executing (not 2), and recent hover title shows Alice Subtask
    const worksSection = view.container.querySelector('[data-testid="overview-works"]');
    const worksText = worksSection?.textContent ?? "";
    expect(worksText).toContain("0/1");
    expect(worksText).toContain("进行中 1");
    expect(worksText).not.toContain("2 项");
    const titledRow = worksSection?.querySelector("[title]");
    expect(titledRow?.getAttribute("title") ?? "").toContain("Alice Subtask");
    expect(titledRow?.getAttribute("title") ?? "").not.toContain("Shared Two-Member Work ·");
    view.unmount();
  });

  it("narrows WorkView mixed work-groups, requires same-task person+node conjunction, and scopes WorkLineageTree", async () => {
    vi.spyOn(harnessClient, "getTaskDispatches").mockResolvedValue({
      ok: true,
      status: "ready",
      unavailableTaskIds: [],
      page: { limit: 100, cursor: null, nextCursor: null },
      dispatches: [
        {
          dispatchId: "d-alice-root",
          runtimeSessionId: "rt-alice-root",
          agentId: "agent-a",
          personId: "person_alice",
          nodeId: edgeA,
          instanceId: "inst-a",
          taskId: "sub-alice",
          startedAt: "2026-10-06T00:05:00.000Z",
          endedAt: null,
          status: "running",
          classification: "execution",
        },
        {
          dispatchId: "d-bob-root",
          runtimeSessionId: "rt-bob-root",
          agentId: "agent-b",
          personId: "person_bob",
          nodeId: edgeB,
          instanceId: "inst-b",
          taskId: "w-mix",
          startedAt: "2026-10-06T00:08:00.000Z",
          endedAt: null,
          status: "running",
          classification: "execution",
        },
      ],
      taskLabels: [],
      truncated: false,
    } as never);

    const workRoot = makeTask({
      taskId: "w-mix",
      workId: "w-mix",
      title: "Mixed Container Work",
      coordinationStatus: "active",
      createdByPersonId: "person_bob",
      activeOrLatestPersonId: "person_bob",
      originNodeId: "center",
      activeOrLatestNodeId: "center",
      lastKnownAt: "2026-10-06T00:12:00.000Z",
    });
    const subAlice = makeTask({
      taskId: "sub-alice",
      parentTaskId: "w-mix",
      workId: "w-mix",
      title: "Alice EdgeA Task",
      coordinationStatus: "active",
      activeExecutionId: "exe-alice",
      leaseActor: { principal: { personId: "person_alice" }, executor: null },
      leaseSource: { kind: "node", nodeId: edgeA },
      createdByPersonId: "person_alice",
      activeOrLatestPersonId: "person_alice",
      originNodeId: edgeA,
      activeOrLatestNodeId: edgeA,
      lastKnownAt: "2026-10-06T00:05:00.000Z",
      events: [
        {
          at: "2026-10-06T00:05:00.000Z",
          projectId: "repo-test",
          taskId: "sub-alice",
          kind: "execution" as never,
          ref: "exe-alice",
          personId: "person_alice",
          nodeId: edgeA,
          summary: "Alice event summary",
        },
      ],
    });
    const subBob = makeTask({
      taskId: "sub-bob",
      parentTaskId: "w-mix",
      workId: "w-mix",
      title: "Bob EdgeB Blocked Task",
      coordinationStatus: "blocked",
      activeExecutionId: "exe-bob",
      leaseActor: { principal: { personId: "person_bob" }, executor: null },
      leaseSource: { kind: "node", nodeId: edgeB },
      createdByPersonId: "person_bob",
      activeOrLatestPersonId: "person_bob",
      originNodeId: edgeB,
      activeOrLatestNodeId: edgeB,
      lastKnownAt: "2026-10-06T00:10:00.000Z",
      events: [
        {
          at: "2026-10-06T00:10:00.000Z",
          projectId: "repo-test",
          taskId: "sub-bob",
          kind: "execution" as never,
          ref: "exe-bob",
          personId: "person_bob",
          nodeId: edgeB,
          summary: "Bob event summary",
        },
      ],
    });

    // Include an Alice attention item so w-mix stays in "attention" tier (size=large),
    // while verifying Bob's blocked attention item on sub-bob is stripped out.
    const agendaWithBoth = makeAgendaFixture({
      attentionItems: [
        {
          ref: "task/sub-alice",
          title: "Alice waiting acceptance",
          kind: "awaiting-you",
          region: "mine",
          workTaskId: "w-mix",
          attention: { score: 95, reasons: [{ label: "mine", contribution: 95 }] },
        },
        {
          ref: "task/sub-bob",
          title: "Bob blocked issue",
          kind: "blocked",
          region: "stuck",
          workTaskId: "w-mix",
          attention: { score: 90, reasons: [{ label: "blocked", contribution: 90 }] },
        },
      ] as never,
    });

    const baseWorkProps = {
      tasks: [workRoot, subAlice, subBob],
      repoId: "repo-test",
      ready: true,
      onOpenTask: () => {},
      catalog: undefined,
      catalogError: null,
      daemonState: "running",
      onRefreshLedger: () => {},
      agenda: agendaWithBoth,
      scopePersonId: "person_alice",
      currentPersonId: "person_alice",
      knownMembers: [
        { personId: "person_alice", label: "alice" },
        { personId: "person_bob", label: "bob" },
      ],
      knownNodes: [
        { nodeId: "center", ownerPersonId: null, label: "center" },
        { nodeId: edgeA, ownerPersonId: "person_alice", label: "alice · aaaa11" },
        { nodeId: edgeB, ownerPersonId: "person_bob", label: "bob · bbbb22" },
      ],
      peopleById: peopleMap,
    };

    const view = renderDom(createElement(WorkView, baseWorkProps));
    await view.mount();

    const row = view.container.querySelector('[data-work-id="w-mix"]')!;
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("0/1");
    expect(row.textContent).not.toContain("0/2");
    expect(row.querySelector('[data-testid="work-running"]')?.textContent).toContain("Alice EdgeA Task");
    expect(row.querySelector('[data-testid="work-running"]')?.textContent).not.toContain("Bob EdgeB");
    expect(row.querySelector('[data-testid="work-recent"]')?.textContent).toContain("Alice EdgeA Task");
    expect(row.querySelector('[data-testid="work-recent"]')?.textContent).not.toContain("Bob EdgeB");
    expect(row.querySelector('[data-testid="work-flags"]')?.textContent).toContain("Alice waiting acceptance");
    expect(row.querySelector('[data-testid="work-flags"]')?.textContent).not.toContain("Bob blocked issue");

    // Search must not hit Bob's subtask
    const searchInput = view.container.querySelector<HTMLInputElement>("input");
    await changeValue(searchInput, "Bob EdgeB");
    expect(view.container.querySelector('[data-testid="work-hit"]')).toBeNull();
    await changeValue(searchInput, "");

    // Expand lineage tree: must only include sub-alice and exclude sub-bob and Bob's dispatch on root
    await click(view.container.querySelector('[data-testid="work-lineage-toggle-w-mix"]'));
    await flushMicroAndTimers();
    const tree = view.container.querySelector('[data-testid="work-lineage-w-mix"]')!;
    expect(tree.textContent).toContain("Alice EdgeA Task");
    expect(tree.textContent).not.toContain("Bob EdgeB Blocked Task");
    expect(tree.textContent).not.toContain("d-bob-root");

    const aliceWithBobExecution = {
      ...subAlice,
      activeOrLatestPersonId: "person_bob",
      activeOrLatestNodeId: edgeB,
      leaseActor: subBob.leaseActor,
      leaseSource: subBob.leaseSource,
      activeExecutionId: subBob.activeExecutionId,
      lastKnownAt: subBob.lastKnownAt,
      events: [...subAlice.events!, { ...subBob.events![0]!, taskId: subAlice.taskId }],
    };
    await view.mount(createElement(WorkView, { ...baseWorkProps, tasks: [workRoot, aliceWithBobExecution, subBob] }));
    const mixedCard = view.container.querySelector('[data-work-id="w-mix"]')!;
    const recentActivity = mixedCard.querySelector('[data-testid="work-last-activity"]');
    expect(recentActivity?.getAttribute("title")).toContain("Alice event summary");
    expect(recentActivity?.getAttribute("title")).not.toContain("Bob event summary");
    expect(mixedCard.querySelector('[data-testid="work-running"]')).toBeNull();
    await view.mount(createElement(WorkView, baseWorkProps));

    // Cross-task conjunction negative test: Alice has edgeA, Bob has edgeB -> Alice + edgeB must yield empty!
    await changeValue(view.container.querySelector<HTMLSelectElement>('[data-testid="work-filter-node"]'), edgeB);
    expect(view.container.querySelector('[data-work-id="w-mix"]')).toBeNull();
    view.unmount();
  });

  it("keeps SessionsView orphans, drill-down, decision rounds, selection/fallback & range consistent", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-index") ? 28 : 600;
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const height = (this as HTMLElement).hasAttribute?.("data-index") ? 28 : 600;
      return { width: 600, height, top: 0, left: 0, bottom: height, right: 600, x: 0, y: 0 } as DOMRect;
    });
    const capturedGroupQueries: Array<Record<string, unknown>> = [];
    vi.spyOn(agentRuntimeClient, "sessionGroups").mockImplementation(async (_repoId, query) => {
      capturedGroupQueries.push({ ...(query ?? {}) });
      if (query?.groupBy === "agent" || query?.groupBy === "squad") {
        const agent = query.groupBy === "agent";
        const group = {
          kind: query.groupBy,
          key: agent ? "agent-a" : "squad-a",
          ...(agent ? { agentId: "agent-a" } : { squadId: "squad-a" }),
          label: agent ? "Agent A" : "Squad A",
          personId: query?.personId ?? "person_bob",
          nodeId: query?.nodeId ?? edgeB,
          sessionCount: 1,
          roundCount: 1,
          runningCount: 0,
          latestStatus: "succeeded" as const,
          latestActivityAt: "2026-10-06T00:05:00.000Z",
          latestRound: {
            runtimeSessionId: query?.personId === "person_alice" ? "rt-alice" : "rt-bob",
            dispatchId: query?.personId === "person_alice" ? "d-alice" : "d-bob",
            agentName: "Agent A",
            instanceId: "inst-1",
            status: "succeeded" as const,
            startedAt: "2026-10-06T00:05:00.000Z",
          },
        };
        return {
          ok: true,
          repoId: "repo-test",
          groups: agent ? [group, { ...group, key: "agent-multi", agentId: "agent-multi" }] : [group],
          totals: { groups: 1, sessions: 1 },
          truncated: false,
        } as never;
      }
      return {
        ok: true,
        repoId: "repo-test",
        groups: [
          {
            kind: "task" as const,
            key: "t-mix",
            taskId: "t-mix",
            label: "Mixed Task",
            personId: query?.personId ?? "person_bob",
            nodeId: query?.nodeId ?? edgeB,
            sessionCount: 1,
            roundCount: 1,
            runningCount: 0,
            latestStatus: "succeeded" as const,
            latestActivityAt: "2026-10-06T00:05:00.000Z",
            latestRound: {
              runtimeSessionId: query?.personId === "person_alice" ? "rt-alice" : "rt-bob",
              dispatchId: query?.personId === "person_alice" ? "d-alice" : "d-bob",
              agentName: "Agent A",
              instanceId: "inst-1",
              status: "succeeded" as const,
              startedAt: "2026-10-06T00:05:00.000Z",
            },
          },
          {
            kind: "decision" as const,
            key: "dec-mix",
            decisionId: "dec-mix",
            label: "Mixed Decision",
            personId: query?.personId ?? "person_bob",
            nodeId: query?.nodeId ?? edgeB,
            sessionCount: 1,
            roundCount: 1,
            runningCount: 0,
            latestStatus: "succeeded" as const,
            latestActivityAt: "2026-10-06T00:05:00.000Z",
            latestRound: {
              runtimeSessionId: query?.personId === "person_alice" ? "rt-dec-alice" : "rt-dec-bob",
              dispatchId: query?.personId === "person_alice" ? "d-dec-alice" : "d-dec-bob",
              agentName: "Reviewer",
              instanceId: "inst-1",
              status: "succeeded" as const,
              startedAt: "2026-10-06T00:05:00.000Z",
            },
          },
        ],
        totals: { groups: 2, sessions: 2 },
        truncated: false,
      } as never;
    });
    vi.spyOn(agentRuntimeClient, "overview").mockResolvedValue({
      ok: true,
      sessions: [
        {
          runtimeSessionId: "rt-alice",
          instanceId: "inst-1",
          kindId: "claude",
          lifecycle: { displayStatus: "succeeded" },
          activity: { lastObservedAt: "2026-10-06T00:05:00.000Z" },
          associations: [
            {
              taskId: "t-mix",
              executionId: "e-1",
              holder: { personId: "person_alice", executorId: null },
              lease: null,
            },
          ],
        },
        {
          runtimeSessionId: "rt-bob",
          instanceId: "inst-2",
          kindId: "codex",
          lifecycle: { displayStatus: "succeeded" },
          activity: { lastObservedAt: "2026-10-06T00:06:00.000Z" },
          associations: [
            { taskId: "t-mix", executionId: "e-2", holder: { personId: "person_bob", executorId: null }, lease: null },
          ],
        },
        {
          runtimeSessionId: "rt-orphan",
          instanceId: "inst-3",
          kindId: "local",
          lifecycle: { displayStatus: "running" },
          activity: { lastObservedAt: "2026-10-06T00:07:00.000Z" },
          associations: [{ taskId: "t-mix", executionId: null, holder: null, lease: null }],
        },
      ],
    } as never);
    vi.spyOn(agentRuntimeClient, "session").mockImplementation(
      async (_repoId, runtimeSessionId) =>
        ({
          ok: true,
          session: {
            runtimeSessionId,
            instanceId: "inst-1",
            kindId: runtimeSessionId === "rt-bob" ? "codex" : "claude",
            lifecycle: { displayStatus: "succeeded" },
            activity: { lastObservedAt: "2026-10-06T00:06:00.000Z", missingEvidence: null },
            associations: [{ taskId: "t-mix", executionId: "e", holder: null, lease: null }],
            installationState: "installed",
            definitionSnapshot: null,
            context: {},
            metrics: {},
          },
        }) as never,
    );
    vi.spyOn(harnessClient, "getTaskDispatches").mockResolvedValue({
      ok: true,
      status: "ready",
      unavailableTaskIds: [],
      page: { limit: 100, cursor: null, nextCursor: null },
      dispatches: [
        {
          dispatchId: "d-alice",
          runtimeSessionId: "rt-alice",
          agentId: "agent-a",
          agentName: "Agent A",
          personId: "person_alice",
          nodeId: edgeA,
          instanceId: "inst-1",
          taskId: "t-mix",
          startedAt: "2026-10-06T00:05:00.000Z",
          endedAt: "2026-10-06T00:06:00.000Z",
          status: "succeeded",
        },
        {
          dispatchId: "d-bob",
          runtimeSessionId: "rt-bob",
          agentId: "agent-a",
          agentName: "Agent A",
          personId: "person_bob",
          nodeId: edgeB,
          instanceId: "inst-2",
          taskId: "t-mix",
          startedAt: "2026-10-06T00:07:00.000Z",
          endedAt: "2026-10-06T00:08:00.000Z",
          status: "running",
        },
      ],
      taskLabels: [{ taskId: "t-mix", title: "Mixed Task" }],
      groups: [
        {
          kind: "task",
          key: "t-mix",
          taskId: "t-mix",
          label: "Mixed Task",
          personId: "person_bob",
          nodeId: edgeB,
          sessionCount: 2,
          roundCount: 2,
          runningCount: 1,
          latestStatus: "running",
          latestActivityAt: "2026-10-06T00:08:00.000Z",
          latestRound: {
            runtimeSessionId: "rt-bob",
            dispatchId: "d-bob",
            agentName: "Agent A",
            instanceId: "inst-2",
            status: "running",
            startedAt: "2026-10-06T00:07:00.000Z",
          },
        },
      ],
      totals: { groups: 1, sessions: 2 },
      truncated: false,
    } as never);
    vi.spyOn(harnessClient, "getDecisions").mockResolvedValue({
      ok: true,
      decisions: [
        {
          decisionId: "dec-mix",
          path: "decisions/dec-mix.md",
          title: "Mixed Decision",
          state: "proposed",
          capabilities: [],
          claimsOpen: 0,
          riskTier: "low",
          urgency: "low",
          vertical: "software/coding",
          preset: "standard-decision",
          decisionClass: "architecture",
          workspaceRevision: 1,
          proposer: { principal: { personId: "person_alice" }, executor: null },
          proposedAt: "2026-10-06T00:00:00.000Z",
          question: "Which option?",
          chosen: [],
          rejected: [],
          claims: [],
          judgmentConsents: [],
          body: null,
          appliesTo: { modules: [], productLines: [] },
          currentReviewContentDigest: null,
          acceptReviewReadiness: null,
          reviews: [],
          reviewResponses: [],
          reviewOverrides: [],
          reviewDispatches: [
            {
              dispatchId: "d-dec-alice",
              runtimeSessionId: "rt-dec-alice",
              personId: "person_alice",
              nodeId: edgeA,
              status: "succeeded",
              reviewContentDigest: "sha256:aaa",
              reportRef: null,
              reviewer: "ReviewerAlice",
              findingCount: 0,
            },
            {
              dispatchId: "d-dec-alice-older",
              runtimeSessionId: "rt-dec-alice-older",
              personId: "person_alice",
              nodeId: edgeA,
              status: "succeeded",
              reviewContentDigest: "sha256:older",
              reportRef: null,
              reviewer: "EarlierReviewerAlice",
              findingCount: 0,
            },
            {
              dispatchId: "d-dec-bob",
              runtimeSessionId: "rt-dec-bob",
              personId: "person_bob",
              nodeId: edgeB,
              status: "succeeded",
              reviewContentDigest: "sha256:bbb",
              reportRef: null,
              reviewer: "ReviewerBob",
              findingCount: 0,
            },
          ],
        },
      ],
      warnings: [],
    } as never);
    vi.spyOn(harnessClient, "getAgenda").mockResolvedValue({
      ok: true,
      awaitingYou: [],
      awaitingDecision: [],
      awaitingDecisionReview: [],
    } as never);
    vi.spyOn(harnessClient, "getTasks").mockResolvedValue({ ok: true, rows: [], invalidRows: [] } as never);
    vi.spyOn(squadRunsClient, "list").mockImplementation(async (_repoId, query) => {
      const runs = ["alice", "bob"]
        .map((member) => ({
          squadRunId: `run-${member}`,
          squadId: `squad-${member}`,
          phase: "converged",
          subject: { kind: "task", taskId: "t-mix" },
          mission: `Squad run by ${member}`,
          latestActivityAt: "2026-10-06T00:08:00.000Z",
          owner: { personId: `person_${member}`, source: { kind: "node", nodeId: member === "alice" ? edgeA : edgeB } },
          leaderTurnCount: 1,
          workerAttemptCount: 1,
          runningCount: 0,
        }))
        .filter(
          ({ owner }) =>
            (!query?.personId || owner.personId === query.personId) &&
            (!query?.nodeId || owner.source.nodeId === query.nodeId),
        );
      return { ok: true, runs, totals: { runs: runs.length }, truncated: false } as never;
    });

    // 1) Pre-select rt-bob under unfiltered scope, then apply scopePersonId=person_alice
    const onSelectEntity = vi.fn();
    const sessionsProps = (scopePersonId: string | null, sessionRange: "24h" | "all" | null = null) => ({
      repoId: "repo-test",
      relations: [],
      focusedEntityRef: "session/rt-bob",
      onSelectEntity,
      onOpenTask: () => {},
      onBack: () => {},
      scopePersonId,
      currentPersonId: "person_alice",
      sessionRange,
      knownMembers: [
        { personId: "person_alice", label: "alice" },
        { personId: "person_bob", label: "bob" },
      ],
      knownNodes: [
        { nodeId: edgeA, ownerPersonId: "person_alice", label: "alice · aaaa11" },
        { nodeId: edgeB, ownerPersonId: "person_bob", label: "bob · bbbb22" },
      ],
      peopleById: peopleMap,
    });

    const view = renderDom(createElement(SessionsView, sessionsProps(null, null)));
    await view.mount();
    await flushMicroAndTimers();
    // Initially default 24h range (since is not 1970-01-01)
    expect(capturedGroupQueries[0]?.since).not.toBe("1970-01-01T00:00:00.000Z");

    // Now apply Alice lens while focusedEntityRef still points at session/rt-bob!
    await view.mount(createElement(SessionsView, sessionsProps("person_alice", null)));
    await flushMicroAndTimers();

    // Right pane must NOT keep pre-selected out-of-scope rt-bob!
    const text = view.container.textContent ?? "";
    expect(text).not.toContain("rt-bob");
    expect(text).not.toContain("d-bob");

    // Expand mixed task (if not already auto-expanded from deep-link) & mixed decision: neither rt-bob (orphan) nor rt-orphan nor d-dec-bob appears
    const tMixToggle = view.container.querySelector('[data-testid="session-group-toggle-t-mix"]');
    expect(tMixToggle).toBeTruthy();
    if (tMixToggle?.getAttribute("aria-expanded") !== "true") await click(tMixToggle);
    const decMixToggle = view.container.querySelector('[data-testid="session-group-toggle-dec-mix"]');
    expect(decMixToggle).toBeTruthy();
    if (decMixToggle?.getAttribute("aria-expanded") !== "true") await click(decMixToggle);
    await flushMicroAndTimers();
    expect(view.container.querySelector('[data-testid="rail-session-rt-alice"]')).toBeTruthy();
    expect(view.container.querySelector('[data-testid="rail-session-rt-bob"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="rail-session-rt-orphan"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="rail-session-rt-dec-alice"]')).toBeTruthy();
    expect(view.container.querySelector('[data-testid="rail-session-rt-dec-alice-older"]')).toBeTruthy();
    await view.mount(
      createElement(SessionsView, {
        ...sessionsProps("person_alice"),
        focusedEntityRef: "decisionsessions/dec-mix/rt-dec-alice-older",
      }),
    );
    await flushMicroAndTimers();
    expect(agentRuntimeClient.session).toHaveBeenCalledWith("repo-test", "rt-dec-alice-older");
    await view.mount(createElement(SessionsView, sessionsProps("person_alice")));
    await flushMicroAndTimers();
    expect(view.container.querySelector('[data-testid="rail-session-rt-dec-bob"]')).toBeNull();

    await click(view.container.querySelector('[data-testid="sessions-segment-squads"]'));
    await changeValue(view.container.querySelector<HTMLSelectElement>('[data-testid="sessions-node-filter"]'), edgeA);
    await flushMicroAndTimers();
    expect(squadRunsClient.list).toHaveBeenCalledWith(
      "repo-test",
      expect.objectContaining({ personId: "person_alice", nodeId: edgeA }),
    );
    const squadList = view.container.querySelector('[data-testid="squad-run-list"]');
    expect(squadList?.textContent).toContain("squad-alice");
    expect(squadList?.textContent).not.toContain("squad-bob");
    await click(view.container.querySelector('[data-testid="sessions-segment-sessions"]'));

    await click(view.container.querySelector('[data-testid="sessions-group-agent"]'));
    await flushMicroAndTimers();
    await click(view.container.querySelector('[data-testid="session-group-drill-agent-a"]'));
    await flushMicroAndTimers();
    expect(harnessClient.getTaskDispatches).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-a", personId: "person_alice", nodeId: edgeA, limit: 50 }),
    );
    await click(view.container.querySelector('[data-testid="session-group-toggle-t-mix"]'));
    await flushMicroAndTimers();
    expect(view.container.querySelector('[data-testid="rail-session-rt-alice"]')).toBeTruthy();
    expect(view.container.querySelector('[data-testid="rail-session-rt-bob"]')).toBeNull();
    await click(view.container.querySelector('[data-testid="sessions-drill-back"]'));

    // One scoped dispatch without payload.taskId belongs to both canonical session bindings.
    const dispatch = {
      dispatchId: "dispatch-multi",
      runtimeSessionId: "session-multi",
      taskId: "",
      agentId: "agent-multi",
      squadId: "squad-a",
      agentName: "Agent A",
      instanceId: "inst-1",
      personId: "person_alice",
      nodeId: edgeA,
      status: "succeeded",
      startedAt: "2026-10-06T00:05:00.000Z",
      endedAt: "2026-10-06T00:06:00.000Z",
    };
    const originalDispatchRead = vi.mocked(harnessClient.getTaskDispatches).getMockImplementation()!;
    vi.mocked(harnessClient.getTaskDispatches).mockImplementation((request) =>
      request.agentId === undefined && request.squadId === undefined
        ? originalDispatchRead(request)
        : Promise.resolve({
            ok: true,
            status: "ready",
            dispatches: [dispatch],
            taskLabels: [],
            groups: ["task-a", "task-b"].map((taskId) => ({
              kind: "task",
              key: taskId,
              taskId,
              label: taskId,
              runtimeSessionIds: [dispatch.runtimeSessionId],
              personId: dispatch.personId,
              nodeId: dispatch.nodeId,
              sessionCount: 1,
              roundCount: 1,
              runningCount: 0,
              latestStatus: dispatch.status,
              latestActivityAt: dispatch.endedAt,
              latestRound: dispatch,
            })),
            totals: { groups: 2, sessions: 1 },
            truncated: false,
          } as never),
    );
    for (const [grouping, id] of [
      ["agent", "agent-multi"],
      ["squad", "squad-a"],
    ] as const) {
      await click(view.container.querySelector(`[data-testid="sessions-group-${grouping}"]`));
      await flushMicroAndTimers();
      await click(view.container.querySelector(`[data-testid="session-group-drill-${id}"]`));
      await flushMicroAndTimers();
      expect(harnessClient.getTaskDispatches).toHaveBeenCalledWith(
        expect.objectContaining({
          [`${grouping}Id`]: id,
          personId: "person_alice",
          nodeId: edgeA,
          limit: 50,
        }),
      );
      expect(view.container.querySelector('[data-testid="sessions-counts"]')?.textContent).toMatch(
        /2 个任务组.*1 会话/u,
      );
      for (const taskId of ["task-a", "task-b"]) {
        const group = view.container.querySelector(`[data-testid="session-group-${taskId}"]`);
        const toggle = group?.querySelector(`[data-testid="session-group-toggle-${taskId}"]`);
        expect(toggle).toBeTruthy();
        if (toggle?.getAttribute("aria-expanded") !== "true") await click(toggle);
        await flushMicroAndTimers();
        onSelectEntity.mockClear();
        await click(group?.querySelector('[data-testid="rail-session-session-multi"]'));
        await flushMicroAndTimers();
        expect(onSelectEntity).toHaveBeenCalledWith("session/session-multi");
        expect(agentRuntimeClient.session).toHaveBeenCalledWith("repo-test", "session-multi");
        await click(toggle);
      }
      expect(view.container.querySelector('[data-testid="rail-session-rt-bob"]')).toBeNull();
      await click(view.container.querySelector('[data-testid="sessions-drill-back"]'));
    }

    view.unmount();

    // 2) Full-history sessionRange="all" passes epoch timestamp
    capturedGroupQueries.length = 0;
    const allView = renderDom(createElement(SessionsView, sessionsProps(null, "all")));
    await allView.mount();
    await flushMicroAndTimers();
    expect(capturedGroupQueries.some((q) => q.since === "1970-01-01T00:00:00.000Z")).toBe(true);
    allView.unmount();
  });

  it("wires real <App /> member scope lens via the repository access directory, excludes unrelated repos, clears on exit/logout, and handles node session range & repo-scoped unregister", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-index") ? 28 : 600;
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const height = (this as HTMLElement).hasAttribute?.("data-index") ? 28 : 600;
      return { width: 600, height, top: 0, left: 0, bottom: height, right: 600, x: 0, y: 0 } as DOMRect;
    });
    const AT = new Date(Date.now() - 60_000).toISOString();
    const wireTask = (
      taskId: string,
      title: string,
      personId: string,
      nodeId: string,
      parentTaskId: string | null = null,
    ) => ({
      taskId,
      generation: "v1",
      workspaceRevision: 1,
      createdAt: AT,
      completedAt: null,
      updatedAt: AT,
      packagePath: `tasks/${taskId}`,
      coordinationStatus: "active",
      snapshotAvailability: { consents: "known", gateWitnesses: "known" },
      closeoutAssessment: { readiness: "not_required", gates: [] },
      blockingAssessment: { taskId, state: "clear", blockers: [], warnings: [] },
      createdByPersonId: personId,
      activeOrLatestPersonId: personId,
      originNodeId: nodeId,
      activeOrLatestNodeId: nodeId,
      placement: {
        productLines: ["desktop"],
        spawningDecisionIds: [],
        parentTaskId,
        origin: "native",
        engine: "kernel/task-lifecycle/v1",
        packageDisposition: "active",
        provenance: [],
      },
      executionEvidence: [],
      board: { columnId: "active", rank: 1 },
      visibility: { archived: false, noise: false },
      capabilities: [{ id: "start", available: true, reason: null }],
      risk: { flagged: false },
      phase: { index: 1, reason: null, steps: ["planned", "active", "in_review", "done"] },
      snapshot: {
        revision: 1,
        task: {
          schema: "task/v2",
          taskId,
          title,
          taskClass: "standard",
          status: "active",
          graph: "D>K",
          currentNode: "implementation",
          iteration: 0,
          createdBy: { principal: { personId }, executor: null },
          completionGateIds: [],
          presetSnapshotDigest: null,
          pinned: false,
          metadata: {
            idempotencyKey: null,
            parentTaskId,
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
    });

    const seedHistory = () => {
      window.localStorage.setItem(
        "harness-view-history:repo-test",
        JSON.stringify({
          schema: "gui-view-history/v1",
          history: {
            entries: [
              {
                view: "overview",
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
    };

    const clickSidebarNav = async (container: HTMLElement, label: string) => {
      const btn = container.querySelector(`[data-testid="app-sidebar"] button[aria-label="${label}"]`);
      await click(btn);
    };

    const sessionGroupCalls: Array<Record<string, unknown>> = [];
    const fleetUnregisterCalls: Array<{ repoId: string; input: unknown }> = [];
    let isAuthenticated = true;
    let isRepoAdmin = true;
    let pendingDirectory: Promise<unknown> | null = null;
    let canFleetManage = true;

    const mountWithBridge = async () => {
      seedHistory();
      const bridge: Record<string, unknown> = {
        auth: {
          status: async () =>
            isAuthenticated
              ? {
                  ok: true,
                  repoId: "repo-test",
                  mode: "remote-center",
                  provider: "keycloak",
                  authenticated: true,
                  personId: "person_alice",
                  username: "alice",
                }
              : {
                  ok: true,
                  repoId: "repo-test",
                  mode: "remote-center",
                  provider: "keycloak",
                  authenticated: false,
                  personId: null,
                  username: null,
                },
          bindingStatus: async () => ({ mode: "keycloak" }),
          signIn: async () => ({ ok: true }),
          signOut: async () => ({ ok: true }),
        },
        access: {
          forRepository: (repoId: string) => ({
            repositoryMembers: async () =>
              pendingDirectory ?? {
                ok: true,
                repoId,
                personId: "person_alice",
                isRepoAdmin,
                canManageFleetNodes: canFleetManage,
                members: isRepoAdmin
                  ? [
                      { personId: "person_alice", username: "alice" },
                      { personId: "person_bob", username: "bob" },
                      { personId: "person_chenyirun", username: "chenyirun" },
                    ]
                  : [],
              },
          }),
        },
        fleetAdmin: {
          unregisterNode: async (input: unknown) => {
            fleetUnregisterCalls.push({ repoId: "default", input });
            return { ok: true, expectedVersion: "v1" };
          },
          forRepository: (repoId: string) => ({
            unregisterNode: async (input: unknown) => {
              fleetUnregisterCalls.push({ repoId, input });
              return { ok: true, expectedVersion: "v-repo" };
            },
          }),
        },
        getSystemStatus: async () => ({
          schema: "gui-system-status/v1",
          ok: true,
          observedAt: AT,
          daemon: {
            daemonId: "d-1",
            pid: 1,
            startedAt: AT,
            protocolVersion: { major: 1, minor: 0 },
            uptimeMs: 1,
            endpoint: "sock",
            build: { version: "0", commitSha: null },
            activeControl: null,
          },
          repos: [
            {
              repoId: "repo-test",
              displayName: "Repo Test",
              canonicalRoot: "/tmp/repo-test",
              authoredBranch: "main",
              registrationState: "enabled",
              mode: "remote-center",
              connectionId: "conn-1",
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
          rows: [
            wireTask("w-app", "App Shared Work", "person_alice", "center", null),
            wireTask("t-app-alice", "App Alice Subtask", "person_alice", edgeA, "w-app"),
            wireTask("t-app-bob", "App Bob Subtask", "person_bob", edgeB, "w-app"),
          ],
          invalidRows: [],
          watermark: 1,
          sourceRevision: 1,
          warnings: [],
        }),
        getWorkIndex: async () => ({
          schema: "daemon.work-index/v1",
          ok: true,
          works: [
            {
              taskId: "w-app",
              title: "App Shared Work",
              status: "active",
              counts: { executing: 2 },
              lastActivityAt: AT,
              memberTaskIds: ["t-app-alice", "t-app-bob"],
            },
          ],
        }),
        getWorkBriefs: async () => ({ schema: "daemon.work-briefs/v1", ok: true, briefs: [] }),
        getWorkspaceSummary: async () => ({
          schema: "daemon.workspace-summary/v1",
          ok: true,
          status: "ready",
          tasks: { lastChangedAt: AT, total: 3, byStatus: { active: 3 } },
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
        getSettings: async () => ({
          schema: "daemon.settings-read/v1",
          ok: true,
          revision: 1,
          settings: { defaults: {}, values: {} },
          values: {},
        }),
        getTaskWip: async () => ({
          ok: true,
          status: "ready",
          limit: 5,
          limitLabel: "5",
          threshold: 2,
          counted: [],
          roots: [],
          warnings: [],
        }),
        getCatalogSnapshot: async () => ({
          schema: "gui-catalog-snapshot/v2",
          ok: true,
          status: "ready",
          repoId: "repo-test",
          observedAt: AT,
          catalogDigest: "d",
          defaults: {
            verticalId: "software/coding",
            presetId: "standard-task",
            profileId: "baseline",
            locale: "zh-CN",
          },
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
          attentionItems: [],
          summary: "",
          page: { sourceLimit: 100, cursor: null, nextCursor: null },
          watermark: 1,
          sourceRevision: 1,
        }),
        tailObservability: async () => ({
          schema: "daemon.observe-tail/v3",
          ok: true,
          repoId: "repo-test",
          mode: "remote-center",
          kind: "events",
          direction: "history",
          status: "ready",
          historyCursor: null,
          items: [],
        }),
        getAgentRuntimeOverview: async () => ({ ok: true, sessions: [] }),
        getTaskDispatches: async (payload: Record<string, unknown>) => {
          const allDispatches = [
            {
              dispatchId: "d-app-alice",
              runtimeSessionId: "rt-app-alice",
              agentId: "agent-a",
              agentName: "Agent A",
              personId: "person_alice",
              nodeId: edgeA,
              instanceId: "inst-1",
              taskId: "t-app-alice",
              startedAt: AT,
              endedAt: AT,
              status: "succeeded",
            },
            {
              dispatchId: "d-app-bob",
              runtimeSessionId: "rt-app-bob",
              agentId: "agent-b",
              agentName: "Agent B",
              personId: "person_bob",
              nodeId: edgeB,
              instanceId: "inst-2",
              taskId: "t-app-bob",
              startedAt: AT,
              endedAt: AT,
              status: "succeeded",
            },
          ];
          const taskIds = Array.isArray(payload.taskIds) ? (payload.taskIds as string[]) : null;
          const taskId = typeof payload.taskId === "string" ? payload.taskId : null;
          const filtered = allDispatches.filter((d) =>
            taskIds ? taskIds.includes(d.taskId) : taskId ? d.taskId === taskId : true,
          );
          return {
            ok: true,
            status: "ready",
            watermark: 1,
            sourceRevision: 1,
            ...(taskIds
              ? { taskIds, unavailableTaskIds: [], page: { limit: 100, cursor: null, nextCursor: null } }
              : { taskId }),
            dispatches: filtered,
          };
        },
        getFleetOverview: async () => ({
          schema: "daemon.fleet-overview/v1",
          ok: true,
          repoId: "repo-test",
          mode: "remote-center",
          generatedAt: AT,
          center: { nodeId: "center", daemonId: "d-1", startedAt: AT, version: "0", commitSha: null },
          centerRevision: 10,
          nodes: [
            {
              nodeId: edgeB,
              role: "edge",
              owner: { kind: "value", text: "person_bob" },
              build: { kind: "unavailable", reason: "no-edge-build-observed" },
              online: { kind: "value", text: "online" },
              replica: null,
              replicaReason: "replica-synced",
              watch: { kind: "unavailable", reason: "edge-sync-internals-not-exposed" },
              lastFailure: { kind: "unavailable", reason: "no-session-failure-observed" },
              leases: [],
            },
          ],
          channels: [],
          links: [],
          events: [],
          notes: [],
          warnings: [],
        }),
        explainEntityActions: async () => ({
          subjects: [
            {
              ref: "person/person_alice",
              failure: null,
              actions: [
                {
                  action: { kind: "person", id: "delegate" },
                  authorizationDecision: { outcome: "allowed" },
                },
              ],
            },
          ],
        }),
        readUseCaseProjection: async (payload: Record<string, unknown>) => {
          if (payload.name === "runtime-session-groups") {
            sessionGroupCalls.push(payload);
            const filterPerson = typeof payload.personId === "string" ? payload.personId : null;
            const groups = [
              ...(filterPerson === null || filterPerson === "person_alice"
                ? [
                    {
                      kind: "task",
                      key: "t-app-alice",
                      taskId: "t-app-alice",
                      label: "App Alice Subtask",
                      personId: "person_alice",
                      nodeId: edgeA,
                      sessionCount: 1,
                      roundCount: 1,
                      runningCount: 0,
                      latestStatus: "succeeded",
                      latestActivityAt: AT,
                      latestRound: {
                        runtimeSessionId: "rt-app-alice",
                        dispatchId: "d-app-alice",
                        agentName: "Agent A",
                        instanceId: "inst-1",
                        status: "succeeded",
                        startedAt: AT,
                      },
                    },
                  ]
                : []),
              ...(filterPerson === null || filterPerson === "person_bob"
                ? [
                    {
                      kind: "task",
                      key: "t-app-bob",
                      taskId: "t-app-bob",
                      label: "App Bob Subtask",
                      personId: "person_bob",
                      nodeId: edgeB,
                      sessionCount: 1,
                      roundCount: 1,
                      runningCount: 0,
                      latestStatus: "succeeded",
                      latestActivityAt: AT,
                      latestRound: {
                        runtimeSessionId: "rt-app-bob",
                        dispatchId: "d-app-bob",
                        agentName: "Agent B",
                        instanceId: "inst-2",
                        status: "succeeded",
                        startedAt: AT,
                      },
                    },
                  ]
                : []),
            ];
            return {
              ok: true,
              schema: "daemon.use-case-projection/v1",
              name: "runtime-session-groups",
              revision: 1,
              projection: {
                ok: true,
                groups,
                totals: { groups: groups.length, sessions: groups.length },
                truncated: false,
              },
            };
          }
          return { ok: true, schema: "daemon.use-case-projection/v1", name: payload.name, revision: 1, projection: {} };
        },
        getDecisions: async () => ({ ok: true, decisions: [], warnings: [] }),
        getRelationGraph: async () => ({
          ok: true,
          facet: "edges",
          edges: [],
          page: { limit: 500, cursor: null, nextCursor: null },
          warnings: [],
        }),
      };

      Object.defineProperty(window, "harness", {
        configurable: true,
        value: mockRpcBridge(
          new Proxy(bridge, {
            get(target, prop: string) {
              if (prop in target) return target[prop];
              return async () => ({ ok: true });
            },
          }),
          {
            "daemon.gui.system.read": "getSystemStatus",
            "observe.tail": "tailObservability",
            "repo.settings.read": "getSettings",
            "repo.tasks.list": "getTasks",
            "repo.tasks.wip": "getTaskWip",
            "repo.works.index": "getWorkIndex",
            "repo.works.briefs.read": "getWorkBriefs",
            "repo.projection.read": "readUseCaseProjection",
            "repo.entity.actions.explain": "explainEntityActions",
            "repo.workspace.summary.read": "getWorkspaceSummary",
            "repo.agenda.read": "getAgenda",
            "repo.triadic.relationGraph": "getRelationGraph",
            "repo.decisions.list": "getDecisions",
            "repo.agentRuntime.overview": "getAgentRuntimeOverview",
            "repo.task.dispatches": "getTaskDispatches",
            "repo.gui.catalog.snapshot": "getCatalogSnapshot",
            "repo.fleet.overview.read": "getFleetOverview",
          },
        ),
      });
      return renderDom(createElement(App));
    };

    // 1) Non-admin user: lens stays hidden
    isRepoAdmin = false;
    const nonAdminApp = await mountWithBridge();
    await nonAdminApp.mount();
    await flushMicroAndTimers();
    expect(nonAdminApp.container.querySelector('[data-testid="global-scope-select"]')).toBeNull();
    nonAdminApp.unmount();

    // 2) Target-repo admin (with outsider excluded), switch member across Overview -> Work -> Board -> Sessions,
    //    exit via banner, logout clearing, plus Collaboration jump & repo-scoped unregister
    isRepoAdmin = true;
    canFleetManage = false;
    isAuthenticated = true;
    const adminApp = await mountWithBridge();
    await adminApp.mount();
    await flushMicroAndTimers();

    const scopeSelect = adminApp.container.querySelector<HTMLSelectElement>('[data-testid="global-scope-select"]')!;
    expect(scopeSelect).toBeTruthy();
    const optionValues = [...scopeSelect.options].map((opt) => opt.value);
    expect(optionValues).toContain("person_alice");
    expect(optionValues).toContain("person_bob");
    expect(optionValues).not.toContain("person_outsider");
    expect(optionValues).toContain("person_chenyirun");

    await clickSidebarNav(adminApp.container, "看板");
    await click(adminApp.container.querySelector('[data-testid="board-filter-toggle"]'));
    const boardPerson = () =>
      adminApp.container.querySelector<HTMLSelectElement>('[data-testid="board-filter-person"]');
    const boardNode = () => adminApp.container.querySelector<HTMLSelectElement>('[data-testid="board-filter-node"]');
    await changeValue(boardPerson(), "person_alice");
    await changeValue(boardNode(), edgeA);
    const aliceCard = [...adminApp.container.querySelectorAll('[data-testid="board-task-card"]')].find((card) =>
      card.textContent?.includes("App Alice Subtask"),
    );
    await click(aliceCard);
    await flushMicroAndTimers();
    expect(adminApp.container.querySelector('[data-testid="task-preview-pin-toggle"]')).toBeTruthy();
    await changeValue(scopeSelect, "person_bob");
    expect(adminApp.container.querySelector('[data-testid="task-preview-pin-toggle"]')).toBeNull();
    expect(boardPerson()?.value).toBe("person_bob");
    expect(boardPerson()?.disabled).toBe(true);
    expect(boardNode()?.value).toBe(edgeA);
    expect(adminApp.container.textContent).not.toContain("App Bob Subtask");
    await changeValue(boardNode(), edgeB);
    expect(adminApp.container.textContent).toContain("App Bob Subtask");

    // Switch topbar lens to Bob
    await changeValue(scopeSelect, "person_bob");
    await flushMicroAndTimers();
    expect(adminApp.container.querySelector('[data-testid="global-scope-banner"]')).toBeTruthy();

    // Navigate to Work view: strips Alice's subtask from mixed work
    await clickSidebarNav(adminApp.container, "工作");
    await flushMicroAndTimers();
    await click(adminApp.container.querySelector('[data-testid="work-lineage-toggle-w-app"]'));
    await flushMicroAndTimers();
    const appWorkText = adminApp.container.querySelector('[data-work-id="w-app"]')?.textContent ?? "";
    expect(appWorkText).toContain("0/1");
    const appLineageText = adminApp.container.querySelector('[data-testid="work-lineage-w-app"]')?.textContent ?? "";
    expect(appLineageText).toContain("App Bob Subtask");
    expect(appLineageText).not.toContain("App Alice Subtask");

    // Navigate to Board view: only Bob's subtask visible
    await clickSidebarNav(adminApp.container, "看板");
    await flushMicroAndTimers();
    const boardText = adminApp.container.textContent ?? "";
    expect(boardText).toContain("App Bob Subtask");
    expect(boardText).not.toContain("App Alice Subtask");

    // Navigate to Sessions view: switch to task grouping, only Bob's session visible
    await clickSidebarNav(adminApp.container, "会话");
    await flushMicroAndTimers();
    await click(adminApp.container.querySelector('[data-testid="sessions-group-task"]'));
    await flushMicroAndTimers();
    expect(sessionGroupCalls.some((c) => c.personId === "person_bob")).toBe(true);
    expect(adminApp.container.querySelector('[data-testid="session-group-t-app-bob"]')).toBeTruthy();
    expect(adminApp.container.querySelector('[data-testid="session-group-t-app-alice"]')).toBeNull();

    // Exit lens via compact banner restores both Alice & Bob
    await click(adminApp.container.querySelector('[data-testid="global-scope-exit"]'));
    await flushMicroAndTimers();
    expect(adminApp.container.querySelector('[data-testid="global-scope-banner"]')).toBeNull();
    expect(adminApp.container.querySelector('[data-testid="session-group-t-app-alice"]')).toBeTruthy();
    expect(adminApp.container.querySelector('[data-testid="session-group-t-app-bob"]')).toBeTruthy();

    // Revoke access while the same signed-in identity's directory read is pending.
    await changeValue(
      adminApp.container.querySelector<HTMLSelectElement>('[data-testid="global-scope-select"]'),
      "person_bob",
    );
    const earlierAdminReply = Promise.withResolvers<unknown>();
    pendingDirectory = earlierAdminReply.promise;
    await act(async () => window.dispatchEvent(new Event("harness-access-changed")));
    expect(adminApp.container.querySelector('[data-testid="global-scope-select"]')).toBeNull();
    expect(adminApp.container.querySelector('[data-testid="global-scope-banner"]')).toBeNull();
    expect(adminApp.container.querySelector('[data-testid="session-group-t-app-alice"]')).toBeTruthy();
    pendingDirectory = null;
    isRepoAdmin = false;
    await act(async () => window.dispatchEvent(new Event("harness-access-changed")));
    await act(async () =>
      earlierAdminReply.resolve({
        ok: true,
        personId: "person_alice",
        isRepoAdmin: true,
        canManageFleetNodes: false,
        members: [],
      }),
    );
    expect(adminApp.container.querySelector('[data-testid="global-scope-select"]')).toBeNull();
    isRepoAdmin = true;
    await act(async () => window.dispatchEvent(new Event("harness-access-changed")));
    await flushMicroAndTimers();

    // Select Bob again then simulate logout -> clears scope & hides lens
    await changeValue(
      adminApp.container.querySelector<HTMLSelectElement>('[data-testid="global-scope-select"]'),
      "person_bob",
    );
    await flushMicroAndTimers();
    expect(adminApp.container.querySelector('[data-testid="global-scope-banner"]')).toBeTruthy();
    isAuthenticated = false;
    await act(async () => {
      window.dispatchEvent(new Event("harness-auth-changed"));
    });
    await flushMicroAndTimers();
    expect(adminApp.container.querySelector('[data-testid="global-scope-select"]')).toBeNull();
    expect(adminApp.container.querySelector('[data-testid="global-scope-banner"]')).toBeNull();

    // Re-authenticate with fleet access for the existing node-unregister route.
    isAuthenticated = true;
    canFleetManage = true;
    await act(async () => {
      window.dispatchEvent(new Event("harness-auth-signed-in"));
    });
    await flushMicroAndTimers();
    await clickSidebarNav(adminApp.container, "协作");
    await flushMicroAndTimers();
    await click(adminApp.container.querySelector(`[data-testid="collaboration-node-${edgeB}"]`));
    await click(adminApp.container.querySelector('[data-testid="collaboration-node-unregister"]'));
    await flushMicroAndTimers();
    expect(fleetUnregisterCalls.some((call) => call.repoId === "repo-test")).toBe(true);

    // Jump from node drawer to sessions -> must open in "all" full-history range, while sidebar entry returns to "24h"
    await click(adminApp.container.querySelector('[data-testid="collaboration-node-open-sessions"]'));
    await flushMicroAndTimers();
    expect(adminApp.container.querySelector('[data-testid="sessions-range-all"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    await clickSidebarNav(adminApp.container, "总览");
    await flushMicroAndTimers();
    await clickSidebarNav(adminApp.container, "会话");
    await flushMicroAndTimers();
    expect(adminApp.container.querySelector('[data-testid="sessions-range-24h"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );

    adminApp.unmount();
  });
});
