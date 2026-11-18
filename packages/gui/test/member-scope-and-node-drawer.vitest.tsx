// harness-test-tier: fast
// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetOverviewRead } from "../src/api/renderer-dto.ts";
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

describe("rework regressions: node label owner and NodeDetails safety", () => {
  const edgeA = "aaaa1111-1111-2222-3333-444455556666";
  const edgeB = "bbbb2222-1111-2222-3333-444455556666";
  const unknownEdge = "unknown99-1111-2222-3333-444455556666";
  const peopleMap = new Map([
    ["person_alice", "alice"],
    ["person_bob", "bob"],
  ]);
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
});
