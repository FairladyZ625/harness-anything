// harness-test-tier: integration
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionGroupList } from "../src/renderer/components/sessions/SessionGroupList.tsx";
import { SessionInspector } from "../src/renderer/components/sessions/SessionInspector.tsx";
import { SquadRunList } from "../src/renderer/components/sessions/SquadRunList.tsx";
import { SessionDetailView } from "../src/renderer/components/runtime/SessionsPanel.tsx";
import { SessionTranscript, SessionTranscriptTurns } from "../src/renderer/components/sessions/SessionTranscript.tsx";
import {
  sessionDecisionRefs,
  sessionOrphans,
  sessionRounds,
  relativeTime,
  shortRef,
  type SessionGroup,
} from "../src/renderer/sessions-model.ts";
import { TIME_ZONE_STORAGE_KEY } from "../src/renderer/model/time.ts";
import type { AgentRuntimeSessionDto } from "../../daemon/src/agent-runtime-contract.ts";
import type { RelationEdge } from "../src/renderer/model/types.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { sessionTranscriptTurns } from "../src/renderer/session-transcript-model.ts";

beforeAll(() => setActiveLocale("en-US"));
afterEach(() => vi.unstubAllGlobals());

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
  definitionSnapshotPersisted: true,
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
  activity: {
    lastObservedAt: "2026-08-23T00:00:00.000Z",
    outcome: null,
    exitCode: null,
    resultRef: null,
    missingEvidence: null,
  },
} as const;
const orphanSession: AgentRuntimeSessionDto = {
  ...sessionDto,
  runtimeSessionId: "runtime-orphan",
  associations: [{ taskId: "task_1994d52c", executionId: "execution-orphan", holder: null, lease: null }],
  activity: {
    lastObservedAt: "2026-08-23T03:00:00.000Z",
    outcome: "unknown",
    exitCode: null,
    resultRef: null,
    missingEvidence: "exit-code-and-result",
  },
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
  classification: null,
  reason: null,
  fallbackState: null,
  nextDispatchId: null,
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
  key: "unattributed:no-squad",
  kind: "unattributed",
  label: "No squad",
  latestStatus: "unavailable",
  latestActivityAt: "2026-08-23T01:00:00.000Z",
  runningCount: 0,
  sessionCount: 4,
  roundCount: 0,
  latestRound: null,
};
/** 同一个 kind 的另外两个成因桶:它们此前与上面那个共用一个「未归属」标签。 */
const unattributedNoTaskGroup: SessionGroup = {
  ...unattributedGroup,
  key: "unattributed:no-task",
  label: "No task binding",
  latestActivityAt: "2026-08-23T00:30:00.000Z",
};
const unattributedNoDispatchGroup: SessionGroup = {
  ...unattributedGroup,
  key: "unattributed:no-dispatch",
  label: "No dispatch record (direct or another node)",
  latestActivityAt: "2026-08-23T00:20:00.000Z",
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
const detailView = (overrides: Partial<Parameters<typeof SessionDetailView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(SessionDetailView, {
      session: sessionDto,
      row: rounds[1],
      squadNames: new Map([["core-squad", "Core Squad"]]),
      decisionRefs: sessionDecisionRefs(relations, "task_1994d52c"),
      result: null,
      transcript: createElement("p", null, "No dispatch record."),
      busy: false,
      onCancel: noop,
      onOpenTask: noop,
      onNavigateEntity: noop,
      ...overrides,
    } as never),
  );

describe("session consumption panel (P1.3)", () => {
  const metrics = {
    inputTokens: 1_200,
    cacheReadTokens: 340,
    outputTokens: 260,
    totalTokens: 1_800,
    toolCallCount: 17,
    compacted: false,
  } as const;

  it("renders the session's dispatch consumption counters", () => {
    const markup = detailView({ session: { ...sessionDto, metrics } as typeof sessionDto });
    expect(markup).toContain('data-testid="session-metrics"');
    expect(markup).toContain("1,200");
    expect(markup).toContain("340");
    expect(markup).toContain("260");
    expect(markup).toContain("1,800");
    expect(markup).toContain("17");
    expect(markup).not.toContain('data-testid="session-metrics-compacted"');
  });

  it("flags compaction with the loss-of-constraints warning", () => {
    const markup = detailView({
      session: { ...sessionDto, metrics: { ...metrics, compacted: true } } as typeof sessionDto,
    });
    expect(markup).toContain('data-testid="session-metrics-compacted"');
    expect(markup).toContain("Compacted");
  });

  it("keeps the panel present and honest when the dispatch has not reported consumption", () => {
    const markup = detailView();
    expect(markup).toContain('data-testid="session-metrics-none"');
    // 撇号在 static markup 里会被转义,断言避开它。
    expect(markup).toContain("not reported consumption yet.");
  });
});

describe("session transcript replay", () => {
  const records = [
    {
      kind: "provider_event",
      occurredAt: "2026-08-26T05:02:11.076Z",
      event: {
        type: "assistant",
        message: {
          id: "message-one",
          content: [{ type: "thinking", thinking: "Read the task plan first." }],
        },
      },
    },
    {
      kind: "provider_event",
      occurredAt: "2026-08-26T05:02:11.148Z",
      event: {
        type: "assistant",
        message: {
          id: "message-one",
          content: [{ type: "tool_use", id: "call-read", name: "Read", input: { file_path: "/fixture/plan" } }],
        },
      },
    },
    {
      kind: "provider_event",
      occurredAt: "2026-08-26T05:02:11.156Z",
      event: {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "call-read", content: "Fixture plan." }],
        },
      },
    },
    {
      kind: "provider_event",
      occurredAt: "2026-08-26T05:02:12.000Z",
      event: {
        type: "assistant",
        message: {
          id: "message-two",
          content: [
            { type: "thinking", thinking: "The check passed." },
            { type: "text", text: "Task complete." },
          ],
        },
      },
    },
    { kind: "process_exit", occurredAt: "2026-08-26T05:02:12.300Z", exitCode: 0 },
  ] as const;

  it("groups ended thinking, tool calls, tool results, and text into collapsible turns", () => {
    const turns = sessionTranscriptTurns(records),
      markup = renderToStaticMarkup(createElement(SessionTranscriptTurns, { turns }));
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.status)).toEqual(["completed", "completed"]);
    expect(turns[0]?.items.map((item) => item.type)).toEqual(["thinking", "tool_call", "tool_result"]);
    expect(turns[1]?.items.map((item) => item.type)).toEqual(["thinking", "text"]);
    expect(markup.match(/data-testid="session-transcript-turn"/gu)).toHaveLength(2);
    expect(markup).toContain("Tool call");
    expect(markup).toContain("Tool result");
    expect(markup).toContain("Task complete.");
  });

  it("completes earlier Claude turns and fails only the turn closed by an error result", () => {
    const turns = sessionTranscriptTurns([
      {
        kind: "provider_event",
        occurredAt: "2026-08-26T05:02:11.000Z",
        event: {
          type: "assistant",
          message: { id: "message-one", content: [{ type: "text", text: "First response." }] },
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-08-26T05:02:12.000Z",
        event: {
          type: "assistant",
          message: { id: "message-two", content: [{ type: "text", text: "Final response." }] },
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-08-26T05:02:13.000Z",
        event: { type: "result", is_error: true, result: "Provider failed." },
      },
    ]);

    expect(turns.map(({ status, endedAt }) => ({ status, endedAt }))).toEqual([
      { status: "completed", endedAt: "2026-08-26T05:02:12.000Z" },
      { status: "failed", endedAt: "2026-08-26T05:02:13.000Z" },
    ]);
  });

  it("maps persisted ZCode reasoning, tools, and response into one transcript turn", () => {
    const turns = sessionTranscriptTurns([
      {
        kind: "provider_event",
        occurredAt: "2026-09-05T00:00:00.001Z",
        event: { type: "turn.started", sessionId: "session-zcode", turnId: "turn-zcode" },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-09-05T00:00:00.002Z",
        event: {
          type: "model.streaming",
          sessionId: "session-zcode",
          turnId: "turn-zcode",
          payload: { kind: "reasoning_delta", delta: "Inspect " },
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-09-05T00:00:00.002Z",
        event: {
          type: "model.streaming",
          sessionId: "session-zcode",
          turnId: "turn-zcode",
          payload: { kind: "reasoning_delta", delta: "persisted state." },
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-09-05T00:00:00.003Z",
        event: {
          type: "model.streaming",
          sessionId: "session-zcode",
          turnId: "turn-zcode",
          payload: {
            kind: "tool_call",
            toolCallId: "call-zcode",
            toolName: "Read",
            input: { file_path: "task_plan.md" },
          },
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-09-05T00:00:00.004Z",
        event: {
          type: "tool.updated",
          sessionId: "session-zcode",
          turnId: "turn-zcode",
          payload: { kind: "result", toolCallId: "call-zcode", result: "Task contract." },
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-09-05T00:00:00.004Z",
        event: {
          type: "model.streaming",
          sessionId: "session-zcode",
          turnId: "turn-zcode",
          payload: { kind: "text_delta", delta: "bounded fix." },
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-09-05T00:00:00.005Z",
        event: {
          type: "result",
          sessionId: "session-zcode",
          turnId: "turn-zcode",
          response: "Implemented the bounded fix.",
          usage: { totalTokens: 42 },
        },
      },
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.status).toBe("completed");
    expect(turns[0]?.items.map(({ type, label, detail }) => ({ type, label, detail }))).toEqual([
      { type: "thinking", label: "thinking", detail: "Inspect persisted state." },
      { type: "tool_call", label: "Read", detail: '{\n  "file_path": "task_plan.md"\n}' },
      { type: "tool_result", label: "Read", detail: "Task contract." },
      { type: "text", label: "result", detail: "Implemented the bounded fix." },
    ]);
  });

  it("renders one ZCode turn when duplicate provider eventIds were removed before persistence", () => {
    const persisted = [
      {
        kind: "provider_event",
        event: {
          type: "turn.started",
          eventId: "event-turn-started",
          sessionId: "session-zcode",
          turnId: "turn-24",
        },
      },
      {
        kind: "provider_event",
        event: {
          type: "model.streaming",
          eventId: "event-model-streaming",
          sessionId: "session-zcode",
          turnId: "turn-24",
          payload: { kind: "text_delta", delta: "done" },
        },
      },
    ];

    expect(sessionTranscriptTurns(persisted)).toHaveLength(1);
  });

  it("states explicitly that a session without a dispatch has no replay record", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionTranscript, {
        repoId: "repo-a",
        dispatchId: null,
        live: false,
        onSettled: noop,
      }),
    );
    expect(markup).toContain("No dispatch record is available for this session.");
    expect(markup).toContain('data-testid="session-transcript-empty"');
  });
});

describe("sessions page: single-session groups", () => {
  it("keeps the daemon's quota classification and resume guidance on an expanded round", () => {
    const quotaRounds = sessionRounds("task_1994d52c", "GUI 会话页重构", [
        dispatchRow(3, {
          status: "failed" as never,
          classification: "provider_quota",
          nextAction: "ha runtime resume dispatch_000000000000000000000003",
        }),
      ]),
      markup = groupList({
        rowsByGroup: new Map([["task_1994d52c", { rounds: quotaRounds, orphans: [], pending: false, error: null }]]),
      });
    expect(markup).toContain('data-testid="runtime-classification-runtime-3"');
    expect(markup).toContain("provider_quota");
    expect(markup).toContain("ha runtime resume dispatch_000000000000000000000003");
  });

  it("renders group headers from the daemon read: title, short task id, status, rounds, activity", () => {
    const markup = groupList({ expandedKeys: new Set() });
    expect(markup).toContain("GUI 会话页重构");
    expect(markup).toContain(shortRef("task_1994d52c", 11));
    expect(markup).toContain("Running");
    expect(markup).toContain("2 rounds");
    expect(markup).toContain("3 sessions");
    expect(markup).toContain("No squad");
  });

  it("names each unattributed bucket after the thing that is missing, not one shared word", () => {
    const markup = groupList({
      expandedKeys: new Set(),
      groups: [taskGroup, unattributedGroup, unattributedNoTaskGroup, unattributedNoDispatchGroup],
    });
    expect(markup).toContain("No squad");
    expect(markup).toContain("No task binding");
    expect(markup).toContain("No dispatch record (direct or another node)");
    // 三个桶各有自己的 section,不再折叠成一个 key 为 "unattributed" 的桶。
    expect(markup).toContain('data-testid="session-group-unattributed:no-squad"');
    expect(markup).toContain('data-testid="session-group-unattributed:no-task"');
    expect(markup).toContain('data-testid="session-group-unattributed:no-dispatch"');
    expect(markup).not.toContain(">Unattributed<");
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

  it("formats session rows and the old relative-time fallback in the configured time zone", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === TIME_ZONE_STORAGE_KEY ? "Asia/Taipei" : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const markup = groupList();
    expect(markup).toContain(">10:00<");
    expect(markup).toContain(">11:00<");
    expect(markup).not.toContain(">02:00<");
    expect(relativeTime("2026-07-01T02:44:00.000Z", Date.parse("2026-08-26T02:44:00.000Z"))).toBe("2026-07-01 10:44");
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

const squadRunView = (props: Partial<Parameters<typeof SquadRunList>[0]>) =>
  renderToStaticMarkup(
    createElement(SquadRunList, {
      runs: [squadRunSummary],
      truncated: false,
      totalRuns: 1,
      squadNames: new Map([[squadRunSummary.squadId, "ontology-squad"]]),
      query: "",
      range: "30d",
      selectedId: null,
      onSelectRun: noop,
      ...props,
    }),
  );

describe("sessions page: squad orchestration", () => {
  it("renders each squad run as one summary from the list read", () => {
    const markup = squadRunView({});
    expect(markup).toContain("ontology-squad");
    expect(markup).toContain("Converged");
    expect(markup).toContain("6 leader turns");
    expect(markup).toContain("5 worker attempts");
    expect(markup).toContain("Ship the ontology milestone");
    expect(markup).not.toContain("runtime-sessions-more");
  });

  it("keeps the whole run row clickable with a selected state (G12 §2b)", () => {
    const markup = squadRunView({ selectedId: squadRunSummary.squadRunId });
    expect(markup).toMatch(/data-testid="squad-run-toggle-squad_a{18}"[^>]*aria-current="true"/u);
    expect(markup).toMatch(/squad-run-toggle-squad_a{18}"[^>]*class="[^"]*bg-accent/u);
  });

  it("keeps a corrupt run projection as a disabled grey row without hiding healthy runs", () => {
    const invalid = {
        squadRunId: "squad_" + "c".repeat(18),
        projectionState: "invalid" as const,
        projectionError: {
          code: "squad_run_projection_invalid" as const,
          hint: "Squad run projection is invalid.",
        },
      },
      markup = squadRunView({ runs: [squadRunSummary, invalid] });
    expect(markup).toContain("ontology-squad");
    expect(markup).toMatch(/disabled=""[^>]*squad-run-toggle-squad_c{18}/u);
    expect(markup).toContain("Squad run projection is invalid.");
    expect(markup).toContain("Invalid");
    expect(markup).not.toContain("runtime-read-error");
  });

  it("keeps the empty state honest when no squad run matches the range (G12 §2a)", () => {
    const inWindow = squadRunView({ runs: [], totalRuns: 0, squadNames: new Map(), range: "30d" });
    expect(inWindow).toContain("No squad runs in this range (30d)");
    expect(inWindow).toContain('data-testid="squad-runs-empty"');
    const never = squadRunView({ runs: [], totalRuns: 0, squadNames: new Map(), range: "all" });
    expect(never).toContain("No squad runs yet");
  });
});
