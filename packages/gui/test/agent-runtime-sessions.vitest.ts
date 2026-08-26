// harness-test-tier: integration
import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionGroupList } from "../src/renderer/components/sessions/SessionGroupList.tsx";
import { SessionInspector } from "../src/renderer/components/sessions/SessionInspector.tsx";
import { SquadRunList } from "../src/renderer/components/sessions/SquadRunList.tsx";
import { SessionDetailView } from "../src/renderer/components/runtime/SessionsPanel.tsx";
import {
  sessionDecisionRefs,
  sessionOrphans,
  sessionRounds,
  shortRef,
  type SessionGroup,
} from "../src/renderer/sessions-model.ts";
import type { AgentRuntimeSessionDto } from "../../daemon/src/agent-runtime-contract.ts";
import type { RelationEdge } from "../src/renderer/model/types.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

beforeAll(() => setActiveLocale("en-US"));

const noop = () => undefined;
const definition = {
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId: "w4c-verify-codex",
  installationId: "codex-install",
  kindId: "codex",
  providerId: "openai",
  model: "gpt-5.6-terra",
  reasoningEffort: null,
  baseUrl: null,
  authMode: "subscription",
} as const;
const sessionDto = {
  runtimeSessionId: "runtime-bound",
  providerSessionId: "provider-1",
  instanceId: "w4c-verify-codex",
  installationId: "codex-install",
  kindId: "codex",
  definitionSnapshotRef: "artifact:runtime-definition/test",
  definitionSnapshot: definition,
  liveness: "live",
  attachCapability: "supported",
  streamCursor: "stream:4",
  associations: [
    {
      taskId: "task-assoc",
      executionId: "execution-1",
      holder: { personId: "person-owner", executorId: null },
      lease: { phase: "held", expiresAt: "2026-08-23T01:00:00.000Z" },
    },
  ],
  activity: { lastObservedAt: "2026-08-23T00:00:00.000Z", outcome: null, exitCode: null, resultRef: null },
} as const;
const orphanSession: AgentRuntimeSessionDto = {
  ...sessionDto,
  runtimeSessionId: "runtime-orphan",
  associations: [{ taskId: "task_1994d52c", executionId: "execution-orphan", holder: null, lease: null }],
  activity: { lastObservedAt: "2026-08-23T03:00:00.000Z", outcome: "unknown", exitCode: null, resultRef: null },
  semanticState: "ended-indeterminate",
};

const dispatchRow = (index: number, overrides: Partial<Parameters<typeof sessionRounds>[2][number]> = {}) => ({
  dispatchId: `dispatch_${index.toString(16).padStart(24, "0")}`,
  taskId: "task_1994d52c",
  executionId: "execution-1",
  runtimeSessionId: `runtime-${index}`,
  instanceId: "w4c-verify-codex",
  agentId: "terra",
  agentName: "terra",
  providerSessionId: null,
  eventStreamRef: null,
  startedAt: `2026-08-23T02:0${index}:00.000Z`,
  endedAt: null,
  outcome: null,
  status: "running" as const,
  ...overrides,
});
const taskGroup: SessionGroup = {
  key: "task_1994d52c",
  kind: "task",
  label: "GUI 会话页重构",
  taskId: "task_1994d52c",
  latestStatus: "running",
  latestActivityAt: "2026-08-23T02:05:00.000Z",
  runningCount: 1,
  sessionCount: 3,
  roundCount: 2,
  latestRound: {
    runtimeSessionId: "runtime-0",
    dispatchId: "dispatch_000000000000000000000000",
    agentName: "terra",
    instanceId: "w4c-verify-codex",
    status: "running",
    startedAt: "2026-08-23T02:00:00.000Z",
  },
};
const unattributedGroup: SessionGroup = {
  key: "unattributed",
  kind: "unattributed",
  label: "Unattributed",
  latestStatus: "unavailable",
  latestActivityAt: "2026-08-23T01:00:00.000Z",
  runningCount: 0,
  sessionCount: 4,
  roundCount: 0,
  latestRound: null,
};
const rounds = sessionRounds("task_1994d52c", "GUI 会话页重构", [
  dispatchRow(0, { delegatedByAgentId: "fable", delegatedByAgentName: "Fable" }),
  dispatchRow(1, { status: "succeeded" as never, runtimeSessionId: "runtime-sibling" }),
]);
const orphans = sessionOrphans("task_1994d52c", "GUI 会话页重构", [orphanSession, sessionDto], rounds);

const relations: readonly RelationEdge[] = [
  {
    from: "decision/dec_57A9D27BA446C23759A08B1C13",
    to: "task/task_1994d52c",
    kind: "derives",
    provenance: "local-document",
  },
  {
    from: "decision/dec_1111111111111111111111111",
    to: "task/task_1994d52c",
    kind: "relates",
    provenance: "local-document",
  },
  { from: "decision/dec_2222222222222222222222222", to: "task/other", kind: "derives", provenance: "local-document" },
];

const groupList = (overrides: Partial<Parameters<typeof SessionGroupList>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(SessionGroupList, {
      groups: [taskGroup, unattributedGroup],
      truncated: false,
      expandedKeys: new Set(["task_1994d52c"]),
      rowsByGroup: new Map([["task_1994d52c", { rounds, orphans, pending: false, error: null }]]),
      selectedId: "runtime-0",
      query: "",
      decisionRefsFor: (taskId) => sessionDecisionRefs(relations, taskId),
      onSelectSession: noop,
      onToggleGroup: noop,
      onOpenTask: noop,
      onSelectEntity: noop,
      ...overrides,
    } as never),
  );

const squadRunSummary = {
  squadRunId: "squad_" + "a".repeat(18),
  squadId: "squad_465504" + "a".repeat(12),
  taskId: "task_5fc508",
  mission: "Ship the ontology milestone",
  phase: "converged" as const,
  leaderTurnCount: 6,
  workerAttemptCount: 5,
  runningCount: 0,
  latestActivityAt: "2026-08-25T18:22:00.000Z",
};
const squadRunDetail = {
  leaders: [
    {
      turnId: "turn-6",
      dispatchId: "dispatch_77a1",
      runtimeSessionId: "runtime-leader-6",
      agentName: "commander",
      instanceId: "codex-m1",
      status: "succeeded" as const,
      startedAt: "2026-08-25T18:00:00.000Z",
    },
  ],
  workers: [
    {
      attemptId: "w-5",
      workerId: "terra",
      dispatchId: "dispatch_08cd",
      runtimeSessionId: "runtime-worker-5",
      agentName: "terra",
      instanceId: "codex-m1",
      status: "succeeded" as const,
      startedAt: "2026-08-25T17:30:00.000Z",
      rejection: null,
    },
    {
      attemptId: "w-4",
      dispatchId: null,
      runtimeSessionId: null,
      agentName: null,
      instanceId: null,
      status: "unknown" as const,
      startedAt: null,
      rejection: "no runtime available",
    },
  ],
  error: null,
};

const detailView = (overrides: Partial<Parameters<typeof SessionDetailView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(SessionDetailView, {
      session: sessionDto,
      row: rounds[1],
      squadNames: new Map([["core-squad", "Core Squad"]]),
      decisionRefs: sessionDecisionRefs(relations, "task_1994d52c"),
      result: null,
      frames: [],
      attach: "attached",
      busy: false,
      onCancel: noop,
      onOpenTask: noop,
      onNavigateEntity: noop,
      ...overrides,
    } as never),
  );

describe("sessions page: single-session groups", () => {
  it("renders group headers from the daemon read: title, short task id, status, rounds, activity", () => {
    const markup = groupList({ expandedKeys: new Set() });
    expect(markup).toContain("GUI 会话页重构");
    expect(markup).toContain(shortRef("task_1994d52c", 11));
    expect(markup).toContain("Running");
    expect(markup).toContain("2 rounds");
    expect(markup).toContain("3 sessions");
    expect(markup).toContain("Unattributed");
  });

  it("expands a task group into full round rows and the no-dispatch orphans, with no batch button", () => {
    const markup = groupList();
    expect(markup.match(/data-testid="rail-session-/gu)).toHaveLength(3);
    expect(markup).toContain('data-testid="rail-session-runtime-0"');
    expect(markup).toContain("Round 2");
    expect(markup).toContain("Fable → terra");
    expect(markup).toContain("No dispatch record: 1 bound sessions");
    expect(markup).toContain('data-testid="rail-session-runtime-orphan"');
    expect(markup).not.toContain("runtime-sessions-more");
  });

  it("renders every status word of the group vocabulary without inventing states", () => {
    const states = [
        "running",
        "succeeded",
        "failed",
        "cancelled",
        "ended-indeterminate",
        "unavailable",
        "lost",
      ] as const,
      rows = states.map((status, index) => ({
        kind: "task" as const,
        key: `t-${index}`,
        label: `Task ${index}`,
        taskId: `t-${index}`,
        latestStatus: status,
        latestActivityAt: "2026-08-23T02:00:00.000Z",
        runningCount: 0,
        sessionCount: 1,
        roundCount: 1,
        latestRound: null,
      })),
      markup = groupList({ groups: rows, expandedKeys: new Set(), rowsByGroup: new Map() });
    for (const label of [
      "Running",
      "Succeeded",
      "Failed",
      "Cancelled",
      "Ended · outcome indeterminate",
      "Status unavailable",
      "Lost",
    ])
      expect(markup).toContain(`>${label}<`);
  });

  it("filters expanded round rows with the same token semantics as the daemon member filter", () => {
    const markup = groupList({ query: "dispatch_000000000000000000000001" });
    expect(markup.match(/data-testid="rail-session-/gu)).toHaveLength(1);
    expect(markup).toContain('data-testid="rail-session-runtime-sibling"');
    expect(markup).not.toContain('data-testid="rail-session-runtime-0"');
  });

  it("links the task detail and every related decision from the group footer", () => {
    const markup = groupList();
    expect(markup).toContain('data-testid="session-group-toggle-task_1994d52c"');
    expect(markup).toContain('title="Open this task"');
    expect(markup).toContain("Decision dec_57A9D27B…");
    expect(markup).toContain("Decision dec_11111111…");
    expect(sessionDecisionRefs(relations, "task_1994d52c")).toHaveLength(2);
    expect(sessionDecisionRefs(relations, "task-none")).toEqual([]);
  });

  it("shows the true group total when the daemon read is truncated", () => {
    const markup = groupList({ truncated: true });
    expect(markup).toContain('data-testid="sessions-groups-truncated"');
    expect(markup).toContain("First 2 groups listed");
  });
});

describe("sessions page: session detail", () => {
  it("keeps the task jump, decision links, and delegation facts from the group row", () => {
    const markup = detailView();
    expect(markup).toMatch(/data-testid="session-open-task"[^>]*data-task="task_1994d52c"/u);
    expect(markup).toContain("dec_57A9D27BA446");
    expect(markup).toContain("Fable → terra");
  });

  it("hides the decision section entirely when the task has no decision edges", () => {
    const markup = detailView({ decisionRefs: [] });
    expect(markup).not.toContain("Decisions of this task");
    // 任务出口仍在(回落会话关联),decision 段整段隐藏、不占位。
    expect(markup).toMatch(/data-testid="session-open-task"/u);
  });

  it("falls back to the session association when the row carries no task", () => {
    const markup = detailView({ row: null });
    expect(markup).toMatch(/data-testid="session-open-task"[^>]*data-task="task-assoc"/u);
  });
});

describe("sessions page: session inspector", () => {
  it("lists same-task sibling rows in full, without a batch reveal button", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionInspector, {
        row: rounds[1],
        siblings: [rounds[0], orphans[0]],
        squadNames: new Map(),
        onSelectSession: noop,
        onOpenTask: noop,
        onSelectEntity: noop,
      }),
    );
    expect(markup).toContain('aria-label="Session inspector"');
    expect(markup).toMatch(/data-testid="inspector-open-task"[^>]*data-task="task_1994d52c"/u);
    expect(markup).toContain("terra");
    expect(markup).toContain("no dispatch record");
    expect(markup).not.toContain("runtime-inspector-siblings-more");
    expect(markup).not.toContain("Show ");
  });
});

const squadRunView = (props: Partial<Parameters<typeof SquadRunList>[0]>) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["sessions-page", "repo-a", "squad-run", squadRunSummary.squadRunId], {
    ok: true,
    status: "ready",
    run: squadRunDetail,
    watermark: 9,
    sourceRevision: 9,
  });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(SquadRunList, {
        repoId: "repo-a",
        runs: [squadRunSummary],
        truncated: false,
        totalRuns: 1,
        expandedKeys: new Set([squadRunSummary.squadRunId]),
        squadNames: new Map([[squadRunSummary.squadId, "ontology-squad"]]),
        query: "",
        onToggleRun: noop,
        onSelectSession: noop,
        onOpenTask: noop,
        ...props,
      }),
    ),
  );
};

describe("sessions page: squad orchestration", () => {
  it("renders each squad run as one unit with leader turns and worker attempts from the read detail", () => {
    const markup = squadRunView({});
    expect(markup).toContain("ontology-squad");
    expect(markup).toContain("Converged");
    expect(markup).toContain("6 leader turns");
    expect(markup).toContain("5 worker attempts");
    expect(markup).toContain("leader");
    expect(markup).toContain("turn-6");
    expect(markup).toContain("runtime-leader-6");
    expect(markup).toContain("worker");
    expect(markup).toContain("w-4");
    expect(markup).toContain("no runtime available");
    expect(markup).not.toContain("runtime-sessions-more");
  });

  it("keeps the empty state honest when no squad run matches the range", () => {
    const markup = squadRunView({ runs: [], totalRuns: 0, expandedKeys: new Set(), squadNames: new Map() });
    expect(markup).toContain("No squad runs yet");
  });
});
