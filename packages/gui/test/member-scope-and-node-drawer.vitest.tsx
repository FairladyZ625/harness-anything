// harness-test-tier: fast
// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetOverviewRead } from "../src/api/renderer-dto.ts";
import { App } from "../src/renderer/App.tsx";
import { resetGuiTransportForTest } from "../src/renderer/gui-transport.ts";
import { GlobalScopeBanner, NavigationHistoryBar } from "../src/renderer/components/NavigationHistoryBar.tsx";
import { SessionGroupList } from "../src/renderer/components/sessions/SessionGroupList.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import {
  attributionBadgeOf,
  collectNodeOptions,
  formatNodeDisplay,
  shortNodeCode,
} from "../src/renderer/model/attribution.ts";
import { applyTaskFilters, DEFAULT_TASK_FILTERS } from "../src/renderer/model/taskFilters.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import {
  evaluateFleetNodeAdminAccess,
  evaluateRepoAdminFromExplain,
  filterRepoKnownMembers,
} from "../src/renderer/use-member-scope-lens.ts";
import { BoardView } from "../src/renderer/views/BoardView.tsx";
import { CollaborationView } from "../src/renderer/views/CollaborationView.tsx";
import { OverviewView } from "../src/renderer/views/OverviewView.tsx";
import { SessionsView } from "../src/renderer/views/SessionsView.tsx";
import { WorkView } from "../src/renderer/views/WorkView.tsx";
import { harnessClient } from "../src/renderer/api-client.ts";
import { agentRuntimeClient } from "../src/renderer/agent-runtime-client.ts";
import { squadRunsClient } from "../src/renderer/squad-run-client.ts";
import { readAllTaskDispatches } from "../src/renderer/task-dispatch-client.ts";
import { useAppLocation } from "../src/renderer/navigation/useAppLocation.ts";
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

describe("attribution formatting and zero-noise rules (CH3)", () => {
  it("shortens UUID/hex nodes to 6 chars while preserving semantic hostnames and center", () => {
    expect(shortNodeCode("center")).toBe("center");
    expect(shortNodeCode("8b1eb14c-1111-2222-3333-444455556666")).toBe("8b1eb1");
    expect(shortNodeCode("abcdef1234567890")).toBe("abcdef");
    expect(shortNodeCode("zeyu-ubuntu")).toBe("zeyu-ubuntu");
    expect(
      formatNodeDisplay("8b1eb14c-1111-2222-3333-444455556666", "person_chen", {
        peopleById: new Map([["person_chen", "chenyirun"]]),
      }),
    ).toBe("chenyirun · 8b1eb1");
  });

  it("renders zero badge for single-user center items and compact owner · node capsule for edge/other member", () => {
    const peopleById = new Map([
      ["person_alice", "alice"],
      ["person_chen", "chenyirun"],
    ]);
    expect(
      attributionBadgeOf({
        personId: "person_alice",
        nodeId: "center",
        currentPersonId: "person_alice",
        peopleById,
      }),
    ).toBeNull();
    expect(
      attributionBadgeOf({
        personId: null,
        nodeId: null,
        currentPersonId: "person_alice",
        peopleById,
      }),
    ).toBeNull();

    expect(
      attributionBadgeOf({
        personId: "person_chen",
        nodeId: "8b1eb14c-1111-2222-3333-444455556666",
        currentPersonId: "person_alice",
        peopleById,
      }),
    ).toEqual({
      label: "chenyirun · 8b1eb1",
      title: "person_chen · 8b1eb14c-1111-2222-3333-444455556666",
    });

    expect(
      attributionBadgeOf({
        personId: "person_chen",
        nodeId: "center",
        currentPersonId: "person_alice",
        peopleById,
      }),
    ).toEqual({
      label: "chenyirun · center",
      title: "person_chen · center",
    });
  });
});

describe("admin global member scope lens (CH2)", () => {
  it("grants repo admin lens strictly from repo.entity.actions.explain, separates @fleet manage, and scopes knownMembers", async () => {
    expect(
      evaluateRepoAdminFromExplain("person_bob", {
        subjects: [
          {
            ref: "person/person_bob",
            failure: null,
            actions: [{ action: { kind: "person", id: "delegate" }, authorizationDecision: { outcome: "denied" } }],
          },
        ],
      }),
    ).toBe(false);

    expect(
      evaluateRepoAdminFromExplain("person_bob", {
        ok: false,
        subjects: [],
      }),
    ).toBe(false);

    expect(
      evaluateRepoAdminFromExplain("person_alice", {
        subjects: [
          {
            ref: "person/person_alice",
            failure: { code: "entity_not_found" },
            actions: [],
          },
        ],
      }),
    ).toBe(false);

    expect(
      evaluateRepoAdminFromExplain("person_alice", {
        subjects: [
          {
            ref: "person/person_alice",
            failure: null,
            actions: [{ action: { kind: "person", id: "delegate" }, authorizationDecision: { outcome: "allowed" } }],
          },
        ],
      }),
    ).toBe(true);

    expect(
      evaluateFleetNodeAdminAccess({
        ok: true,
        personId: "person_alice",
        resource: "@fleet",
        grants: [],
        actions: [{ action: "read" }] as never,
      }),
    ).toBe(false);
    expect(
      evaluateFleetNodeAdminAccess({
        ok: true,
        personId: "person_alice",
        resource: "@fleet",
        grants: [],
        actions: [{ action: "access-manage" }] as never,
      }),
    ).toBe(true);

    const { memberPeople, allPeople } = filterRepoKnownMembers("repo-test", {
      ok: true,
      repoId: "repo-test",
      grants: [
        { personId: "person_alice", groupId: "admin", resource: "repo-test" } as never,
        { personId: "person_chen", groupId: "contributor", resource: "@fleet" } as never,
        { personId: "person_outsider", groupId: "admin", resource: "other-repo" } as never,
      ],
      people: [
        { personId: "person_alice", username: "alice" },
        { personId: "person_chen", username: "chenyirun" },
        { personId: "person_outsider", username: "outsider" },
      ],
    });
    expect(memberPeople.map((p) => p.personId)).toEqual(["person_alice", "person_chen"]);
    expect(allPeople.map((p) => p.personId)).toEqual(["person_alice", "person_chen", "person_outsider"]);

    const view = renderDom(
      createElement(NavigationHistoryBar, {
        canBack: false,
        canForward: false,
        onBack: () => {},
        onForward: () => {},
        scopeLens: null,
      }),
    );
    await view.mount();
    expect(view.container.querySelector('[data-testid="global-scope-select"]')).toBeNull();
    view.unmount();
  });

  it("allows admin to switch scope to self/member and exit via compact banner", async () => {
    let selected: string | null = null;
    const onChange = vi.fn((next: string | null) => {
      selected = next;
    });
    const peopleById = new Map([
      ["person_alice", "alice"],
      ["person_chen", "chenyirun"],
    ]);
    const barProps = () => ({
      canBack: false,
      canForward: false,
      onBack: () => {},
      onForward: () => {},
      scopeLens: {
        value: selected,
        currentPersonId: "person_alice",
        members: [
          { personId: "person_alice", label: "alice" },
          { personId: "person_chen", label: "chenyirun" },
        ],
        onChange,
      },
    });
    const view = renderDom(createElement(NavigationHistoryBar, barProps()));
    await view.mount();

    const select = view.container.querySelector<HTMLSelectElement>('[data-testid="global-scope-select"]')!;
    expect(select).toBeTruthy();
    expect(select.textContent).toContain("全部成员");
    expect(select.textContent).toContain("我（只看自己）");
    expect(select.textContent).toContain("chenyirun");

    await changeValue(select, "person_chen");
    expect(onChange).toHaveBeenCalledWith("person_chen");

    await view.mount(
      createElement("div", null, [
        createElement(NavigationHistoryBar, { key: "bar", ...barProps() }),
        createElement(GlobalScopeBanner, {
          key: "banner",
          personId: "person_chen",
          currentPersonId: "person_alice",
          peopleById,
          onExit: () => onChange(null),
        }),
      ]),
    );

    const banner = view.container.querySelector('[data-testid="global-scope-banner"]')!;
    expect(banner.textContent).toContain("chenyirun");
    await click(view.container.querySelector('[data-testid="global-scope-exit"]'));
    expect(onChange).toHaveBeenLastCalledWith(null);
    view.unmount();
  });

  it("filters OverviewView tasks & pinned items when scopePersonId is set", async () => {
    vi.stubGlobal("harness", {
      request: () => Promise.reject(new Error("no bridge in test")),
    });

    const aliceTask = makeTask({
      taskId: "task-alice",
      title: "Alice Active",
      coordinationStatus: "active",
      pinned: true,
      createdByPersonId: "person_alice",
      activeOrLatestPersonId: "person_alice",
    });
    const chenTask = makeTask({
      taskId: "task-chen",
      title: "Chen Active",
      coordinationStatus: "active",
      pinned: true,
      createdByPersonId: "person_chen",
      activeOrLatestPersonId: "person_chen",
    });

    const pinnedAgenda = makeAgendaFixture({
      awaitingYou: [],
      answeredForYou: [],
      inFlight: [],
      stalled: [
        {
          taskId: "task-alice",
          title: "Alice Active",
          status: "active",
          pinned: true,
          updatedAt: "2026-10-06T00:00:00.000Z",
          leaseExecutionId: null,
          activeExecutionIds: [],
          blockingAssessment: { state: "clear", blockers: [], warnings: [] },
        },
        {
          taskId: "task-chen",
          title: "Chen Active",
          status: "active",
          pinned: true,
          updatedAt: "2026-10-06T00:00:00.000Z",
          leaseExecutionId: null,
          activeExecutionIds: [],
          blockingAssessment: { state: "clear", blockers: [], warnings: [] },
        },
      ],
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
          ref: "task/task-alice",
          entityKind: "task",
          entityId: "task-alice",
          title: "Alice Active",
          summary: null,
          pinnedAt: "2026-10-06T00:00:00.000Z",
        },
        {
          ref: "task/task-chen",
          entityKind: "task",
          entityId: "task-chen",
          title: "Chen Active",
          summary: null,
          pinnedAt: "2026-10-06T00:00:00.000Z",
        },
      ] as never,
      regionWeights: { mine: 0, stuck: 2, run: 0, review: 0, queue: 0, recent: 0, works: 0 },
    });

    const props = (scopePersonId: string | null) => ({
      repoId: "repo-test",
      connectionId: null,
      agenda: pinnedAgenda,
      works: undefined,
      titles: new Map([
        ["task/task-alice", "Alice Active"],
        ["task/task-chen", "Chen Active"],
      ]),
      workspaceSummary: SUMMARY,
      health: HEALTH,
      tasks: [aliceTask, chenTask],
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
      scopePersonId,
    });

    const view = renderDom(createElement(OverviewView, props("person_chen")));
    await view.mount();
    expect(view.container.textContent).toContain("进行中 1");
    expect(view.container.textContent).toContain("Chen Active");
    expect(view.container.textContent).not.toContain("Alice Active");
    view.unmount();
  });

  it("filters WorkView by scopePersonId and local work-filter-node selector", async () => {
    const workA = makeTask({
      taskId: "work-a",
      workId: "work-a",
      title: "Work Alpha",
      createdByPersonId: "person_alice",
      activeOrLatestPersonId: "person_alice",
      originNodeId: "center",
      activeOrLatestNodeId: "center",
    });
    const workB = makeTask({
      taskId: "work-b",
      workId: "work-b",
      title: "Work Beta",
      createdByPersonId: "person_chen",
      activeOrLatestPersonId: "person_chen",
      originNodeId: "8b1eb14c-1111-2222-3333-444455556666",
      activeOrLatestNodeId: "8b1eb14c-1111-2222-3333-444455556666",
    });

    const peopleById = new Map([
      ["person_alice", "alice"],
      ["person_chen", "chenyirun"],
    ]);
    const view = renderDom(
      createElement(WorkView, {
        tasks: [workA, workB],
        repoId: "repo-test",
        ready: true,
        onOpenTask: () => {},
        catalog: undefined,
        catalogError: null,
        daemonState: "running",
        onRefreshLedger: () => {},
        agenda: undefined,
        scopePersonId: "person_chen",
        currentPersonId: "person_alice",
        knownMembers: [
          { personId: "person_alice", label: "alice" },
          { personId: "person_chen", label: "chenyirun" },
        ],
        knownNodes: [
          { nodeId: "center", ownerPersonId: null, label: "center" },
          { nodeId: "8b1eb14c-1111-2222-3333-444455556666", ownerPersonId: "person_chen", label: "chenyirun · 8b1eb1" },
        ],
        peopleById,
      }),
    );
    await view.mount();
    expect(view.container.textContent).toContain("Work Beta");
    expect(view.container.textContent).not.toContain("Work Alpha");

    expect(view.container.querySelector('[data-testid="work-filter-person"]')).toBeNull();

    const nodeSelect = view.container.querySelector<HTMLSelectElement>('[data-testid="work-filter-node"]')!;
    await changeValue(nodeSelect, "center");
    expect(view.container.textContent).not.toContain("Work Beta");

    await view.mount(
      createElement(WorkView, {
        tasks: [workA, workB],
        repoId: "repo-test",
        ready: true,
        onOpenTask: () => {},
        catalog: undefined,
        catalogError: null,
        daemonState: "running",
        onRefreshLedger: () => {},
        agenda: undefined,
        scopePersonId: null,
        currentPersonId: "person_alice",
        knownMembers: [
          { personId: "person_alice", label: "alice" },
          { personId: "person_chen", label: "chenyirun" },
        ],
        knownNodes: [
          { nodeId: "center", ownerPersonId: null, label: "center" },
          { nodeId: "8b1eb14c-1111-2222-3333-444455556666", ownerPersonId: "person_chen", label: "chenyirun · 8b1eb1" },
        ],
        peopleById,
      }),
    );
    await changeValue(view.container.querySelector<HTMLSelectElement>('[data-testid="work-filter-node"]'), "all");
    await changeValue(
      view.container.querySelector<HTMLSelectElement>('[data-testid="work-filter-person"]'),
      "person_alice",
    );
    expect(view.container.textContent).toContain("Work Alpha");
    expect(view.container.textContent).not.toContain("Work Beta");
    view.unmount();
  });
});

describe("board / swimlane / list / sessions member & node filtering and badges (CH3)", () => {
  const peopleById = new Map([
    ["person_alice", "alice"],
    ["person_chen", "chenyirun"],
  ]);
  const selfCenterTask = makeTask({
    taskId: "task-self",
    title: "Self Center Task",
    createdByPersonId: "person_alice",
    activeOrLatestPersonId: "person_alice",
    originNodeId: "center",
    activeOrLatestNodeId: "center",
  });
  const foreignEdgeTask = makeTask({
    taskId: "task-edge",
    title: "Edge Chen Task",
    createdByPersonId: "person_chen",
    activeOrLatestPersonId: "person_chen",
    originNodeId: "8b1eb14c-1111-2222-3333-444455556666",
    activeOrLatestNodeId: "8b1eb14c-1111-2222-3333-444455556666",
  });

  it("filters tasks by person and node and renders badges only for non-self/non-center rows", async () => {
    expect(
      applyTaskFilters(
        [selfCenterTask, foreignEdgeTask],
        { ...DEFAULT_TASK_FILTERS, person: "person_chen" },
        new Set(),
      ).map((t) => t.taskId),
    ).toEqual(["task-edge"]);
    expect(
      applyTaskFilters([selfCenterTask, foreignEdgeTask], { ...DEFAULT_TASK_FILTERS, node: "center" }, new Set()).map(
        (t) => t.taskId,
      ),
    ).toEqual(["task-self"]);

    const onFiltersChange = vi.fn();
    const view = renderDom(
      createElement(BoardView, {
        tasks: [selfCenterTask, foreignEdgeTask],
        allTasks: [selfCenterTask, foreignEdgeTask],
        filters: { ...DEFAULT_TASK_FILTERS },
        onFiltersChange,
        onSelect: () => {},
        favorites: new Set(),
        onToggleFavorite: () => {},
        onSetPin: () => {},
        currentPersonId: "person_alice",
        knownMembers: [
          { personId: "person_alice", label: "alice" },
          { personId: "person_chen", label: "chenyirun" },
        ],
        knownNodes: [
          { nodeId: "center", ownerPersonId: null, label: "center" },
          { nodeId: "8b1eb14c-1111-2222-3333-444455556666", ownerPersonId: "person_chen", label: "chenyirun · 8b1eb1" },
        ],
        peopleById,
      }),
    );
    await view.mount();

    const badges = [...view.container.querySelectorAll('[data-testid^="task-attribution-badge-"]')];
    expect(badges).toHaveLength(1);
    expect(badges[0]!.textContent).toBe("chenyirun · 8b1eb1");
    expect(badges[0]!.getAttribute("title")).toBe("person_chen · 8b1eb14c-1111-2222-3333-444455556666");

    // Open filter panel and change person & node filters
    await click(view.container.querySelector('[data-testid="board-filter-toggle"]'));
    await changeValue(
      view.container.querySelector<HTMLSelectElement>('[data-testid="board-filter-person"]'),
      "person_chen",
    );
    expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ person: "person_chen" }));
    await changeValue(
      view.container.querySelector<HTMLSelectElement>('[data-testid="board-filter-node"]'),
      "8b1eb14c-1111-2222-3333-444455556666",
    );
    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({ node: "8b1eb14c-1111-2222-3333-444455556666" }),
    );
    view.unmount();
  });

  it("supports person and node swimlanes on BoardView and keeps ListView badges low-noise", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-index") ? 28 : 600;
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const height = (this as HTMLElement).hasAttribute?.("data-index") ? 28 : 600;
      return { width: 600, height, top: 0, left: 0, bottom: height, right: 600, x: 0, y: 0 } as DOMRect;
    });
    const view = renderDom(
      createElement(BoardView, {
        tasks: [selfCenterTask, foreignEdgeTask],
        allTasks: [selfCenterTask, foreignEdgeTask],
        filters: { ...DEFAULT_TASK_FILTERS },
        onFiltersChange: () => {},
        onSelect: () => {},
        favorites: new Set(),
        onToggleFavorite: () => {},
        onSetPin: () => {},
        initialLayout: "swimlane",
        initialGroupBy: "person",
        currentPersonId: "person_alice",
        nodeOwners: new Map([["8b1eb14c-1111-2222-3333-444455556666", "person_chen"]]),
        peopleById,
      }),
    );
    await view.mount();
    expect(view.container.textContent).toContain("alice");
    expect(view.container.textContent).toContain("chenyirun");

    const nodeGroupBtn = [...view.container.querySelectorAll("button")].find((b) => b.textContent === "节点");
    await click(nodeGroupBtn);
    expect(view.container.textContent).toContain("chenyirun · 8b1eb1");
    expect(view.container.textContent).toContain("中心");

    const listBtn = [...view.container.querySelectorAll("button")].find((b) => b.textContent === "列表");
    await click(listBtn);
    const listBadges = [...view.container.querySelectorAll('[data-testid^="list-attribution-badge-"]')];
    expect(listBadges).toHaveLength(1);
    expect(listBadges[0]!.textContent).toBe("chenyirun · 8b1eb1");
    view.unmount();
  });

  it("passes personId/nodeId to sessionGroups in SessionsView, keeps search last, and shows round attribution badge", async () => {
    const sessionGroupsSpy = vi.spyOn(agentRuntimeClient, "sessionGroups").mockResolvedValue({
      ok: true,
      repoId: "repo-test",
      groups: [],
      totals: { groups: 0, sessions: 0 },
      truncated: false,
    } as never);
    vi.spyOn(squadRunsClient, "list").mockResolvedValue({
      ok: true,
      repoId: "repo-test",
      runs: [],
      totals: { runs: 0 },
    } as never);
    vi.spyOn(harnessClient, "getDecisions").mockResolvedValue({ ok: true, decisions: [] } as never);
    vi.spyOn(harnessClient, "getAgenda").mockResolvedValue({
      ok: true,
      awaitingYou: [],
      awaitingDecision: [],
      awaitingDecisionReview: [],
    } as never);
    vi.spyOn(harnessClient, "getTasks").mockResolvedValue({ ok: true, rows: [], invalidRows: [] } as never);

    const view = renderDom(
      createElement(SessionsView, {
        repoId: "repo-test",
        relations: [],
        focusedEntityRef: null,
        onSelectEntity: () => {},
        onOpenTask: () => {},
        onBack: () => {},
        currentPersonId: "person_alice",
        knownMembers: [
          { personId: "person_alice", label: "alice" },
          { personId: "person_chen", label: "chenyirun" },
        ],
        knownNodes: [
          { nodeId: "center", ownerPersonId: null, label: "center" },
          { nodeId: "8b1eb14c-1111-2222-3333-444455556666", ownerPersonId: "person_chen", label: "chenyirun · 8b1eb1" },
        ],
        peopleById,
      }),
    );
    await view.mount();

    const toolbar = view.container.querySelector('[data-testid="sessions-toolbar"]')!;
    const search = view.container.querySelector('[data-testid="sessions-search"]')!;
    expect(toolbar.lastElementChild).toBe(search);

    await changeValue(
      view.container.querySelector<HTMLSelectElement>('[data-testid="sessions-person-filter"]'),
      "person_chen",
    );
    await changeValue(
      view.container.querySelector<HTMLSelectElement>('[data-testid="sessions-node-filter"]'),
      "8b1eb14c-1111-2222-3333-444455556666",
    );

    expect(sessionGroupsSpy).toHaveBeenLastCalledWith(
      "repo-test",
      expect.objectContaining({
        personId: "person_chen",
        nodeId: "8b1eb14c-1111-2222-3333-444455556666",
      }),
    );

    // Verify RoundRow low-noise badge inside SessionGroupList
    const listView = renderDom(
      createElement(SessionGroupList, {
        groups: [
          {
            kind: "task",
            key: "task-1",
            taskId: "task-1",
            label: "Task One",
            sessionCount: 2,
            roundCount: 2,
            runningCount: 0,
            latestStatus: "succeeded",
            latestActivityAt: "2026-10-06T00:10:00.000Z",
          },
        ] as never,
        truncated: false,
        expandedKeys: new Set(["task-1"]),
        rowsByGroup: new Map([
          [
            "task-1",
            {
              pending: false,
              error: null,
              orphans: [],
              rounds: [
                {
                  kind: "round",
                  roundIndex: 1,
                  runtimeSessionId: "rt-self",
                  dispatchId: "d-self",
                  agentId: "agent-a",
                  agentName: "Agent A",
                  squadId: null,
                  personId: "person_alice",
                  nodeId: "center",
                  instanceId: "inst-1",
                  taskId: "task-1",
                  taskTitle: "Task One",
                  startedAt: "2026-10-06T00:05:00.000Z",
                  endedAt: "2026-10-06T00:06:00.000Z",
                  status: "succeeded",
                  classification: "execution",
                  resume: null,
                  nextAction: null,
                  delegation: null,
                  reportPath: null,
                  reviewTarget: null,
                },
                {
                  kind: "round",
                  roundIndex: 2,
                  runtimeSessionId: "rt-edge",
                  dispatchId: "d-edge",
                  agentId: "agent-b",
                  agentName: "Agent B",
                  squadId: null,
                  personId: "person_chen",
                  nodeId: "8b1eb14c-1111-2222-3333-444455556666",
                  instanceId: "inst-2",
                  taskId: "task-1",
                  taskTitle: "Task One",
                  startedAt: "2026-10-06T00:10:00.000Z",
                  endedAt: "2026-10-06T00:11:00.000Z",
                  status: "succeeded",
                  classification: "execution",
                  resume: null,
                  nextAction: null,
                  delegation: null,
                  reportPath: null,
                  reviewTarget: null,
                },
              ],
            },
          ],
        ]),
        selectedId: null,
        query: "",
        decisionRefsFor: () => [],
        onSelectSession: () => {},
        onToggleGroup: () => {},
        onOpenTask: () => {},
        onSelectEntity: () => {},
        currentPersonId: "person_alice",
        peopleById,
      }),
    );
    await listView.mount();
    const roundBadges = [...listView.container.querySelectorAll('[data-testid^="session-attribution-badge-"]')];
    expect(roundBadges).toHaveLength(1);
    expect(roundBadges[0]!.textContent).toBe("chenyirun · 8b1eb1");
    expect(roundBadges[0]!.getAttribute("title")).toBe("person_chen · 8b1eb14c-1111-2222-3333-444455556666");

    expect(typeof readAllTaskDispatches).toBe("function");
    expect(typeof useAppLocation).toBe("function");
    listView.unmount();
    view.unmount();
  });
});

describe("collaboration topology readable names and NodeDetails drawer (CH4)", () => {
  const edgeUuid = "8b1eb14c-1111-2222-3333-444455556666";
  const overviewData: FleetOverviewRead = {
    schema: "daemon.fleet-overview/v1",
    ok: true,
    repoId: "repo-test",
    mode: "remote-center",
    generatedAt: "2026-10-06T00:30:00.000Z",
    center: {
      nodeId: "center",
      daemonId: "default",
      startedAt: "2026-10-01T00:00:00.000Z",
      version: "0.0.0",
      commitSha: "bd2251a",
    },
    centerRevision: 164,
    nodes: [
      {
        nodeId: "center",
        role: "center",
        owner: { kind: "value", text: "daemon" },
        build: { kind: "value", text: "0.0.0 @ bd2251a" },
        online: { kind: "value", text: "running" },
        leases: [],
        replica: null,
        replicaReason: "center-local-writer",
        watch: { kind: "value", text: "local canonical writer" },
        lastFailure: { kind: "unavailable", reason: "no-session-failure-observed" },
      },
      {
        nodeId: edgeUuid,
        role: "edge",
        owner: { kind: "value", text: "person_chen" },
        build: { kind: "unavailable", reason: "no-edge-build-observed" },
        online: { kind: "value", text: "online" },
        leases: [],
        replica: {
          repoId: "repo-test",
          viewId: "view-chen",
          centerRevision: 164,
          centerEventAt: "2026-10-06T00:30:00.000Z",
          ackRevision: 164,
          ackedAt: "2026-10-06T00:29:00.000Z",
          lagRevisions: 0,
          lagMs: 500,
          delivery: "delta",
          connected: true,
          syncFailure: null,
        },
        replicaReason: "replica-synced",
        watch: { kind: "unavailable", reason: "edge-sync-internals-not-exposed" },
        lastFailure: { kind: "unavailable", reason: "no-session-failure-observed" },
        recentTasks: [
          {
            taskId: "task_edge_recent",
            title: "Recent Edge Task",
            coordinationStatus: "active",
            updatedAt: "2026-10-06T00:20:00.000Z",
            personId: "person_chen",
          },
        ],
        recentDispatches: [
          {
            dispatchId: "disp_edge_recent",
            runtimeSessionId: "rt_edge_recent",
            taskId: "task_edge_recent",
            taskTitle: "Recent Edge Task",
            agentId: "agent_worker",
            agentLabel: "Worker",
            status: "succeeded",
            startedAt: "2026-10-06T00:21:00.000Z",
            personId: "person_chen",
          },
        ],
        recentEvents: [
          {
            eventId: "evt_recent_1",
            type: "task_status_changed",
            occurredAt: "2026-10-06T00:22:00.000Z",
            workspaceRevision: 164,
            taskId: "task_edge_recent",
            title: "Edge event",
            nodeId: edgeUuid,
          },
        ],
      } as never,
    ],
    links: [
      {
        nodeId: edgeUuid,
        state: "fresh",
        delivery: "delta",
        lagRevisions: 0,
        lagMs: 500,
        ackedAt: "2026-10-06T00:29:00.000Z",
        centerRevision: 164,
      },
    ],
    events: [],
    notes: ["events-attribution=event-source"],
    warnings: [],
  };

  it("displays <owner> · <6-char> node name, activity archive rows, quick links, and hides unregister from non-admins", async () => {
    const onOpenTask = vi.fn();
    const onNavigateEntity = vi.fn();
    const onOpenNodeBoard = vi.fn();
    const onOpenNodeSessions = vi.fn();
    const view = renderDom(
      createElement(CollaborationView, {
        repoId: "repo-test",
        mode: "remote-center",
        overview: overviewData,
        onOpenTask,
        onNavigateEntity,
        onOpenNodeBoard,
        onOpenNodeSessions,
        canManageFleetNodes: false,
        peopleById: new Map([["person_chen", "chenyirun"]]),
        onUnregisterNode: vi.fn(),
        now: "2026-10-06T00:30:00.000Z",
      }),
    );
    await view.mount();

    const edgeCard = view.container.querySelector(`[data-testid="collaboration-node-${edgeUuid}"]`)!;
    expect(edgeCard.textContent).toContain("chenyirun · 8b1eb1");
    expect(edgeCard.querySelector(`[title="${edgeUuid}"]`)).toBeTruthy();

    await click(edgeCard);
    const details = view.container.querySelector('[data-testid="collaboration-node-details"]')!;
    expect(details.textContent).toContain("chenyirun · 8b1eb1");
    expect(details.textContent).toContain("Recent Edge Task");
    expect(details.textContent).toContain("Worker");
    expect(details.textContent).toContain("Edge event");
    expect(view.container.querySelector('[data-testid="collaboration-node-unregister"]')).toBeNull();

    await click(view.container.querySelector('[data-testid="collaboration-recent-task-task_edge_recent"]'));
    expect(onOpenTask).toHaveBeenCalledWith("task_edge_recent");

    await click(view.container.querySelector('[data-testid="collaboration-recent-dispatch-disp_edge_recent"]'));
    expect(onNavigateEntity).toHaveBeenCalledWith("session/rt_edge_recent");

    await click(view.container.querySelector('[data-testid="collaboration-node-open-board"]'));
    expect(onOpenNodeBoard).toHaveBeenCalledWith(edgeUuid);

    await click(view.container.querySelector('[data-testid="collaboration-node-open-sessions"]'));
    expect(onOpenNodeSessions).toHaveBeenCalledWith(edgeUuid);

    expect(view.container.querySelector('[data-testid="collaboration-read-notes"]')?.textContent).toContain(
      "event.source",
    );
    view.unmount();
  });

  it("performs two-step admin node unregister confirmation with busy force option", async () => {
    const unregisterSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, dryRun: true, expectedVersion: "v9", online: true, leases: 1 })
      .mockResolvedValueOnce({ ok: true, dryRun: false });

    const view = renderDom(
      createElement(CollaborationView, {
        repoId: "repo-test",
        mode: "remote-center",
        overview: overviewData,
        onOpenTask: () => {},
        onNavigateEntity: () => {},
        canManageFleetNodes: true,
        peopleById: new Map([["person_chen", "chenyirun"]]),
        onUnregisterNode: unregisterSpy,
        now: "2026-10-06T00:30:00.000Z",
      }),
    );
    await view.mount();
    await click(view.container.querySelector(`[data-testid="collaboration-node-${edgeUuid}"]`));

    await click(view.container.querySelector('[data-testid="collaboration-node-unregister"]'));
    expect(unregisterSpy).toHaveBeenNthCalledWith(1, { nodeId: edgeUuid });

    const confirmBtn = view.container.querySelector('[data-testid="collaboration-unregister-confirm"]')!;
    expect(confirmBtn.textContent).toContain("chenyirun · 8b1eb1");
    const forceCheckbox = view.container.querySelector<HTMLInputElement>(
      '[data-testid="collaboration-unregister-force"]',
    )!;
    await click(forceCheckbox);
    await click(confirmBtn);
    expect(unregisterSpy).toHaveBeenNthCalledWith(2, {
      nodeId: edgeUuid,
      expectedVersion: "v9",
      confirm: true,
      force: true,
    });
    expect(view.container.querySelector('[data-testid="collaboration-unregister-succeeded"]')).toBeTruthy();
    view.unmount();
  });
});

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
  const unknownEdge = "unknown99-1111-2222-3333-444455556666";
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
        ...(personId === undefined || personId === "person_bob"
          ? [
              {
                kind: "agent" as const,
                key: "agent:agent-shared",
                groupKey: "agent:agent-shared",
                label: "SharedAgent",
                agentId: "agent-shared",
                taskId: "t-shared",
                personId: "person_bob",
                nodeId: edgeB,
                sessionCount: 1,
                roundCount: 1,
                runningCount: 1,
                latestStatus: "running" as const,
                latestActivityAt: recentAt,
                latestRound: {
                  runtimeSessionId: "rt-bob",
                  dispatchId: "d-bob",
                  agentName: "SharedAgent",
                  instanceId: "inst-1",
                  status: "running" as const,
                  startedAt: recentAt,
                },
              },
            ]
          : []),
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
    vi.spyOn(harnessClient, "getTaskDispatches").mockResolvedValue({
      ok: true,
      status: "ready",
      unavailableTaskIds: [],
      page: { limit: 100, cursor: null, nextCursor: null },
      dispatches: [
        {
          dispatchId: "d-bob",
          runtimeSessionId: "rt-bob",
          agentId: "agent-shared",
          personId: "person_bob",
          nodeId: edgeB,
          instanceId: "inst-1",
          taskId: "t-shared",
          startedAt: recentAt,
          endedAt: null,
          status: "running",
        },
      ],
      taskLabels: [{ taskId: "t-shared", title: "Alice Created Shared Task" }],
      truncated: false,
    } as never);
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
          pinnedEntities: [],
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
    // Bob's running dispatch on Alice-created t-shared must not appear as Alice running task
    expect(view.container.querySelector('[data-testid="overview-running-empty"]')).toBeTruthy();
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
      if (query?.groupBy === "agent") {
        return {
          ok: true,
          repoId: "repo-test",
          groups: [
            {
              kind: "agent" as const,
              key: "agent-a",
              agentId: "agent-a",
              label: "Agent A",
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
          ],
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
              status: "succeeded",
              reviewContentDigest: "sha256:aaa",
              reportRef: null,
              reviewer: "ReviewerAlice",
              findingCount: 0,
            },
            {
              dispatchId: "d-dec-bob",
              runtimeSessionId: "rt-dec-bob",
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
    vi.spyOn(squadRunsClient, "list").mockResolvedValue({
      ok: true,
      repoId: "repo-test",
      runs: [],
      totals: { runs: 0 },
    } as never);

    // 1) Pre-select rt-bob under unfiltered scope, then apply scopePersonId=person_alice
    const sessionsProps = (scopePersonId: string | null, sessionRange: "24h" | "all" | null = null) => ({
      repoId: "repo-test",
      relations: [],
      focusedEntityRef: "session/rt-bob",
      onSelectEntity: () => {},
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
    expect(view.container.querySelector('[data-testid="rail-session-rt-dec-bob"]')).toBeNull();

    // Agent drill-down narrows dispatches/groups to Alice only
    await click(view.container.querySelector('[data-testid="sessions-group-agent"]'));
    await flushMicroAndTimers();
    await click(view.container.querySelector('[data-testid="session-group-drill-agent-a"]'));
    await flushMicroAndTimers();
    await click(view.container.querySelector('[data-testid="session-group-toggle-t-mix"]'));
    await flushMicroAndTimers();
    expect(view.container.querySelector('[data-testid="rail-session-rt-alice"]')).toBeTruthy();
    expect(view.container.querySelector('[data-testid="rail-session-rt-bob"]')).toBeNull();

    view.unmount();

    // 2) Full-history sessionRange="all" passes epoch timestamp
    capturedGroupQueries.length = 0;
    const allView = renderDom(createElement(SessionsView, sessionsProps(null, "all")));
    await allView.mount();
    await flushMicroAndTimers();
    expect(capturedGroupQueries.some((q) => q.since === "1970-01-01T00:00:00.000Z")).toBe(true);
    allView.unmount();
  });

  it("never infers unknown edge node owner labels from first task actor on options or board lanes", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-index") ? 28 : 600;
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const height = (this as HTMLElement).hasAttribute?.("data-index") ? 28 : 600;
      return { width: 600, height, top: 0, left: 0, bottom: height, right: 600, x: 0, y: 0 } as DOMRect;
    });

    const taskOnUnknown = makeTask({
      taskId: "t-unknown",
      title: "Unknown Node Task",
      createdByPersonId: "person_alice",
      activeOrLatestPersonId: "person_alice",
      originNodeId: unknownEdge,
      activeOrLatestNodeId: unknownEdge,
    });
    const nodeOpts = collectNodeOptions({
      tasks: [taskOnUnknown],
      nodeOwners: new Map(),
      peopleById: peopleMap,
    });
    expect(nodeOpts).toEqual([{ nodeId: unknownEdge, ownerPersonId: null, label: shortNodeCode(unknownEdge) }]);

    const view = renderDom(
      createElement(BoardView, {
        tasks: [taskOnUnknown],
        allTasks: [taskOnUnknown],
        filters: DEFAULT_TASK_FILTERS,
        onFiltersChange: () => {},
        onSelect: () => {},
        favorites: new Set(),
        onToggleFavorite: () => {},
        initialLayout: "swimlane",
        initialGroupBy: "node",
        currentPersonId: "person_alice",
        nodeOwners: new Map(),
        peopleById: peopleMap,
      }),
    );
    await view.mount();
    const laneText = view.container.textContent ?? "";
    expect(laneText).toContain(shortNodeCode(unknownEdge));
    expect(laneText).not.toContain(`alice · ${shortNodeCode(unknownEdge)}`);
    view.unmount();
  });

  it("guards NodeDetails against preview failure, inFlight busy, node_busy, version_conflict, permission revoke, and node-switch races", async () => {
    const overviewTwoEdges: FleetOverviewRead = {
      schema: "daemon.fleet-overview/v1",
      ok: true,
      repoId: "repo-test",
      mode: "remote-center",
      generatedAt: "2026-10-06T00:30:00.000Z",
      center: {
        nodeId: "center",
        daemonId: "default",
        startedAt: "2026-10-01T00:00:00.000Z",
        version: "0",
        commitSha: null,
      },
      centerRevision: 10,
      nodes: [
        {
          nodeId: edgeA,
          role: "edge",
          owner: { kind: "value", text: "person_alice" },
          build: { kind: "unavailable", reason: "no-edge-build-observed" },
          online: { kind: "value", text: "online" },
          replica: null,
          replicaReason: "replica-synced",
          watch: { kind: "unavailable", reason: "edge-sync-internals-not-exposed" },
          lastFailure: { kind: "unavailable", reason: "no-session-failure-observed" },
          leases: [],
        } as never,
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
        } as never,
      ],
      channels: [],
      links: [],
      events: [],
      notes: [],
      warnings: [],
    };

    // A) Preview rejection & inFlight busy & node_busy & version_conflict
    const spy = vi
      .fn()
      // 1. Failed preview -> preview_error, no confirm
      .mockResolvedValueOnce({ ok: false, code: "daemon_unavailable", message: "daemon down" })
      // 2. Retry preview with inFlight: 1 -> busy prompt + v1
      .mockResolvedValueOnce({ ok: true, expectedVersion: "v1", online: false, leases: 0, executions: 0, inFlight: 1 })
      // 3. Confirm gets node_busy
      .mockResolvedValueOnce({ ok: false, code: "node_busy", message: "busy now" })
      // 4. Confirm gets version_conflict -> drops stale v1 & blocks confirm until re-check
      .mockResolvedValueOnce({ ok: false, code: "version_conflict", message: "stale" })
      // 5. Re-check gets fresh v2
      .mockResolvedValueOnce({ ok: true, expectedVersion: "v2", online: false, leases: 0, executions: 0, inFlight: 0 })
      // 6. Final confirm succeeds with v2
      .mockResolvedValueOnce({ ok: true, status: "unregistered" });

    const view = renderDom(
      createElement(CollaborationView, {
        repoId: "repo-test",
        mode: "remote-center",
        overview: overviewTwoEdges,
        onOpenTask: () => {},
        onNavigateEntity: () => {},
        canManageFleetNodes: true,
        actorPersonId: "person_alice",
        peopleById: peopleMap,
        onUnregisterNode: spy,
      }),
    );
    await view.mount();
    await click(view.container.querySelector(`[data-testid="collaboration-node-${edgeA}"]`));

    // 1. Failed preview -> no confirm button!
    await click(view.container.querySelector('[data-testid="collaboration-node-unregister"]'));
    await flushMicroAndTimers();
    expect(view.container.querySelector('[data-testid="collaboration-unregister-error"]')?.textContent).toContain(
      "daemon down",
    );
    expect(view.container.querySelector('[data-testid="collaboration-unregister-confirm"]')).toBeNull();

    // 2. Retry preview succeeds with inFlight: 1 -> shows force checkbox
    await click(view.container.querySelector('[data-testid="collaboration-unregister-retry"]'));
    await flushMicroAndTimers();
    expect(view.container.querySelector('[data-testid="collaboration-unregister-force"]')).toBeTruthy();

    // 3. Confirm hits node_busy
    await click(view.container.querySelector('[data-testid="collaboration-unregister-confirm"]'));
    await flushMicroAndTimers();
    expect(view.container.querySelector('[data-testid="collaboration-unregister-error"]')?.textContent).toContain(
      "busy now",
    );
    expect(view.container.querySelector('[data-testid="collaboration-unregister-confirm"]')).toBeTruthy();

    // 4. Confirm hits version_conflict -> must invalidate old v1 & hide confirm until re-checked!
    await click(view.container.querySelector('[data-testid="collaboration-unregister-confirm"]'));
    await flushMicroAndTimers();
    expect(view.container.querySelector('[data-testid="collaboration-unregister-confirm"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="collaboration-unregister-retry"]')).toBeTruthy();

    // 5-6. Re-check gets v2 & confirm succeeds with v2
    await click(view.container.querySelector('[data-testid="collaboration-unregister-retry"]'));
    await flushMicroAndTimers();
    await click(view.container.querySelector('[data-testid="collaboration-unregister-confirm"]'));
    await flushMicroAndTimers();
    expect(spy).toHaveBeenNthCalledWith(6, { nodeId: edgeA, expectedVersion: "v2", confirm: true });
    expect(view.container.querySelector('[data-testid="collaboration-unregister-succeeded"]')).toBeTruthy();
    view.unmount();

    // B) Node-switch race + permission revocation
    let resolveSlowPreview!: (value: Record<string, unknown>) => void;
    const slowSpy = vi.fn().mockImplementation(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveSlowPreview = resolve;
        }),
    );
    const raceView = renderDom(
      createElement(CollaborationView, {
        repoId: "repo-test",
        mode: "remote-center",
        overview: overviewTwoEdges,
        onOpenTask: () => {},
        onNavigateEntity: () => {},
        canManageFleetNodes: true,
        actorPersonId: "person_alice",
        peopleById: peopleMap,
        onUnregisterNode: slowSpy,
      }),
    );
    await raceView.mount();
    await click(raceView.container.querySelector(`[data-testid="collaboration-node-${edgeA}"]`));
    await click(raceView.container.querySelector('[data-testid="collaboration-node-unregister"]'));
    // Switch node to edgeB BEFORE edgeA preview resolves
    await click(raceView.container.querySelector(`[data-testid="collaboration-node-${edgeB}"]`));
    resolveSlowPreview({ ok: true, expectedVersion: "v-stale-a", online: false });
    await flushMicroAndTimers();
    expect(raceView.container.querySelector('[data-testid="collaboration-unregister-confirm"]')).toBeNull();

    // Revoking canManageFleetNodes immediately closes confirm/unregister flow
    const readySpy = vi.fn().mockResolvedValue({ ok: true, expectedVersion: "v-b", online: false });
    await raceView.mount(
      createElement(CollaborationView, {
        repoId: "repo-test",
        mode: "remote-center",
        overview: overviewTwoEdges,
        onOpenTask: () => {},
        onNavigateEntity: () => {},
        canManageFleetNodes: true,
        actorPersonId: "person_alice",
        peopleById: peopleMap,
        onUnregisterNode: readySpy,
      }),
    );
    await click(raceView.container.querySelector('[data-testid="collaboration-node-unregister"]'));
    await flushMicroAndTimers();
    expect(raceView.container.querySelector('[data-testid="collaboration-unregister-confirm"]')).toBeTruthy();
    await raceView.mount(
      createElement(CollaborationView, {
        repoId: "repo-test",
        mode: "remote-center",
        overview: overviewTwoEdges,
        onOpenTask: () => {},
        onNavigateEntity: () => {},
        canManageFleetNodes: false,
        actorPersonId: "person_alice",
        peopleById: peopleMap,
        onUnregisterNode: readySpy,
      }),
    );
    expect(raceView.container.querySelector('[data-testid="collaboration-unregister-confirm"]')).toBeNull();
    raceView.unmount();
  });

  it("wires real <App /> member scope lens via entity.actions.explain, excludes unrelated repos, clears on exit/logout, and handles node session range & repo-scoped unregister", async () => {
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
    let isDelegateAllowed = true;
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
            grants: async () => ({
              ok: true,
              repoId,
              grants: [
                { personId: "person_alice", groupId: "admin", resource: "repo-test" },
                { personId: "person_bob", groupId: "contributor", resource: "repo-test" },
                { personId: "person_outsider", groupId: "admin", resource: "other-repo" },
              ],
              people: [
                { personId: "person_alice", username: "alice" },
                { personId: "person_bob", username: "bob" },
                { personId: "person_outsider", username: "outsider" },
              ],
            }),
            effectivePermissions: async () => ({
              ok: true,
              personId: "person_alice",
              resource: "@fleet",
              grants: [],
              actions: canFleetManage ? [{ action: "access-manage" }] : [{ action: "read" }],
            }),
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
                  authorizationDecision: { outcome: isDelegateAllowed ? "allowed" : "denied" },
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
        value: new Proxy(bridge, {
          get(target, prop: string) {
            if (prop in target) return target[prop];
            return async () => ({ ok: true });
          },
        }),
      });
      return renderDom(createElement(App));
    };

    // 1) Non-admin user: lens stays hidden
    isDelegateAllowed = false;
    const nonAdminApp = await mountWithBridge();
    await nonAdminApp.mount();
    await flushMicroAndTimers();
    expect(nonAdminApp.container.querySelector('[data-testid="global-scope-select"]')).toBeNull();
    nonAdminApp.unmount();

    // 2) Target-repo admin (with outsider excluded), switch member across Overview -> Work -> Board -> Sessions,
    //    exit via banner, logout clearing, plus Collaboration jump & repo-scoped unregister
    isDelegateAllowed = true;
    canFleetManage = true;
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

    // Re-authenticate as admin -> navigate to Collaboration -> test repo-scoped unregister & "View dispatches in sessions" (range=all)
    isAuthenticated = true;
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
