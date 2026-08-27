// harness-test-tier: integration
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionGroupList } from "../src/renderer/components/sessions/SessionGroupList.tsx";
import { SessionInspector } from "../src/renderer/components/sessions/SessionInspector.tsx";
import { SquadRunList } from "../src/renderer/components/sessions/SquadRunList.tsx";
import { SquadRunDetail } from "../src/renderer/components/sessions/SquadRunDetail.tsx";
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

  it("keeps the empty state honest when no squad run matches the range (G12 §2a)", () => {
    const inWindow = squadRunView({ runs: [], totalRuns: 0, squadNames: new Map(), range: "30d" });
    expect(inWindow).toContain("No squad runs in this range (30d)");
    expect(inWindow).toContain('data-testid="squad-runs-empty"');
    const never = squadRunView({ runs: [], totalRuns: 0, squadNames: new Map(), range: "all" });
    expect(never).toContain("No squad runs yet");
  });
});

const leaderReceipt = JSON.stringify({
  schema: "runtime-batch/v1",
  dispatches: [
    { instance: "instance-ontology", to: "terra", prompt: "map the ontology seam" },
    { instance: "instance-ontology", to: "sol", prompt: "audit the ledger reads" },
  ],
});
const squadRunDetail = {
  ok: true as const,
  status: "ready" as const,
  run: {
    squadRunId: "squad_" + "b".repeat(18),
    squadId: squadRunSummary.squadId,
    taskId: "task_5fc508",
    mission: "Ship the ontology milestone",
    phase: "workers_running" as const,
    error: null,
    currentLeaderRuntimeSessionId: "runtime-leader-2",
    leaderTurns: [
      {
        turnId: "leader-1",
        trigger: { kind: "initial" },
        dispatchId: "dispatch_000000000000000000000001",
        runtimeSessionId: "runtime-leader-1",
        decision: { kind: "plan", dispatchCount: 2 },
        resultText: leaderReceipt,
        status: "succeeded" as const,
        startedAt: "2026-08-25T18:00:00.000Z",
        endedAt: "2026-08-25T18:04:00.000Z",
      },
      {
        turnId: "leader-2",
        trigger: { kind: "worker_outcome", runtimeSessionId: "runtime-worker-1" },
        dispatchId: "dispatch_000000000000000000000002",
        runtimeSessionId: "runtime-leader-2",
        decision: null,
        resultText: null,
        status: "running" as const,
        startedAt: "2026-08-25T18:10:00.000Z",
        endedAt: null,
      },
    ],
    workerAttempts: [
      {
        attemptId: "worker-1",
        workerId: "terra",
        leaderTurnId: "leader-1",
        dispatchId: "dispatch_000000000000000000000003",
        runtimeSessionId: "runtime-worker-1",
        rejection: null,
        status: "succeeded" as const,
        startedAt: "2026-08-25T18:05:00.000Z",
        endedAt: "2026-08-25T18:09:00.000Z",
      },
      {
        attemptId: "worker-2",
        workerId: "sol",
        leaderTurnId: null,
        dispatchId: null,
        runtimeSessionId: null,
        rejection: "Runtime dispatch was rejected.",
        status: null,
        startedAt: null,
        endedAt: null,
      },
    ],
  },
  watermark: 9,
  sourceRevision: 9,
};

describe("sessions page: squad run detail", () => {
  const detailView = (props: Partial<Parameters<typeof SquadRunDetail>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(SquadRunDetail, {
        detail: squadRunDetail,
        squadName: "ontology-squad",
        pending: false,
        error: null,
        onOpenTask: noop,
        onSelectEntity: noop,
        ...props,
      }),
    );

  it("renders the leader-to-worker fan-out tree with the mission verbatim", () => {
    const markup = detailView();
    expect(markup).toContain("Leader turns (2)");
    expect(markup).toContain("leader-1");
    expect(markup).toContain("initial mission");
    expect(markup).toContain("plan · 2 dispatches");
    expect(markup).toContain("leader-2");
    expect(markup).toContain("after worker session");
    expect(markup).toContain("decision pending");
    expect(markup).toMatch(/data-testid="squad-run-turn-leader-2"/u);
    // 当前 leader 轮高亮;轮次行直达 session/<id>(EntityRefLink 是 button 出口)。
    expect(markup).toMatch(/border-accent\/40/u);
    expect(markup).toContain('title="runtime-leader-2"');
    expect(markup).toContain("runtime-leader-2");
    expect(markup).toContain("Ship the ontology milestone");
    // 扇出树:worker-1 挂在 leader-1 节内,且出现在 leader-2 之前(父子序,不是平铺)。
    const inLeader1 = markup.indexOf('data-testid="squad-run-turn-leader-1"'),
      attemptAt = markup.indexOf('data-testid="squad-run-attempt-worker-1"'),
      leader2At = markup.indexOf('data-testid="squad-run-turn-leader-2"');
    expect(inLeader1).toBeGreaterThan(-1);
    expect(attemptAt).toBeGreaterThan(inLeader1);
    expect(attemptAt).toBeLessThan(leader2At);
    // worker attempt 直达 session 详情。
    expect(markup).toContain('title="runtime-worker-1"');
  });

  it("shows each leader turn's receipt verbatim in a collapsible block", () => {
    const markup = detailView();
    expect(markup).toMatch(/data-testid="squad-run-receipt-leader-1"/u);
    expect(markup).toContain("leader receipt (raw)");
    expect(markup).toContain("map the ontology seam");
    expect(markup).toContain("audit the ledger reads");
    // 未结算的轮次诚实呈空,不伪造 receipt。
    expect(markup).toMatch(/data-testid="squad-run-receipt-leader-2"[^>]*>[^<]*<\/summary>\s*<p[^>]*>no receipt yet/u);
  });

  it("labels a leader recovery turn from its durable retry trigger", () => {
    const retry = detailView({
      detail: {
        ...squadRunDetail,
        run: {
          ...squadRunDetail.run,
          leaderTurns: squadRunDetail.run.leaderTurns.map((turn) =>
            turn.turnId === "leader-2"
              ? {
                  ...turn,
                  trigger: {
                    kind: "leader_retry" as const,
                    turnId: "leader-1",
                    reason: "Leader result was not JSON.",
                  },
                }
              : turn,
          ),
        },
      },
    });
    expect(retry).toContain("retry after leader turn leader-1");
  });

  it("shows why a duplicate worker dispatch waited for the running attempt", () => {
    const reason = "Worker terra was already running; waited for its callback instead of redispatching.",
      wait = detailView({
        detail: {
          ...squadRunDetail,
          run: {
            ...squadRunDetail.run,
            leaderTurns: squadRunDetail.run.leaderTurns.map((turn) =>
              turn.turnId === "leader-2"
                ? {
                    ...turn,
                    trigger: {
                      kind: "worker_wait" as const,
                      runtimeSessionId: "runtime-worker-1",
                      reason,
                    },
                  }
                : turn,
            ),
          },
        },
      });
    expect(wait).toContain(reason);
  });

  it("keeps attempts without turn linkage in their own group with rejections visible", () => {
    const markup = detailView();
    expect(markup).toContain("Worker attempts without turn linkage (1)");
    expect(markup).toMatch(/data-testid="squad-run-unlinked"/u);
    expect(markup).toContain("worker-2");
    expect(markup).toContain("sol");
    expect(markup).toContain("rejected: Runtime dispatch was rejected.");
    expect(markup).toContain("no dispatch");
    expect(markup).toMatch(/data-testid="squad-run-attempt-worker-2"/u);
    // 全关联时不再渲染未关联组。
    const linked = detailView({
      detail: {
        ...squadRunDetail,
        run: {
          ...squadRunDetail.run,
          workerAttempts: squadRunDetail.run.workerAttempts.map((attempt) => ({
            ...attempt,
            leaderTurnId: "leader-1",
          })),
        },
      },
    });
    expect(linked).not.toContain("Worker attempts without turn linkage");
    expect(linked).not.toMatch(/data-testid="squad-run-unlinked"/u);
  });

  it("surfaces the run error line and read failures without inventing flow", () => {
    const failed = detailView({
      detail: {
        ...squadRunDetail,
        run: { ...squadRunDetail.run, error: "Leader turn leader-1 ended with failed." },
      },
    });
    expect(failed).toContain("Leader turn leader-1 ended with failed.");
    const error = detailView({ detail: null, pending: false, error: "squad read failed" });
    expect(error).toContain("squad read failed");
    expect(error).toMatch(/data-testid="squad-run-detail-error"/u);
  });
});
