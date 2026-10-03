// harness-test-tier: integration
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionGroupList } from "../src/renderer/components/sessions/SessionGroupList.tsx";
import { SessionInspector } from "../src/renderer/components/sessions/SessionInspector.tsx";
import { SessionDetailView } from "../src/renderer/components/runtime/SessionsPanel.tsx";
import { SessionTranscript, SessionTranscriptTurns } from "../src/renderer/components/sessions/SessionTranscript.tsx";
import {
  sessionDecisionRefs,
  sessionOrphans,
  sessionRounds,
  shortRef,
  type SessionGroup,
} from "../src/renderer/sessions-model.ts";
import { formatRelative, TIME_DISPLAY_STORAGE_KEY } from "../src/renderer/model/time.ts";
import type { AgentRuntimeSessionDto } from "@harness-anything/daemon/protocol";
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

  it("drops empty blocks instead of drawing placeholder boxes (standard §1.5)", () => {
    // 未上报消耗、无结果文本、未绑定任务:整块不渲染,不画虚线占位框。
    const markup = detailView({ session: { ...sessionDto, associations: [] }, row: null, transcript: null });
    expect(markup).not.toContain("Session consumption");
    expect(markup).not.toContain("session-metrics");
    expect(markup).not.toContain("Output / result");
    expect(markup).not.toContain("session-open-task");
    expect(markup).not.toContain("border-dashed");
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

  it("renders nothing as a titled detail block when there is no dispatch record", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionTranscript, {
        repoId: "repo-a",
        dispatchId: null,
        live: false,
        onSettled: noop,
        title: "Transcript",
      }),
    );
    expect(markup).toBe("");
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

  it("sinks completed sessions below a divider and keeps them visible, with no expand fold", () => {
    const markup = groupList({ selectedId: null });
    // 标准 §1.8 v2:有空间就铺开,终态沉底在「已完成 N」分隔线之后照常显示,不收进 <details>。
    expect(markup).not.toContain("<details");
    expect(markup).toMatch(/Completed \/ cancelled \d+</u);
    expect(markup).not.toContain("· expand");
    expect(markup).toContain('data-status-tone="done"');
  });

  it("renders group headers as two lines: title, then executor · rounds · activity in the weak line", () => {
    const markup = groupList({ expandedKeys: new Set() });
    expect(markup).toContain("GUI 会话页重构");
    expect(markup).toContain("Running");
    expect(markup).toContain("2 rounds");
    expect(markup).toContain("3 sessions");
    expect(markup).toContain("No squad");
    // 标准 §2.4:编号不进行,只进详情;组头是宽松两行条目(56px 档)。
    expect(markup).not.toContain(shortRef("task_1994d52c", 11));
    expect(markup).toContain("min-h-14");
    expect(markup).not.toContain("h-[25px]");
  });

  it("makes the task group head and its round rows different shapes: semibold head, single-line rounds under a guide line", () => {
    // 层次裁定(task_666b2539):父子关系不能只靠缩进——组头半粗两行,子行 40px 单行,
    // 第几轮打头、Agent 名降为行内弱色,整组子行挂在连续 border-l 细竖线容器里。
    const markup = groupList();
    const head = markup.slice(
      markup.indexOf('data-testid="session-group-toggle-task_1994d52c"'),
      markup.indexOf('data-testid="session-group-body-task_1994d52c"'),
    );
    expect(head).toContain("font-semibold");
    expect(head).toContain('title="GUI 会话页重构"');
    const body = markup.slice(
      markup.indexOf('data-testid="session-group-body-task_1994d52c"'),
      markup.indexOf('data-testid="session-group-unattributed:no-squad"'),
    );
    expect(body).toContain("border-l border-border");
    // 子行是单行 40px 档,不再与组头同高同字形;轮次打头,Agent/委派是弱色行内补充。
    expect(body).toContain("min-h-10");
    expect(body).not.toContain("min-h-14");
    expect(body.indexOf(">Round 1<")).toBeLessThan(body.indexOf('data-testid="runtime-classification-runtime-0"'));
    // disclosure 语义:组头控制组体。
    expect(markup).toContain('aria-controls="session-group-body-task_1994d52c"');
    expect(markup).toContain('id="session-group-body-task_1994d52c"');
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
      getItem: (key: string) => (key === TIME_DISPLAY_STORAGE_KEY ? JSON.stringify({ timeZone: "Asia/Taipei" }) : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const markup = groupList();
    expect(markup).toContain(">10:00<");
    expect(markup).toContain(">11:00<");
    expect(markup).not.toContain(">02:00<");
    expect(formatRelative("2026-07-01T02:44:00.000Z", { now: Date.parse("2026-08-26T02:44:00.000Z") })).toBe(
      "2026-07-01 10:44",
    );
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

  it("keeps the round row visible when the query is the runtime session id", () => {
    // 检索词是面包屑显示的会话 id 时,daemon 组成员过滤按 runtimeSessionId 命中该组;
    // 轮次行必须同口径可见,否则组展开为空、续跑按钮(只挂在轮次行上)不可达。
    const markup = groupList({ query: "runtime-0" });
    expect(markup.match(/data-testid="rail-session-/gu)).toHaveLength(1);
    expect(markup).toContain('data-testid="rail-session-runtime-0"');
    expect(markup).not.toContain('data-testid="rail-session-runtime-sibling"');
    expect(markup).not.toContain('data-testid="rail-session-runtime-orphan"');
  });

  it("matches round rows by squadId like the daemon member filter does", () => {
    const squadRounds = sessionRounds("task_1994d52c", "GUI 会话页重构", [
        dispatchRow(0, { squadId: "squad_core" }),
        dispatchRow(1, { status: "succeeded" as never, runtimeSessionId: "runtime-sibling" }),
      ]),
      markup = groupList({
        rowsByGroup: new Map([["task_1994d52c", { rounds: squadRounds, orphans: [], pending: false, error: null }]]),
        query: "squad_core",
      });
    expect(markup.match(/data-testid="rail-session-/gu)).toHaveLength(1);
    expect(markup).toContain('data-testid="rail-session-runtime-0"');
    expect(markup).not.toContain('data-testid="rail-session-runtime-sibling"');
  });

  it("does not match round rows on fields outside the daemon member vocabulary", () => {
    // classification/nextAction 是轮次行的展示字段,daemon 组成员检索口径不含它们;
    // 前端多出的字段会让轮次行命中 daemon 不会命中的检索词,口径漂移。
    const classified = sessionRounds("task_1994d52c", "GUI 会话页重构", [
        dispatchRow(3, {
          status: "failed" as never,
          classification: "provider_quota",
          nextAction: "ha runtime resume dispatch_000000000000000000000003",
        }),
      ]),
      markup = groupList({
        rowsByGroup: new Map([["task_1994d52c", { rounds: classified, orphans: [], pending: false, error: null }]]),
        query: "provider_quota",
      });
    expect(markup.match(/data-testid="rail-session-/gu) ?? []).toHaveLength(0);
  });

  it("links the task detail and every related decision from the group footer", () => {
    const markup = groupList();
    expect(markup).toContain('data-testid="session-group-toggle-task_1994d52c"');
    expect(markup).toContain('title="Open this task · task/task_1994d52c"');
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
