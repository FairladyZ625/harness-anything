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

/**
 * 取 `<details ...>` 的起始标签原文(含全部属性),用于断言「默认折叠」。
 * 不从 data-testid 往右切:属性顺序是自由的,`open` 排在 testid 之前时切出来的是空串。
 */
function detailsStartTag(markup: string): string | null {
  const open = /<details\b[^>]*>/u.exec(markup);
  return open === null ? null : open[0];
}

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

  it("deduplicates the detail head meter and drops the fake context-window ratio", () => {
    // 业主截图的形态:累计 token 远超 200K 硬编码窗口,水位条显示危险红百分比。
    const big = {
      inputTokens: 180_000,
      cacheReadTokens: 2_300_000,
      outputTokens: 63_000,
      totalTokens: 2_543_000,
      toolCallCount: 1_271,
      compacted: false,
    } as const;
    const markup = detailView({ session: { ...sessionDto, metrics: big } as typeof sessionDto });
    // 重复位已删:详情卡头不再有第二个 meter。
    expect(markup).not.toContain('data-testid="session-detail-context-meter"');
    // 会话累计消耗不冒充上下文窗口占用:没有 /200K 比值与水位档。
    expect(markup).not.toContain("/ 200K");
    expect(markup).not.toContain('data-context-level="danger"');
    // 唯一展示位保留:消耗卡头仍是 meter,精确数字在 KV。
    expect(markup).toContain('data-testid="session-metrics-context-meter"');
    expect(markup).toContain("2,543,000");
  });

  it("draws the context window the provider reported, and no ratio when it reported none", () => {
    // 唯一展示位是详情头的窗口水位:分母就是 provider 自报的窗口(这里是 1M,不是 200K)。
    const markup = detailView({
      session: { ...sessionDto, context: { usedTokens: 516_976, windowTokens: 1_000_000 } } as typeof sessionDto,
    });
    expect(markup).toContain('data-testid="session-detail-context"');
    expect(markup).toContain('aria-valuemax="1000000"');
    expect(markup).toContain('aria-valuenow="516976"');
    expect(markup).toContain("517K / 1M · 52%");
    expect(markup).not.toContain("200K");
    expect(markup).not.toContain('data-context-level="danger"');
    // 没有 provider 上报:不画比值、不猜默认窗口(累计消耗仍按组成口径留在消耗卡里)。
    const missing = detailView({ session: sessionDto });
    expect(missing).not.toContain('data-testid="session-detail-context"');
    expect(missing).not.toContain('data-testid="session-detail-context-meter"');
    expect(missing).not.toContain("/ 200K");
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

// 会话详情可读面(业主 2026-10-21 13:50 定案):详情回答「这次会话做成了什么」,
// 原始哈希、运行时 id、模型元组字符串不上屏;结论文本与转写(工具调用)是主角。
describe("session detail readable surface", () => {
  it("renders the readable model label instead of the raw candidate-list tuple", () => {
    const tuple = '["deepseek-official","Deepseek-V4.1-Flash"]';
    const markup = detailView({
      session: { ...sessionDto, definitionSnapshot: { ...definition, model: tuple } } as typeof sessionDto,
    });
    expect(markup).toContain("deepseek-official / Deepseek-V4.1-Flash");
    expect(markup).not.toContain(tuple);
    expect(markup).not.toContain('["');
  });

  it("shows the final result text it is given", () => {
    const markup = detailView({ result: "Delivered the fix; all targeted tests green." });
    expect(markup).toContain("Delivered the fix; all targeted tests green.");
  });

  it("shortens the session breadcrumb; the full runtime id lives only in hover titles", () => {
    const longId = "runtime_eb17a3274ac2ff920a09f37b";
    const markup = detailView({ session: { ...sessionDto, runtimeSessionId: longId } as typeof sessionDto });
    expect(markup).toContain(`>session/${longId.slice(0, 14)}…<`);
    expect(markup).not.toContain(`>${longId}<`);
  });

  it("keeps raw fields out of the first screen: they live inside the collapsed technical details", () => {
    const markup = detailView(),
      technical = markup.indexOf('data-testid="session-technical-details"'),
      firstScreen = markup.slice(0, technical);
    // 技术详情默认收起:解析 <details> 起始标签本身,不按 data-testid 切字符串——后者在
    // `open` 排在 data-testid 之前时会切掉属性而假绿(评审 F2 用变异证明过)。
    const detailsTag = detailsStartTag(markup);
    expect(technical).toBeGreaterThan(0);
    expect(detailsTag).not.toBeNull();
    expect(/\sopen(?:=|\s|>)/u.test(detailsTag!)).toBe(false);
    for (const raw of [
      "Provider session",
      "Definition snapshot",
      "provider-1",
      "artifact:runtime-definition/test",
      "Auth mode",
      "Subscription login",
      "Lease",
      "held",
      "2026-08-23T01:00:00.000Z",
    ])
      expect(firstScreen).not.toContain(raw);
    // 原始值仍然可查(折叠块里在 DOM,展开即见),不是删掉了事实。
    expect(markup).toContain("provider-1");
    // 首屏可读行:身份(agent/模型/实例)、结局、最近活动。
    for (const readable of ["Agent", "Model", "Instance", "Last activity", "w4c-verify-codex", "Running"])
      expect(firstScreen).toContain(readable);
  });
});

// 业主定案的核心:会话详情首屏回答「这次会话做成了什么」——任务名、结局、耗时、结论、
// 产出在首屏;原始字段在折叠块里。这一组逐条锁住这几个答案的位置与措辞。
describe("session detail achieved first", () => {
  const settlement = (outcome: "succeeded" | "failed" | "cancelled" | "stopped" | "unknown") =>
    ({ outcome, exitCode: outcome === "succeeded" ? 0 : 1, code: null, reason: null }) as const;

  it("titles the card with the task and verdicts the session from the daemon settlement", () => {
    const markup = detailView(),
      technical = markup.indexOf('data-testid="session-technical-details"'),
      firstScreen = markup.slice(0, technical);
    // 任务名是卡头主文字,并且仍点得进任务详情。
    expect(firstScreen).toContain('data-testid="session-open-task"');
    expect(firstScreen).toContain("GUI 会话页重构");
    expect(firstScreen).toContain('data-testid="session-verdict"');
    // live 会话就是「正在跑」,不被上一轮结局抢先命名。
    expect(firstScreen).toContain("Running");
    // 终局裁决:settlement 是 daemon 的裁决,优先于会话语义状态(会话已退出才有终局)。
    const ended = { ...sessionDto, liveness: "exited" } as typeof sessionDto;
    expect(detailView({ session: ended, settlement: settlement("failed") })).toContain("Failed");
    expect(detailView({ session: ended, settlement: settlement("succeeded") })).toContain("Delivered");
    expect(detailView({ session: ended, settlement: settlement("stopped") })).toContain("Stopped");
    // 没有 settlement 时按会话语义状态退,不把「已结束但判不出」说成失败。
    expect(detailView({ session: { ...ended, semanticState: "ended-indeterminate" } as typeof sessionDto })).toContain(
      "Result unconfirmed",
    );
  });

  it("shows the elapsed time from the dispatch row instead of inventing one", () => {
    // rounds[1] 是 02:00 那轮(轮次按新→旧编号);收口时刻显式给到 03:31 → 1h 31m。
    const markup = detailView({
      row: { ...rounds[1]!, endedAt: "2026-08-23T03:31:00.000Z" },
    });
    expect(markup).toContain("Duration");
    expect(markup).toContain("1h 31m");
    // 没有收口时刻(仍在跑)时不编造时长,如实显示开始时间。
    expect(detailView()).toContain("Started");
  });

  it("states the missing conclusion in words rather than drawing an empty result shell", () => {
    const markup = detailView();
    expect(markup).toContain('data-testid="session-conclusion"');
    expect(markup).toContain("Still running");
    const settled = detailView({
      session: { ...sessionDto, liveness: "exited" } as typeof sessionDto,
    });
    expect(settled).toContain("no conclusion text");
  });

  it("lists what the session produced: commit, delivered files, artifacts, and the result report", () => {
    const markup = detailView({
      task: {
        packagePath: "tasks/task-1994",
        executions: [
          {
            schema: "execution/v1",
            executionId: "execution-1",
            taskId: "task_1994d52c",
            nodeId: "implementation",
            iteration: 0,
            state: "submitted",
            actor: { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "terra" } },
            claimedAt: "2026-08-23T02:00:00.000Z",
            submittedAt: "2026-08-23T03:00:00.000Z",
            closedAt: null,
            submission: {
              completionClaim: "done",
              deliverables: ["packages/gui/src/renderer/views/SessionsView.tsx"],
              outputs: ["Artifact-Anchor: tasks/task-1994/artifacts/report.md@3"],
              verificationNotes: [],
              knownGaps: [],
              residualRisks: [],
              commitSha: "b".repeat(40),
              completionContract: { gates: [] },
              artifacts: [
                { path: "tasks/task-1994/artifacts/report.md", revision: 3, blobSha256: `sha256:${"c".repeat(64)}` },
              ],
            },
          },
        ],
      } as never,
      row: { ...rounds[1]!, reportPath: "tasks/task-1994/artifacts/reports/dispatch_000000000000000000000001.md" },
      onOpenTaskDoc: noop,
    });
    expect(markup).toContain('data-testid="session-outputs"');
    expect(markup).toContain("bbbbbbbbbb");
    expect(markup).toContain("packages/gui/src/renderer/views/SessionsView.tsx");
    expect(markup).toContain("tasks/task-1994/artifacts/report.md");
    expect(markup).toContain("tasks/task-1994/artifacts/reports/dispatch_000000000000000000000001.md");
    // 包内产物是真能打开的落点(包相对路径),不是假链接。
    expect(markup).toContain('data-testid="session-open-output"');
    expect(markup).toContain('data-path="artifacts/report.md"');
    // 没有任何产出时整块不画,而不是空壳。
    expect(detailView()).not.toContain('data-testid="session-outputs"');
  });

  it("leads with the review verdict and its reason for a review dispatch, not the reviewer's last message", () => {
    // 评审派工的「结论」是它登记的 verdict + 一句理由;agent 最后一条消息是过程叙述。
    const markup = detailView({
      row: {
        ...rounds[1]!,
        reviewTarget: {
          kind: "task",
          taskId: "task_1994d52c",
          executionId: "execution-1",
          digest: "sha256:" + "a".repeat(64),
        },
      },
      task: {
        packagePath: "tasks/task-1994",
        executions: [
          {
            executionId: "execution-1",
            submittedAt: "2026-08-23T03:00:00.000Z",
            submission: {
              completionClaim: "worker claim that must not win",
              deliverables: [],
              commitSha: "c".repeat(40),
            },
          },
        ],
        reviews: [
          {
            reviewId: "review-1",
            executionId: "execution-1",
            verdict: "changes_requested",
            reason: "Contract conformance is FULL except the explainer is blank.",
            reviewedAt: "2026-08-23T04:00:00.000Z",
          },
        ],
      } as never,
      result: "I'll start by loading the required skills.\n\nNow let me run the tests.",
    });
    const text = /data-testid="session-conclusion-text"[^>]*>([\s\S]*?)<\/p>/u.exec(markup)?.[1] ?? "";
    expect(text).toContain("explainer is blank");
    expect(text).not.toContain("I'll start by loading");
    // claim 与评审同场时评审优先(谁有权下结论)。
    expect(text).not.toContain("worker claim that must not win");
    expect(markup).toContain('data-testid="session-conclusion-source"');
    expect(markup).toContain("from the review verdict");
  });

  it("uses the submission's completion claim for a worker session and never the process narration", () => {
    const markup = detailView({
      task: {
        packagePath: "tasks/task-1994",
        executions: [
          {
            executionId: "execution-1",
            submittedAt: "2026-08-23T03:00:00.000Z",
            submission: {
              completionClaim: "SessionsPanel now leads with the verdict; 39 tests green.",
              deliverables: [],
              commitSha: "d".repeat(40),
            },
          },
        ],
        reviews: [],
      } as never,
      result: "I'll start by loading the skills.\n\nNow let me run the affected tests.",
    });
    const text = /data-testid="session-conclusion-text"[^>]*>([\s\S]*?)<\/p>/u.exec(markup)?.[1] ?? "";
    expect(text).toContain("39 tests green");
    expect(text).not.toContain("I'll start by loading");
    expect(text).not.toContain("Now let me run");
    // renderToStaticMarkup 会把撇号转义成 &#x27;;断言来源标注的稳定片段。
    expect(markup).toContain('data-testid="session-conclusion-source"');
    expect(markup).toContain("completion claim");
  });

  it("falls back to the settlement reason for a failed session, and strips narration from a raw result", () => {
    const failed = detailView({
      session: { ...sessionDto, liveness: "exited" } as typeof sessionDto,
      settlement: {
        outcome: "failed",
        exitCode: 1,
        code: "provider_exit",
        reason: "Internal error: turn failed: SSE event type mismatch",
      },
      result: null,
    });
    expect(failed).toContain("SSE event type mismatch");
    expect(failed).toContain("from the daemon settlement");

    // 没有 claim/评审时退回 result 原文,但过程叙述行不进首屏;结论段落保留。
    const raw = detailView({
      session: { ...sessionDto, liveness: "exited" } as typeof sessionDto,
      result:
        "I'll start by loading the task plan.\n\nDelivered the session-detail rewrite: verdict head, wrapped conclusion, basename output paths, and the dispatch start time fallback. All 39 targeted tests pass.",
    });
    const text = /data-testid="session-conclusion-text"[^>]*>([\s\S]*?)<\/p>/u.exec(raw)?.[1] ?? "";
    expect(text).toContain("Delivered the session-detail rewrite");
    expect(text).not.toContain("I'll start by loading");
    expect(raw).toContain("narration removed");
  });

  it("never attributes another iteration's submission to a session that has not submitted", () => {
    // 运行中的会话绑定了 execution-2,但任务里只有 execution-1 提交过:不能把上一轮的
    // claim / 产物说成这一轮的(实测真实数据时发现的错误归属)。
    const twoExec = [
      {
        executionId: "execution-1",
        submittedAt: "2026-08-23T03:00:00.000Z",
        submission: {
          completionClaim: "Previous iteration claim.",
          deliverables: ["old/file.ts"],
          commitSha: "a".repeat(40),
        },
      },
      { executionId: "execution-2", submittedAt: null, submission: null },
    ];
    const markup = detailView({
      session: {
        ...sessionDto,
        associations: [{ taskId: "task_1994d52c", executionId: "execution-2", holder: null, lease: null }],
      } as typeof sessionDto,
      task: { packagePath: "tasks/task-1994", executions: twoExec, reviews: [] } as never,
    });
    expect(markup).not.toContain("Previous iteration claim.");
    expect(markup).not.toContain("old/file.ts");
    // 没有本轮结论时如实说没有,不用上一轮冒充。
    expect(markup).toContain("Still running");
  });

  it("wraps long conclusion lines instead of clipping them off the right edge", () => {
    // rt-pre 的 white-space:pre 会压掉 Tailwind 的 whitespace-pre-wrap(无层规则优先),
    // 长行右侧被裁就是这条层叠冲突;换行口径现在收在 .rt-pre-wrap 一处。
    const long = "x".repeat(400);
    const markup = detailView({ result: long, task: null });
    expect(markup).toContain('data-testid="session-conclusion-text"');
    expect(markup).toContain("rt-pre-wrap");
    expect(markup).not.toContain("whitespace-pre-wrap");
  });

  it("labels the two token quantities separately and draws each once", () => {
    const markup = detailView({
      session: {
        ...sessionDto,
        context: { usedTokens: 243_138, windowTokens: 1_000_000 },
        metrics: {
          inputTokens: 9_300_000,
          cacheReadTokens: 4_400_000,
          outputTokens: 120_000,
          totalTokens: 13_820_000,
          toolCallCount: 80,
          compacted: false,
        },
      } as typeof sessionDto,
    });
    // 当前上下文只一处,且是 provider 自报的窗口比值。
    expect(markup.match(/data-testid="session-detail-context-meter"/gu) ?? []).toHaveLength(1);
    expect(markup).toContain("243K / 1M · 24%");
    expect(markup).toContain("Current context");
    // 累计口径如实标注,不冒充窗口占用,也不出现业主截图里的 4634% 假报警。
    expect(markup).toContain("Cumulative totals; not context-window occupancy");
    expect(markup).not.toContain("4634%");
    expect(markup).not.toContain('data-context-level="danger"');
    // 同一组数字只出现一次:没有第二个窗口 meter。
    expect(markup.match(/role="meter"/gu) ?? []).toHaveLength(1);
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
    expect(markup).toContain("Read");
    expect(markup).toContain('data-testid="toolcall-card"');
    expect(markup).toContain("Task complete.");
    expect(markup).not.toContain("<pre");
  });

  it("renders consecutive tool calls in a ToolCallGroup", () => {
    const recordsWithMultipleTools = [
      {
        kind: "provider_event",
        occurredAt: "2026-08-26T05:02:10.000Z",
        event: {
          type: "assistant",
          message: {
            id: "msg-multi-tool",
            content: [
              { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } },
              { type: "tool_use", id: "call_2", name: "read_file", input: { path: "b.ts" } },
            ],
          },
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-08-26T05:02:11.000Z",
        event: { type: "result", tool_use_id: "call_1", result: "content a" },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-08-26T05:02:12.000Z",
        event: { type: "result", tool_use_id: "call_2", result: "content b" },
      },
    ] as const;
    const turns = sessionTranscriptTurns(recordsWithMultipleTools);
    const markup = renderToStaticMarkup(createElement(SessionTranscriptTurns, { turns }));
    expect(markup).toContain('data-testid="toolcall-group"');
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
    expect(markup).toContain("No dispatch record: 1 bound session");
    expect(markup).not.toContain("No dispatch record: 1 bound sessions");
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
